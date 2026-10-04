// One round of mail sync, every minute. Each account syncs in its own action, back to back while
// there's more to bring in, for at most 50 seconds a round so rounds never pile up. An account
// stops for the round when Gmail asked Hearth to slow down, when this minute's budget is spent, or
// when another sync (the server's, right after you connect) already has it; the next round picks
// up where it left off. A network blip or Google server error is tried again after a short wait,
// here and not inside a transaction (D55).
import { googleAccount } from "@hearth/db";
import { integrationCaller, type Kernel } from "@hearth/kernel";
import { SCOPES } from "@hearth/modules";
import { and, arrayContains, ne } from "drizzle-orm";

export interface MailRoundOptions {
  /** How long a round may keep starting syncs. */
  budgetMs?: number;
  /** Waits before trying an account again after a failure that may pass. */
  backoffMs?: number[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/** What a sync result says; see MailSyncResult in the mail module. */
interface SyncResult {
  more: boolean;
  failed: string[];
  paused: string[];
  skipped: string[];
  retryAt: string | null;
  transient: boolean;
}

export type RoundStop = "done" | "paused" | "paced" | "busy" | "failed" | "time";

export interface MailRound {
  syncs: number;
  /** Why each account stopped this round, by address. */
  accounts: Record<string, RoundStop>;
}

export const MAIL_ROUND_MS = 50_000;
const BACKOFF_MS = [1_000, 3_000];

export async function mailRound(kernel: Kernel, opts: MailRoundOptions = {}): Promise<MailRound> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = opts.backoffMs ?? BACKOFF_MS;
  const deadline = now() + (opts.budgetMs ?? MAIL_ROUND_MS);
  const accounts = await kernel.db
    .select({ email: googleAccount.email })
    .from(googleAccount)
    .where(
      and(
        ne(googleAccount.status, "revoked"),
        arrayContains(googleAccount.scopes, [SCOPES.gmail[0]]),
      ),
    );
  const round: MailRound = { syncs: 0, accounts: {} };
  for (const { email } of accounts) {
    let tries = 0;
    let stop: RoundStop = "time";
    while (now() < deadline) {
      const res = await kernel.execute<SyncResult>(
        "mail.sync",
        { account: email },
        integrationCaller("google"),
      );
      round.syncs++;
      if (res.status !== "ok") {
        opts.log?.(`mail sync for ${email}: ${JSON.stringify(res)}`);
        stop = "failed";
        break;
      }
      const r = res.result;
      if (r.failed.length > 0) {
        const wait = backoff[tries];
        if (r.transient && wait !== undefined && now() + wait < deadline) {
          tries++;
          await sleep(wait);
          continue;
        }
        opts.log?.(`mail sync: ${r.failed.join("; ")}`);
        stop = "failed";
        break;
      }
      tries = 0;
      if (r.skipped.length > 0) stop = "busy";
      else if (r.paused.length > 0) stop = "paused";
      else if (r.retryAt) stop = "paced";
      else if (!r.more) stop = "done";
      else continue;
      break;
    }
    round.accounts[email] = stop;
  }
  return round;
}
