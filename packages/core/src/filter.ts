// One small filter language shared by watches, saved views and Jarvis's tools.
// The shape follows Macro's filter_ast (And / Or / Not over typed conditions), made n-ary so
// it's easy for Jarvis to write as JSON.
import { z } from "zod";

export const CONDITION_OPS = [
  "eq",
  "neq",
  "in",
  "contains",
  "exists",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type Scalar = string | number | boolean | null;

export interface Condition {
  field: string;
  op: ConditionOp;
  value?: Scalar | Scalar[];
}

export type Filter = { and: Filter[] } | { or: Filter[] } | { not: Filter } | Condition;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const conditionSchema: z.ZodType<Condition> = z.object({
  field: z.string().min(1).max(100),
  op: z.enum(CONDITION_OPS),
  value: z.union([scalar, z.array(scalar)]).optional(),
});

export const filterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    z.object({ and: z.array(filterSchema).max(50) }),
    z.object({ or: z.array(filterSchema).max(50) }),
    z.object({ not: filterSchema }),
    conditionSchema,
  ]),
);

/** Reads a dotted path ("payload.status") from a plain object. */
export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function compare(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function test(c: Condition, obj: unknown): boolean {
  const actual = readPath(obj, c.field);
  switch (c.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "eq":
      return actual === c.value;
    case "neq":
      return actual !== c.value;
    case "in":
      return Array.isArray(c.value) && c.value.includes(actual as Scalar);
    case "contains":
      if (typeof actual === "string" && typeof c.value === "string") {
        return actual.toLowerCase().includes(c.value.toLowerCase());
      }
      return Array.isArray(actual) && actual.includes(c.value);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const d = compare(actual, c.value);
      if (d === null) return false;
      if (c.op === "gt") return d > 0;
      if (c.op === "gte") return d >= 0;
      if (c.op === "lt") return d < 0;
      return d <= 0;
    }
  }
}

export function matches(filter: Filter, obj: unknown): boolean {
  if ("and" in filter) return filter.and.every((f) => matches(f, obj));
  if ("or" in filter) return filter.or.some((f) => matches(f, obj));
  if ("not" in filter) return !matches(filter.not, obj);
  return test(filter, obj);
}
