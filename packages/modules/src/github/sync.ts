// The GitHub loop (PLAN.md section 8.4): a pull request that names a task (T-123 in its title,
// branch or description) is linked to it and moves it forward: In Review when you open it,
// Completed when it's merged. It never reopens a Completed or Canceled task, and it only acts when
// a pull request changes state, so moving a task back by hand sticks.
import { findTaskNumbers, isClosedStatus } from "@hearth/core";
import { githubAccount, githubPr, githubRepo } from "@hearth/db";
import {
  type ActionContext,
  addLink,
  createEntity,
  createNotification,
  updateEntity,
} from "@hearth/kernel";
import { and, eq } from "drizzle-orm";
import { VAULT_SERVICE, type Vault } from "../browser/vault.ts";
import { updateTask } from "../tasks/actions.ts";
import { loadTask } from "../tasks/view.ts";
import { GITHUB_SERVICE, type GithubApi, GithubError, type PullRequest } from "./api.ts";

export type AccountRow = typeof githubAccount.$inferSelect;

const PER_REPO = 50;
const FIRST_LOOK_MS = 14 * 86_400_000;
const MAX_TASKS_PER_PR = 10;

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

async function follow(ctx: ActionContext, account: AccountRow, repo: string, pr: PullRequest) {
  const { id, before } = await savePr(ctx, repo, pr);
  const mine = pr.author.toLowerCase() === account.login.toLowerCase();
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

export interface GithubSyncResult {
  prs: number;
  moved: number;
  failed: string[];
}

export async function syncGithub(ctx: ActionContext): Promise<GithubSyncResult> {
  const result: GithubSyncResult = { prs: 0, moved: 0, failed: [] };
  const [account] = await ctx.tx.select().from(githubAccount).limit(1);
  if (!account) return result;
  const token = openToken(ctx, account);
  for (const repo of await ctx.tx.select().from(githubRepo)) {
    try {
      const since = repo.seenUntil ?? new Date(ctx.now.getTime() - FIRST_LOOK_MS);
      let seen = repo.seenUntil;
      // Oldest first, so a PR opened and merged between syncs ends at Completed.
      const fresh = (await githubApi(ctx).pulls(token, repo.fullName, PER_REPO))
        .filter((p) => p.updatedAt > since)
        .reverse();
      for (const pr of fresh) {
        result.moved += await follow(ctx, account, repo.fullName, pr);
        result.prs++;
        if (!seen || pr.updatedAt > seen) seen = pr.updatedAt;
      }
      await ctx.tx
        .update(githubRepo)
        .set({ seenUntil: seen ?? since, polledAt: ctx.now })
        .where(eq(githubRepo.fullName, repo.fullName));
    } catch (err) {
      if (!(err instanceof GithubError)) throw err;
      result.failed.push(`${repo.fullName}: ${err.message}`);
    }
  }
  await ctx.tx
    .update(githubAccount)
    .set({ syncedAt: ctx.now, lastError: result.failed.join("\n") || null })
    .where(eq(githubAccount.login, account.login));
  if (result.failed.length)
    ctx.emit({ kind: "github.sync_failed", payload: { errors: result.failed } });
  return result;
}
