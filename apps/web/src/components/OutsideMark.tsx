// The mark on text that may carry outside content (an email, a web page): other people's words,
// which Jarvis treats with care, so you can too (D58). It says so in words and with its icon,
// with the why on hover, as a conversation's "Read outside content" does.

import type { JSX } from "solid-js";
import { Pill } from "./kit/Pill.tsx";

export function OutsideMark(props: { children: JSX.Element; class?: string }) {
  return (
    <Pill
      tone="warn"
      class={props.class}
      title="Some of this comes from outside Nook, such as an email or a web page: other people's words, not Pip's. Pip checks with you before acting on anything that read it."
    >
      {props.children}
    </Pill>
  );
}
