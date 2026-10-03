// Phone notifications (M6). Mirrors migrations/0016_push.up.sql.
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const pushSubscription = pgTable("push_subscription", {
  endpoint: text("endpoint").primaryKey(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  label: text("label").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSentAt: ts("last_sent_at"),
});
