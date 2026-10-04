// Speech for the phone and the web (PLAN.md section 7.4): Hearth has no speech engine of its own,
// so a recording waits here until the desktop app on the PC picks it up, transcribes it with the
// engine it already has loaded, and sends the text back (D46). Nothing is stored.
import { randomUUID } from "node:crypto";

interface Job {
  id: string;
  audio: Uint8Array;
  done: (r: { text: string } | { error: string }) => void;
}

/** How long a recording waits for the desktop app. */
const WAIT_MS = 60_000;
/** The desktop app counts as running if it asked for work this recently. */
const SEEN_MS = 45_000;
/** Recordings waiting or being transcribed at once (each up to 10 MB, held in memory). */
const MAX_JOBS = 4;

export class SpeechRelay {
  private queue: Job[] = [];
  private taken = new Map<string, Job>();
  private waiters: ((job: Job | null) => void)[] = [];
  private lastAsked = 0;

  /** Whether the desktop app is around to transcribe. */
  available(now = Date.now()): boolean {
    return this.waiters.length > 0 || now - this.lastAsked < SEEN_MS;
  }

  /** Whether another recording would be one too many. */
  busy(): boolean {
    return this.queue.length + this.taken.size >= MAX_JOBS;
  }

  /** Text for a recording (16 kHz mono WAV), once the desktop app has done it. */
  transcribe(audio: Uint8Array, waitMs = WAIT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: randomUUID(),
        audio,
        done: (r) => {
          clearTimeout(timer);
          this.taken.delete(job.id);
          this.queue = this.queue.filter((j) => j !== job);
          if ("text" in r) resolve(r.text);
          else reject(new Error(r.error));
        },
      };
      const timer = setTimeout(
        () => job.done({ error: "The desktop app didn't answer in time." }),
        waitMs,
      );
      const waiter = this.waiters.shift();
      if (waiter) this.take(job, waiter);
      else this.queue.push(job);
    });
  }

  /** The desktop app asks for work; resolves with a job, or null after `waitMs`. */
  next(waitMs: number, signal?: AbortSignal): Promise<Job | null> {
    this.lastAsked = Date.now();
    const job = this.queue.shift();
    if (job) return Promise.resolve(this.take(job));
    return new Promise((resolve) => {
      const waiter = (j: Job | null) => {
        clearTimeout(timer);
        this.lastAsked = Date.now();
        resolve(j);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter(null);
      }, waitMs);
      signal?.addEventListener("abort", () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter(null);
      });
      this.waiters.push(waiter);
    });
  }

  private take(job: Job, waiter?: (j: Job) => void): Job {
    this.taken.set(job.id, job);
    waiter?.(job);
    return job;
  }

  /** The desktop app's answer for a job it took. */
  answer(id: string, r: { text: string } | { error: string }): boolean {
    const job = this.taken.get(id);
    if (!job) return false;
    job.done(r);
    return true;
  }
}
