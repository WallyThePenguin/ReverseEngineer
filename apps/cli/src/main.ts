// The `hearth` command. Run `hearth help` for the list.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { connect, databaseUrl, migrateUp } from "@hearth/db";
import {
  fileLog,
  guardProcess,
  Kernel,
  ownerCaller,
  Registry,
  systemCaller,
  teeConsole,
} from "@hearth/kernel";
import { ALL_MODULES, secretMigrations, vaultFromEnv } from "@hearth/modules";
import {
  createApiToken,
  createSetupCode,
  listApiTokens,
  listDevices,
  pairDevice,
  revokeApiTokens,
  unpairDevice,
} from "@hearth/server";
import { dataFolders, runBackup } from "./backup.ts";
import { formatChecks } from "./doctor.ts";
import { runDoctor } from "./doctor-run.ts";
import { migrateCommand } from "./migrate.ts";
import { restart } from "./restart.ts";
import { restoreReport, runRestore, switchEnv } from "./restore.ts";
import { guardSchema } from "./schema-guard.ts";

const HELP = `hearth: your personal workspace, with Jarvis.

  hearth setup              Prepare the database and print a one-time code for your first passkey
  hearth migrate [down [name]]
                            Apply database changes (or revert the last one, or the one named)
  hearth serve              Run the web server
  hearth worker             Run schedules and health checks
  hearth jarvis             Run Jarvis
  hearth dev [--no-jarvis]  Run all three in one process
  hearth restart [server|worker|jarvis|all]
                            Restart Hearth's Windows services (all by default) and wait for them
  hearth backup             Back up now (dump, upload with restic, prune, test a restore)
  hearth restore [snapshot | file.dump] [--into name] [--switch]
                            Restore a backup (the newest by default) into a new database and
                            say how to switch to it; --switch also updates .env and restarts
  hearth doctor [--json]    Check that everything is set up and running; exits 1 on any fail
  hearth eval [--record] [name...]
                            Run Jarvis's eval scenarios with the real model (needs
                            HEARTH_TEST_DATABASE_URL); --record saves passing runs as fixtures
  hearth status             Show health, routines and whether Jarvis is paused
  hearth pause | resume     Pause or resume Jarvis's own initiative (it still answers you)
  hearth token create <name>   Make a token for an outside agent (Claude Code, Claude Desktop)
  hearth token list
  hearth token revoke <name>
  hearth device pair desktop   Make a pairing code for the desktop app (shown once)
  hearth device list
  hearth device unpair desktop
`;

function withDatabase<T>(fn: (db: ReturnType<typeof connect>) => Promise<T>): Promise<T> {
  const database = connect(databaseUrl(), { max: 2 });
  return fn(database).finally(() => database.close());
}

const kernelFor = (database: ReturnType<typeof connect>) =>
  new Kernel({ db: database.db, registry: new Registry(ALL_MODULES) });

/** Under the services' 20 s stop timeout (ops/windows/*.xml), so a stop never ends in a kill. */
const STOP_LIMIT_MS = 15_000;

/** Migration steps that need the vault key (sealing Google's tokens, D58). */
const migrationCode = () => secretMigrations(vaultFromEnv());

async function untilSignal(stops: (() => Promise<void>)[]): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  // A stop that hangs, or something left open after it (a timer, a socket, a database client),
  // would keep the process up until the service manager kills it. Say what's holding on, and go.
  setTimeout(() => {
    const open = process.getActiveResourcesInfo().filter((r) => r !== "TTYWrap");
    console.error(
      `Still running ${STOP_LIMIT_MS / 1000} s after being asked to stop (open: ${open.join(", ") || "nothing"}). Exiting anyway.`,
    );
    process.exit(1);
  }, STOP_LIMIT_MS).unref();
  for (const stop of stops.reverse()) await stop().catch((e) => console.error(e));
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      console.log(HELP);
      return 0;

    case "migrate":
      return withDatabase(({ pool }) =>
        migrateCommand(pool, rest, console.log, undefined, migrationCode()),
      );

    case "setup":
      return withDatabase(async ({ pool, db }) => {
        await migrateUp(pool, undefined, migrationCode());
        const code = await createSetupCode(db);
        const origin = process.env.HEARTH_ORIGIN ?? "http://localhost:4400";
        console.log(
          `Database ready.\n\nOpen ${origin} and enter this code to add your first passkey:\n\n    ${code}\n\nIt works once and expires in 30 minutes.`,
        );
        return 0;
      });

    case "serve":
    case "worker":
    case "jarvis":
    case "dev": {
      const { values } = parseArgs({ args: rest, options: { "no-jarvis": { type: "boolean" } } });
      // A stray failure in a background task is logged, not the end of Hearth. (Jarvis's own
      // process installs its own.)
      if (command !== "jarvis") guardProcess(command);
      // What the server and worker print is also kept as timed JSON lines in the data folder's
      // logs (server.jsonl, worker.jsonl), rolled over by size. Jarvis keeps its own (D54).
      if (command !== "jarvis") {
        const name = command === "serve" ? "server" : command;
        const dataDir = process.env.HEARTH_DATA_DIR ?? process.cwd();
        teeConsole(
          name,
          fileLog(join(dataDir, "logs", `${name}.jsonl`), {
            onError: (err) =>
              console.warn(`Couldn't write ${name}.jsonl: ${(err as Error).message}`),
          }),
        );
      }
      const stops: (() => Promise<void>)[] = [];
      if (command === "dev")
        await withDatabase(({ pool }) => migrateUp(pool, undefined, migrationCode()));
      else {
        const service = command === "serve" ? "server" : command;
        const refused = await withDatabase((d) => guardSchema(service, d.pool, kernelFor(d)));
        if (refused) {
          console.error(refused);
          return 1;
        }
      }
      try {
        if (command === "serve" || command === "dev")
          stops.push(await (await import("@hearth/server")).runServer());
        if (command === "worker" || command === "dev")
          stops.push(await (await import("@hearth/worker")).runWorker());
        if (command === "jarvis" || (command === "dev" && !values["no-jarvis"])) {
          stops.push(await (await import("@hearth/jarvis-service")).runJarvis());
        }
      } catch (err) {
        // Not starting ends the process, whatever was left open: the service manager only starts
        // again a process that exited, never one that's up and answering nothing.
        console.error(`Hearth's ${command} couldn't start: ${(err as Error).message}`);
        for (const stop of stops.reverse()) await stop().catch((e) => console.error(e));
        process.exit(1);
      }
      await untilSignal(stops);
      return 0;
    }

    case "backup":
      return withDatabase(async (database) => {
        const dataDir = process.env.HEARTH_DATA_DIR ?? process.cwd();
        const { blobs, voice } = dataFolders(dataDir);
        const result = await runBackup({
          databaseUrl: databaseUrl(),
          dir: process.env.HEARTH_BACKUP_DIR ?? join(dataDir, "backups"),
          repository: process.env.HEARTH_BACKUP_REPOSITORY || null,
          restoreDatabase: "hearth_restore_check",
          folders: [blobs, voice],
        });
        const kernel = kernelFor(database);
        const { offsite, ...report } = result;
        await kernel.execute("system.backup_finished", report, systemCaller());
        if (result.ok && !offsite) {
          await kernel.execute(
            "system.report",
            { component: "backup", status: "degraded", detail: result.detail },
            systemCaller(),
          );
        }
        console.log(result.detail);
        return result.ok ? 0 : 1;
      });

    case "restore": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { into: { type: "string" }, switch: { type: "boolean", default: false } },
        allowPositionals: true,
      });
      const dataDir = process.env.HEARTH_DATA_DIR ?? process.cwd();
      const current = databaseUrl();
      const result = await runRestore({
        databaseUrl: current,
        source: positionals[0] ?? null,
        repository: process.env.HEARTH_BACKUP_REPOSITORY || null,
        backupDir: process.env.HEARTH_BACKUP_DIR ?? join(dataDir, "backups"),
        dataDir,
        ...(values.into ? { into: values.into } : {}),
        migrationCode: migrationCode(),
      });
      const switched = values.switch
        ? await switchEnv(join(process.cwd(), ".env"), result.url)
        : null;
      const vaultKey = !!process.env.HEARTH_VAULT_KEY || existsSync(join(dataDir, "vault.key"));
      console.log(restoreReport(result, current, switched, vaultKey));
      return switched ? restart(["all"]) : 0;
    }

    case "eval": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { record: { type: "boolean", default: false } },
        allowPositionals: true,
      });
      const { ClaudeBrain } = await import("@hearth/jarvis");
      const { SCENARIOS, runLive } = await import("@hearth/jarvis/evals");
      const model = process.env.HEARTH_JARVIS_MODEL;
      const brain = new ClaudeBrain({
        ...(model ? { models: { fast: model, deep: model } } : {}),
        web: false,
      });
      const chosen = positionals.length
        ? SCENARIOS.filter((s) => positionals.includes(s.name))
        : SCENARIOS;
      let failed = 0;
      for (const s of chosen) {
        const r = await runLive(s, brain, values.record ? { record: model ?? "default" } : {});
        console.log(`${r.passed ? "pass" : "FAIL"}  ${s.name}  (${r.turns} turns)`);
        for (const f of r.failures) console.log(`      ${f}`);
        if (!r.passed) failed++;
      }
      console.log(`${chosen.length - failed}/${chosen.length} passed`);
      return failed ? 1 : 0;
    }

    case "doctor": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      const result = await runDoctor();
      console.log(values.json ? JSON.stringify(result) : formatChecks(result.checks));
      return result.ok ? 0 : 1;
    }

    case "restart":
      return restart(rest);

    case "status":
    case "pause":
    case "resume":
      return withDatabase(async (database) => {
        const action = command === "status" ? "system.status" : `jarvis.${command}`;
        const res = await kernelFor(database).execute(action, {}, ownerCaller("cli"));
        console.log(JSON.stringify(res.status === "ok" ? res.result : res, null, 2));
        return res.status === "ok" ? 0 : 1;
      });

    case "token":
      return withDatabase(async ({ db }) => {
        const [sub, name] = rest;
        if (sub === "create" && name) {
          const { token } = await createApiToken(db, name);
          console.log(
            `Token for ${name} (shown once; store it in that app's settings):\n\n    ${token}\n`,
          );
          console.log(
            `Connect it to ${process.env.HEARTH_ORIGIN ?? "http://localhost:4400"}/mcp with the header\n    Authorization: Bearer <token>`,
          );
          return 0;
        }
        if (sub === "list") {
          for (const t of await listApiTokens(db)) {
            const state = t.revokedAt
              ? "revoked"
              : `last used ${t.lastSeenAt?.toISOString() ?? "never"}`;
            console.log(`${t.principal.padEnd(28)} ${state}`);
          }
          return 0;
        }
        if (sub === "revoke" && name) {
          console.log(`Revoked ${await revokeApiTokens(db, name)} token(s) for ${name}.`);
          return 0;
        }
        console.error("Usage: hearth token create|list|revoke <name>");
        return 2;
      });

    case "device":
      return withDatabase(async ({ db }) => {
        const [sub, name] = rest;
        if (sub === "pair" && name) {
          const token = await pairDevice(db, name);
          console.log(
            `Pairing code for ${name} (shown once; paste it into its settings):\n\n    ${token}\n`,
          );
          return 0;
        }
        if (sub === "list") {
          for (const d of await listDevices(db))
            console.log(`${d.name.padEnd(12)} last seen ${d.lastSeenAt?.toISOString() ?? "never"}`);
          return 0;
        }
        if (sub === "unpair" && name) {
          console.log(`Signed out ${await unpairDevice(db, name)} sign-in(s) for ${name}.`);
          return 0;
        }
        console.error("Usage: hearth device pair|list|unpair <name>");
        return 2;
      });

    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((err: Error) => {
    console.error(err.message);
    return 1;
  });
}

export { main };
