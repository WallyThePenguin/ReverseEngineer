// A box or a choice that saves as you change it shows what's saved: when the change doesn't go
// through, it goes back. A list read again keeps its unchanged rows as they were
// (keepUnchanged.ts), so nothing else would put it back, and the next tick would ask for the
// opposite of what it shows.

type Control = HTMLInputElement | HTMLSelectElement;

/** A box that's ticked or not, rather than a value. */
const ticks = (el: Control) => el.type === "checkbox" || el.type === "radio";
/** What it shows: ticked or not, or its value. */
const shows = (el: Control) => (ticks(el) ? (el as HTMLInputElement).checked : el.value);

/**
 * Waits for `saving` (an `act`, which is null when it didn't go through, or a save that says
 * false), and if it didn't go through, puts `el` back to `saved()`: ticked or not, or the choice.
 * Not when it has changed since (a second choice, more typed: the next save carries that), or
 * while you're typing in it.
 */
export async function orBack<T>(
  el: Control,
  saving: Promise<T>,
  saved: () => boolean | string,
): Promise<T> {
  const sent = shows(el);
  const r = await saving;
  const typing = el.tagName === "INPUT" && !ticks(el) && el.ownerDocument?.activeElement === el;
  if ((r === null || r === false) && shows(el) === sent && !typing) {
    const was = saved();
    if (typeof was === "boolean") (el as HTMLInputElement).checked = was;
    else el.value = was;
  }
  return r;
}
