// A screen that loads its code the first time it's opened (lazyViews.ts), with a skeleton while it
// does. An update replaces those files, so a page from before it can't fetch them any more: then
// it reloads into the new Hearth by itself, once and only when that loses nothing, and otherwise
// the pane says why (PaneCrashed) and tries again from scratch when asked, unlike Solid's lazy(),
// which keeps a failed load for good.

import { type Component, createComponent, createResource, type JSX, Show } from "solid-js";
import { Skeleton } from "../components/kit/Skeleton.tsx";
import {
  afterLoadFailed,
  pageBuild,
  reloadedFor,
  reloadInto,
  reloadPage,
  type ServerBuild,
  tryAgainBy,
  wouldLoseWork,
} from "../lib/version.ts";

/** Why a screen's code couldn't be loaded: Hearth was updated, or the PC didn't answer. */
export class ViewLoadError extends Error {
  constructor(readonly why: "updated" | "offline") {
    super(why === "updated" ? "Hearth was updated" : "Couldn't load this screen");
  }
}

async function runningBuild(): Promise<ServerBuild | null> {
  try {
    const res = await fetch("/api/health/deep", { cache: "no-store" });
    return res.ok ? ((await res.json()) as ServerBuild) : null;
  } catch {
    return null;
  }
}

/**
 * Loads a screen's code, or reloads into the new Hearth, or says why it can't (ViewLoadError).
 * Cmd+K's New note and the like load their screen's code this way too.
 */
export async function loadCode<T>(get: () => Promise<T>): Promise<T> {
  try {
    return await get();
  } catch (err) {
    console.error(err);
    const next = afterLoadFailed(pageBuild(), await runningBuild(), reloadedFor(), wouldLoseWork);
    if ("why" in next) throw new ViewLoadError(next.why);
    reloadInto(next.reload);
    // The page is going; the skeleton stays until it has.
    return new Promise<T>(() => {});
  }
}

/** "Try again" on a screen the PC didn't send: reloads once it answers (tryAgainBy). */
export async function tryAgain(reset: () => void): Promise<void> {
  if (tryAgainBy(await runningBuild(), wouldLoseWork) === "reload") reloadPage();
  else reset();
}

function Loading() {
  return (
    <div class="p-4">
      <Skeleton kind="record" count={5} />
    </div>
  );
}

/** A screen whose code loads when it's first opened. */
export function view<P extends object>(get: () => Promise<Component<P>>): Component<P> {
  let loaded: Component<P> | undefined;
  return (props: P): JSX.Element => {
    if (loaded) return createComponent(loaded, props);
    // A new try each time it's drawn, so the pane's "Try again" fetches it afresh.
    const [code] = createResource(() =>
      loadCode(get).then((c) => {
        loaded = c;
        return c;
      }),
    );
    return (
      <Show when={code()} fallback={<Loading />}>
        {(c) => createComponent(c(), props)}
      </Show>
    );
  };
}
