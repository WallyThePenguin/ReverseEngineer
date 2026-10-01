// Task vocabulary (PLAN.md section 8.4).

export const TASK_STATUSES = [
  "not_started",
  "in_progress",
  "in_review",
  "completed",
  "canceled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  in_review: "In Review",
  completed: "Completed",
  canceled: "Canceled",
};

export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export function isClosedStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "canceled";
}

export function formatTaskNumber(n: number): string {
  return `T-${n}`;
}

export function parseTaskNumber(text: string): number | null {
  const m = /^T-(\d{1,9})$/i.exec(text.trim());
  return m ? Number(m[1]) : null;
}

/** Branch names embed the task number, as Macro does: jarvis/T-123-fix-login. */
export function taskBranchName(prefix: string, n: number, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `${prefix}/${formatTaskNumber(n)}${slug ? `-${slug}` : ""}`;
}

/** Task numbers mentioned in text such as a PR title ("Fix login (T-123)"). */
export function findTaskNumbers(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\bT-(\d{1,9})\b/gi)) out.add(Number(m[1]));
  return [...out];
}
