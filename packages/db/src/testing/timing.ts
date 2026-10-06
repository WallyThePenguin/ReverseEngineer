// Timed checks that hold on a slow, shared machine and still catch real slowdowns. (Here
// because every package's tests can reach @hearth/db/testing.)
//
// A timed check is there to catch something getting many times slower: a quadratic loop, a lost
// limit, IronCalc working out the sheet after every cell. Its budget leaves room for the machine
// it runs on, but not for a 10x slowdown. Two things keep it from failing on a machine that's
// only slow or busy:
// - The fastest of a few runs counts, after a warm-up. A garbage collection, a compile, or the
//   scheduler giving the CPU to another test file slows one run, not all of them.
// - Budgets are set for a developer's PC and scaled by HEARTH_PERF_SLACK, which says how much
//   slower this machine is. ci.yml sets it per job. CI's Windows runner (4 vCPUs shared by the
//   suite's parallel files) runs the tests 2.5 times slower than Linux, and its fastest of ten
//   sheet runs took 54 to 67 ms where a developer's PC takes about 20.
//
// The factor is set, not measured. A calibration loop would measure how busy the machine was
// just before the timed runs rather than during them, add CPU load to a shared runner, and grow
// without limit on a busy machine until it hid the slowdown the check is there for. For the same
// reason it stops at 10: past that, a budget no longer catches a 10x slowdown.
//
// Some limits stay as they are on any machine:
// - A bound between two fixed timers, such as a 50 ms per-device timeout the test passes and the
//   product's 10 s default. A slow machine has the whole gap to spare, and a scaled bound could
//   pass the long timer and stop telling the two apart.
// - A wait for something to happen. Wait for the thing itself (a message, a row, a condition),
//   with a deadline far beyond it, not for a set time.

const MAX_SLACK = 10;

/** Reads HEARTH_PERF_SLACK: 1 when unset. A mistake fails loudly rather than loosening budgets. */
export function parseSlack(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const slack = Number(raw);
  if (!Number.isFinite(slack) || slack < 1 || slack > MAX_SLACK)
    throw new Error(`HEARTH_PERF_SLACK must be a number from 1 to ${MAX_SLACK}, not "${raw}".`);
  return slack;
}

/** How much slower this machine runs the tests than a developer's PC. */
export const PERF_SLACK = parseSlack(process.env.HEARTH_PERF_SLACK);

/** A budget of `ms` on a developer's PC, made to fit this machine. */
export const budget = (ms: number) => ms * PERF_SLACK;

/**
 * The fastest of `runs` timed calls of `fn`, in milliseconds, after `warmup` calls that aren't
 * timed. Each call gets its number, counting from 0 across the warm-up and the timed runs, for
 * work that needs a fresh input each time.
 */
export async function fastest(
  fn: (run: number) => unknown,
  { runs = 5, warmup = 1 }: { runs?: number; warmup?: number } = {},
): Promise<number> {
  for (let n = 0; n < warmup; n++) await fn(n);
  let best = Number.POSITIVE_INFINITY;
  for (let n = warmup; n < warmup + runs; n++) {
    const started = performance.now();
    await fn(n);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}
