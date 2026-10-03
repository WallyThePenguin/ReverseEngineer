import { randomBytes } from "node:crypto";
import { audit, githubAccount, link } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../browser/vault.ts";
import { ALL_MODULES } from "../index.ts";
import { FakeGithub, GITHUB_SERVICE, type PullRequest } from "./api.ts";

let t: TestKernel;
let g: FakeGithub;
const REPO = "wally/hearth";

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGithub();
  g.repos.set(REPO, []);
  t.kernel.services[GITHUB_SERVICE] = g.api();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () =>
  ok<{ prs: number; moved: number; failed: string[] }>(
    "github.sync",
    {},
    integrationCaller("github"),
  );
const task = (title: string) => ok<{ id: string; key: string }>("task.create", { title });
const status = async (id: string) => (await ok<{ status: string }>("task.get", { id })).status;
let n = 0;
function pr(p: Partial<PullRequest>): PullRequest {
  const list = g.repos.get(REPO)!;
  const number = p.number ?? ++n;
  const made: PullRequest = {
    number,
    title: "",
    body: "",
    url: `https://github.com/${REPO}/pull/${number}`,
    author: "wally",
    headRef: "main",
    state: "open",
    updatedAt: new Date(t.clock.now().getTime() - 60_000 + list.length),
    ...p,
  };
  g.repos.set(REPO, [...list.filter((x) => x.number !== number), made]);
  return made;
}

describe("github loop", () => {
  it("connects with a sealed token the audit log never sees, and Jarvis can't", async () => {
    expect(await ok("github.connect", { token: g.token, repos: [REPO] })).toMatchObject({
      login: "wally",
    });
    const [a] = await t.tdb.db.select().from(githubAccount);
    expect(a?.token).not.toContain(g.token);
    const rows = await t.tdb.db.select().from(audit).where(eq(audit.action, "github.connect"));
    expect(JSON.stringify(rows)).not.toContain(g.token);
    const denied = await t.kernel.execute(
      "github.connect",
      { token: g.token, repos: [REPO] },
      jarvisCaller("owner"),
    );
    expect(denied.status).toBe("denied");
    const bad = await t.kernel.execute(
      "github.connect",
      { token: "ghp_wrongwrongwrong", repos: [REPO] },
      ownerCaller(),
    );
    expect(bad).toMatchObject({ status: "error", code: "invalid_input" });
  });

  it("moves a task to In Review when you open its PR and to Completed when it merges", async () => {
    const a = await task("Fix login");
    const b = await task("Docs");
    await ok("github.connect", { token: g.token, repos: [REPO] });
    pr({ number: 1, title: `Fix login (${a.key})`, headRef: `jarvis/${a.key}-fix-login` });
    expect(await sync()).toMatchObject({ prs: 1, moved: 1 });
    expect(await status(a.id)).toBe("in_review");
    // The PR is linked to the task.
    const links = await t.tdb.db.select().from(link).where(eq(link.toId, a.id));
    expect(links).toMatchObject([{ kind: "related" }]);

    // Moved back by hand: a sync with nothing new on the PR leaves it.
    await ok("task.update", { id: a.id, status: "in_progress" });
    await sync();
    expect(await status(a.id)).toBe("in_progress");

    t.clock.advance(60_000);
    pr({ number: 1, title: `Fix login (${a.key})`, state: "merged", updatedAt: t.clock.now() });
    // Someone else's PR doesn't put a task in review; a description mention counts.
    pr({ number: 2, author: "stranger", body: `Also touches ${b.key}`, updatedAt: t.clock.now() });
    expect(await sync()).toMatchObject({ moved: 1 });
    expect(await status(a.id)).toBe("completed");
    expect(await status(b.id)).toBe("not_started");
    const inbox = await ok<{ notification: { title: string } }[]>("inbox.list", { lane: "signal" });
    expect(inbox.map((i) => i.notification.title)).toContain(
      `${a.key} is Completed: ${REPO}#1 merged`,
    );
  });

  it("never reopens a Completed or Canceled task, and reads PR text as outside content", async () => {
    const a = await task("Old");
    await ok("task.update", { id: a.id, status: "canceled" });
    await ok("github.connect", { token: g.token, repos: [REPO] });
    pr({ title: `Revisit ${a.key}`, state: "merged" });
    expect(await sync()).toMatchObject({ prs: 1, moved: 0 });
    expect(await status(a.id)).toBe("canceled");
    expect(t.kernel.registry.isOutsideType("github_pr")).toBe(true);
    const prs = await ok<{ type: string }[]>("github.prs");
    expect(prs).toMatchObject([{ type: "github_pr" }]);
  });

  it("says when a repo can't be read, and forgets everything on disconnect", async () => {
    await ok("github.connect", { token: g.token, repos: [REPO, "wally/gone"] });
    pr({ title: "x" });
    const r = await sync();
    expect(r.failed).toEqual([
      "wally/gone: GitHub can't find wally/gone, or the token can't see it.",
    ]);
    expect(r.prs).toBe(1);
    await ok("github.disconnect");
    expect(await ok("github.prs")).toEqual([]);
    expect(await ok("github.status")).toMatchObject({ connected: false, repos: [] });
  });
});
