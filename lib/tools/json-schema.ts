// Author: HyeonMo Gu
// Created: 2026-10-27

// zod → JSON Schema for strict structured output and function tools. Strict mode needs every
// object closed and every property required, so .optional(), .loose() and records are rejected
// here: use .nullable() instead.
import { z } from "zod";
import type { Tool } from "./types";

export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  assertStrict(json, "#");
  return json;
}

export function jsonSchemaFormat(name: string, schema: z.ZodType) {
  return { type: "json_schema" as const, json_schema: { name, schema: strictJsonSchema(schema), strict: true } };
}

export function toFunctionTool(tool: Pick<Tool<z.ZodType, z.ZodType>, "name" | "description" | "input">) {
  return {
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: strictJsonSchema(tool.input),
    strict: true,
  };
}

function assertStrict(node: unknown, path: string): void {
  if (Array.isArray(node)) return node.forEach((n, i) => assertStrict(n, `${path}/${i}`));
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (obj.type === "object") {
    if (obj.additionalProperties !== false) throw new Error(`${path}: object must be closed`);
    const required = new Set((obj.required as string[] | undefined) ?? []);
    const missing = Object.keys((obj.properties as object | undefined) ?? {}).filter((k) => !required.has(k));
    if (missing.length > 0) throw new Error(`${path}: optional properties ${missing.join(", ")}; use .nullable()`);
  }
  for (const [k, v] of Object.entries(obj)) assertStrict(v, `${path}/${k}`);
}
