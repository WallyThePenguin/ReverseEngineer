// Phone-sized screens get one pane at a time, a tab bar, and Jarvis full screen.

import { createRoot, createSignal } from "solid-js";

const QUERY = "(max-width: 767px)";

export const narrow = createRoot(() => {
  const media = window.matchMedia(QUERY);
  const [is, setIs] = createSignal(media.matches);
  media.addEventListener("change", (e) => setIs(e.matches));
  return is;
});
