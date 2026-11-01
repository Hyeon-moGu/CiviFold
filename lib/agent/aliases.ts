// Author: HyeonMo Gu
// Created: 2026-10-28

// The agent sees photos, incidents and reports by neutral names (photo_01, incident_02, report_01). Real ids can
// carry what the agent is asked to find out: an evaluation photo is named after its asset and state
// (syn_H15_damaged_v2_front), a report after its case type (report:H15-t6), and two incidents of different
// assets have different prefixes. The server keeps the real ids; every call is mapped back before it runs.
type Kind = "photo" | "incident" | "report";

// Fields that hold ids in tool data and in the pipeline's analysis.
const FIELD_KIND: Array<[RegExp, Kind]> = [
  [/(^|_)(image_ids?|photo_ids?|crop_id)$/, "photo"],
  [/(^|_)incident_id$|^recurrence_of$/, "incident"],
  [/(^|_)report_id$/, "report"],
];

// Ids written into free text (event summaries, rule reasons, tool errors), in either world: evaluation
// (syn_…, H15/I1, H15#2, report:H15-t6) or app (img_…, inc_…, rep_…).
const SHAPES: Array<[RegExp, Kind]> = [
  [/\bsyn_[A-Za-z0-9_]+(?:@[A-Za-z0-9:_-]+)?/g, "photo"],
  [/\bimg_[A-Za-z0-9_]+/g, "photo"],
  [/\b[A-Z]+\d+\/I\d+\b/g, "incident"],
  [/\binc_[A-Za-z0-9_]+/g, "incident"],
  [/\breport:[A-Za-z0-9_-]+|\b[A-Z]+\d+#\d+\b|\brep_[A-Za-z0-9_]+/g, "report"],
];

// Case-insensitive: a model sometimes writes "Incident_01" at the start of a sentence.
const ALIAS = /\b(photo|incident|report)_(\d{2,})\b/gi;

export class Aliases {
  private alias = new Map<string, string>();
  private real = new Map<string, string>();
  private count: Record<Kind, number> = { photo: 0, incident: 0, report: 0 };

  private add(kind: Kind, id: string): void {
    if (this.alias.has(id) || this.real.has(id)) return;
    this.count[kind] += 1;
    const name = `${kind}_${String(this.count[kind]).padStart(2, "0")}`;
    this.alias.set(id, name);
    this.real.set(name, id);
  }

  /** Registers every id held in an id field, in the order met, so the names follow the data. */
  collect(value: unknown, key = ""): void {
    if (Array.isArray(value)) return value.forEach((v) => this.collect(v, key));
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) this.collect(v, k);
      return;
    }
    if (typeof value !== "string" || value === "") return;
    const kind = FIELD_KIND.find(([re]) => re.test(key))?.[1];
    if (kind) this.add(kind, value);
  }

  /** The text the model sees: registered ids first (longest first), then anything shaped like an id. */
  mask(text: string): string {
    for (const [re, kind] of SHAPES) for (const m of text.matchAll(re)) this.add(kind, m[0]);
    const ids = [...this.alias.keys()].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
    if (ids.length === 0) return text;
    return text.replace(new RegExp(`(?<![A-Za-z0-9_])(?:${ids.join("|")})(?![A-Za-z0-9_])`, "g"), (id) => this.alias.get(id)!);
  }

  /** The model's call with real ids; an unknown name is left for the tool to reject. */
  unmask(text: string): string {
    return text.replace(ALIAS, (name) => this.real.get(name.toLowerCase()) ?? name);
  }
}
