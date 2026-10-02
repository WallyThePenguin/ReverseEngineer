import { describe, expect, it } from "vitest";
import type { Runner } from "./backup.ts";
import { checkChrome } from "./doctor.ts";

const schtasks =
  (code: number): Runner =>
  async () => ({ code, stdout: "", stderr: "" });

describe("hearth doctor", () => {
  it("checks that Windows can open Chrome for Hearth's service", async () => {
    expect(await checkChrome({}, "win32", schtasks(0))).toMatchObject({
      mark: "ok",
      detail: 'Hearth opens it with the "Hearth Chrome" task',
    });
    expect((await checkChrome({}, "win32", schtasks(1))).mark).toBe("warn");
  });

  it("finds Chrome elsewhere, or says you open it yourself", async () => {
    expect((await checkChrome({ PATH: "/nowhere" }, "linux")).mark).toBe("warn");
    const off = await checkChrome({ HEARTH_CHROME_LAUNCH: "off" }, "linux");
    expect(off).toMatchObject({ mark: "ok" });
    const node = { HEARTH_CHROME_PATH: process.execPath };
    expect(await checkChrome(node, "linux")).toMatchObject({ mark: "ok" });
  });
});
