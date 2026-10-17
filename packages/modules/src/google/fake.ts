// A fake Google for tests: sign-in, token refresh and the Calendar calls Hearth makes, kept in
// memory. Hand `fake.fetch` to a GoogleClient. It holds one account to start with; addAccount
// adds more, each with its own calendars, mailbox and tokens, and shareCalendar puts one calendar
// (a holiday calendar, a colleague's) in several accounts at once, as Google does.
import type { Db } from "@hearth/db";
import type { Allowance, GoogleService } from "./budget.ts";
import type { GCalendar, GEvent } from "./calendar-api.ts";
import { GoogleClient, SCOPES } from "./client.ts";
import { errorReply, FakeGmail } from "./fake-gmail.ts";

interface FakeCalendar extends GCalendar {
  events: Map<string, GEvent>;
  /** Ids of events deleted here: Google never hands an id out again. */
  gone: Set<string>;
}

interface FreeBusyAsk {
  timeMin: string;
  timeMax: string;
  items: { id: string }[];
}

export interface FakeAccount {
  email: string;
  refreshToken: string;
  calendars: Map<string, FakeCalendar>;
  gmail: FakeGmail;
}

const json = (status: number, data: unknown) =>
  new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export class FakeGoogle {
  /** The first account's address. */
  readonly email: string;
  readonly accounts = new Map<string, FakeAccount>();
  readonly calls: { method: string; path: string; body?: unknown }[] = [];
  /** Set to make the next token refresh fail as if access was revoked. */
  revoked = false;
  /** What a sign-in grants. */
  grants: string[] = ["openid", "email", ...SCOPES.calendar];
  /** Which account the next sign-in is. */
  signingIn: string;
  /** How long each call takes, for tests where calls overlap. */
  latencyMs = 0;
  /** The next `n` Calendar changes are made, but the reply is lost (Hearth sees a 503). */
  loseCalendarReplies = 0;
  /**
   * Calendars still in the list whose events Google won't give, with what it says: a 404 for one
   * whose source was deleted, say. Until removed from here.
   */
  readonly brokenCalendars = new Map<string, 403 | 404 | 500>();
  /**
   * Other people's calendars Google shows through free/busy, by address: their busy times, and
   * the accounts they're shared with (a colleague's, seen from your work account). Anyone else's
   * calendar is one Google can't find.
   */
  readonly colleagues = new Map<
    string,
    { busy: { start: string; end: string }[]; seenBy: string[] }
  >();
  /** The time clients and the fake Gmail see; set it to the test kernel's clock. */
  clock: { now(): Date } = { now: () => new Date() };
  /** What clients made by client() logged. */
  readonly logs: string[] = [];
  /** Who each access token handed out belongs to. */
  private readonly issued = new Map<string, string>();
  private readonly invalid = new Set<string>();
  private readonly calendarFailures: number[] = [];
  private readonly refreshFailures: number[] = [];
  private seq = 0;

  constructor(email = "owner@example.com") {
    this.email = email;
    this.signingIn = email;
    this.addAccount(email, "rt");
  }

  /** Adds an account with its own primary calendar and mailbox. Sign in as it with signingIn. */
  addAccount(email: string, refreshToken = `rt-${email}`): FakeAccount {
    const gmail = new FakeGmail(email);
    gmail.now = () => this.clock.now().getTime();
    const account: FakeAccount = { email, refreshToken, calendars: new Map(), gmail };
    this.accounts.set(email, account);
    this.addCalendar({ id: email, summary: email, primary: true, accessRole: "owner" }, email);
    return account;
  }

  private account(email: string): FakeAccount {
    const a = this.accounts.get(email);
    if (!a) throw new Error(`No fake Google account ${email}`);
    return a;
  }

  /** The first account's calendars. */
  get calendars(): Map<string, FakeCalendar> {
    return this.account(this.email).calendars;
  }

  /** The first account's mailbox. */
  get gmail(): FakeGmail {
    return this.account(this.email).gmail;
  }

  /** Every access token handed out so far stops working, as if Google expired them early. */
  invalidateTokens() {
    for (const t of this.issued.keys()) this.invalid.add(t);
  }

  /** The next `n` Calendar calls fail with `status`, as Google sends it. */
  failCalendar(n: number, status: 403 | 404 | 429 | 500 | 503) {
    for (let i = 0; i < n; i++) this.calendarFailures.push(status);
  }

  /** The next `n` token refreshes fail with `status`. */
  failRefresh(n: number, status: 429 | 500 | 503) {
    for (let i = 0; i < n; i++) this.refreshFailures.push(status);
  }

  addCalendar(c: GCalendar, account = this.email) {
    this.account(account).calendars.set(c.id, { ...c, events: new Map(), gone: new Set() });
  }

  /** One calendar seen by several accounts, each with its own access: the events are shared. */
  shareCalendar(c: Omit<GCalendar, "accessRole">, access: Record<string, GCalendar["accessRole"]>) {
    const events = new Map<string, GEvent>();
    const gone = new Set<string>();
    for (const [email, accessRole] of Object.entries(access))
      this.account(email).calendars.set(c.id, { ...c, accessRole, events, gone });
  }

  private calendar(calendarId: string, account?: string): FakeCalendar {
    const where = account ? [this.account(account)] : [...this.accounts.values()];
    for (const a of where) {
      const cal = a.calendars.get(calendarId);
      if (cal) return cal;
    }
    throw new Error(`No fake calendar ${calendarId}`);
  }

  /** Puts an event straight into Google, as if made in Google's own app or by someone else. */
  put(calendarId: string, ev: Partial<GEvent> & Pick<GEvent, "start" | "end">): GEvent {
    const cal = this.calendar(calendarId);
    const id = ev.id ?? `ev${++this.seq}`;
    const full: GEvent = { status: "confirmed", summary: "", ...ev, id, etag: `"${++this.seq}"` };
    cal.events.set(id, full);
    return full;
  }

  remove(calendarId: string, id: string) {
    const cal = this.calendar(calendarId);
    cal.events.delete(id);
    cal.gone.add(id);
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

  private issue(email: string): string {
    const token = `at${++this.seq}`;
    this.issued.set(token, email);
    return token;
  }

  private signIn(body: Record<string, unknown> | undefined): Response {
    if (body?.grant_type === "refresh_token") {
      if (this.revoked)
        return json(400, { error: "invalid_grant", error_description: "Token has been revoked." });
      const failing = this.refreshFailures.shift();
      if (failing) return json(failing, { error: "rate_limit_exceeded" });
      const owner = [...this.accounts.values()].find((a) => a.refreshToken === body.refresh_token);
      if (!owner) return json(400, { error: "invalid_grant", error_description: "Bad token." });
      return json(200, { access_token: this.issue(owner.email), expires_in: 3600 });
    }
    const a = this.account(this.signingIn);
    return json(200, {
      access_token: this.issue(a.email),
      expires_in: 3600,
      refresh_token: a.refreshToken,
      scope: this.grants.join(" "),
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

    if (u.hostname === "oauth2.googleapis.com") return this.signIn(body);
    const bearer = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "");
    const who = bearer ? this.issued.get(bearer) : undefined;
    // Signed out, or a token Google no longer takes: every API call is turned away.
    if (this.revoked || !who || (bearer && this.invalid.has(bearer)))
      return json(401, {
        error: { code: 401, message: "Request had invalid authentication credentials." },
      });
    const account = this.account(who);
    if (u.hostname === "openidconnect.googleapis.com") return json(200, { email: account.email });
    if (u.hostname === "gmail.googleapis.com") {
      const id = u.pathname.match(/\/messages\/([^/]+)$/)?.[1];
      if (id && account.gmail.hangIds.has(decodeURIComponent(id))) {
        account.gmail.hung++;
        // No answer: wait until the client gives up on it.
        await new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        );
      }
      return account.gmail.handle(u, method, body);
    }
    const failing = this.calendarFailures.shift();
    if (failing) return errorReply(failing);
    const res = this.calendarCall(account, u, method, body);
    if (method !== "GET" && this.loseCalendarReplies > 0) {
      this.loseCalendarReplies--;
      return errorReply(503);
    }
    return res;
  }

  /** Busy times as free/busy gives them: no titles, only when. */
  private freeBusy(account: FakeAccount, ask: FreeBusyAsk) {
    const from = new Date(ask.timeMin).getTime();
    const to = new Date(ask.timeMax).getTime();
    const at = (t?: { dateTime?: string; date?: string }) =>
      new Date(t?.dateTime ?? `${t?.date}T00:00:00Z`);
    const calendars: Record<string, unknown> = {};
    for (const { id } of ask.items) {
      const colleague = this.colleagues.get(id);
      const own = account.calendars.get(id);
      if (colleague?.seenBy.includes(account.email)) {
        calendars[id] = { busy: colleague.busy };
      } else if (own) {
        const busy = [...own.events.values()]
          .filter((e) => e.status !== "cancelled" && e.transparency !== "transparent")
          .map((e) => ({ start: at(e.start), end: at(e.end) }))
          .filter((b) => b.start.getTime() < to && b.end.getTime() > from)
          .map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() }));
        calendars[id] = { busy };
      } else {
        calendars[id] = { busy: [], errors: [{ domain: "global", reason: "notFound" }] };
      }
    }
    return { kind: "calendar#freeBusy", timeMin: ask.timeMin, timeMax: ask.timeMax, calendars };
  }

  private calendarCall(account: FakeAccount, u: URL, method: string, body: GEvent | undefined) {
    const path = u.pathname.replace("/calendar/v3", "");
    if (path === "/freeBusy" && method === "POST")
      return json(200, this.freeBusy(account, body as unknown as FreeBusyAsk));
    if (path === "/users/me/calendarList") {
      return json(200, {
        items: [...account.calendars.values()].map(({ events: _e, gone: _g, ...c }) => c),
      });
    }
    const m = path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    const cal = m ? account.calendars.get(decodeURIComponent(m[1]!)) : undefined;
    if (!m || !cal) return json(404, { error: { message: "Not found" } });
    const eventId = m[2] ? decodeURIComponent(m[2]) : null;
    const broken = this.brokenCalendars.get(cal.id);
    if (broken) return errorReply(broken);
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
      // An id the caller chose is Google's to refuse when it's taken, even by a deleted event.
      if (body?.id && (cal.events.has(body.id) || cal.gone.has(body.id)))
        return json(409, {
          error: {
            code: 409,
            message: "The requested identifier already exists.",
            errors: [{ reason: "duplicate", message: "The requested identifier already exists." }],
          },
        });
      return json(
        200,
        this.put(cal.id, { ...body, organizer: { email: account.email, self: true } }),
      );
    }
    if (method === "GET" && eventId && cal.gone.has(eventId))
      return json(200, { id: eventId, status: "cancelled" });
    const existing = eventId ? cal.events.get(eventId) : undefined;
    if (!existing) return json(404, { error: { message: "Not found" } });
    if (method === "GET") return json(200, existing);
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
      cal.gone.add(existing.id);
      return json(204, null);
    }
    return json(405, { error: { message: "Unsupported" } });
  }
}
