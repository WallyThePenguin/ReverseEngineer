// The mail list a page at a time: the newest conversations first, and older ones as you scroll
// (or move with j) down to them. Each page starts after the last one shown, by its time and id,
// so mail arriving meanwhile doesn't skip or repeat any.

import { createInfiniteQuery } from "@tanstack/solid-query";
import { action } from "../lib/api.ts";
import type { MailThread } from "../lib/types.ts";

/** Conversations per page. */
export const PAGE = 50;

interface Cursor {
  before?: string;
  beforeId?: string;
}

export function useThreadPages(input: () => Record<string, unknown>, enabled: () => boolean) {
  const query = createInfiniteQuery(() => ({
    queryKey: ["mail.threads", input()],
    queryFn: ({ queryKey, pageParam }: { queryKey: unknown[]; pageParam: Cursor }) =>
      action<MailThread[]>("mail.threads", { ...(queryKey[1] as object), ...pageParam }),
    initialPageParam: {} as Cursor,
    getNextPageParam: (last: MailThread[]): Cursor | undefined => {
      const end = last.at(-1);
      // Lists in order of how long they've waited come whole, up to their limit.
      if (!end || last.length < PAGE || input().waiting) return undefined;
      return { before: end.lastMessageAt, beforeId: end.id };
    },
    enabled: enabled(),
  }));
  /** Every page loaded, in order, each conversation once. */
  const list = (): MailThread[] => {
    const seen = new Set<string>();
    return (query.data?.pages ?? []).flat().filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  };
  const more = () => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  };
  return { query, list, more };
}

/** Loads more when `el` (the end of the list) scrolls into view, or close to it. */
export function whenSeen(el: HTMLElement, run: () => void): () => void {
  let io: IntersectionObserver | undefined;
  // Once it's on the page, so the list it scrolls in can be found.
  const frame = requestAnimationFrame(() => {
    io = new IntersectionObserver((seen) => seen.some((e) => e.isIntersecting) && run(), {
      root: el.closest<HTMLElement>(".overflow-auto"),
      rootMargin: "400px",
    });
    io.observe(el);
  });
  return () => {
    cancelAnimationFrame(frame);
    io?.disconnect();
  };
}
