// Types for rules.js, so Hearth's TypeScript (the tests' Chromium) can share the extension's rules.

export const PROTOCOL: number;
export const ALLOWED: Set<string>;
export const DIALOG_SAFE: Set<string>;
export const NAVIGATIONS: Set<string>;

export class HearthError extends Error {
  constructor(code: string, message: string);
  code: string;
}

export function assertWebUrl(url: string): void;
export function checkCommand(
  method: string,
  params: Record<string, unknown>,
  worlds: Set<unknown> | undefined,
): void;

export interface Dialog {
  type: string;
  message: string;
  url: string;
  defaultPrompt?: string;
}

export function dialogOpen(dialog: Dialog): HearthError;

export class Dialogs {
  open: Map<number, Dialog>;
  waiting: Map<number, Set<(err: Error) => void>>;
  get(tabId: number): Dialog | null;
  opened(tabId: number, dialog: Dialog): void;
  closed(tabId: number): void;
  guard<T>(tabId: number, method: string, send: () => Promise<T>): Promise<T>;
}

export function answersItself(dialog: Dialog, tab: { navigating: boolean; own: boolean }): boolean;
