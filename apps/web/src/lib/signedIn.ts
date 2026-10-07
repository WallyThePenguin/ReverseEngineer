// Whether this device was signed in last time, so Hearth draws its frame at once instead of a
// "Loading…" screen while it asks the server who you are. The server still decides: an answer
// that says signed out, or a 401, puts the sign-in screen up and forgets this. Until it has said
// signed in, note bodies (kept on this device) stay closed.

const KEY = "hearth.signed-in";
// A sign-in lasts 30 days from when it was last used (SESSION_DAYS, apps/server/src/auth). A
// device the server hasn't confirmed in that long has likely been signed out there: ask first.
const FRESH_MS = 30 * 86_400_000;

export function wasSignedIn(now = Date.now()): boolean {
  try {
    // When the server last said so. Before this was kept it was "1", which is long gone.
    const at = Number(localStorage.getItem(KEY));
    return at > 0 && now - at < FRESH_MS;
  } catch {
    // Storage turned off (a private window): ask the server first, as before.
    return false;
  }
}

let confirm = () => {};
let confirmed = new Promise<void>((resolve) => {
  confirm = resolve;
});
let answered = false;

/** Resolves once the server has said this device is signed in, not just the guess. */
export const signInConfirmed = () => confirmed;

/** The server's answer: signed in (from now), or signed out. */
export function rememberSignedIn(on: boolean): void {
  if (on) {
    answered = true;
    confirm();
  } else if (answered) {
    answered = false;
    confirmed = new Promise((resolve) => {
      confirm = resolve;
    });
  }
  try {
    if (on) localStorage.setItem(KEY, String(Date.now()));
    else localStorage.removeItem(KEY);
  } catch {}
}

/**
 * Whether to draw Hearth rather than sign-in: the server's answer once there is one, and until
 * then, whether this device was signed in lately. That holds while Hearth can't be reached too,
 * so what's on screen stays, under the notice, for when it can.
 */
export function showHearth(answer: { signedIn: boolean } | undefined): boolean {
  if (answer) return answer.signedIn;
  return wasSignedIn();
}
