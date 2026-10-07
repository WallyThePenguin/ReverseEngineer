// A box or a choice that saves as you change it shows what's saved: when the change doesn't go
// through, it goes back. A list read again keeps its unchanged rows as they were
// (keepUnchanged.ts), so nothing else would put it back, and the next tick would ask for the
// opposite of what it shows.

/**
 * Waits for `saving` (an `act`, which is null when it didn't go through, or a save that says
 * false), and if it didn't go through, puts `el` back to `saved()`: ticked or not, or the choice.
 */
export async function orBack<T>(
  el: HTMLInputElement | HTMLSelectElement,
  saving: Promise<T>,
  saved: () => boolean | string,
): Promise<T> {
  const r = await saving;
  if (r === null || r === false) {
    const was = saved();
    if (typeof was === "boolean") (el as HTMLInputElement).checked = was;
    else el.value = was;
  }
  return r;
}
