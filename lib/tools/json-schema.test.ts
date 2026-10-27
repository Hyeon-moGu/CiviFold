// Author: HyeonMo Gu
// Created: 2026-10-27

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonSchemaFormat, strictJsonSchema, toFunctionTool } from "./json-schema";
import { Box, CompareResult } from "./types";

describe("strictJsonSchema", () => {
  it("accepts the shared schemas", () => {
    expect(() => strictJsonSchema(CompareResult)).not.toThrow();
    expect(() => strictJsonSchema(Box)).not.toThrow();
  });

  it("drops $schema and keeps nullable as a type union", () => {
    const json = strictJsonSchema(z.object({ note: z.string().nullable() }).strict());
    expect(json).not.toHaveProperty("$schema");
    expect(JSON.stringify(json)).toContain("null");
  });

  it("rejects optional properties, open objects and records, including nested ones", () => {
    expect(() => strictJsonSchema(z.object({ a: z.string().optional() }).strict())).toThrow(/optional properties a/);
    expect(() => strictJsonSchema(z.object({ a: z.string() }).loose())).toThrow(/closed/);
    expect(() => strictJsonSchema(z.object({ a: z.array(z.object({ b: z.number() }).loose()) }).strict())).toThrow(/closed/);
    expect(() => strictJsonSchema(z.object({ a: z.record(z.string(), z.number()) }).strict())).toThrow(/closed/);
  });
});

describe("formats", () => {
  it("builds a chat response_format", () => {
    const f = jsonSchemaFormat("box", Box);
    expect(f.type).toBe("json_schema");
    expect(f.json_schema).toMatchObject({ name: "box", strict: true });
  });

  it("builds a function tool from a tool's input", () => {
    const t = toFunctionTool({ name: "noop", description: "Does nothing.", input: z.object({ id: z.string() }).strict() });
    expect(t).toMatchObject({ type: "function", name: "noop", strict: true, parameters: { required: ["id"] } });
  });
});
