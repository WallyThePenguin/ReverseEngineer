import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HEARTH_ROOT, restart, restartCommand } from "./restart.ts";

describe("hearth restart", () => {
  it("runs restart.ps1 from this Hearth folder for what you name, all by default", () => {
    const all = restartCommand(undefined);
    expect(all?.cmd).toBe("powershell.exe");
    expect(all?.args.slice(-2)).toEqual(["-Service", "all"]);
    const script = all?.args[all.args.indexOf("-File") + 1] ?? "";
    expect(existsSync(script)).toBe(true);
    expect(script.startsWith(HEARTH_ROOT)).toBe(true);
    const elsewhere = join("C:\\Hearth", "ops", "windows", "restart.ps1");
    expect(restartCommand("jarvis", "C:\\Hearth")?.args).toContain(elsewhere);
    expect(restartCommand("everything")).toBeNull();
  });

  it("restarts on Windows, explains elsewhere, and rejects anything else", async () => {
    const run = vi.fn(async () => 0);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await restart(["worker"], "win32", run)).toBe(0);
    expect(run).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-Service", "worker"]),
    );
    expect(await restart([], "win32", async () => 1)).toBe(1);
    expect(await restart(["db"], "win32", run)).toBe(2);
    expect(await restart(["server", "worker"], "win32", run)).toBe(2);
    expect(await restart(["all"], "linux", run)).toBe(2);
    expect(run).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });
});
