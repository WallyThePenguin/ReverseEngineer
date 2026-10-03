// Every Hearth module. Each one meets the Jarvis contract: events, actions, knowledge and
// reflexes (PLAN.md section 6.1).
import type { HearthModule } from "@hearth/kernel";
import { approvalsModule } from "./approvals/index.ts";
import { assistantModule } from "./assistant/index.ts";
import { browserModule } from "./browser/index.ts";
import { calendarModule } from "./calendar/index.ts";
import { chatModule } from "./chat/index.ts";
import { graphModule } from "./graph/index.ts";
import { inboxModule } from "./inbox/index.ts";
import { memoryModule } from "./memory/index.ts";
import { notesModule } from "./notes/index.ts";
import { peopleModule } from "./people/index.ts";
import { routinesModule } from "./routines/index.ts";
import { systemModule } from "./system/index.ts";
import { tasksModule } from "./tasks/index.ts";

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
];

export { renderBrief, renderDigest } from "./assistant/brief.ts";
export {
  BROWSER_SERVICE,
  type BrowserClient,
  type BrowserStatus,
  HttpBrowserClient,
  internalBrowserClient,
  OFFLINE_MESSAGE,
  REQUEST_TIMEOUT_MS,
  serverUrl,
  type TabInfo,
} from "./browser/client.ts";
export { pacing } from "./browser/pace.ts";
export { VAULT_SERVICE, Vault, vaultFromEnv } from "./browser/vault.ts";
export type { EventView } from "./calendar/store.ts";
export { appendLog, type LogEntry, type LogKind, routeLane } from "./chat/index.ts";
export { GOOGLE_SERVICE, GoogleClient, googleFromEnv, SCOPES } from "./google/client.ts";
export { recallMemory, renderMemory } from "./memory/index.ts";
export { parseChecklist } from "./notes/checklist.ts";
export { loadTask, type TaskView } from "./tasks/index.ts";
export {
  approvalsModule,
  assistantModule,
  browserModule,
  calendarModule,
  chatModule,
  graphModule,
  inboxModule,
  memoryModule,
  notesModule,
  peopleModule,
  routinesModule,
  systemModule,
  tasksModule,
};
