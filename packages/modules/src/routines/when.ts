// When a routine runs, in words people use: every day, weekdays or one day a week at a time, or
// every few hours. Stored as cron, in the owner's time zone.
import { z } from "zod";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const When = z
  .object({
    every: z.enum(["day", "weekday", "week", "hours"]),
    at: z
      .string()
      .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'A time like "07:30" (24-hour).')
      .default("09:00"),
    day: z.enum(DAYS).optional().describe("For every week: which day."),
    hours: z.number().int().min(1).max(12).optional().describe("For every few hours: how many."),
  })
  .describe("When it runs, in the owner's time zone.");
export type When = z.output<typeof When>;

export function cronFor(w: When): string {
  const [h, m] = w.at.split(":").map(Number) as [number, number];
  switch (w.every) {
    case "day":
      return `${m} ${h} * * *`;
    case "weekday":
      return `${m} ${h} * * 1-5`;
    case "week":
      return `${m} ${h} * * ${DAYS.indexOf(w.day ?? "mon")}`;
    case "hours":
      return `${m} */${w.hours ?? 4} * * *`;
  }
}

function clock(h: number, m: number): string {
  const suffix = h < 12 ? "a.m." : "p.m.";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "weekdays at 7 a.m.", for the schedules cronFor makes; anything else as cron. */
export function describeCron(cron: string): string {
  const [m, h, , , dow] = cron.split(" ");
  const every = /^\*\/(\d+)$/.exec(h ?? "");
  if (every) return `every ${every[1]} hours`;
  const at = clock(Number(h), Number(m));
  if (dow === "*") return `every day at ${at}`;
  if (dow === "1-5") return `weekdays at ${at}`;
  const day = DAY_NAMES[Number(dow)];
  return day ? `${day}s at ${at}` : cron;
}
