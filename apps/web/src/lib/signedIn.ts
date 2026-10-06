// Whether this device was signed in last time, so Hearth draws its frame at once instead of a
// "Loading…" screen while it asks the server who you are. The server still decides: an answer
// that says signed out, or a 401, puts the sign-in screen up and forgets this.

const KEY = "hearth.signed-in";

export function wasSignedIn(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // Storage turned off (a private window): ask the server first, as before.
    return false;
  }
}

export function rememberSignedIn(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {}
}

/**
 * Whether to draw Hearth rather than sign-in: the server's answer once there is one, and until
 * then, whether this device was signed in last time.
 */
export function showHearth(answer: { signedIn: boolean } | undefined, asking: boolean): boolean {
  if (answer) return answer.signedIn;
  return asking && wasSignedIn();
}
