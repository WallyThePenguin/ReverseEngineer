// Sign in with a passkey (Windows Hello, Touch ID, your phone). The first time, enter the code
// `hearth setup` printed to add your first passkey.

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { createSignal, Show } from "solid-js";
import { authPost } from "../lib/api.ts";
import { inDesktopApp } from "../lib/desktop.ts";

export function Login(props: { needsSetup: boolean; onSignedIn: () => void }) {
  const [code, setCode] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      props.onSignedIn();
    } catch (err) {
      const e = err as Error;
      setError(
        e.name === "NotAllowedError"
          ? "The passkey prompt was closed. Try again."
          : // Opened at another address, like the Windows app's window at localhost (D53).
            e.name === "SecurityError"
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
        <Show
          when={props.needsSetup}
          fallback={
            <button
              type="button"
              class="w-full rounded-md bg-accent px-3 py-2 font-medium text-white disabled:opacity-50"
              disabled={busy()}
              onClick={() => void login()}
            >
              Sign in with your passkey
            </button>
          }
        >
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
            <button
              type="submit"
              class="w-full rounded-md bg-accent px-3 py-2 font-medium text-white disabled:opacity-50"
              disabled={busy() || code().trim().length < 6}
            >
              Create passkey
            </button>
          </form>
        </Show>
        <Show when={error()}>
          <p class="text-sm text-bad">{error()}</p>
        </Show>
        {/* Passkeys belong to Hearth's own address, so the Windows app signs in by hand-off (D53). */}
        <Show when={!props.needsSetup && inDesktopApp()}>
          <p class="text-sm text-muted">
            Passkey not working here? Open Hearth in your browser, go to Settings, Desktop app, and
            choose Connect Hearth on this PC.
          </p>
        </Show>
      </div>
    </div>
  );
}
