// The CI guard (D66), as each self-hosted job runs it: `node ops/ci-runner/guard.ts`. It checks
// every time it's run, with no test for being the main module: a Node that strips types but has no
// import.meta.main (23.6 to 24.1) would answer that test with undefined and skip the guard,
// passing without a word. The rules are in guard-rules.ts, which the tests import instead.
import { main } from "./guard-rules.ts";

process.exitCode = main();
