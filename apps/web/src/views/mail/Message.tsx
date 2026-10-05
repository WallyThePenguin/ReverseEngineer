// One message in an email conversation: who it's from, then, opened, its invitation, its body and
// its attachments. HTML mail is shown in a sandboxed frame that runs no scripts and loads nothing
// from the internet (so senders can't see you opened it) until you ask for images.

import { createSignal, For, Show } from "solid-js";
import { ago } from "../../lib/format.ts";
import type { MailAddress, MailMessage } from "../../lib/types.ts";
import { named } from "../Mail.tsx";
import { InviteCard } from "./InviteCard.tsx";

const list = (xs: MailAddress[]) =>
  xs.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");

/** An HTML message in its own frame, sized to fit. The frame runs no scripts. */
function HtmlBody(props: { id: string; text: string }) {
  const [images, setImages] = createSignal(false);
  const [remote, setRemote] = createSignal(false);
  const [missing, setMissing] = createSignal(false);
  let frame: HTMLIFrameElement | undefined;
  const loaded = () => {
    const doc = frame?.contentDocument;
    if (!frame || !doc?.body || doc.location.href === "about:blank") return;
    const meta = doc.querySelector('meta[name="hearth-remote-images"]');
    if (!meta) {
      // Not the message page: its original couldn't be had, here or from the mail service.
      setMissing(true);
      return;
    }
    frame.style.height = `${Math.min(doc.documentElement.scrollHeight + 4, 20000)}px`;
    setRemote(meta.getAttribute("content") === "1");
  };
  return (
    <div class="space-y-2">
      <Show when={missing()}>
        <p class="text-xs text-muted">
          The original of this message isn't available, so here's its text.
        </p>
        <pre class="whitespace-pre-wrap font-sans text-sm">{props.text}</pre>
      </Show>
      <Show when={remote() && !images() && !missing()}>
        <p class="text-xs text-muted">
          Pictures from the internet are hidden, so the sender can't tell you opened this.{" "}
          <button type="button" class="underline" onClick={() => setImages(true)}>
            Show them
          </button>
        </p>
      </Show>
      {/* No scripts: same-origin only lets Hearth measure the height. */}
      <iframe
        ref={frame}
        title="Message"
        class="w-full rounded-md border border-line bg-white"
        classList={{ hidden: missing() }}
        style={{ height: "120px" }}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        src={`/api/mail/frame/${props.id}${images() ? "?images=1" : ""}`}
        onLoad={loaded}
      />
    </div>
  );
}

export function Message(props: { m: MailMessage; open: boolean; onToggle: () => void }) {
  const files = () => props.m.attachments.filter((a) => !a.inline);
  return (
    <article class="rounded-lg border border-line">
      <button
        type="button"
        class="flex w-full items-baseline gap-3 px-4 py-2 text-left"
        onClick={props.onToggle}
      >
        <span class="font-medium">{props.m.outbound ? "You" : named(props.m.from)}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-muted">
          <Show
            when={!props.open}
            fallback={
              <>
                to {list(props.m.to)}
                {props.m.cc.length ? `, cc ${list(props.m.cc)}` : ""}
              </>
            }
          >
            {props.m.text.slice(0, 140)}
          </Show>
        </span>
        <span class="shrink-0 text-xs text-faint" title={new Date(props.m.sentAt).toLocaleString()}>
          {ago(props.m.sentAt)}
        </span>
      </button>
      <Show when={props.open}>
        <div class="space-y-3 px-4 pb-4">
          <Show when={props.m.invite}>{(i) => <InviteCard invite={i()} />}</Show>
          <Show
            when={props.m.hasHtml}
            fallback={<pre class="whitespace-pre-wrap font-sans text-sm">{props.m.text}</pre>}
          >
            <HtmlBody id={props.m.id} text={props.m.text} />
          </Show>
          <Show when={files().length > 0}>
            <ul class="flex flex-wrap gap-2 text-xs">
              <For each={files()}>
                {(a) => (
                  <li class="rounded border border-line bg-sunk px-2 py-1">
                    <a href={`/api/mail/attachment/${props.m.id}/${a.index}`} download={a.filename}>
                      📎 {a.filename}
                    </a>{" "}
                    <span class="text-faint">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </article>
  );
}
