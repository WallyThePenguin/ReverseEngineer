// GitHub (M7, PLAN.md section 8.4): pull requests that name a task link to it and move it
// forward. Read with your own read-only token; Hearth never writes to GitHub. Pull request text
// is written by other people, so it's outside content for Jarvis.
import { localDate } from "@hearth/core";
import { entity, githubAccount, githubPr, githubRepo } from "@hearth/db";
import {
  ActionError,
  defineAction,
  defineModule,
  getSetting,
  type ReflexDef,
} from "@hearth/kernel";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { describeRow, liveEntity } from "../shared.ts";
import { GithubError } from "./api.ts";
import { githubApi, sealToken, syncGithub } from "./sync.ts";

export { FakeGithub, GITHUB_SERVICE, type GithubApi, httpGithub } from "./api.ts";

const repoName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "owner/name");

const syncFailed: ReflexDef = {
  name: "github.sync_failed",
  description: "When GitHub stops syncing, you get one notice a day about it.",
  mode: "always",
  on: ["github.sync_failed"],
  async run(event, ctx) {
    const rules = await getSetting(ctx.db, "owner.dayRules");
    const errors = (event.payload.errors as string[] | undefined) ?? [];
    return [
      {
        kind: "tell",
        notification: {
          kind: "system.alert",
          title: "GitHub isn't syncing",
          body: errors.join("\n").slice(0, 1000),
          urgency: "normal",
          dedupeKey: `github.sync_failed:${localDate(event.at, rules.timeZone)}`,
        },
      },
    ];
  },
};

export const githubModule = defineModule({
  name: "github",
  description: "GitHub: pull requests that name a task (T-123) link to it and move it forward.",
  entityTypes: ["github_pr"],
  outsideTypes: ["github_pr"],
  events: [{ kind: "github.sync_failed", description: "Reading GitHub failed. Payload: errors." }],
  kernelEvents: ["entity.created", "entity.updated", "link.added"],
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
      input: z.object({
        token: z
          .string()
          .trim()
          .regex(/^(github_pat_|ghp_)[A-Za-z0-9_]{10,300}$/),
        repos: z.array(repoName).min(1).max(30),
      }),
      // Only you, from Settings; the audit log keeps none of it.
      risk: "secret",
      callers: ["owner"],
      async handler(i, ctx) {
        let login: string;
        try {
          login = (await githubApi(ctx).whoami(i.token)).login;
        } catch (err) {
          throw new ActionError(
            "invalid_input",
            err instanceof GithubError ? err.message : "GitHub couldn't be reached.",
          );
        }
        await ctx.tx.delete(githubAccount);
        await ctx.tx.insert(githubAccount).values({ login, token: sealToken(ctx, login, i.token) });
        await ctx.tx.delete(githubRepo);
        await ctx.tx
          .insert(githubRepo)
          .values([...new Set(i.repos)].map((fullName) => ({ fullName })));
        return { login, repos: i.repos.length };
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
      callers: ["owner", "system", "integration"],
      handler: (_i, ctx) => syncGithub(ctx),
    }),
  ],
  reflexes: [syncFailed],
});
