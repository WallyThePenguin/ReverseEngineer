// What the model sees of a tool's input. Zod writes a long pattern beside format "uuid" for every
// record id, about 80 of them across Jarvis's tools, sent with every turn. The format says the
// same thing, and the kernel checks every input anyway, so the model's copy leaves the pattern
// out. Anything this doesn't recognise is passed through as it is.
import { z } from "zod";

export function forModel(input: z.ZodObject): z.ZodRawShape {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(input.shape)) shape[key] = lighten(field as z.ZodType);
  return shape;
}

function lighten(s: z.ZodType): z.ZodType {
  if (s instanceof z.ZodString && s.format === "uuid") {
    const description = s.description;
    return z.string().meta({ format: "uuid", ...(description ? { description } : {}) });
  }
  const def = s._zod.def as unknown as Record<string, unknown>;
  let next: z.ZodType | null = null;
  if (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault) {
    const inner = lighten(def.innerType as z.ZodType);
    if (inner !== def.innerType) next = s.clone({ ...def, innerType: inner } as never);
  } else if (s instanceof z.ZodArray) {
    const element = lighten(def.element as z.ZodType);
    if (element !== def.element) next = s.clone({ ...def, element } as never);
  } else if (s instanceof z.ZodUnion) {
    // Discriminated unions too: they're unions with a key to tell the options apart.
    const options = (def.options as z.ZodType[]).map(lighten);
    if (options.some((o, i) => o !== (def.options as z.ZodType[])[i]))
      next = s.clone({ ...def, options } as never);
  } else if (s instanceof z.ZodObject) {
    const shape = forModel(s);
    if (Object.keys(shape).some((k) => shape[k] !== s.shape[k]))
      next = s.clone({ ...def, shape } as never);
  }
  if (!next) return s;
  return s.description ? next.describe(s.description) : next;
}
