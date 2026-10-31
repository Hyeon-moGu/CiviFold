// Author: HyeonMo Gu
// Created: 2026-11-01

import { describe, expect, it } from "vitest";
import type { GuardStep } from "../pipeline/guard";
import { strictJsonSchema } from "./json-schema";
import { cleanBrief, WriteBriefIn, writeBrief } from "./write-brief";
import type { ToolContext } from "./types";

const step = (ref: string, ok: boolean): GuardStep => ({ ref, tool: "search_incidents", ok, args: {}, data: null });
const briefing = { steps: [step("step_1", true), step("step_2", false)], fact_refs: ["fact_01", "fact_02"] };
const item = (text: string, evidence_refs: string[], section: "reported" | "photos" | "next" = "photos") => ({ section, text, evidence_refs });

describe("cleanBrief", () => {
  it("keeps items citing a successful step or a fact", () => {
    const out = cleanBrief({ summary: "Open hydrant case.", summary_refs: ["fact_01"], items: [item("Search found one.", ["step_1"]), item("Cap missing.", ["fact_02"], "reported")] }, briefing);
    expect(out.items.map((i) => i.evidence_refs)).toEqual([["step_1"], ["fact_02"]]);
    expect(out).toMatchObject({ kept: 2, dropped: 0, summary: { text: "Open hydrant case.", evidence_refs: ["fact_01"] } });
  });

  it("strips invalid refs from a kept item, keeping the order and no repeats", () => {
    const out = cleanBrief({ summary: "", summary_refs: [], items: [item("  Same place.  ", ["step_9", "fact_02", "step_2", "step_1", "fact_02"])] }, briefing);
    expect(out.items).toEqual([{ section: "photos", text: "Same place.", evidence_refs: ["fact_02", "step_1"] }]);
  });

  it("drops items with no valid ref (a failed step counts as none) and counts them", () => {
    const out = cleanBrief({ summary: "x", summary_refs: ["fact_01"], items: [item("A.", ["step_2"]), item("B.", []), item("C.", ["fact_99"]), item("D.", ["fact_01"])] }, briefing);
    expect(out.items.map((i) => i.text)).toEqual(["D."]);
    expect(out).toMatchObject({ kept: 1, dropped: 3 });
  });

  it("drops an item with empty text", () => {
    const out = cleanBrief({ summary: "x", summary_refs: ["fact_01"], items: [item("   ", ["fact_01"])] }, briefing);
    expect(out).toMatchObject({ items: [], kept: 0, dropped: 1 });
  });

  it("keeps at most 12 items and counts the rest as dropped", () => {
    const many = Array.from({ length: 15 }, (_, i) => item(`Item ${i}.`, ["fact_01"]));
    const out = cleanBrief({ summary: "x", summary_refs: ["fact_01"], items: many }, briefing);
    expect(out.items).toHaveLength(12);
    expect(out.items.at(-1)!.text).toBe("Item 11.");
    expect(out).toMatchObject({ kept: 12, dropped: 3 });
  });

  it("drops the summary when none of its refs is valid", () => {
    expect(cleanBrief({ summary: "Looks settled.", summary_refs: ["step_2", "fact_07"], items: [] }, briefing).summary).toBeNull();
  });
});

describe("writeBrief", () => {
  it("runs only inside a brief", async () => {
    await expect(writeBrief.run({ summary: "", summary_refs: [], items: [] }, {} as ToolContext)).rejects.toThrow(/only inside a brief/);
  });

  it("has a strict schema the Responses API accepts", () => {
    expect(() => strictJsonSchema(WriteBriefIn)).not.toThrow();
  });
});
