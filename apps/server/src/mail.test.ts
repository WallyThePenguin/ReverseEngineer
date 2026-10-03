import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { BLOB_SERVICE, BlobStore, GOOGLE_SERVICE, SCOPES } from "@hearth/modules";
import { FakeGoogle } from "@hearth/modules/google-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
let g: FakeGoogle;
let dir: string;

// A message with an HTML body that tries to run a script and load a tracking pixel, and an
// attachment that is itself a web page.
const RAW = [
  "From: Shop <deals@shop.example>",
  "To: owner@example.com",
  "Subject: Your receipt",
  "Date: Thu, 01 Oct 2026 12:00:00 +0000",
  "Message-ID: <r1@shop.example>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/html; charset=UTF-8",
  "",
  '<p>Thanks</p><script>alert(1)</script><img src="https://track.shop.example/p.gif">',
  "--b1",
  'Content-Type: text/html; name="receipt.html"',
  'Content-Disposition: attachment; filename="receipt.html"',
  "",
  "<script>steal()</script>",
  "--b1--",
  "",
].join("\r\n");

beforeEach(async () => {
  t = await createTestServer({ devAuth: true });
  g = new FakeGoogle("owner@example.com");
  g.grants = ["openid", "email", ...SCOPES.gmail];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  const id = g.gmail.deliver({ from: { address: "deals@shop.example" }, subject: "x", text: "x" });
  g.gmail.messages.get(id)!.raw = Buffer.from(RAW);
  await t.kernel.execute("mail.sync", {}, integrationCaller("google"));
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function messageId() {
  const res = await t.kernel.execute<{ id: string }[]>(
    "mail.threads",
    { view: "all" },
    ownerCaller(),
  );
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  const view = await t.kernel.execute<{ messages: { id: string }[] }>(
    "mail.thread",
    { id: res.result[0]!.id },
    ownerCaller(),
  );
  if (view.status !== "ok") throw new Error(JSON.stringify(view));
  return view.result.messages[0]!.id;
}

describe("mail pages", () => {
  it("shows HTML mail under a policy that runs nothing and loads nothing remote", async () => {
    const id = await messageId();
    const res = await t.browser(`/api/mail/frame/${id}`);
    expect(res.status).toBe(200);
    const policy = res.headers.get("content-security-policy")!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toMatch(/script-src|https:/);
    expect(await res.text()).toContain('name="hearth-remote-images" content="1"');
    const shown = await t.browser(`/api/mail/frame/${id}?images=1`);
    expect(shown.headers.get("content-security-policy")).toContain("img-src data: https: http:");
  });

  it("only ever downloads attachments", async () => {
    const id = await messageId();
    const res = await t.browser(`/api/mail/attachment/${id}/0`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="receipt.html"/);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect((await res.text()).trim()).toBe("<script>steal()</script>");
    expect((await t.browser(`/api/mail/attachment/${id}/5`)).status).toBe(404);
  });

  it("is only for you", async () => {
    const id = await messageId();
    const res = await t.api(`/api/mail/frame/${id}`, "not-a-token");
    expect(res.status).toBe(401);
    expect((await t.api(`/api/mail/attachment/${id}/0`, "not-a-token")).status).toBe(401);
  });
});
