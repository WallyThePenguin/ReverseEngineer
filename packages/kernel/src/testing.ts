// Test helpers: a kernel on a fresh database with a manual clock.

import { event } from "@hearth/db";
import { createTestDatabase, type TestDatabase } from "@hearth/db/testing";
import { asc } from "drizzle-orm";
import { ManualClock } from "./clock.ts";
import { toHearthEvent } from "./events.ts";
import { Kernel } from "./kernel.ts";
import { Registry } from "./registry.ts";
import type { HearthEvent, HearthModule } from "./types.ts";

export interface TestKernel {
  kernel: Kernel;
  clock: ManualClock;
  tdb: TestDatabase;
  events(kind?: string): Promise<HearthEvent[]>;
  destroy(): Promise<void>;
}

/** 2026-10-01 10 a.m. Eastern, a Thursday. */
export const TEST_START = "2026-10-01T14:00:00Z";

export async function createTestKernel(
  modules: HearthModule[],
  start = TEST_START,
): Promise<TestKernel> {
  const tdb = await createTestDatabase();
  const clock = new ManualClock(start);
  const kernel = new Kernel({ db: tdb.db, registry: new Registry(modules), clock, log: () => {} });
  return {
    kernel,
    clock,
    tdb,
    async events(kind?: string) {
      const rows = await tdb.db.select().from(event).orderBy(asc(event.seq));
      return rows.map(toHearthEvent).filter((e) => !kind || e.kind === kind);
    },
    destroy: () => tdb.destroy(),
  };
}
