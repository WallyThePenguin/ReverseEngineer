// What Hearth needs from GitHub's REST API: who the token is, and the pull requests of a few repos,
// most recently updated first, a page at a time. Read only.

export const GITHUB_SERVICE = "github";

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  headRef: string;
  state: "open" | "draft" | "merged" | "closed";
  updatedAt: Date;
}

export interface PullPage {
  prs: PullRequest[];
  /** GitHub has another page after this one. */
  more: boolean;
  /** When the token stops working, when GitHub says (fine-grained tokens expire). */
  tokenExpiresAt: Date | null;
}

export interface GithubApi {
  whoami(token: string): Promise<{ login: string; tokenExpiresAt: Date | null }>;
  /** One page (from 1) of pull requests, most recently updated first. */
  pulls(token: string, repo: string, page: number, perPage: number): Promise<PullPage>;
}

/**
 * - revoked: the token no longer works (401); polling stops until it's replaced.
 * - refused: the token can't see the repo, or the repo is gone (403, 404).
 * - slow: GitHub asked Hearth to slow down.
 * - transient: GitHub couldn't be reached (status 0) or had trouble of its own (5xx).
 */
export type GithubErrorKind = "revoked" | "refused" | "slow" | "transient";

export class GithubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GithubError";
  }
  get kind(): GithubErrorKind {
    if (this.status === 401) return "revoked";
    if (this.status === 429) return "slow";
    if (this.status === 403 || this.status === 404 || this.status === 422) return "refused";
    return "transient";
  }
}

/** GitHub's token expiry header ("2026-11-01 12:00:00 UTC", or with "+0000") as a date. */
export function expiryOf(header: string | null | undefined): Date | null {
  const m = header
    ?.trim()
    .match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const z = m[3];
  const zone = !z || z === "UTC" || z === "Z" ? "Z" : `${z.slice(0, 3)}:${z.slice(-2)}`;
  const d = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

type Raw = Record<string, unknown>;

export function httpGithub(base = "https://api.github.com"): GithubApi {
  async function get(token: string, path: string) {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "Hearth",
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GithubError(0, "GitHub couldn't be reached.");
    }
    const repo = path.split("/").slice(2, 4).join("/");
    if (res.status === 401) throw new GithubError(401, "GitHub doesn't accept this token.");
    if (res.status === 404)
      throw new GithubError(404, `GitHub can't find ${repo}, or the token can't see it.`);
    const limited =
      res.status === 429 ||
      (res.status === 403 &&
        (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
    if (limited) throw new GithubError(429, "GitHub asked Hearth to slow down.");
    if (res.status === 403)
      throw new GithubError(403, `The token can't read ${repo}'s pull requests.`);
    if (!res.ok) throw new GithubError(res.status, `GitHub answered ${res.status}.`);
    const body = (await res.json().catch(() => {
      throw new GithubError(502, "GitHub sent back something Hearth can't read.");
    })) as unknown;
    return {
      body,
      link: res.headers.get("link"),
      tokenExpiresAt: expiryOf(res.headers.get("github-authentication-token-expiration")),
    };
  }
  return {
    async whoami(token) {
      const r = await get(token, "/user");
      return { login: String((r.body as Raw).login), tokenExpiresAt: r.tokenExpiresAt };
    },
    async pulls(token, repo, page, perPage) {
      const r = await get(
        token,
        `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
      );
      const rows = r.body as Raw[];
      const prs: PullRequest[] = rows.map((p) => ({
        number: Number(p.number),
        title: String(p.title ?? ""),
        body: String(p.body ?? ""),
        url: String(p.html_url ?? ""),
        author: String((p.user as Raw | null)?.login ?? ""),
        headRef: String((p.head as Raw | null)?.ref ?? ""),
        state: p.merged_at
          ? "merged"
          : p.state === "closed"
            ? "closed"
            : p.draft
              ? "draft"
              : "open",
        updatedAt: new Date(String(p.updated_at)),
      }));
      const more = r.link ? /rel="next"/.test(r.link) : rows.length === perPage;
      return { prs, more, tokenExpiresAt: r.tokenExpiresAt };
    },
  };
}

/** A GitHub in memory, for tests. */
export class FakeGithub {
  token = "github_pat_test_0123456789";
  login = "wally";
  repos = new Map<string, PullRequest[]>();
  /** What a call to GitHub sends back as the token's expiry. */
  tokenExpiresAt: Date | null = null;
  /** Set to have every call fail with it (GitHub unreachable, say). */
  failWith: GithubError | null = null;
  /** The most it sends in one page, whatever was asked for (GitHub's own is 100). */
  pageSize = 100;
  calls: string[] = [];

  api(): GithubApi {
    const check = (token: string) => {
      if (this.failWith) throw this.failWith;
      if (token !== this.token) throw new GithubError(401, "GitHub doesn't accept this token.");
    };
    return {
      whoami: async (token) => {
        check(token);
        return { login: this.login, tokenExpiresAt: this.tokenExpiresAt };
      },
      pulls: async (token, repo, page, perPage) => {
        this.calls.push(`${repo} ${page}`);
        check(token);
        const list = this.repos.get(repo);
        if (!list)
          throw new GithubError(404, `GitHub can't find ${repo}, or the token can't see it.`);
        const sorted = [...list].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        const size = Math.min(perPage, this.pageSize);
        return {
          prs: sorted.slice((page - 1) * size, page * size),
          more: page * size < sorted.length,
          tokenExpiresAt: this.tokenExpiresAt,
        };
      },
    };
  }
}
