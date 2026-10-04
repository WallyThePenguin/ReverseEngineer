// Whether the open page is the Hearth that's running (D57). The page knows the build it came
// from; /api/health/deep says the build the server started with and whether its database fits.

/** What the page reads from /api/health/deep. */
export interface ServerBuild {
  build: string | null;
  migrations: { ok: boolean } | null;
}

export type Notice = "updated" | "mismatch" | null;

/** The build this page came from: vite.config.ts stamps it into index.html. */
export function pageBuild(doc: Pick<Document, "querySelector"> = document): string | null {
  return doc.querySelector<HTMLMetaElement>('meta[name="hearth-build"]')?.content || null;
}

export function noticeFor(mine: string | null, server: ServerBuild | null): Notice {
  if (!server) return null;
  if (server.migrations && !server.migrations.ok) return "mismatch";
  if (mine && server.build && server.build !== mine) return "updated";
  return null;
}
