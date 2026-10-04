// Whether the open page is the Hearth that's running (D57). The page knows the build it came
// from; /api/health/deep says the build the server started with and whether its database fits.

/** What the page reads from /api/health/deep. */
export interface ServerBuild {
  build: string | null;
  migrations: { ok: boolean } | null;
}

export type Notice = "updated" | "mismatch" | null;

export function noticeFor(mine: string, server: ServerBuild | null): Notice {
  if (!server) return null;
  if (server.migrations && !server.migrations.ok) return "mismatch";
  if (server.build && server.build !== mine) return "updated";
  return null;
}
