// The GitHub loop (PLAN.md section 8.4): a pull request that names a task (T-123 in its title,
// branch or description) is linked to it and moves it forward: In Review when you open it,
// Completed when it's merged. It never reopens a Completed or Canceled task, and it only acts when
// a pull request changes state, so moving a task back by hand sticks. Pull requests are read a
// page at a time until the ones seen before; how the round went is saved on the account (D61).
import { findTaskNumbers, isClosedStatus } from "@hearth/core";
import { githubAccount, githubPr, githubRepo } from "@hearth/db";
import {
  type ActionContext,
  addLink,
  createEntity,
  createNotification,
  savepoint,
  updateEntity,
} from "@hearth/kernel";
import { and, asc, eq, sql } from "drizzle-orm";
import { VAULT_SERVICE, type Vault } from "../browser/vault.ts";
import { closeAlerts, nextHealth, type Trouble, worst } from "../connector-health.ts";
import { updateTask } from "../tasks/actions.ts";
import { loadTask } from "../tasks/view.ts";
import { GITHUB_SERVICE, type GithubApi, GithubError, type PullRequest } from "./api.ts";

export type AccountRow = typeof githubAccount.$inferSelect;
type RepoRow = typeof githubRepo.$inferSelect;

/** Pull requests per page, and pages one repo may read in a round. */
export const PER_PAGE = 100;
export const PAGES_PER_REPO = 5;
const FIRST_LOOK_MS = 14 * 86_400_000;
const MAX_TASKS_PER_PR = 10;
/** You're told this long before the token stops working. */
export const EXPIRY_WARNING_MS = 7 * 86_400_000;

export const githubApi = (ctx: Pick<ActionContext, "service">) =>
  ctx.service<GithubApi>(GITHUB_SERVICE);
export const sealToken = (ctx: Pick<ActionContext, "service">, login: string, token: string) =>
  ctx.service<Vault>(VAULT_SERVICE).seal("github.com", login, token);
const openToken = (ctx: Pick<ActionContext, "service">, a: AccountRow) =>
  ctx.service<Vault>(VAULT_SERVICE).open("github.com", a.login, a.token);

const LABEL = { in_review: "In Review", completed: "Completed" } as const;

/** Saves or refreshes the pull request's record. Returns it and the state it had before. */
async function savePr(ctx: ActionContext, repo: string, pr: PullRequest) {
  // Hearth's own link tags can't be forged from a pull request (they'd link records it names).
  const defuse = (s: string) => s.replace(/<(\/?m-ref)/gi, "‹$1");
  const title = defuse(`${repo}#${pr.number}: ${pr.title}`).slice(0, 500);
  const body = defuse(pr.body.slice(0, 20_000));
  const [known] = await ctx.tx
    .select()
    .from(githubPr)
    .where(and(eq(githubPr.repo, repo), eq(githubPr.number, pr.number)));
  const values = {
    url: pr.url,
    author: pr.author,
    headRef: pr.headRef.slice(0, 300),
    state: pr.state,
    updatedAt: pr.updatedAt,
  };
  if (known) {
    await updateEntity(ctx, known.entityId, { title, body });
    await ctx.tx.update(githubPr).set(values).where(eq(githubPr.entityId, known.entityId));
    return { id: known.entityId, before: known.state };
  }
  const row = await createEntity(ctx, { type: "github_pr", title, body });
  await ctx.tx.insert(githubPr).values({ entityId: row.id, repo, number: pr.number, ...values });
  return { id: row.id, before: null };
}

/** What a pull request in this state, by this author, moves its tasks to. */
export function moveTo(pr: PullRequest, me: string): "in_review" | "completed" | null {
  // Anyone can open a pull request on a public repo, and a maintainer can merge it; only yours
  // move your tasks.
  if (pr.author.toLowerCase() !== me.toLowerCase()) return null;
  if (pr.state === "merged") return "completed";
  if (pr.state === "open") return "in_review";
  return null;
}

/** The event for a pull request's change of state, if it's one a watch can wait for. */
function changeOf(before: PullRequest["state"] | null, after: PullRequest["state"]) {
  if (before === after) return null;
  if (after === "merged") return "github.pr_merged";
  if (after === "closed") return "github.pr_closed";
  return before === null || before === "closed" ? "github.pr_opened" : null;
}

async function follow(
  ctx: ActionContext,
  account: AccountRow,
  repo: string,
  pr: PullRequest,
  quiet: boolean,
) {
  const { id, before } = await savePr(ctx, repo, pr);
  const mine = pr.author.toLowerCase() === account.login.toLowerCase();
  const change = changeOf(before, pr.state);
  if (change && !quiet)
    ctx.emit({
      kind: change,
      entityId: id,
      payload: { repo, number: pr.number, author: pr.author, url: pr.url, mine },
    });
  // A stranger's pull request can't attach itself to your tasks either.
  const numbers = mine
    ? findTaskNumbers(`${pr.title}\n${pr.headRef}\n${pr.body}`).slice(0, MAX_TASKS_PER_PR)
    : [];
  const target = before === pr.state ? null : moveTo(pr, account.login);
  let moved = 0;
  for (const n of numbers) {
    const t = await loadTask(ctx.tx, { number: n });
    if (!t) continue;
    await addLink(ctx, { fromId: id, toId: t.id, kind: "related" });
    if (!target || t.status === target || isClosedStatus(t.status)) continue;
    await updateTask.handler({ id: t.id, status: target }, ctx);
    moved++;
    await createNotification(ctx, {
      kind: "github.task_moved",
      title: `${t.key} is ${LABEL[target]}: ${repo}#${pr.number} ${pr.state === "merged" ? "merged" : "opened"}`,
      entityId: t.id,
      urgency: "quiet",
      dedupeKey: `github:${repo}#${pr.number}:${t.id}:${target}`,
    });
  }
  return moved;
}

/**
 * Reads a repo's pull requests changed since last time, newest first, a page at a time. When more
 * changed than a round reads, the rest come in later rounds before reading moves on.
 */
async function readRepo(ctx: ActionContext, account: AccountRow, token: string, repo: RepoRow) {
  const since = repo.seenUntil ?? new Date(ctx.now.getTime() - FIRST_LOOK_MS);
  // A first look, and the rest of a busy spell, still move tasks but don't announce each PR.
  const quiet = repo.seenUntil === null || repo.resumePage !== null;
  const got = new Map<number, PullRequest>();
  let page = repo.resumePage ?? 1;
  let done = false;
  let tokenExpiresAt: Date | null = null;
  for (let n = 0; n < PAGES_PER_REPO; n++, page++) {
    const r = await githubApi(ctx).pulls(token, repo.fullName, page, PER_PAGE);
    tokenExpiresAt = r.tokenExpiresAt ?? tokenExpiresAt;
    const fresh = r.prs.filter((p) => p.updatedAt > since);
    // One changed while Hearth read can show up twice: the first is the newest.
    for (const p of fresh) if (!got.has(p.number)) got.set(p.number, p);
    if (!r.more || fresh.length < r.prs.length) {
      done = true;
      break;
    }
  }
  // Oldest first, so a PR opened and merged between syncs ends at Completed.
  const prs = [...got.values()].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
  let moved = 0;
  for (const pr of prs) moved += await follow(ctx, account, repo.fullName, pr, quiet);
  const newest = prs.reduce<Date | null>(
    (d, p) => (!d || p.updatedAt > d ? p.updatedAt : d),
    repo.backlogTop,
  );
  await ctx.tx
    .update(githubRepo)
    .set(
      done
        ? { seenUntil: newest ?? since, resumePage: null, backlogTop: null, polledAt: ctx.now }
        : { seenUntil: since, resumePage: page, backlogTop: newest, polledAt: ctx.now },
    )
    .where(eq(githubRepo.fullName, repo.fullName));
  return { prs: prs.length, moved, tokenExpiresAt };
}

export interface GithubSyncResult {
  prs: number;
  moved: number;
  failed: string[];
}

export async function syncGithub(ctx: ActionContext): Promise<GithubSyncResult> {
  const result: GithubSyncResult = { prs: 0, moved: 0, failed: [] };
  const [account] = await ctx.tx.select().from(githubAccount).limit(1);
  if (!account) return result;
  // A token that stopped working isn't tried again until you paste a new one.
  if (account.syncState === "revoked")
    return { ...result, failed: account.lastError ? [account.lastError] : [] };
  const token = openToken(ctx, account);
  const repos = await ctx.tx
    .select()
    .from(githubRepo)
    .orderBy(sql`${githubRepo.polledAt} ASC NULLS FIRST`, asc(githubRepo.fullName));
  const troubles: Trouble[] = [];
  let progressed = repos.length === 0;
  let slowed = false;
  let tokenExpiresAt: Date | null = null;
  for (const repo of repos) {
    try {
      const r = await savepoint(ctx, (sp) => readRepo(sp, account, token, repo));
      result.prs += r.prs;
      result.moved += r.moved;
      tokenExpiresAt = r.tokenExpiresAt ?? tokenExpiresAt;
      progressed = true;
    } catch (err) {
      const e = err instanceof GithubError ? err : null;
      const kind = e?.kind ?? "transient";
      // Slowing down when asked is normal; the rest wait for the next round.
      if (kind === "slow") {
        slowed = true;
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      troubles.push({
        kind,
        message: kind === "revoked" ? message : `${repo.fullName}: ${message}`,
      });
      result.failed.push(`${repo.fullName}: ${message}`);
      // A token that stopped working, or no GitHub at all, fails the other repos too.
      if (kind === "revoked" || e?.status === 0) break;
    }
  }
  const trouble = worst(troubles);
  if (slowed && !trouble && !progressed) return result;
  const next = nextHealth(account, ctx.now, trouble, progressed);
  await ctx.tx
    .update(githubAccount)
    .set({ ...next.values, ...(tokenExpiresAt ? { tokenExpiresAt } : {}) })
    .where(eq(githubAccount.login, account.login));
  if (next.recovered) await closeAlerts(ctx, "github");
  if (next.alert)
    ctx.emit({
      kind: "github.sync_failed",
      payload: {
        errors: result.failed,
        since: next.alert.since.toISOString(),
        reconnect: next.alert.reconnect,
      },
    });
  if (tokenExpiresAt) warnOfExpiry(ctx, account, tokenExpiresAt);
  return result;
}

/** Once, when the token first gets within a week of stopping working. */
function warnOfExpiry(ctx: ActionContext, account: AccountRow, expiresAt: Date) {
  const warnAt = expiresAt.getTime() - EXPIRY_WARNING_MS;
  if (ctx.now.getTime() < warnAt) return;
  const seen =
    account.tokenExpiresAt?.getTime() === expiresAt.getTime() &&
    (account.syncedAt?.getTime() ?? 0) >= warnAt;
  if (!seen)
    ctx.emit({
      kind: "github.token_expiring",
      payload: { login: account.login, expiresAt: expiresAt.toISOString() },
    });
}
