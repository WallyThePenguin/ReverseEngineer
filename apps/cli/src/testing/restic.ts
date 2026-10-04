// restic, faked for tests: a repository in a temp folder that keeps a copy of what each backup
// sent, and serves `snapshots`, `dump`, `restore <id>:<folder>` and `forget` the way restic does.
// Everything else runs for real (pg_dump, pg_restore).
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dataFolders, type Runner, runProgram, snapshotPath } from "../backup.ts";

/** A data folder under root with stored files (named by their hash), a voice sample and a vault key. */
export async function dataFolder(root: string, count = 5): Promise<string> {
  const data = join(root, "data");
  const { blobs, voice } = dataFolders(data);
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.from(`message ${i}`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await mkdir(join(blobs, hash.slice(0, 2)), { recursive: true });
    await writeFile(join(blobs, hash.slice(0, 2), hash.slice(2)), bytes);
  }
  await mkdir(voice, { recursive: true });
  await writeFile(join(voice, "one.wav"), "RIFF");
  await writeFile(join(data, "vault.key"), randomBytes(32));
  return data;
}

interface Kept {
  id: string;
  short_id: string;
  time: string;
  paths: string[];
  /** Where the copy of each path is, in the fake repository. */
  copies: Map<string, string>;
}

export interface FakeRestic {
  run: Runner;
  calls: string[][];
  snapshots: Kept[];
  /** The repository's copy of a file or folder a backup sent. */
  copyOf(path: string): string;
  destroy(): Promise<void>;
}

const VALUED = new Set(["--repo", "--tag", "--host", "--exclude", "--target", "--group-by"]);

/** The arguments that aren't flags (or a flag's value). */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUED.has(args[i]!)) i++;
    else if (!args[i]!.startsWith("--")) out.push(args[i]!);
  }
  return out;
}

export async function fakeRestic(): Promise<FakeRestic> {
  const repo = await mkdtemp(join(tmpdir(), "hearth-fake-restic-"));
  const calls: string[][] = [];
  const snapshots: Kept[] = [];
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const find = (id: string) =>
    id === "latest" ? snapshots.at(-1) : snapshots.find((s) => s.id.startsWith(id));

  /** The repository copy holding a snapshot path: a path sent, or a file under a folder sent. */
  const locate = (snap: Kept, inside: string): string | null => {
    for (const [path, copy] of snap.copies) {
      const at = snapshotPath(path);
      if (inside === at) return copy;
      if (inside.startsWith(`${at}/`)) return join(copy, ...inside.slice(at.length + 1).split("/"));
    }
    return null;
  };

  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== "restic") return runProgram(cmd, args);
    const [sub, ...rest] = positionals(args);
    const target = args[args.indexOf("--target") + 1]!;
    if (sub === "backup") {
      const n = snapshots.length + 1;
      const id = `${String(n).padStart(8, "0")}${"ab".repeat(28)}`;
      const copies = new Map<string, string>();
      for (const [i, path] of rest.entries()) {
        const copy = join(repo, id, String(i));
        const skip = args[args.indexOf("--exclude") + 1];
        await cp(path, copy, { recursive: true, filter: (src) => !skip || !src.endsWith(skip) });
        copies.set(path, copy);
      }
      const time = new Date(Date.UTC(2026, 9, 4, 2, 30, n)).toISOString();
      snapshots.push({ id, short_id: id.slice(0, 8), time, paths: rest, copies });
      const summary = { message_type: "summary", snapshot_id: id };
      return ok(`{"message_type":"status"}\n${JSON.stringify(summary)}\n`);
    }
    if (sub === "snapshots") return ok(JSON.stringify(snapshots.map(({ copies: _, ...s }) => s)));
    if (sub === "dump") {
      const snap = find(rest[0]!);
      const copy = snap && locate(snap, rest[1]!);
      if (!copy) return { code: 1, stdout: "", stderr: `Fatal: no such file ${rest[1]}` };
      await mkdir(dirname(target), { recursive: true });
      await cp(copy, target);
      return ok();
    }
    if (sub === "restore") {
      const [id, inside] = rest[0]!.split(/:(.*)/s);
      const snap = find(id!);
      const copy = snap && inside ? locate(snap, inside) : null;
      if (!copy) return { code: 1, stdout: "", stderr: `Fatal: nothing at ${rest[0]}` };
      await cp(copy, target, { recursive: true });
      return ok();
    }
    return ok();
  };

  return {
    run,
    calls,
    snapshots,
    copyOf: (path) => snapshots.at(-1)!.copies.get(path)!,
    destroy: () => rm(repo, { recursive: true, force: true }),
  };
}
