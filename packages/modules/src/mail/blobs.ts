// Files Hearth keeps on disk by the hash of their contents, like the raw text of every email, so
// a message can be read again later without asking the provider, and the same bytes are kept once.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The kernel service name: ctx.service<BlobStore>(BLOB_SERVICE). */
export const BLOB_SERVICE = "blobs";

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
    if (await stat(file).catch(() => null)) return hash;
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
}

/** The store under Hearth's data folder. */
export function blobsFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStore {
  return new BlobStore(join(env.HEARTH_DATA_DIR ?? process.cwd(), "blobs"));
}
