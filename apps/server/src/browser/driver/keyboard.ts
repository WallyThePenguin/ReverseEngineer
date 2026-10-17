// The keyboard and forms (B1, D52): typing as keystrokes, into a ref or whatever has focus (in a
// frame from another site too); keys and combinations, judged like clicks; setting a list, a box,
// a date or a slider; and the press browser_submit makes once the owner says yes.
import { isPaste, keyRefusal, parseKeys } from "@hearth/modules/driver-kit";
import type { DriverContext } from "./context.ts";
import { fail } from "./errors.ts";
import { click, pressCombo, typeText } from "./input.ts";
import { centerOf, checkName, entryOf, hitAt, reaches, type Target } from "./locate.ts";
import { aimRef, assertMayPress, type Inspect, inspect } from "./pointer.ts";

const NO_PASSWORDS = "Passwords are typed only by browser_sign_in, from the owner's vault.";
const NO_CARDS = "Card and bank details are never Pip's to type; the owner types those.";

/** What has the keyboard's focus, followed into frames (from other sites too). */
export async function focused(d: DriverContext): Promise<Target | null> {
  await d.seed();
  let session: string | undefined;
  let frameId = d.tab.mainFrame ?? "";
  for (let depth = 0; depth < 6; depth++) {
    const node = await d.worlds.nodeOf(session, frameId, "__hearth.active()");
    if (!node) return null;
    if (!/^(IFRAME|FRAME)$/i.test(node.nodeName) || !node.frameId)
      return { session, frameId, node: node.backendNodeId };
    const child = d.tab.sessionOf(node.frameId);
    if (child) d.tab.owners.set(node.frameId, { session, node: node.backendNodeId });
    session = child ?? session;
    frameId = node.frameId;
  }
  return null;
}

function assertTypeable(info: Inspect, what: string): void {
  if (info.password) throw fail("refused", NO_PASSWORDS);
  if (info.card) throw fail("refused", NO_CARDS);
  if (!info.editable)
    throw fail("invalid", `${what} is a ${info.kind}, not something to type into.`);
  if (info.disabled) throw fail("disabled", `"${info.label || what}" is disabled right now.`);
}

/** Puts the cursor in a ref's field: focus, or a real click on it when focus alone won't. */
async function focusRef(d: DriverContext, t: Target, ref: string, clear: boolean): Promise<void> {
  const fn = `(h, el, clear) => h.focus(el, clear)`;
  if (await d.worlds.call<boolean>(t.session, t.frameId, [t.node], fn, [clear])) return;
  const at = await centerOf(d, t);
  if (at) {
    const hit = await hitAt(d, at.x, at.y);
    if ((await reaches(d, t, hit)).ok)
      await click(d.cdp, at.x, at.y, { still: () => d.assertStill() });
  }
  if (!(await d.worlds.call<boolean>(t.session, t.frameId, [t.node], fn, [clear])))
    throw fail(
      "covered",
      `Couldn't put the cursor in ${ref}. Click it first, or read the page again.`,
    );
}

export async function typeStep(
  d: DriverContext,
  i: { text: string; ref?: string; clear?: boolean },
) {
  let where: string;
  if (i.ref) {
    const e = entryOf(d, i.ref);
    await checkName(d, e);
    const t = { session: e.session, frameId: e.frameId, node: e.node };
    const info = await inspect(d, t, "enter");
    assertTypeable(info, i.ref);
    await focusRef(d, t, i.ref, i.clear ?? true);
    where = `"${info.label || e.name || i.ref}" (${i.ref})`;
  } else {
    const t = await focused(d);
    if (!t)
      throw fail(
        "invalid",
        "Nothing has the keyboard's focus. Give a ref, or click into the field first.",
      );
    const info = await inspect(d, t, "enter");
    assertTypeable(info, "What has focus");
    where = `"${info.label || info.kind}"`;
  }
  await typeText(d.cdp, i.text, () => d.assertStill());
  return `Typed ${i.text.length} characters into ${where}`;
}

const MOVES = new Set([
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "PageDown",
  "PageUp",
  "Home",
  "End",
]);

export async function keyStep(d: DriverContext, i: { keys: string; repeat?: number }) {
  const combos = parseKeys(i.keys);
  const repeat = i.repeat ?? 1;
  if (combos.length * repeat > 200)
    throw fail("invalid", "That's too many presses at once (200 at most).");
  if (combos.some(isPaste))
    throw fail(
      "refused",
      "Pasting isn't allowed: it would send whatever is on the owner's clipboard. Type the text with browser_type.",
    );
  const done: string[] = [];
  for (let r = 0; r < repeat; r++)
    for (const c of combos) {
      const sensitive =
        ["Enter", " ", "Delete"].includes(c.key.key) || Boolean(c.key.text) || MOVES.has(c.key.key);
      if (sensitive) {
        const t = await focused(d);
        const a = t ? await inspect(d, t, "enter") : null;
        const url = t ? await d.frameUrl(t.session, t.frameId) : d.url();
        const active = a
          ? {
              kind: a.kind,
              label: a.label,
              editable: a.editable,
              password: a.password,
              card: a.card,
              enter: a.enter,
              click: a.click,
            }
          : { kind: null, editable: false };
        const no = keyRefusal(c, active, d.trusted(/^https?:/.test(url) ? url : d.url()));
        if (no)
          throw fail(
            /Passwords|Card/.test(no) ? "refused" : "would_send",
            done.length ? `${no} (Already pressed: ${done.join(", ")}.)` : no,
          );
      }
      d.assertStill(done);
      const stopped = await pressCombo(d.cdp, c);
      done.push(c.name);
      if (stopped) return `Pressed ${done.join(", ")}; a dialog opened`;
    }
  return `Pressed ${done.join(", ")}`;
}

export async function formInputStep(d: DriverContext, i: { ref: string; value: string }) {
  const e = entryOf(d, i.ref);
  await checkName(d, e);
  const t = { session: e.session, frameId: e.frameId, node: e.node };
  const info = await inspect(d, t, "click");
  const name = info.label || e.name || i.ref;
  if (info.password) throw fail("refused", NO_PASSWORDS);
  if (info.card) throw fail("refused", NO_CARDS);
  if (info.disabled) throw fail("disabled", `"${name}" is disabled right now.`);
  // Changing a switch, or a box outside any form, can change something at once.
  if (/checkbox|radio|select/.test(info.kind) || info.click.sends)
    await assertMayPress(d, t, info.click, `Changing "${name}"`);
  const res = await d.worlds.call<{ error?: string; now?: string }>(
    t.session,
    t.frameId,
    [t.node],
    "(h, el, v) => h.setValue(el, v)",
    [i.value],
  );
  if (res.error) throw fail("invalid", res.error);
  return { did: `Set "${name}" (${i.ref})`, now: res.now ?? "" };
}

/** What pressing a ref would send: the page and its form's fields (browser_submit's card). */
export async function probeStep(d: DriverContext, ref: string) {
  const e = entryOf(d, ref);
  return d.worlds.call<{ url: string; fields: { label: string; value: string }[] }>(
    e.session,
    e.frameId,
    [e.node],
    "(h, el) => h.form(el)",
  );
}

/** The press browser_submit makes with the owner's yes: by name as read, then Enter or a click. */
export async function pressStep(
  d: DriverContext,
  i: { ref: string; label: string; sends?: unknown },
) {
  const e = entryOf(d, i.ref);
  await checkName(d, e);
  const t = { session: e.session, frameId: e.frameId, node: e.node };
  const info = await inspect(d, t, "click");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (norm(info.label || e.name) !== norm(i.label) && norm(e.name) !== norm(i.label))
    throw fail(
      "changed",
      `The page changed: ${i.ref} is now "${info.label || e.name}", not "${i.label}". Nothing was pressed.`,
    );
  if (
    i.sends !== undefined &&
    JSON.stringify(await probeStep(d, i.ref)) !== JSON.stringify(i.sends)
  )
    throw fail(
      "changed",
      "The page or what it would send changed since this was asked. Nothing was pressed.",
    );
  if (info.editable) {
    await focusRef(d, t, i.ref, false);
    d.assertStill();
    await pressCombo(d.cdp, parseKeys("Enter")[0]!);
  } else {
    const { center } = await aimRef(d, i.ref, false);
    const hit = await hitAt(d, center.x, center.y);
    if (!(await reaches(d, t, hit)).ok)
      throw fail("covered", `Something covers ${i.ref}. Nothing was pressed.`);
    await click(d.cdp, center.x, center.y, { still: () => d.assertStill() });
  }
  return `Pressed "${info.label || e.name}" (${i.ref})`;
}
