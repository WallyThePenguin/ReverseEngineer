// Every Hearth module. Each one meets the Jarvis contract: events, actions, knowledge and
// reflexes (PLAN.md section 6.1).
import type { HearthModule } from "@hearth/kernel";
import { approvalsModule } from "./approvals/index.ts";
import { assistantModule } from "./assistant/index.ts";
import { browserModule } from "./browser/index.ts";
import { calendarModule } from "./calendar/index.ts";
import { canvasModule } from "./canvas/index.ts";
import { chatModule } from "./chat/index.ts";
import { githubModule } from "./github/index.ts";
import { graphModule } from "./graph/index.ts";
import { inboxModule } from "./inbox/index.ts";
import { mailModule } from "./mail/index.ts";
import { meetingsModule } from "./meetings/index.ts";
import { memoryModule } from "./memory/index.ts";
import { notesModule } from "./notes/index.ts";
import { notionModule } from "./notion/index.ts";
import { peopleModule } from "./people/index.ts";
import { routinesModule } from "./routines/index.ts";
import { sheetsModule } from "./sheets/index.ts";
import { slackModule } from "./slack/index.ts";
import { systemModule } from "./system/index.ts";
import { tasksModule } from "./tasks/index.ts";
import { voiceModule } from "./voice/index.ts";

export const ALL_MODULES: HearthModule[] = [
  graphModule,
  notesModule,
  tasksModule,
  chatModule,
  inboxModule,
  approvalsModule,
  peopleModule,
  systemModule,
  assistantModule,
  browserModule,
  memoryModule,
  calendarModule,
  routinesModule,
  mailModule,
  meetingsModule,
  voiceModule,
  canvasModule,
  slackModule,
  githubModule,
  notionModule,
  sheetsModule,
];

export { renderBrief, renderDigest } from "./assistant/brief.ts";
export { CANCEL_CHANNEL } from "./assistant/turns.ts";
export {
  BROWSER_SERVICE,
  type BrowserClient,
  BrowserError,
  type BrowserStatus,
  chromeError,
  type DialogInfo,
  HttpBrowserClient,
  internalBrowserClient,
  OFFLINE_MESSAGE,
  REQUEST_TIMEOUT_MS,
  reasonOf,
  serverUrl,
  type TabInfo,
} from "./browser/client.ts";
export { type BrowserHealth, browserHealth } from "./browser/health.ts";
export { pacing } from "./browser/pace.ts";
export { BRIDGE_PROTOCOL, EXTENSION_ID } from "./browser/protocol.ts";
export {
  runSelfTest,
  type SelfTestResult,
  type SelfTestStep,
  TEST_PAGE,
  TEST_PAGE_CSP,
  TEST_PAGE_PATH,
} from "./browser/self-test.ts";
export { VAULT_SERVICE, Vault, vaultFromEnv } from "./browser/vault.ts";
export type { EventView } from "./calendar/store.ts";
export { appendLog, type LogEntry, type LogKind, routeLane } from "./chat/index.ts";
export { MENTION_SETTLE_MS } from "./chat/mention.ts";
export { FakeGithub, GITHUB_SERVICE, type GithubApi, httpGithub } from "./github/index.ts";
export { GOOGLE_SERVICE, GoogleClient, googleFromEnv, SCOPES } from "./google/client.ts";
export {
  BLOB_SERVICE,
  BlobStore,
  blobsFromEnv,
  DAYTIME_DRAFTS,
  type DraftView,
  type MessageView,
  messageAttachment,
  messageHtml,
  NEEDS_REPLY,
  type ThreadSummary,
  type ThreadView,
  threadsToDraft,
} from "./mail/index.ts";
export { recallMemory, renderMemory } from "./memory/index.ts";
export { parseChecklist } from "./notes/checklist.ts";
export {
  ExportError,
  readExport,
  UPLOADS_SERVICE,
  type Uploads,
} from "./notion/index.ts";
export {
  isSealed,
  openGoogleTokens,
  type Sealer,
  sealGoogleTokens,
  secretMigrations,
} from "./secrets.ts";
export {
  FakeSlack,
  httpSlack,
  SLACK_ASKS,
  SLACK_FOR_YOU,
  SLACK_SCOPES,
  SLACK_SERVICE,
  type SlackApi,
  taskAbout,
} from "./slack/index.ts";
export {
  type HealthRecord,
  type HealthStatus,
  type JudgedHealth,
  judgeHealth,
  REPORT_EVERY_MS,
  roughly,
} from "./system/index.ts";
export { loadTask, type TaskView } from "./tasks/index.ts";
export { POLISH_SERVICE, type Polisher, polisherFromEnv } from "./voice/polish.ts";
export {
  approvalsModule,
  assistantModule,
  browserModule,
  calendarModule,
  chatModule,
  githubModule,
  graphModule,
  inboxModule,
  mailModule,
  meetingsModule,
  memoryModule,
  notesModule,
  notionModule,
  peopleModule,
  routinesModule,
  sheetsModule,
  slackModule,
  systemModule,
  tasksModule,
  voiceModule,
};
