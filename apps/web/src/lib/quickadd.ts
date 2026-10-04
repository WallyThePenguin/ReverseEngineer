// Quick-add boxes (a new task, a subtask, a person): what you typed is taken and the box cleared
// before Hearth answers, so what you type next starts a new entry instead of joining this one.

/**
 * Sends the box's text. The box is empty while it's on its way; if it fails, the text comes back,
 * unless you've started typing something else meanwhile. Returns the result, or null.
 */
export async function quickAdd<T>(
  box: { get: () => string; set: (text: string) => void },
  send: (text: string) => Promise<T | null>,
): Promise<T | null> {
  const text = box.get().trim();
  if (!text) return null;
  box.set("");
  const made = await send(text);
  if (made === null && !box.get().trim()) box.set(text);
  return made;
}
