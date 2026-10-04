// Files Hearth keeps on disk by the hash of their contents, like the raw text of every email, so
// a message can be read again later without asking the provider, and the same bytes are kept once.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The kernel service name: ctx.service<BlobStore>(BLOB_SERVICE). */
export const BLOB_SERVICE = "blobs";

const HOUR_MS = 3600_000;

export class BlobStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private path(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Not a blob hash");
    return join(this.dir, hash.slice(0, 2), hash.slice(2));
  }

  /** Saves bytes and returns their hash. Saving the same bytes twice keeps one copy. */
  async put(data: Buffer): Promise<string> {
    const hash = createHash("sha256").update(data).digest("hex");
    const file = this.path(hash);
    if (await stat(file).catch(() => null)) {
      // Marked as just used, so a sweep running alongside leaves it be.
      const now = new Date();
      await utimes(file, now, now).catch(() => {});
      return hash;
    }
    await mkdir(join(this.dir, hash.slice(0, 2)), { recursive: true });
    // Written beside it first, so a crash never leaves half a file under the real name.
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, data);
    await rename(temp, file);
    return hash;
  }

  /** The bytes for a hash, or null if they aren't here. */
  async get(hash: string): Promise<Buffer | null> {
    return readFile(this.path(hash)).catch(() => null);
  }

  /** Whether the bytes for a hash are here. */
  async has(hash: string): Promise<boolean> {
    return Boolean(await stat(this.path(hash)).catch(() => null));
  }

  /**
   * Deletes what nothing keeps, once it's older than `graceMs`: a file another process just
   * saved, for a record not written yet, stays. Returns how many went.
   */
  async sweep(keep: Set<string>, graceMs = HOUR_MS, now = Date.now()): Promise<number> {
    let removed = 0;
    const folders = await readdir(this.dir).catch(() => [] as string[]);
    for (const folder of folders) {
      if (!/^[0-9a-f]{2}$/.test(folder)) continue;
      for (const name of await readdir(join(this.dir, folder)).catch(() => [] as string[])) {
        const file = join(this.dir, folder, name);
        const hash = `${folder}${name}`;
        if (/^[0-9a-f]{64}$/.test(hash) && keep.has(hash)) continue;
        const info = await stat(file).catch(() => null);
        if (!info?.isFile() || now - info.mtimeMs < graceMs) continue;
        await rm(file, { force: true }).catch(() => {});
        removed++;
      }
    }
    return removed;
  }
}

/** The store under Hearth's data folder. */
export function blobsFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStore {
  return new BlobStore(join(env.HEARTH_DATA_DIR ?? process.cwd(), "blobs"));
}
