import { describe, expect, it } from "vitest";
import type { Runner } from "./backup.ts";
import { checkBackupTools, checkChrome } from "./doctor.ts";

const schtasks =
  (code: number, stdout = ""): Runner =>
  async () => ({ code, stdout, stderr: "" });

describe("hearth doctor", () => {
  it("checks that Windows can open Chrome for Hearth's service", async () => {
    expect(await checkChrome({}, "win32", schtasks(0))).toMatchObject({
      mark: "ok",
      detail: 'Hearth opens it with the "Hearth Chrome" task',
    });
    expect((await checkChrome({}, "win32", schtasks(1))).mark).toBe("warn");
  });

  it("notices when the task's Chrome has moved", async () => {
    const xml = (path: string) =>
      [..."<Task><Actions><Exec><Command>", ...path, ..."</Command></Exec></Actions></Task>"].join(
        "\0",
      );
    const gone = await checkChrome({}, "win32", schtasks(0, xml("C:\\Old\\chrome.exe")));
    expect(gone).toMatchObject({ mark: "warn" });
    expect(gone.detail).toContain("isn't there anymore");
    const here = await checkChrome({}, "win32", schtasks(0, xml(process.execPath)));
    expect(here.mark).toBe("ok");
  });

  it("finds Chrome elsewhere, or says you open it yourself", async () => {
    expect((await checkChrome({ PATH: "/nowhere" }, "linux")).mark).toBe("warn");
    const off = await checkChrome({ HEARTH_CHROME_LAUNCH: "off" }, "linux");
    expect(off).toMatchObject({ mark: "ok" });
    const node = { HEARTH_CHROME_PATH: process.execPath };
    expect(await checkChrome(node, "linux")).toMatchObject({ mark: "ok" });
  });

  it("asks restic for its version the way restic understands", async () => {
    // Like the real tools: restic rejects --version, the others accept it.
    const tools: Runner = async (cmd, args) => ({
      code: (cmd === "restic" ? args[0] === "version" : args[0] === "--version") ? 0 : 1,
      stdout: "",
      stderr: "",
    });
    const env = { HEARTH_BACKUP_REPOSITORY: "rclone:gdrive:hearth", RESTIC_PASSWORD_FILE: "key" };
    const checks = await checkBackupTools(env, tools);
    expect(checks.map((c) => [c.name, c.mark])).toEqual([
      ["pg_dump", "ok"],
      ["restic", "ok"],
      ["rclone", "ok"],
    ]);
  });
});
