import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Asker, ownerOf, type StopWatchOptions, watchForStopRequest } from "./stop-request.ts";

let dir: string;
let file: string;
let unwatch = () => {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-stop-"));
  file = join(dir, "hearth-jarvis.stop");
});
afterEach(() => {
  unwatch();
  rmSync(dir, { recursive: true, force: true });
});

const you: Asker = { trusted: true, who: "Your account" };

/** Watches as the task's Jarvis would, checking every 10 ms, with who asked and the task faked. */
function watch(change: Partial<StopWatchOptions> = {}) {
  const stop = vi.fn();
  const log = vi.fn();
  const whoAsked = vi.fn(async () => you);
  unwatch = watchForStopRequest({
    file,
    startedAt: Date.now() - 60_000,
    stop,
    log,
    whoAsked,
    parentAlive: () => true,
    everyMs: 10,
    ...change,
  });
  return { stop, log, whoAsked };
}
/** Lets the watcher look a few times. */
const aFewChecks = () => new Promise((r) => setTimeout(r, 100));

describe("a request to stop Jarvis", () => {
  it("stops Jarvis when it's newer than Jarvis, once", async () => {
    const { stop } = watch();
    await aFewChecks();
    expect(stop).not.toHaveBeenCalled();
    writeFileSync(file, "now");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(stop.mock.calls[0]?.[0]).toBe(`Your account asked Jarvis to stop (${file})`);
    // Removed, so a clock that steps back can't make it the next Jarvis's.
    expect(existsSync(file)).toBe(false);
    await aFewChecks();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("is ignored when it was for an earlier Jarvis", async () => {
    // Left from the last stop: written before this Jarvis started.
    writeFileSync(file, "then");
    const old = new Date(Date.now() - 120_000);
    utimesSync(file, old, old);
    const { stop, whoAsked } = watch();
    await aFewChecks();
    expect(stop).not.toHaveBeenCalled();
    expect(whoAsked).not.toHaveBeenCalled();
  });

  it("is ignored from anyone but you or an administrator, and looked at once", async () => {
    const whoAsked = vi.fn(async () => ({
      trusted: false,
      who: "the account S-1-5-21-9-9-9-1002",
    }));
    const { stop, log } = watch({ whoAsked });
    writeFileSync(file, "now");
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(log.mock.calls[0]?.[0]).toMatch(/^Ignored a request to stop from the account S-1-5-21/);
    await aFewChecks();
    expect(stop).not.toHaveBeenCalled();
    expect(whoAsked).toHaveBeenCalledOnce();
  });

  it("is ignored when who wrote it can't be told", async () => {
    const { stop, log } = watch({
      whoAsked: vi.fn(async () => {
        throw new Error("powershell.exe not found");
      }),
    });
    writeFileSync(file, "now");
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(stop).not.toHaveBeenCalled();
  });

  it("isn't needed once the task run that started Jarvis has ended", async () => {
    let alive = true;
    const { stop } = watch({ parentAlive: () => alive });
    await aFewChecks();
    expect(stop).not.toHaveBeenCalled();
    // Stop-ScheduledTask ends the task's cmd.exe, not the node under it (2026-10-05).
    alive = false;
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(stop.mock.calls[0]?.[0]).toBe("The task that started Jarvis has ended");
  });

  it("isn't waited on once the task run has ended", async () => {
    let alive = true;
    // Who asked never comes back (a PowerShell stuck starting on a busy PC).
    const { stop } = watch({
      parentAlive: () => alive,
      whoAsked: vi.fn(() => new Promise<Asker>(() => {})),
    });
    writeFileSync(file, "now");
    await aFewChecks();
    expect(stop).not.toHaveBeenCalled();
    alive = false;
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(stop.mock.calls[0]?.[0]).toBe("The task that started Jarvis has ended");
    // It came with the end of the task run, for this Jarvis: removed too.
    expect(existsSync(file)).toBe(false);
  });

  it("from an earlier Jarvis is left when the task run ends", async () => {
    writeFileSync(file, "then");
    const old = new Date(Date.now() - 120_000);
    utimesSync(file, old, old);
    let alive = true;
    const { stop } = watch({ parentAlive: () => alive });
    alive = false;
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(existsSync(file)).toBe(true);
  });

  it("is no longer watched for once Jarvis is stopping anyway", async () => {
    const { stop } = watch();
    unwatch();
    writeFileSync(file, "now");
    await aFewChecks();
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("who asked", () => {
  it("is your account for a request this account wrote", async () => {
    writeFileSync(file, "now");
    const asker = await ownerOf(file);
    expect(asker.trusted).toBe(true);
    if (process.platform === "win32") expect(asker.who).toBe("Your account");
  }, 30_000);

  it("can't be told for a request that isn't there", async () => {
    expect((await ownerOf(join(dir, "missing.stop"))).trusted).toBe(false);
  }, 30_000);
});
