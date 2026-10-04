// What the driver takes (B1): a tab, the policy the kernel sent with the step, and each verb's
// input, checked here too since the bridge's RPC is open to the owner and Hearth's own processes.
import { z } from "zod";

export const point = z.tuple([z.number().min(0), z.number().min(0)]);
export const ref = z.string().max(40);
export const Policy = z
  .object({
    owner: z.boolean().default(false),
    trusted: z.array(z.string()).max(500).default([]),
    blocked: z.array(z.string()).max(500).default([]),
    pace: z
      .object({
        seconds: z.number().min(0).max(60),
        sites: z.record(z.string(), z.number().min(0).max(300)),
      })
      .nullable()
      .default(null),
    site: z.string().max(253).optional(),
  })
  .default({ owner: false, trusted: [], blocked: [], pace: null });

/** The steps that act on a page, as browser.batch runs them too. */
export const STEPS = {
  click: z.object({
    ref: ref.optional(),
    coordinate: point.optional(),
    button: z.enum(["left", "right", "middle"]).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
    modifiers: z.string().max(40).optional(),
  }),
  hover: z.object({ ref: ref.optional(), coordinate: point.optional() }),
  drag: z.object({
    from: point.optional(),
    to: point.optional(),
    fromRef: ref.optional(),
    toRef: ref.optional(),
  }),
  scroll: z.object({
    coordinate: point.optional(),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(30).optional(),
  }),
  scroll_to: z.object({ ref }),
  type: z.object({
    text: z.string().max(10_000),
    ref: ref.optional(),
    clear: z.boolean().optional(),
  }),
  key: z.object({
    keys: z.string().min(1).max(300),
    repeat: z.number().int().min(1).max(100).optional(),
  }),
  form_input: z.object({ ref, value: z.string().max(2000) }),
  wait: z.object({ ms: z.number().int().min(0).max(10_000) }),
} as const;
export type StepName = keyof typeof STEPS;

export const Base = z.object({
  tabId: z.number().int(),
  policy: Policy,
  screenshot: z.boolean().optional(),
});
export const Read = Base.extend({
  filter: z.enum(["all", "interactive"]).default("all"),
  depth: z.number().int().min(1).max(60).default(30),
  refId: ref.optional(),
  maxChars: z.number().int().min(500).max(100_000).default(15_000),
});
export const Batch = Base.extend({
  steps: z
    .array(
      z.object({
        action: z.enum(Object.keys(STEPS) as [StepName, ...StepName[]]),
        input: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1)
    .max(25),
});
