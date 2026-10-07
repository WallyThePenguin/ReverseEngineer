// Sign in with a passkey (Windows Hello, Touch ID, your phone). The first time, enter the code
// `hearth setup` printed to add your first passkey. The desktop app's window on this PC signs in
// with a Windows Hello passkey of its own once you've added one there, or else from your browser
// (D53, D69): it never shows a passkey button that can't work where it is.

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { createSignal, Match, Show, Switch } from "solid-js";
import { authPost } from "../lib/api.ts";
import { inDesktopApp } from "../lib/desktop.ts";
import { connectLink, wayIn } from "../lib/wayIn.ts";

const BUTTON = "w-full rounded-md bg-accent px-3 py-2 font-medium text-on-fill disabled:opacity-50";

export function Login(props: {
  needsSetup: boolean;
  origin?: string;
  localPasskey?: boolean;
  onSignedIn: () => void;
}) {
  const [code, setCode] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  // Windows Hello didn't work in the window: the browser is offered too.
  const [helloFailed, setHelloFailed] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const way = () => wayIn(location, props);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      props.onSignedIn();
    } catch (err) {
      const e = err as Error;
      if (way() === "hello") {
        setHelloFailed(true);
        setError(
          e.name === "NotAllowedError"
            ? "Windows Hello was closed, or couldn't open in this window. Try again, or connect from your browser."
            : `Windows Hello didn't work here: ${e.message}`,
        );
        return;
      }
      setError(
        e.name === "NotAllowedError"
          ? "The passkey prompt was closed. Try again."
          : e.name === "SecurityError"
            ? "Your passkey only works at Hearth's own address, not this one."
            : e.message,
      );
    } finally {
      setBusy(false);
    }
  };

  const register = () =>
    run(async () => {
      const options = await authPost<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
        "register/options",
        {
          setupCode: code(),
        },
      );
      const response = await startRegistration({ optionsJSON: options });
      await authPost("register/verify", {
        response,
        setupCode: code(),
        label: navigator.platform || "Passkey",
      });
    });

  const login = () =>
    run(async () => {
      const options =
        await authPost<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("login/options");
      const response = await startAuthentication({ optionsJSON: options });
      await authPost("login/verify", { response });
    });

  // In the app, Windows opens your browser at Settings, Desktop app; elsewhere, this page goes there.
  const toBrowser = () => {
    if (!props.origin) return;
    setSent(true);
    location.href = inDesktopApp() ? connectLink(props.origin) : props.origin;
  };
  const browserButton = (primary: boolean) => (
    <button
      type="button"
      class={
        primary
          ? BUTTON
          : "w-full rounded-md border border-line px-3 py-2 font-medium hover:bg-sunk"
      }
      onClick={toBrowser}
    >
      {inDesktopApp() ? "Connect in your browser" : "Go to Hearth's address"}
    </button>
  );

  return (
    <div class="flex h-full items-center justify-center p-6">
      <div class="w-full max-w-sm space-y-5 rounded-xl border border-line bg-panel p-6 shadow-sm">
        <div>
          <h1 class="text-xl font-semibold">Hearth</h1>
          <p class="text-sm text-muted">
            {props.needsSetup
              ? "Welcome. Add a passkey to get started."
              : "Your workspace, with Jarvis."}
          </p>
        </div>
        <Switch>
          <Match when={props.needsSetup}>
            <form
              class="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void register();
              }}
            >
              <label class="block space-y-1">
                <span class="text-sm">
                  Setup code from <code class="font-mono">hearth setup</code>
                </span>
                <input
                  class="w-full rounded-md border border-line bg-panel px-3 py-2 font-mono tracking-widest uppercase outline-none focus:border-accent"
                  value={code()}
                  onInput={(e) => setCode(e.currentTarget.value)}
                  autocomplete="one-time-code"
                  autofocus
                />
              </label>
              <button type="submit" class={BUTTON} disabled={busy() || code().trim().length < 6}>
                Create passkey
              </button>
            </form>
          </Match>
          <Match when={way() === "passkey"}>
            <button type="button" class={BUTTON} disabled={busy()} onClick={() => void login()}>
              Sign in with your passkey
            </button>
          </Match>
          <Match when={way() === "hello"}>
            <div class="space-y-2">
              <button type="button" class={BUTTON} disabled={busy()} onClick={() => void login()}>
                Sign in with Windows Hello
              </button>
              <Show when={helloFailed()}>{browserButton(false)}</Show>
            </div>
          </Match>
          <Match when={way() === "browser"}>
            <div class="space-y-3">
              <p class="text-sm text-muted">
                {inDesktopApp()
                  ? "This window was signed out. Your passkeys work at Hearth's own address, so sign it in from your browser: Settings, Desktop app, Connect Hearth on this PC. After that you can add Windows Hello here, in Settings, Passkeys."
                  : "Your passkeys work at Hearth's own address, not this one."}
              </p>
              {browserButton(true)}
            </div>
          </Match>
        </Switch>
        <Show when={error()}>
          <p class="text-sm text-bad">{error()}</p>
        </Show>
        <Show when={sent() && inDesktopApp()}>
          <p class="text-sm text-muted">
            Your browser opens Hearth's Settings. Choose Connect Hearth on this PC there.
          </p>
        </Show>
      </div>
    </div>
  );
}
