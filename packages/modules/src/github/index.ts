// GitHub (M7, PLAN.md section 8.4): pull requests that name a task link to it and move it
// forward. Read with your own read-only token; Hearth never writes to GitHub. Pull request text
// is written by other people, so it's outside content for Jarvis.
import { entity, githubAccount, githubPr, githubRepo } from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  type DigestItem,
  defineAction,
  defineModule,
  type ReadContext,
  type ReflexDef,
} from "@hearth/kernel";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { closeAlerts, syncFailedReflex } from "../connector-health.ts";
import { describeRow, liveEntity } from "../shared.ts";
import { GithubError } from "./api.ts";
import { githubApi, sealToken, syncGithub } from "./sync.ts";

export { FakeGithub, GITHUB_SERVICE, type GithubApi, httpGithub } from "./api.ts";

const repoName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "owner/name");

const token = z
  .string()
  .trim()
  .regex(/^(github_pat_|ghp_)[A-Za-z0-9_]{10,300}$/);

const syncFailed = syncFailedReflex("github", "GitHub", async (ctx) => {
  const [a] = await ctx.db.select({ since: githubAccount.failingSince }).from(githubAccount);
  return a?.since;
});

const tokenExpiring: ReflexDef = {
  name: "github.token_expiring",
  description: "A week before your GitHub token stops working, you're told so you can replace it.",
  mode: "always",
  on: ["github.token_expiring"],
  run(event) {
    const at = String(event.payload.expiresAt ?? "");
    const day = at ? new Date(at).toUTCString().slice(0, 16) : "soon";
    return [
      {
        kind: "tell",
        notification: {
          kind: "system.alert",
          title: "Your GitHub token is about to stop working",
          body: `It expires ${day}. Make a new one and paste it in Settings, under GitHub, so pull requests keep coming in.`,
          urgency: "normal",
          dedupeKey: `github.token_expiring:${at}`,
        },
      },
    ];
  },
};

async function whoami(ctx: ActionContext, t: string) {
  try {
    return await githubApi(ctx).whoami(t);
  } catch (err) {
    throw new ActionError(
      "invalid_input",
      err instanceof GithubError ? err.message : "GitHub couldn't be reached.",
    );
  }
}

/** Pull requests merged or still open that changed since the last brief. */
async function digest(ctx: ReadContext & { since: Date }): Promise<DigestItem[]> {
  const rows = await ctx.db
    .select({ id: githubPr.entityId, title: entity.title, state: githubPr.state })
    .from(githubPr)
    .innerJoin(entity, eq(entity.id, githubPr.entityId))
    .where(and(gte(githubPr.updatedAt, ctx.since), inArray(githubPr.state, ["merged", "open"])))
    .orderBy(desc(githubPr.updatedAt))
    .limit(6);
  const items: DigestItem[] = rows.slice(0, 5).map((r) => ({
    bucket: "fyi",
    text: `${r.state === "merged" ? "Merged" : "Open"}: ${r.title}`,
    entityId: r.id,
    outside: true,
  }));
  if (rows.length > 5)
    items.push({ bucket: "fyi", text: "More pull requests changed on GitHub.", outside: true });
  return items;
}

export const githubModule = defineModule({
  name: "github",
  description: "GitHub: pull requests that name a task (T-123) link to it and move it forward.",
  entityTypes: ["github_pr"],
  outsideTypes: ["github_pr"],
  events: [
    {
      kind: "github.sync_failed",
      description:
        "GitHub stopped syncing: its token stopped working (reconnect), a repo can't be read, or it kept failing. Sent once when it starts. Payload: errors, since, reconnect.",
    },
    {
      kind: "github.token_expiring",
      description: "The GitHub token stops working within a week. Payload: login, expiresAt.",
    },
    {
      kind: "github.pr_opened",
      description:
        "A pull request was opened (or reopened). Payload: repo, number, author, url, mine.",
    },
    {
      kind: "github.pr_merged",
      description: "A pull request was merged. Payload: repo, number, author, url, mine.",
    },
    {
      kind: "github.pr_closed",
      description:
        "A pull request was closed without merging. Payload: repo, number, author, url, mine.",
    },
  ],
  kernelEvents: ["entity.created", "entity.updated", "link.added", "notification.updated"],
  knowledge: {
    async github_pr(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "github_pr");
      if (!row) return null;
      const [pr] = await ctx.db.select().from(githubPr).where(eq(githubPr.entityId, entityId));
      const extra = pr ? [`${pr.state} pull request by ${pr.author}`, pr.url] : [];
      return describeRow(row, extra);
    },
  },
  actions: [
    defineAction({
      name: "github.connect",
      description:
        "Connect GitHub with a read-only personal access token and the repos to follow (owner/name).",
      input: z.object({ token, repos: z.array(repoName).min(1).max(30) }),
      // Only you, from Settings; the audit log keeps none of it.
      risk: "secret",
      callers: ["owner"],
      async handler(i, ctx) {
        const me = await whoami(ctx, i.token);
        const [had] = await ctx.tx.select().from(githubAccount);
        if (had && had.login !== me.login)
          throw new ActionError(
            "conflict",
            `GitHub is connected as ${had.login}. Disconnect it first to switch accounts.`,
          );
        await ctx.tx.delete(githubAccount);
        await ctx.tx.insert(githubAccount).values({
          login: me.login,
          token: sealToken(ctx, me.login, i.token),
          tokenExpiresAt: me.tokenExpiresAt,
        });
        await closeAlerts(ctx, "github");
        await ctx.tx.delete(githubRepo);
        await ctx.tx
          .insert(githubRepo)
          .values([...new Set(i.repos)].map((fullName) => ({ fullName })));
        return { login: me.login, repos: i.repos.length };
      },
    }),
    defineAction({
      name: "github.replace_token",
      description:
        "Give Hearth a new GitHub token for the connected account (the old one expired or was revoked), keeping the repos and pull requests read in so far.",
      input: z.object({ token }),
      risk: "secret",
      callers: ["owner"],
      async handler(i, ctx) {
        const [a] = await ctx.tx.select().from(githubAccount);
        if (!a) throw new ActionError("not_found", "GitHub isn't connected.");
        const me = await whoami(ctx, i.token);
        if (me.login !== a.login)
          throw new ActionError(
            "invalid_input",
            `That token is for ${me.login}, not ${a.login}. Disconnect first to switch accounts.`,
          );
        await ctx.tx
          .update(githubAccount)
          .set({
            token: sealToken(ctx, a.login, i.token),
            tokenExpiresAt: me.tokenExpiresAt,
            syncState: "ok",
            failures: 0,
            failingSince: null,
            lastError: null,
          })
          .where(eq(githubAccount.login, a.login));
        await closeAlerts(ctx, "github");
        return { login: a.login, tokenExpiresAt: me.tokenExpiresAt };
      },
    }),
    defineAction({
      name: "github.status",
      description:
        "Whether GitHub is connected, as whom, the repos followed and how syncing is going.",
      input: z.object({}),
      risk: "read",
      async handler(_i, ctx) {
        const [a] = await ctx.tx
          .select({
            login: githubAccount.login,
            syncedAt: githubAccount.syncedAt,
            lastError: githubAccount.lastError,
            state: githubAccount.syncState,
            tokenExpiresAt: githubAccount.tokenExpiresAt,
          })
          .from(githubAccount);
        const repos = await ctx.tx.select({ name: githubRepo.fullName }).from(githubRepo);
        return { connected: Boolean(a), ...(a ?? {}), repos: repos.map((r) => r.name) };
      },
    }),
    defineAction({
      name: "github.set_repos",
      description: "Change which repos (owner/name) are followed.",
      input: z.object({ repos: z.array(repoName).max(30) }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const want = [...new Set(i.repos)];
        const have = (await ctx.tx.select().from(githubRepo)).map((r) => r.fullName);
        const gone = have.filter((r) => !want.includes(r));
        if (gone.length) await ctx.tx.delete(githubRepo).where(inArray(githubRepo.fullName, gone));
        const added = want.filter((r) => !have.includes(r));
        if (added.length)
          await ctx.tx.insert(githubRepo).values(added.map((fullName) => ({ fullName })));
        return { repos: want };
      },
    }),
    defineAction({
      name: "github.disconnect",
      description: "Forget the GitHub token, the repos and the pull requests read in.",
      input: z.object({}),
      risk: "internal",
      callers: ["owner"],
      async handler(_i, ctx) {
        const ids = ctx.tx.select({ id: githubPr.entityId }).from(githubPr);
        await ctx.tx.delete(entity).where(inArray(entity.id, ids));
        await ctx.tx.delete(githubRepo);
        await ctx.tx.delete(githubAccount);
        await closeAlerts(ctx, "github");
        return { disconnected: true };
      },
    }),
    defineAction({
      name: "github.prs",
      description:
        "Pull requests read in from GitHub, most recently updated first, with their state. Their text is written by other people.",
      input: z.object({ limit: z.number().int().min(1).max(100).default(30) }),
      risk: "read",
      async handler(i, ctx) {
        const rows = await ctx.tx
          .select({
            id: githubPr.entityId,
            title: entity.title,
            state: githubPr.state,
            url: githubPr.url,
            author: githubPr.author,
            updatedAt: githubPr.updatedAt,
          })
          .from(githubPr)
          .innerJoin(entity, eq(entity.id, githubPr.entityId))
          .orderBy(desc(githubPr.updatedAt))
          .limit(i.limit);
        return rows.map((r) => ({ ...r, type: "github_pr" }));
      },
    }),
    defineAction({
      name: "github.sync",
      description: "Read pull requests in from GitHub now.",
      input: z.object({}),
      risk: "internal",
      // Only as the integration: pull requests are outside content, never the owner's (D49).
      callers: ["integration"],
      handler: (_i, ctx) => syncGithub(ctx),
    }),
  ],
  reflexes: [syncFailed, tokenExpiring],
  digest,
});
