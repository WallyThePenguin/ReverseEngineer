// Page watches (B1): the pages that are due get checked, as the system and with no model.
import { entity, pageWatch } from "@hearth/db";
import { type Kernel, systemCaller } from "@hearth/kernel";
import { and, asc, eq, isNull, lte } from "drizzle-orm";

/** Checks up to `limit` due watches, the longest-waiting first. Returns how many it checked. */
export async function checkDueWatches(
  kernel: Kernel,
  limit = 5,
  log: (msg: string) => void = () => {},
): Promise<number> {
  const due = await kernel.db
    .select({ id: pageWatch.entityId })
    .from(pageWatch)
    .innerJoin(entity, eq(entity.id, pageWatch.entityId))
    .where(
      and(
        eq(pageWatch.active, true),
        isNull(entity.deletedAt),
        lte(pageWatch.nextCheckAt, kernel.clock.now()),
      ),
    )
    .orderBy(asc(pageWatch.nextCheckAt))
    .limit(limit);
  for (const w of due) {
    const res = await kernel.execute("page_watch.check", { id: w.id }, systemCaller());
    if (res.status !== "ok") log(`page watch ${w.id}: ${JSON.stringify(res)}`);
  }
  return due.length;
}
