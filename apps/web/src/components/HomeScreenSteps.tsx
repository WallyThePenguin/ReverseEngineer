// The one step an iPhone needs before Hearth can notify it: on the Home Screen, and opened from
// there (lib/alertsHere.ts). Today's "Turn on notifications" shows it, and so does Settings' Phone.

import { Icon } from "./icons.tsx";

export function HomeScreenSteps(props: { class?: string }) {
  return (
    <div class={`rounded-md bg-sunk px-3 py-3 text-sm ${props.class ?? ""}`}>
      <p class="font-medium">To get notifications here, put Hearth on your Home Screen</p>
      <ol class="mt-1 list-decimal space-y-0.5 pl-5 text-muted">
        <li>
          In Safari, tap Share{" "}
          <Icon
            name="share"
            size={14}
            class="inline align-text-bottom"
            label="(a square with an arrow)"
          />
          .
        </li>
        <li>Choose Add to Home Screen, then Add.</li>
        <li>Open Hearth from its new icon, and tap Turn on notifications there.</li>
      </ol>
    </div>
  );
}
