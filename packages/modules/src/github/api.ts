// What Hearth needs from GitHub's REST API: who the token is, and the pull requests of a few repos,
// most recently updated first. Read only.

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

export interface GithubApi {
  whoami(token: string): Promise<{ login: string }>;
  /** Up to `limit` pull requests, most recently updated first. */
  pulls(token: string, repo: string, limit: number): Promise<PullRequest[]>;
}

export class GithubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GithubError";
  }
}

type Raw = Record<string, unknown>;

export function httpGithub(base = "https://api.github.com"): GithubApi {
  async function get(token: string, path: string) {
    const res = await fetch(`${base}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "Hearth",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new GithubError(401, "GitHub doesn't accept this token.");
    if (res.status === 404)
      throw new GithubError(
        404,
        `GitHub can't find ${path.split("/").slice(2, 4).join("/")}, or the token can't see it.`,
      );
    if (res.status === 403 || res.status === 429)
      throw new GithubError(res.status, "GitHub asked Hearth to slow down.");
    if (!res.ok) throw new GithubError(res.status, `GitHub answered ${res.status}.`);
    return res.json() as Promise<unknown>;
  }
  return {
    async whoami(token) {
      const me = (await get(token, "/user")) as Raw;
      return { login: String(me.login) };
    },
    async pulls(token, repo, limit) {
      const rows = (await get(
        token,
        `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${limit}`,
      )) as Raw[];
      return rows.map((p) => ({
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
    },
  };
}

/** A GitHub in memory, for tests. */
export class FakeGithub {
  token = "github_pat_test_0123456789";
  login = "wally";
  repos = new Map<string, PullRequest[]>();
  calls: string[] = [];

  api(): GithubApi {
    const check = (token: string) => {
      if (token !== this.token) throw new GithubError(401, "GitHub doesn't accept this token.");
    };
    return {
      whoami: async (token) => {
        check(token);
        return { login: this.login };
      },
      pulls: async (token, repo, limit) => {
        check(token);
        this.calls.push(repo);
        const list = this.repos.get(repo);
        if (!list)
          throw new GithubError(404, `GitHub can't find ${repo}, or the token can't see it.`);
        return [...list]
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, limit);
      },
    };
  }
}
