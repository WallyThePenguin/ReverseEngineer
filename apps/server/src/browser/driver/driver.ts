// The server-side driver (B1, D52): one HTTP call per step from Jarvis or the worker, and the
// driver does the rest here, next to Chrome's link: reads the page by its accessibility tree,
// finds things, looks, and acts by refs or screenshot points, judging every press where it lands,
// then waits for what the step set off and says what changed.
import {
  type DriverPolicy,
  isLoopbackHost,
  paceFor,
  snapshotExpression,
} from "@hearth/modules/driver-kit";
import { z } from "zod";
import { DriverContext, hostOf } from "./context.ts";
import { fail, reasonOf } from "./errors.ts";
import { formInputStep, keyStep, pressStep, probeStep, typeStep } from "./keyboard.ts";
import { clickStep, dragStep, hoverStep, scrollStep, scrollToStep } from "./pointer.ts";
import { find, lineText, render, shownByRef } from "./render.ts";
import { Base, Batch, Policy, Read, ref, STEPS, type StepName } from "./schemas.ts";
import { readTree } from "./snapshot.ts";
import { TabState } from "./tab.ts";
import { Cdp, type CdpTransport } from "./transport.ts";
import { screenshot, zoom } from "./vision.ts";
import { after, assertFree, before, settle, stepBack } from "./wait.ts";
import { Worlds } from "./world.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_TABS = 200;

export class Driver {
  private readonly transport: CdpTransport;
  private readonly tabs = new Map<number, TabState>();
  /** When Jarvis last stepped on each site, for pacing (shared by Jarvis and the worker). */
  private readonly lastStep = new Map<string, number>();

  constructor(transport: CdpTransport) {
    this.transport = transport;
    transport.onEvent((e) => this.tab(e.tabId).handle(e));
  }

  private tab(tabId: number): TabState {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = new TabState(tabId);
      this.tabs.set(tabId, tab);
      if (this.tabs.size > MAX_TABS) this.tabs.delete(this.tabs.keys().next().value as number);
    }
    return tab;
  }

  /** The owner used a tab in Hearth's live view: Jarvis's steps there wait a moment. */
  ownerInput(tabId: number): void {
    this.tab(tabId).ownerAt = Date.now();
  }

  private context(tabId: number, policy: DriverPolicy): DriverContext {
    const tab = this.tab(tabId);
    const cdp = new Cdp(this.transport, tabId);
    return new DriverContext(this.transport, cdp, tab, new Worlds(cdp, tab), policy);
  }

  /** Waits out the site's pause since Jarvis's last step there (the owner's steps never wait). */
  private async pace(d: DriverContext): Promise<void> {
    const pace = d.policy.pace;
    const host = hostOf(d.url());
    if (!pace || d.policy.owner || !host || isLoopbackHost(host)) return;
    const wait = (this.lastStep.get(host) ?? 0) + paceFor(host, pace) * 1000 - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 60_000));
    this.lastStep.set(host, Date.now());
    if (this.lastStep.size > 500) this.lastStep.delete(this.lastStep.keys().next().value as string);
  }

  /** Runs one driver request: "read_page", "click", "batch"... */
  async run(op: string, raw: Record<string, unknown>): Promise<unknown> {
    let d: DriverContext | null = null;
    try {
      const tabId = z.object({ tabId: z.number().int() }).parse(raw).tabId;
      d = this.context(tabId, Policy.parse(raw.policy));
      return await this.dispatch(d, op, raw);
    } catch (err) {
      if (err instanceof z.ZodError) {
        const issue = err.issues[0];
        throw fail(
          "invalid",
          `${issue?.path.join(".") || "input"}: ${issue?.message ?? "not valid"}`,
        );
      }
      throw err;
    } finally {
      d?.worlds.release();
    }
  }

  private async dispatch(
    d: DriverContext,
    op: string,
    raw: Record<string, unknown>,
  ): Promise<unknown> {
    await d.seed();
    d.assertAllowed(d.url());
    switch (op) {
      case "read_page":
        return this.readPage(d, Read.parse(raw));
      case "find": {
        const i = Base.extend({ query: z.string().min(1).max(300) }).parse(raw);
        const tree = await readTree(d);
        d.tab.last = shownByRef(tree.lines);
        const found = find(tree.lines, i.query);
        return {
          ...this.where(d),
          found: found.length,
          text: found.map((l) => `- ${lineText(l)}`).join("\n"),
          links: tree.links,
        };
      }
      case "get_text": {
        const i = Base.extend({
          maxChars: z.number().int().min(500).max(300_000).default(20_000),
        }).parse(raw);
        return d.worlds.evaluate(undefined, d.tab.mainFrame ?? "", snapshotExpression(i.maxChars));
      }
      case "screenshot": {
        const i = Base.extend({ scale: z.number().min(0.1).max(1).optional() }).parse(raw);
        const { meta, image } = await screenshot(d, i.scale);
        return { ...this.where(d), ...meta, image };
      }
      case "zoom": {
        const i = Base.extend({
          region: z.tuple([z.number(), z.number(), z.number(), z.number()]),
          scale: z.number().min(0.5).max(4).optional(),
        }).parse(raw);
        return { ...this.where(d), ...(await zoom(d, i.region, i.scale)) };
      }
      case "console": {
        const i = Base.extend({
          limit: z.number().int().min(1).max(200).default(50),
          pattern: z.string().max(200).optional(),
        }).parse(raw);
        const re = i.pattern
          ? new RegExp(i.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
          : null;
        return { entries: d.tab.console.filter((c) => !re || re.test(c.text)).slice(-i.limit) };
      }
      case "probe":
        return probeStep(d, Base.extend({ ref }).parse(raw).ref);
      case "press": {
        const i = Base.extend({
          ref,
          label: z.string().max(200),
          sends: z.unknown().optional(),
        }).parse(raw);
        return this.act(d, () => pressStep(d, i), false);
      }
      case "batch":
        return this.batch(d, Batch.parse(raw));
      default: {
        if (!(op in STEPS)) throw fail("invalid", `The driver has no "${op}".`);
        const shot = Base.parse(raw).screenshot ?? false;
        return this.act(d, () => this.step(d, op as StepName, raw), shot);
      }
    }
  }

  /** The address and title, as last heard. */
  private where(d: DriverContext) {
    return { tabId: d.tab.tabId, url: d.url() };
  }

  private async readPage(d: DriverContext, i: z.output<typeof Read>) {
    const tree = await readTree(d);
    d.tab.last = shownByRef(tree.lines);
    const out = render(tree.lines, {
      filter: i.filter,
      depth: i.depth,
      refId: i.refId,
      maxChars: i.maxChars,
    });
    if (!out)
      throw fail("gone", `${i.refId} isn't on the page any more. Read the whole page again.`);
    const view = await d.cdp.send<{
      cssVisualViewport: {
        clientWidth: number;
        clientHeight: number;
        pageX: number;
        pageY: number;
      };
      cssContentSize: { width: number; height: number };
    }>("Page.getLayoutMetrics");
    const v = view.cssVisualViewport;
    return {
      ...this.where(d),
      viewport: {
        width: Math.round(v.clientWidth),
        height: Math.round(v.clientHeight),
        scrollX: Math.round(v.pageX),
        scrollY: Math.round(v.pageY),
        pageHeight: Math.round(view.cssContentSize.height),
      },
      text: out.text,
      ...(out.cut
        ? {
            cut: `Cut off at ${i.maxChars} characters: read a part with refId, use browser_find, or filter "interactive".`,
          }
        : {}),
      links: tree.links,
    };
  }

  /** One step that acts on the page: run it, wait for what it set off, and say what changed. */
  private async step(
    d: DriverContext,
    op: StepName,
    raw: Record<string, unknown>,
  ): Promise<string | Record<string, unknown>> {
    switch (op) {
      case "click":
        return clickStep(d, STEPS.click.parse(raw));
      case "hover":
        return hoverStep(d, STEPS.hover.parse(raw));
      case "drag":
        return dragStep(d, STEPS.drag.parse(raw));
      case "scroll":
        return scrollStep(d, STEPS.scroll.parse(raw));
      case "scroll_to":
        return scrollToStep(d, STEPS.scroll_to.parse(raw).ref);
      case "type":
        return typeStep(d, STEPS.type.parse(raw));
      case "key":
        return keyStep(d, STEPS.key.parse(raw));
      case "form_input":
        return formInputStep(d, STEPS.form_input.parse(raw));
      case "wait":
        await sleep(STEPS.wait.parse(raw).ms);
        return "Waited";
    }
  }

  private async act(
    d: DriverContext,
    run: () => Promise<string | Record<string, unknown>>,
    shot: boolean,
  ) {
    assertFree(d);
    d.assertSite();
    await this.pace(d);
    const b = await before(d);
    const did = await run();
    const s = await settle(d, b);
    await stepBack(d, b);
    const { did: text, ...extra } = typeof did === "string" ? { did } : (did as { did: string });
    const out = { ...(await after(d, b, String(text), s)), ...extra };
    if (!shot || d.tab.dialog) return out;
    return { ...out, image: (await screenshot(d)).image };
  }

  /** Several steps in one tab, one after another, each judged as it runs; stops at the first error. */
  private async batch(d: DriverContext, i: z.output<typeof Batch>) {
    assertFree(d);
    d.assertSite();
    await this.pace(d);
    const b = await before(d);
    const done: string[] = [];
    let stopped: { step: number; action: string; reason: string | null; error: string } | null =
      null;
    let last = { navigated: false, loading: false };
    for (const [n, s] of i.steps.entries()) {
      try {
        if (d.tab.dialog) assertFree(d);
        const nb = await before(d);
        const did = await this.step(d, s.action, s.input);
        last = await settle(d, nb);
        await stepBack(d, nb);
        done.push(
          typeof did === "string" ? did : String((did as { did?: string }).did ?? s.action),
        );
        if (
          last.navigated &&
          n < i.steps.length - 1 &&
          i.steps.slice(n + 1).some((x) => "ref" in x.input || "fromRef" in x.input)
        )
          throw fail(
            "gone",
            "A new page loaded, so the refs in the steps after this one are gone. Read the page again.",
          );
      } catch (err) {
        stopped = {
          step: n + 1,
          action: s.action,
          reason: reasonOf(err),
          error: err instanceof Error ? err.message : String(err),
        };
        break;
      }
    }
    const out = {
      ...(await after(d, b, done.join("; ") || "Nothing", {
        navigated: d.tab.navigations !== b.navigations,
        loading: last.loading,
      })),
      steps: done.length,
      ...(stopped ? { stopped } : {}),
    };
    if (!i.screenshot || d.tab.dialog) return out;
    return { ...out, image: (await screenshot(d)).image };
  }
}
