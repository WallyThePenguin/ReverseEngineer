// What Cmd+K lists for what's typed, in order: a command named by what you typed comes first
// ("settings" → Go to Settings), then the records found, then other commands, then asking
// Jarvis or making a task. Records found for something typed earlier are never listed. With
// nothing typed, the few things you do most come first, then what you opened lately.

export interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  run: (beside: boolean) => void | Promise<void>;
}

/** A command's name without its verb: "Go to the trash (…)" → "trash (…)". */
const nameOf = (label: string) => label.toLowerCase().replace(/^go to (the )?/, "");

export function arrange(opts: {
  /** What's typed, trimmed. */
  query: string;
  /** What you do most (Today, New task…): first when nothing's typed, a command like any other
   * once something is. */
  top?: PaletteItem[];
  commands: PaletteItem[];
  /** Records found, and what was typed when they were found. */
  records: { query: string; list: PaletteItem[] };
  /** Asking Jarvis and the like, offered once something's typed. */
  extra: PaletteItem[];
}): PaletteItem[] {
  const q = opts.query.toLowerCase();
  const top = opts.top ?? [];
  const records = opts.records.query === opts.query ? opts.records.list : [];
  if (!q) return [...top, ...records, ...opts.commands.slice(0, 12 - top.length)];
  const commands = [...top, ...opts.commands];
  const named = commands.filter((c) => nameOf(c.label).startsWith(q));
  const others = commands.filter((c) => !named.includes(c) && c.label.toLowerCase().includes(q));
  return [...named, ...records, ...others.slice(0, Math.max(0, 4 - named.length)), ...opts.extra];
}
