// Author: HyeonMo Gu
// Created: 2026-10-28

import { describe, expect, it } from "vitest";
import { Aliases } from "./aliases";

describe("Aliases", () => {
  it("names evaluation ids neutrally and maps a call back", () => {
    const names = new Aliases();
    names.collect({ report: { report_id: "report:H15-t6", image_id: "syn_H15_damaged_v2_front@H15-t6" }, around: [{ incident_id: "H15/I1", photo_ids: ["syn_H15_damaged_v1_front"] }] });
    const seen = names.mask("REPORT report:H15-t6 photo syn_H15_damaged_v2_front@H15-t6 vs H15/I1 (syn_H15_damaged_v1_front); Report H15#2 linked");
    expect(seen).toBe("REPORT report_01 photo photo_01 vs incident_01 (photo_02); Report report_02 linked");
    expect(seen).not.toMatch(/H15|damaged|t6/);
    expect(JSON.parse(names.unmask(JSON.stringify({ new_image_id: "photo_01", candidate_image_id: "photo_02" })))).toEqual({
      new_image_id: "syn_H15_damaged_v2_front@H15-t6",
      candidate_image_id: "syn_H15_damaged_v1_front",
    });
  });

  it("masks ids inside tool output JSON and keeps the same name for the same id", () => {
    const names = new Aliases();
    const data = { chosen: { object_crop_id: "img_0a1b2c3d4e5f", context_crop_id: "img_ffeeddccbbaa" }, candidate_incident_id: "inc_h1", recurrence_of: "inc_h2" };
    names.collect(data);
    expect(names.mask(JSON.stringify(data))).toBe('{"chosen":{"object_crop_id":"photo_01","context_crop_id":"photo_02"},"candidate_incident_id":"incident_01","recurrence_of":"incident_02"}');
    expect(names.mask("inc_h1 again")).toBe("incident_01 again");
  });

  it("does not touch a longer id that only starts like a known one, and leaves unknown names alone", () => {
    const names = new Aliases();
    names.collect({ incident_id: "inc_h1" });
    expect(names.mask("inc_h1 inc_h12")).toBe("incident_01 incident_02");
    expect(names.unmask('{"incident_id":"incident_09"}')).toBe('{"incident_id":"incident_09"}');
  });

  it("unmasks a name whatever its case, as a model writes it at the start of a sentence", () => {
    const names = new Aliases();
    names.collect({ incident_id: "inc_w1" });
    expect(names.unmask("Incident_01 was opened on Oct 29.")).toBe("inc_w1 was opened on Oct 29.");
  });
});
