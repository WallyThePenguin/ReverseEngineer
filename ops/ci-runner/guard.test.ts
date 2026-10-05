import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { check, type Host, main, runDatabase } from "./guard-rules.ts";

const T = "D:/hearth-ci/_work-win/_temp";
const RCLONE = `${T}/rclone-empty.conf`;
const WORKSPACE = "D:\\hearth-ci\\_work-win\\ReverseEngineer\\ReverseEngineer";

/** What the Windows job sets (ci.yml), with the runner's own variables. */
const WINDOWS: NodeJS.ProcessEnv = {
  RUNNER_TEMP: "D:\\hearth-ci\\_work-win\\_temp",
  GITHUB_WORKSPACE: WORKSPACE,
  GITHUB_RUN_ID: "37350213541",
  GITHUB_RUN_ATTEMPT: "2",
  HEARTH_DATABASE_URL: "postgres://hearth@127.0.0.1:5499/hearth_ci_37350213541_2",
  HEARTH_TEST_DATABASE_URL: "postgres://hearth@127.0.0.1:5499/postgres",
  PGHOST: "127.0.0.1",
  PGPORT: "5499",
  HEARTH_PORT: "4480",
  HEARTH_ORIGIN: "http://localhost:4480",
  HEARTH_HOST: "127.0.0.1",
  HEARTH_E2E_URL: "http://localhost:4480",
  HEARTH_E2E_PORT: "4484",
  HEARTH_DATA_DIR: `${T}/hearth-data`,
  HEARTH_BACKUP_DIR: `${T}/hearth-data/backups`,
  RESTIC_CACHE_DIR: `${T}/restic-cache`,
  RCLONE_CONFIG: RCLONE,
  HEARTH_CHROME_LAUNCH: "off",
};

const LT = "/home/runner/_work/_temp";
/** What the Linux job sets, inside its container. */
const LINUX: NodeJS.ProcessEnv = {
  ...WINDOWS,
  RUNNER_TEMP: LT,
  GITHUB_WORKSPACE: "/home/runner/_work/ReverseEngineer/ReverseEngineer",
  HEARTH_DATA_DIR: `${LT}/hearth-data`,
  HEARTH_BACKUP_DIR: `${LT}/hearth-data/backups`,
  RESTIC_CACHE_DIR: `${LT}/restic-cache`,
  RCLONE_CONFIG: `${LT}/rclone-empty.conf`,
};

const MOUNTS = [
  "584 495 0:258 / / rw,relatime master:236 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/X",
  "590 584 8:48 /docker/volumes/hearth-ci-linux-work/_data /home/runner/_work rw,relatime - ext4 /dev/sdd rw",
].join("\n");

function host(
  platform: NodeJS.Platform,
  files: Record<string, number> = {},
  mounts = MOUNTS,
): Host {
  const all: Record<string, number> = { [RCLONE]: 0, [`${LT}/rclone-empty.conf`]: 0, ...files };
  if (platform === "linux" && !("/.dockerenv" in files)) all["/.dockerenv"] = 0;
  return {
    platform,
    exists: (p) => p in all && all[p]! >= 0,
    fileSize: (p) => (p in all && all[p]! >= 0 ? all[p]! : null),
    mounts: () => mounts,
  };
}

const win = (change: NodeJS.ProcessEnv, files?: Record<string, number>) =>
  check({ ...WINDOWS, ...change }, host("win32", files));
const linux = (change: NodeJS.ProcessEnv, files?: Record<string, number>, mounts?: string) =>
  check({ ...LINUX, ...change }, host("linux", files, mounts));
const one = (problems: string[], text: string | RegExp) =>
  expect(
    problems.filter((p) => (typeof text === "string" ? p.includes(text) : text.test(p))),
  ).not.toEqual([]);

describe("the CI guard", () => {
  it("lets the jobs' own settings through, on Windows and in the Linux container", () => {
    expect(win({})).toEqual([]);
    expect(linux({})).toEqual([]);
    // The off-site drill: a restic repository in RUNNER_TEMP, with a throwaway password.
    expect(
      win({ HEARTH_BACKUP_REPOSITORY: `${T}/restic-repo`, RESTIC_PASSWORD: "ci-only" }),
    ).toEqual([]);
    // Each end-to-end server on its own CI port, sharing the run's database.
    expect(
      win({
        HEARTH_PORT: "4483",
        HEARTH_ORIGIN: "http://localhost:4483",
        HEARTH_E2E_URL: "http://localhost:4483",
      }),
    ).toEqual([]);
    expect(
      win({
        HEARTH_E2E_PORT: "4484",
        HEARTH_DATABASE_URL: `${WINDOWS.HEARTH_DATABASE_URL}_restored`,
      }),
    ).toEqual([]);
  });

  it("names the run's database after the run and its attempt", () => {
    expect(runDatabase(WINDOWS)).toBe("hearth_ci_37350213541_2");
    expect(runDatabase({ GITHUB_RUN_ID: "1; DROP" })).toBeNull();
  });

  it("refuses the live Postgres, and anything that could lead to it", () => {
    one(
      win({ HEARTH_DATABASE_URL: "postgres://hearth:hearth@localhost:5432/hearth" }),
      "5432 is the live Hearth's",
    );
    one(
      win({ HEARTH_DATABASE_URL: "postgres://hearth@localhost/hearth_ci_37350213541_2" }),
      "must name port 5499",
    );
    one(win({ HEARTH_DATABASE_URL: undefined }), "HEARTH_DATABASE_URL isn't set");
    one(
      win({ HEARTH_TEST_DATABASE_URL: "postgres://hearth@localhost:5432/postgres" }),
      "HEARTH_TEST_DATABASE_URL",
    );
    one(win({ HEARTH_TEST_DATABASE_URL: undefined }), "HEARTH_TEST_DATABASE_URL isn't set");
    one(
      win({ HEARTH_DATABASE_URL: `${WINDOWS.HEARTH_DATABASE_URL}?port=5432` }),
      "can't have a query",
    );
    one(
      win({ HEARTH_DATABASE_URL: "postgres://hearth@192.168.1.5:5499/hearth_ci_37350213541_2" }),
      "on this machine",
    );
    one(win({ PGPORT: undefined }), "PGPORT must be 5499");
    one(win({ PGPORT: "5432" }), "PGPORT must be 5499");
    one(win({ PGHOST: "db.example" }), "PGHOST");
    one(win({ PGSERVICE: "hearth" }), "PGSERVICE is set");
  });

  it("refuses a database that isn't this run's", () => {
    const named = (db: string) =>
      win({ HEARTH_DATABASE_URL: `postgres://hearth@127.0.0.1:5499/${db}` });
    one(named("hearth"), 'names the database "hearth"');
    one(named("hearth_ci_37350213541_1"), "hearth_ci_37350213541_2");
    one(named("hearth_ci_37350213541_20"), "names the database");
    one(win({ GITHUB_RUN_ID: undefined }), "GITHUB_RUN_ID");
  });

  it("refuses the live ports, and a server anywhere but loopback", () => {
    one(win({ HEARTH_PORT: "4400" }), "HEARTH_PORT is 4400");
    one(win({ HEARTH_PORT: undefined }), "would take 4400");
    one(
      win({ HEARTH_ORIGIN: "https://pc.tailnet.ts.net:4443" }),
      "HEARTH_ORIGIN is https://pc.tailnet.ts.net:4443",
    );
    one(win({ HEARTH_ORIGIN: "http://localhost:4400" }), "HEARTH_ORIGIN");
    one(win({ HEARTH_ORIGIN: undefined }), "HEARTH_ORIGIN isn't set");
    one(win({ HEARTH_E2E_URL: "http://localhost:4400" }), "HEARTH_E2E_URL");
    one(win({ HEARTH_E2E_PORT: "4404" }), "HEARTH_E2E_PORT is 4404");
    // The end-to-end tests' own defaults: the live server to drive, and ports outside CI's.
    one(win({ HEARTH_E2E_URL: undefined }), "would drive http://localhost:4400");
    one(linux({ HEARTH_E2E_PORT: undefined }), "HEARTH_E2E_PORT isn't set");
    one(win({ HEARTH_LOCAL_ORIGIN: "http://127.0.0.1:4400" }), "HEARTH_LOCAL_ORIGIN");
    one(win({ HEARTH_HOST: "0.0.0.0" }), "loopback only");
  });

  it("refuses the live data, and any folder outside RUNNER_TEMP", () => {
    one(
      win({ HEARTH_DATA_DIR: "D:\\Hearth\\data" }),
      "HEARTH_DATA_DIR is D:\\Hearth\\data, outside RUNNER_TEMP",
    );
    one(win({ HEARTH_DATA_DIR: "d:/HEARTH/data" }), "outside RUNNER_TEMP");
    one(win({ HEARTH_DATA_DIR: undefined }), "HEARTH_DATA_DIR isn't set");
    one(win({ HEARTH_BACKUP_DIR: undefined }), "HEARTH_BACKUP_DIR isn't set");
    one(win({ HEARTH_BACKUP_DIR: `${T}/../../backups` }), "HEARTH_BACKUP_DIR");
    one(win({ RESTIC_CACHE_DIR: "C:\\Users\\owner\\AppData\\Local\\restic" }), "RESTIC_CACHE_DIR");
    one(
      win({ HEARTH_E2E_PROFILE: "C:\\Users\\owner\\AppData\\Local\\Google\\Chrome\\User Data" }),
      "HEARTH_E2E_PROFILE",
    );
  });

  it("refuses off-site backups: the owner's rclone config, remotes and real passwords", () => {
    one(win({ RCLONE_CONFIG: undefined }), "RCLONE_CONFIG isn't set");
    const owners = "C:\\Users\\owner\\AppData\\Roaming\\rclone\\rclone.conf";
    one(win({ RCLONE_CONFIG: owners }, { [owners]: 512 }), "outside RUNNER_TEMP");
    one(win({}, { [RCLONE]: 120 }), "must be an empty file");
    one(win({ RCLONE_CONFIG: `${T}/missing.conf` }), "must be an empty file");
    one(win({ RCLONE_CONFIG_GDRIVE_TYPE: "drive" }), "RCLONE_CONFIG_GDRIVE_TYPE is set");
    one(win({ HEARTH_BACKUP_REPOSITORY: "rclone:gdrive:hearth-backups" }), "never rclone:");
    one(win({ RESTIC_REPOSITORY: "s3:s3.amazonaws.com/bucket" }), "never s3:");
    one(win({ HEARTH_BACKUP_REPOSITORY: "D:\\Hearth\\restic" }), "outside RUNNER_TEMP");
    one(win({ RESTIC_PASSWORD: "the real one" }), "doesn't start with ci-");
    one(win({ RESTIC_PASSWORD_FILE: "D:\\Hearth\\restic-password.txt" }), "RESTIC_PASSWORD_FILE");
    one(win({ RESTIC_PASSWORD_COMMAND: "type secret" }), "RESTIC_PASSWORD_COMMAND");
    one(win({ HEARTH_VAULT_KEY: "AAAA" }), "HEARTH_VAULT_KEY");
  });

  it("refuses the owner's Chrome and the live services' settings", () => {
    one(win({ HEARTH_CHROME_LAUNCH: undefined }), "HEARTH_CHROME_LAUNCH is unset");
    one(win({ HEARTH_CHROME_LAUNCH: "task" }), "HEARTH_CHROME_LAUNCH is task");
    one(win({ HEARTH_AS_SERVICE: "1" }), "HEARTH_AS_SERVICE=1");
    const chromium = "/home/runner/_work/_cache/ms-playwright/chromium-1200/chrome-linux/chrome";
    const direct = { HEARTH_CHROME_LAUNCH: "direct", HEARTH_CHROME_PATH: chromium };
    // The Linux chrome-launch step: Playwright's Chromium, in a throwaway profile.
    expect(
      linux({ ...direct, HEARTH_CHROME_ARGS: `--headless=new --user-data-dir=${LT}/chrome.x1` }),
    ).toEqual([]);
    one(
      linux({ ...direct, HEARTH_CHROME_ARGS: "--headless=new" }),
      "--user-data-dir under RUNNER_TEMP",
    );
    one(
      linux({ ...direct, HEARTH_CHROME_ARGS: "--user-data-dir=/home/runner/.config/chromium" }),
      "RUNNER_TEMP",
    );
    one(
      linux({
        ...direct,
        HEARTH_CHROME_PATH: "/usr/bin/google-chrome",
        HEARTH_CHROME_ARGS: `--user-data-dir=${LT}/p`,
      }),
      "ms-playwright",
    );
    const program = "D:\\hearth-ci\\ms-playwright\\chromium-1200\\chrome-win\\chrome.exe";
    one(
      win({ ...direct, HEARTH_CHROME_PATH: program, HEARTH_CHROME_ARGS: `--user-data-dir=${T}/p` }),
      "HEARTH_CHROME_LAUNCH is direct",
    );
  });

  it("refuses a .env in the checkout", () => {
    one(win({}, { [`${WORKSPACE}\\.env`]: 40 }), ".env exists");
    one(
      linux({}, { "/home/runner/_work/ReverseEngineer/ReverseEngineer/.env": 40 }),
      ".env exists",
    );
  });

  it("refuses the owner's files without looking at them", () => {
    const looked: string[] = [];
    const watched = host("win32");
    const spy: Host = {
      ...watched,
      exists: (p) => {
        looked.push(p);
        return watched.exists(p);
      },
      fileSize: (p) => {
        looked.push(p);
        return watched.fileSize(p);
      },
    };
    const owners = "C:\\Users\\owner\\AppData\\Roaming\\rclone\\rclone.conf";
    const env = { ...WINDOWS, RCLONE_CONFIG: owners, GITHUB_WORKSPACE: "D:\\Hearth" };
    one(check(env, spy), "RCLONE_CONFIG is C:\\Users\\owner");
    one(check(env, spy), "overlaps the live Hearth's D:\\Hearth");
    expect(looked.filter((p) => /rclone\.conf$|^D:\\Hearth/i.test(p))).toEqual([]);
  });

  it("runs on Windows only in D:\\hearth-ci, apart from the live Hearth", () => {
    one(
      win({ GITHUB_WORKSPACE: "D:\\Hearth\\ci\\ReverseEngineer" }),
      "overlaps the live Hearth's D:\\Hearth",
    );
    one(win({ GITHUB_WORKSPACE: "D:\\" }), "overlaps the live Hearth's D:\\Hearth");
    one(win({ GITHUB_WORKSPACE: "C:\\actions-runner\\_work\\x" }), "outside D:\\hearth-ci");
    one(win({ GITHUB_WORKSPACE: "D:\\hearth-ci2\\x" }), "outside D:\\hearth-ci");
    one(
      win({ RUNNER_TEMP: "C:\\ProgramData\\Hearth\\temp" }),
      "overlaps the live Hearth's C:\\ProgramData\\Hearth",
    );
    one(win({ RUNNER_TEMP: undefined }), "RUNNER_TEMP isn't set");
  });

  it("runs on Linux only in a container that can't reach the PC's drives or Docker", () => {
    one(linux({}, { "/.dockerenv": -1 }), "Not inside a container");
    one(linux({}, { "/var/run/docker.sock": 0 }), "must not reach Docker");
    const drive = "600 584 0:120 / /data rw,noatime - 9p C:\\134 rw,dirsync,aname=drvfs;path=D:\\";
    one(
      linux({}, {}, `${MOUNTS}\n${drive}`),
      "A drive of the PC is mounted in the container (/data)",
    );
    const desktop = "601 584 0:121 /run/desktop/mnt/host/d/Hearth /live rw - fakeowner grpcfuse rw";
    one(linux({}, {}, `${MOUNTS}\n${desktop}`), "(/live)");
  });

  it("prints every problem and fails, without the restic password; or says what it checked", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const bad = {
        ...WINDOWS,
        HEARTH_PORT: "4400",
        RESTIC_PASSWORD: "hunter2-real",
        GITHUB_ACTIONS: "true",
      };
      expect(main(bad, host("win32"))).toBe(1);
      const printed = err.mock.calls.flat().join("\n");
      expect(printed).toContain("::error::HEARTH_PORT is 4400");
      expect(printed).not.toContain("hunter2");
      expect(
        main(
          {
            ...WINDOWS,
            HEARTH_DATABASE_URL: "postgres://hearth:pw@127.0.0.1:5499/hearth_ci_37350213541_2",
          },
          host("win32"),
        ),
      ).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toMatch(
        /CI guard: ok\. .*hearth:\*\*\*@127\.0\.0\.1:5499.*port 4480/,
      );
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });

  it("checks whenever it's run, so a Node without import.meta.main can't skip it", () => {
    const guard = fileURLToPath(new URL("./guard.ts", import.meta.url));
    const run = spawnSync(process.execPath, [guard], {
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("RUNNER_TEMP isn't set");
  });
});
