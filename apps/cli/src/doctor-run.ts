// `hearth doctor` put together: the setup, the running install, then the database. Every check
// runs even when an earlier one fails, so one run shows everything that's wrong.
import { connect, type Database, databaseUrl } from "@hearth/db";
import { type Runner, runProgram } from "./backup.ts";
import {
  type Check,
  checkBackupTools,
  checkChrome,
  checkClaudeLogin,
  checkNode,
  checkOrigin,
} from "./doctor.ts";
import { checkDatabase } from "./doctor-db.ts";
import {
  checkBuild,
  checkChromeLink,
  checkDiskSpace,
  checkServices,
  checkTailscale,
  probeServer,
} from "./doctor-host.ts";

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: Runner;
  fetch?: typeof fetch;
  /** The checkout the install runs from (where git and apps/web/dist are). */
  root?: string;
  connectDb?: () => Database;
  now?: Date;
}

export interface DoctorResult {
  ok: boolean;
  checks: Check[];
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runProgram;
  const checks: Check[] = [
    checkNode(),
    checkOrigin(env),
    checkClaudeLogin(env),
    await checkChrome(env, platform, run),
    ...(await checkBackupTools(env, run)),
  ];

  const services = await checkServices(platform, run);
  checks.push(...services.checks);
  const server = await probeServer(env, opts.fetch ?? fetch, services.installed);
  checks.push(server.check);
  const link = checkChromeLink(server.report);
  if (link) checks.push(link);
  checks.push(await checkBuild(env, run, server.report, opts.root));
  const tailscale = await checkTailscale(env, run);
  if (tailscale) checks.push(tailscale);
  checks.push(...(await checkDiskSpace(env)));

  let database: Database | null = null;
  try {
    database = opts.connectDb ? opts.connectDb() : connect(databaseUrl(env), { max: 2 });
    checks.push(...(await checkDatabase(database, opts.now)));
  } catch (err) {
    checks.push({
      name: "Database",
      mark: "fail",
      detail: `Couldn't check: ${(err as Error).message}`,
    });
  } finally {
    await database?.close();
  }
  return { ok: !checks.some((c) => c.mark === "fail"), checks };
}
