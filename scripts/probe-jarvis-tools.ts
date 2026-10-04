// The update gate's check that Claude accepts every tool Jarvis sends (ops/windows/update.ps1;
// D54, D57): one cheap call carrying the whole tool list, built the way a turn builds it. Only a
// rejected request fails the update. A usage limit, a busy API or no network says nothing about
// the new code, so those warn and pass.
import { connect, databaseUrl } from "../packages/db/src/index.ts";
import { probeToolSchemas } from "../packages/jarvis/src/probe.ts";
import { Kernel, Registry } from "../packages/kernel/src/index.ts";
import { ALL_MODULES } from "../packages/modules/src/index.ts";

const REJECTED = new Set(["bad_tool", "invalid_request"]);

const database = connect(databaseUrl(), { max: 1 });
try {
  const kernel = new Kernel({ db: database.db, registry: new Registry(ALL_MODULES) });
  const res = await probeToolSchemas(kernel);
  if (res.ok) {
    console.log(`Claude accepts all ${res.tools} of Jarvis's tools.`);
  } else if (REJECTED.has(res.failure.kind)) {
    const which = res.failure.tool ?? `tool #${res.failure.toolIndex ?? "?"}`;
    console.error(`Claude rejected Jarvis's tools (${which}): ${res.failure.message}`);
    process.exitCode = 1;
  } else {
    console.warn(
      `Couldn't check Jarvis's tools (${res.failure.kind}); not holding the update for it: ${res.failure.message}`,
    );
  }
} finally {
  await database.close();
}
