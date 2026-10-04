// Hearth's isolated world in each frame (B1): where the driver's page-side helpers run, out of the
// page's own scripts' sight. Elements are handed in by Chrome's node numbers and come back as
// plain values; a world that went with its page is made again once.
import { DRIVER_INSTALL } from "@hearth/modules/driver-kit";
import { isGone } from "./errors.ts";
import type { TabState } from "./tab.ts";
import type { Cdp } from "./transport.ts";

const GROUP = "hearth-driver";

interface Evaluated {
  result?: { value?: unknown; objectId?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

function thrown(res: Evaluated): Error | null {
  if (!res.exceptionDetails) return null;
  const why = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
  return new Error(`The page's script failed: ${why.split("\n")[0]}`);
}

export class Worlds {
  private readonly cdp: Cdp;
  private readonly tab: TabState;
  /** Sessions whose handles to the page's nodes are to be let go after this step. */
  private readonly used = new Set<string>();

  constructor(cdp: Cdp, tab: TabState) {
    this.cdp = cdp;
    this.tab = tab;
  }

  /** The world in a frame, made and given the helpers if it isn't there yet. */
  async context(session: string | undefined, frameId: string): Promise<number> {
    const key = `${session ?? ""}|${frameId}`;
    const had = this.tab.worlds.get(key);
    if (had !== undefined) return had;
    const { executionContextId } = await this.cdp.send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      { frameId, worldName: "hearth", grantUniveralAccess: false },
      session,
    );
    const res = await this.cdp.send<Evaluated>(
      "Runtime.evaluate",
      { expression: DRIVER_INSTALL, contextId: executionContextId, returnByValue: true },
      session,
    );
    const err = thrown(res);
    if (err) throw err;
    this.tab.worlds.set(key, executionContextId);
    return executionContextId;
  }

  /** Runs `fn` once more in a fresh world if the old one went with its page. */
  private async again<T>(
    session: string | undefined,
    frameId: string,
    fn: (ctx: number) => Promise<T>,
  ): Promise<T> {
    this.used.add(session ?? "");
    try {
      return await fn(await this.context(session, frameId));
    } catch (err) {
      if (
        !/Cannot find context|Execution context was destroyed|Cannot find default execution context/i.test(
          String(err),
        )
      )
        throw err;
      this.tab.worlds.delete(`${session ?? ""}|${frameId}`);
      return fn(await this.context(session, frameId));
    }
  }

  /** An expression's value, with `__hearth` there to use. */
  evaluate<T>(session: string | undefined, frameId: string, expression: string): Promise<T> {
    return this.again(session, frameId, async (contextId) => {
      const res = await this.cdp.send<Evaluated>(
        "Runtime.evaluate",
        { expression, contextId, returnByValue: true, awaitPromise: true },
        session,
      );
      const err = thrown(res);
      if (err) throw err;
      return res.result?.value as T;
    });
  }

  /** An expression's result as a handle, for arrays of elements. */
  handle(session: string | undefined, frameId: string, expression: string): Promise<string | null> {
    return this.again(session, frameId, async (contextId) => {
      const res = await this.cdp.send<Evaluated>(
        "Runtime.evaluate",
        { expression, contextId, returnByValue: false, objectGroup: GROUP },
        session,
      );
      const err = thrown(res);
      if (err) throw err;
      return res.result?.objectId ?? null;
    });
  }

  /**
   * Calls `fn(h, ...elements, ...args)` in the frame's world, where `h` is the page-side helpers
   * and each element is a node by Chrome's number. Every node must be in that frame.
   */
  async call<T>(
    session: string | undefined,
    frameId: string,
    nodes: number[],
    fn: string,
    args: unknown[] = [],
  ): Promise<T> {
    return (await this.invoke(session, frameId, nodes, fn, args, true)).value as T;
  }

  /** Like call, for a function that gives an element: that element's node. */
  async callNode(session: string | undefined, frameId: string, nodes: number[], fn: string) {
    const { objectId } = await this.invoke(session, frameId, nodes, fn, [], false);
    if (!objectId) return null;
    const d = await this.cdp.send<{
      node: { backendNodeId: number; nodeName: string; frameId?: string };
    }>("DOM.describeNode", { objectId }, session);
    return d.node;
  }

  private invoke(
    session: string | undefined,
    frameId: string,
    nodes: number[],
    fn: string,
    args: unknown[],
    byValue: boolean,
  ): Promise<{ value?: unknown; objectId?: string }> {
    return this.again(session, frameId, async (contextId) => {
      const objects: string[] = [];
      for (const node of nodes) {
        const res = await this.cdp.send<{ object: { objectId?: string } }>(
          "DOM.resolveNode",
          { backendNodeId: node, executionContextId: contextId, objectGroup: GROUP },
          session,
        );
        if (!res.object.objectId) throw new Error("No node found for that number");
        objects.push(res.object.objectId);
      }
      const params = nodes.map((_, n) => `n${n}`);
      const res = await this.cdp.send<Evaluated>(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: `function(${[...params, "...a"].join(", ")}) { return (${fn})(globalThis.__hearth, ${[...params, "...a"].join(", ")}); }`,
          executionContextId: contextId,
          arguments: [
            ...objects.map((objectId) => ({ objectId })),
            ...args.map((value) => ({ value })),
          ],
          returnByValue: byValue,
          awaitPromise: true,
          ...(byValue ? {} : { objectGroup: GROUP }),
        },
        session,
      );
      const err = thrown(res);
      if (err) throw err;
      return res.result ?? {};
    });
  }

  /** The node an expression gives (an element, or null), with its tag and the frame it holds. */
  async nodeOf(session: string | undefined, frameId: string, expression: string) {
    const objectId = await this.handle(session, frameId, expression);
    if (!objectId) return null;
    const d = await this.cdp.send<{
      node: { backendNodeId: number; nodeName: string; frameId?: string };
    }>("DOM.describeNode", { objectId }, session);
    return d.node;
  }

  /** Chrome's numbers for the elements in an array handle, by position. */
  async nodesOf(session: string | undefined, array: string, positions: number[]) {
    const props = await this.cdp.send<{
      result: { name: string; value?: { objectId?: string } }[];
    }>("Runtime.getProperties", { objectId: array, ownProperties: true }, session);
    const byName = new Map(props.result.map((p) => [p.name, p.value?.objectId]));
    const out = new Map<number, number>();
    await Promise.all(
      positions.map(async (n) => {
        const objectId = byName.get(String(n));
        if (!objectId) return;
        const d = await this.cdp
          .send<{ node: { backendNodeId: number } }>("DOM.describeNode", { objectId }, session)
          .catch((err) => {
            if (isGone(err)) return null;
            throw err;
          });
        if (d) out.set(n, d.node.backendNodeId);
      }),
    );
    return out;
  }

  /** Lets go of the page's nodes this step held, so the page can free them. */
  release(): void {
    for (const s of this.used)
      void this.cdp
        .send("Runtime.releaseObjectGroup", { objectGroup: GROUP }, s || undefined)
        .catch(() => {});
    this.used.clear();
  }
}
