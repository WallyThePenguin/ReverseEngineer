// A fake Google for tests: sign-in, token refresh and the Calendar calls Hearth makes, kept in
// memory. Hand `fake.fetch` to a GoogleClient.
import type { Db } from "@hearth/db";
import type { Allowance, GoogleService } from "./budget.ts";
import type { GCalendar, GEvent } from "./calendar-api.ts";
import { GoogleClient, SCOPES } from "./client.ts";
import { FakeGmail } from "./fake-gmail.ts";

interface FakeCalendar extends GCalendar {
  events: Map<string, GEvent>;
}

export class FakeGoogle {
  readonly email: string;
  readonly calendars = new Map<string, FakeCalendar>();
  readonly calls: { method: string; path: string; body?: unknown }[] = [];
  /** Set to make the next token refresh fail as if access was revoked. */
  revoked = false;
  /** What a sign-in grants. */
  grants: string[] = ["openid", "email", ...SCOPES.calendar];
  readonly gmail: FakeGmail;
  /** How long each call takes, for tests where calls overlap. */
  latencyMs = 0;
  /** The time clients and the fake Gmail see; set it to the test kernel's clock. */
  clock: { now(): Date } = { now: () => new Date() };
  /** What clients made by client() logged. */
  readonly logs: string[] = [];
  private readonly issued: string[] = [];
  private readonly invalid = new Set<string>();
  private seq = 0;

  /** Every access token handed out so far stops working, as if Google expired them early. */
  invalidateTokens() {
    for (const t of this.issued) this.invalid.add(t);
  }

  constructor(email = "owner@example.com") {
    this.email = email;
    this.gmail = new FakeGmail(email);
    this.gmail.now = () => this.clock.now().getTime();
    this.addCalendar({ id: email, summary: email, primary: true, accessRole: "owner" });
  }

  addCalendar(c: GCalendar) {
    this.calendars.set(c.id, { ...c, events: new Map() });
  }

  /** Puts an event straight into Google, as if made in Google's own app or by someone else. */
  put(calendarId: string, ev: Partial<GEvent> & Pick<GEvent, "start" | "end">): GEvent {
    const cal = this.calendars.get(calendarId)!;
    const id = ev.id ?? `ev${++this.seq}`;
    const full: GEvent = { status: "confirmed", summary: "", ...ev, id, etag: `"${++this.seq}"` };
    cal.events.set(id, full);
    return full;
  }

  remove(calendarId: string, id: string) {
    this.calendars.get(calendarId)!.events.delete(id);
  }

  /** A client talking to this fake. With `db`, its budget and tokens are shared through it. */
  client(
    db?: Db,
    opts: { allowances?: Partial<Record<GoogleService, Allowance>>; timeoutMs?: number } = {},
  ): GoogleClient {
    return new GoogleClient({
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUri: "http://localhost:4400/api/google/callback",
      fetch: (url, init) => this.fetch(url, init),
      db: db ?? null,
      now: () => this.clock.now(),
      log: (msg) => void this.logs.push(msg),
      ...opts,
    });
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body =
      typeof init.body === "string" && init.body.startsWith("{")
        ? JSON.parse(init.body)
        : init.body instanceof URLSearchParams
          ? Object.fromEntries(init.body)
          : undefined;
    this.calls.push({ method, path: u.pathname, ...(body ? { body } : {}) });
    const json = (status: number, data: unknown) =>
      new Response(data === null ? null : JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (u.hostname === "oauth2.googleapis.com") {
      if (body?.grant_type === "refresh_token" && this.revoked)
        return json(400, { error: "invalid_grant", error_description: "Token has been revoked." });
      const token = `at${++this.seq}`;
      this.issued.push(token);
      return json(200, {
        access_token: token,
        expires_in: 3600,
        ...(body?.grant_type === "authorization_code"
          ? {
              refresh_token: "rt",
              scope: this.grants.join(" "),
            }
          : {}),
      });
    }
    if (u.hostname === "openidconnect.googleapis.com") return json(200, { email: this.email });
    // Signed out, or a token Google no longer takes: every API call is turned away.
    const bearer = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "");
    if (this.revoked || (bearer && this.invalid.has(bearer)))
      return json(401, {
        error: { code: 401, message: "Request had invalid authentication credentials." },
      });
    if (u.hostname === "gmail.googleapis.com") return this.gmail.handle(u, method, body);

    const path = u.pathname.replace("/calendar/v3", "");
    if (path === "/users/me/calendarList") {
      return json(200, {
        items: [...this.calendars.values()].map(({ events: _e, ...c }) => c),
      });
    }
    const m = path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    const cal = m ? this.calendars.get(decodeURIComponent(m[1]!)) : undefined;
    if (!m || !cal) return json(404, { error: { message: "Not found" } });
    const eventId = m[2] ? decodeURIComponent(m[2]) : null;
    if (method === "GET" && !eventId) {
      const from = new Date(u.searchParams.get("timeMin") ?? 0).getTime();
      const to = new Date(u.searchParams.get("timeMax") ?? 8.64e15).getTime();
      const start = (t?: { dateTime?: string; date?: string }) =>
        new Date(t?.dateTime ?? `${t?.date}T00:00:00Z`).getTime();
      const items = [...cal.events.values()].filter(
        (e) => start(e.start) < to && start(e.end) > from,
      );
      return json(200, { items });
    }
    if (method === "POST" && !eventId) {
      return json(200, this.put(cal.id, { ...body, organizer: { email: this.email, self: true } }));
    }
    const existing = eventId ? cal.events.get(eventId) : undefined;
    if (!existing) return json(404, { error: { message: "Not found" } });
    if (method === "PATCH") {
      const next = { ...existing, ...body, etag: `"${++this.seq}"` } as GEvent;
      // Google works out who "self" and the organizer are; a patch doesn't send them.
      if (next.attendees)
        next.attendees = next.attendees.map((a) => {
          const was = existing.attendees?.find((x) => x.email === a.email);
          return {
            ...a,
            ...(was?.self ? { self: true } : {}),
            ...(was?.organizer ? { organizer: true } : {}),
          };
        });
      cal.events.set(existing.id, next);
      return json(200, next);
    }
    if (method === "DELETE") {
      cal.events.delete(existing.id);
      return json(204, null);
    }
    return json(405, { error: { message: "Unsupported" } });
  }
}
