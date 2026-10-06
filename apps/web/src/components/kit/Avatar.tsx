// A person's initials on a quiet tint, the same tint for them on every screen (lib/avatar.ts).
// Never a sub-product's colour, and never a photo: nothing is fetched, and it's more private.

import { Show } from "solid-js";
import { initials, tintOf } from "../../lib/avatar.ts";

/** Written out whole, so Tailwind finds each class. */
const TINT = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
  "bg-avatar-7",
  "bg-avatar-8",
];

/** The letters' size for each avatar size: a row's, a header's, a person's page. */
const TEXT: Record<number, string> = {
  20: "text-micro",
  24: "text-micro",
  32: "text-meta font-medium",
  40: "text-sm font-medium",
  56: "text-title",
};

export function Avatar(props: {
  name?: string | null;
  email?: string | null;
  /** 24 in a row by default; 32 in a header, 56 on a person's page. */
  size?: 20 | 24 | 32 | 40 | 56;
  /** Says who it is, for an avatar with no name beside it. */
  label?: string;
  class?: string;
}) {
  const size = () => props.size ?? 24;
  return (
    <>
      <span
        aria-hidden="true"
        class={`inline-flex shrink-0 select-none items-center justify-center rounded-full text-ink ${TINT[tintOf(props.email || props.name || "")]} ${TEXT[size()]} ${props.class ?? ""}`}
        style={{ width: `${size()}px`, height: `${size()}px` }}
      >
        {initials(props.name, props.email)}
      </span>
      <Show when={props.label}>
        <span class="sr-only">{props.label}</span>
      </Show>
    </>
  );
}
