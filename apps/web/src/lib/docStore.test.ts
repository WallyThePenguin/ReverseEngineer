// What makes writing ahead safe (D59): an edit counts as written only once it's flushed to disk,
// not when the OS has it, since Hearth may get it next and this device's peer goes on from it.
// Runs against a small in-memory stand-in for IndexedDB that records how each write was asked for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Each transaction: the stores it covers, its mode and the durability it asked for. */
let txs: { stores: string[]; mode: string; durability?: string }[] = [];

function fakeIndexedDB() {
  const data = new Map<string, Map<unknown, unknown>>();
  const request = <T>(result: T) => {
    const req = { result, onsuccess: null as null | (() => void) };
    setTimeout(() => req.onsuccess?.());
    return req;
  };
  const store = (name: string) => ({
    indexNames: { contains: () => true },
    createIndex() {},
    put: (v: { slot?: unknown }) => request(data.get(name)!.set(v.slot ?? v, v)),
    get: (k: unknown) => request(data.get(name)!.get(k)),
    delete: (k: unknown) => request(data.get(name)!.delete(k)),
  });
  const db = {
    objectStoreNames: { contains: (n: string) => data.has(n) },
    createObjectStore(n: string) {
      data.set(n, new Map());
      return store(n);
    },
    transaction(stores: string[], mode: string, opts?: { durability?: string }) {
      txs.push({ stores, mode, durability: opts?.durability });
      const tx = {
        oncomplete: null as null | (() => void),
        objectStore: store,
      };
      setTimeout(() => setTimeout(() => tx.oncomplete?.()));
      return tx;
    },
  };
  return {
    open() {
      const req = {
        result: db,
        transaction: { objectStore: store },
        onupgradeneeded: null as null | (() => void),
        onsuccess: null as null | (() => void),
      };
      setTimeout(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

beforeEach(() => {
  txs = [];
  vi.stubGlobal("indexedDB", fakeIndexedDB());
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

describe("writing a note's edits ahead", () => {
  it("counts an edit as written only once it's flushed to disk", async () => {
    const { appendUpdate } = await import("./docStore.ts");
    const u = { doc: "n1", tab: "t", n: 1, data: new Uint8Array([1]) };
    expect(await appendUpdate(u)).toBe(true);
    expect(txs.find((t) => t.stores.includes("updates"))).toMatchObject({
      mode: "readwrite",
      durability: "strict",
    });
  });

  it("retires a peer on disk at once too", async () => {
    const { peerFor, retirePeer } = await import("./docStore.ts");
    expect(await peerFor(0)).not.toBeNull();
    await retirePeer(0);
    expect(txs.filter((t) => t.stores.includes("peers")).at(-1)).toMatchObject({
      mode: "readwrite",
      durability: "strict",
    });
  });
});
