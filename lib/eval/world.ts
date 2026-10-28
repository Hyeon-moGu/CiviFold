// Author: HyeonMo Gu
// Created: 2026-10-27

import { imageId, type AssetFile } from "../dataset/assets";
import type { EventRow, IncidentRow, PhotoRow } from "../tools/data";
import { assetLocation, at, incidentKey, RECURRENCE_DAY, REPAIR_DAY, T0, TIMELINE } from "./cases";

export type World = { incidents: IncidentRow[]; events: EventRow[]; photos: PhotoRow[]; incidentByReport: Record<string, string> };

export const reportKey = (assetId: string, n: number) => `${assetId}#${n}`;

// Oracle replay: the incident state just before `asOf`, as if every earlier report had been handled
// correctly, so one wrong prediction never leaks into the next case.
export function worldAt(file: AssetFile, asOf: string): World {
  const t = Date.parse(asOf);
  const before = (days: number) => Date.parse(at(days)) < t;
  const world: World = { incidents: [], events: [], photos: [], incidentByReport: {} };

  for (const a of file.assets.filter((x) => x.role === "main")) {
    if (!before(0)) continue;
    const loc = assetLocation(file, a);
    const i1 = incidentKey(a.id, 1);
    const repaired = before(REPAIR_DAY);
    world.incidents.push({
      id: i1,
      category: a.category,
      status: repaired ? "resolved" : "open",
      ...loc,
      title: a.object,
      created_at: T0,
      resolved_at: repaired ? at(REPAIR_DAY) : null,
      recurrence_of: null,
      representative_report_id: reportKey(a.id, 1),
    });
    world.events.push({ incident_id: i1, at: T0, type: "created", summary: "Created from the first report" });
    if (repaired) world.events.push({ incident_id: i1, at: at(REPAIR_DAY), type: "repair_recorded", summary: "Resolved by staff" });

    if (before(RECURRENCE_DAY)) {
      const i2 = incidentKey(a.id, 2);
      world.incidents.push({
        id: i2,
        category: a.category,
        status: "open",
        ...loc,
        title: a.object,
        created_at: at(RECURRENCE_DAY),
        resolved_at: null,
        recurrence_of: i1,
        representative_report_id: reportKey(a.id, 6),
      });
      world.events.push({ incident_id: i2, at: at(RECURRENCE_DAY), type: "recurrence_created", summary: `Recurrence of ${i1}` });
    }

    for (const step of TIMELINE) {
      if (!step.links_to || !before(step.submitted)) continue;
      const incident = incidentKey(a.id, step.links_to);
      const report = reportKey(a.id, step.n);
      world.photos.push({ image_id: imageId(a.id, step.state, step.view), report_id: report, incident_id: incident, observed_at: at(step.observed) });
      world.incidentByReport[report] = incident;
      if (step.n !== 1 && step.n !== 6) {
        world.events.push({ incident_id: incident, at: at(step.submitted), type: "report_linked", summary: `Report ${report} linked` });
      }
    }
  }
  return world;
}
