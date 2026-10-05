// References to things on a page ("ref_12"), per tab (B1, D52). A ref is Chrome's own number for
// a node, kept here on the server and never written into the page. Reading the page again gives
// the same thing the same ref; a new page drops them all, and the count never goes back, so an old
// ref can't land on something new.

export interface RefEntry {
  ref: string;
  /** The frame session the node is in; undefined for the tab's own. */
  session: string | undefined;
  frameId: string;
  node: number;
  role: string;
  name: string;
}

const key = (session: string | undefined, node: number) => `${session ?? ""}:${node}`;

export class RefMap {
  private next = 1;
  private readonly byKey = new Map<string, RefEntry>();
  private readonly byRef = new Map<string, RefEntry>();

  /** The ref for a node, the same one it had before if it had one. */
  refFor(
    session: string | undefined,
    frameId: string,
    node: number,
    role: string,
    name: string,
  ): string {
    const k = key(session, node);
    const had = this.byKey.get(k);
    if (had) {
      had.role = role;
      had.name = name;
      had.frameId = frameId;
      return had.ref;
    }
    const entry = { ref: `ref_${this.next++}`, session, frameId, node, role, name };
    this.byKey.set(k, entry);
    this.byRef.set(entry.ref, entry);
    return entry.ref;
  }

  get(ref: string): RefEntry | undefined {
    return this.byRef.get(ref);
  }

  of(session: string | undefined, node: number): RefEntry | undefined {
    return this.byKey.get(key(session, node));
  }

  /** A new page in the tab: every ref goes. */
  clear(): void {
    this.byKey.clear();
    this.byRef.clear();
  }

  /** A frame loaded a new page, or a frame's session went: its refs go. */
  drop(match: (e: RefEntry) => boolean): void {
    for (const [k, e] of this.byKey)
      if (match(e)) {
        this.byKey.delete(k);
        this.byRef.delete(e.ref);
      }
  }

  get size(): number {
    return this.byRef.size;
  }
}
