// Which copy of Hearth this is (D62): one id per data folder, kept outside the database, so a
// dev copy with the live database restored into it is still another install.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFromEnv } from "./install.ts";

const dirs: string[] = [];
const folder = async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-install-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("the install id", () => {
  it("is made once per data folder and kept there, and differs between folders", async () => {
    const live = await folder();
    const id = installFromEnv({ HEARTH_DATA_DIR: live }).id();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await readFile(join(live, "install.id"), "utf8")).trim()).toBe(id);
    // Another process on the same folder, or the same one after a restart.
    expect(installFromEnv({ HEARTH_DATA_DIR: live }).id()).toBe(id);
    // A dev copy, whatever database it has.
    expect(installFromEnv({ HEARTH_DATA_DIR: await folder() }).id()).not.toBe(id);
  });

  it("can be given, and refuses an emptied file rather than guess", async () => {
    expect(installFromEnv({ HEARTH_INSTALL_ID: " pc-1 " }).id()).toBe("pc-1");
    const dir = await folder();
    await writeFile(join(dir, "install.id"), "\n");
    expect(() => installFromEnv({ HEARTH_DATA_DIR: dir }).id()).toThrow(/is empty/);
  });
});
