// Author: HyeonMo Gu
// Created: 2026-10-27

// Runs the fast path on local photos against a small JSON world of existing incidents.
// Usage: npm run analyze -- <photo> [<photo> ...] [--world scripts/worlds/smoke.json] [--observed ISO] [--category trash] [--asked]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { z } from "zod";
import { defaultMode, spent } from "../lib/meta/call";
import { analyze } from "../lib/pipeline/analyze";
import { memoryData, type PhotoRow } from "../lib/tools/data";
import { memoryImages, type ImageRow } from "../lib/tools/images";
import { Category, IncidentStatus, type ToolContext } from "../lib/tools/types";

const World = z.object({
  asOf: z.string(),
  report_at: z.object({ lat: z.number(), lng: z.number() }),
  incidents: z.array(
    z.object({
      id: z.string(),
      category: Category,
      status: IncidentStatus,
      lat: z.number(),
      lng: z.number(),
      title: z.string(),
      created_at: z.string(),
      resolved_at: z.string().nullable(),
      recurrence_of: z.string().nullable(),
      photos: z.array(z.object({ path: z.string(), report_id: z.string(), observed_at: z.string() })),
    }),
  ),
});

async function loadImage(file: string, id: string, reportId: string): Promise<{ row: ImageRow; bytes: Buffer }> {
  const bytes = await readFile(file);
  const { width = 0, height = 0, format = "jpeg" } = await sharp(bytes).metadata();
  return {
    row: { id, report_id: reportId, kind: "original", source_image_id: null, width, height, mime: `image/${format}`, is_synthetic: true },
    bytes,
  };
}

const imageId = (file: string) => `img_${path.basename(file, path.extname(file))}`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      world: { type: "string", default: "scripts/worlds/smoke.json" },
      observed: { type: "string" },
      category: { type: "string" },
      asked: { type: "boolean", default: false },
    },
  });
  if (positionals.length === 0) throw new Error("Pass at least one photo path");
  const world = World.parse(JSON.parse(await readFile(values.world, "utf8")));

  const photos: PhotoRow[] = [];
  const seed: Array<{ row: ImageRow; bytes: Buffer }> = [];
  const incidentByReport: Record<string, string> = {};
  for (const inc of world.incidents) {
    for (const p of inc.photos) {
      seed.push(await loadImage(p.path, imageId(p.path), p.report_id));
      photos.push({ image_id: imageId(p.path), report_id: p.report_id, incident_id: inc.id, observed_at: p.observed_at });
      incidentByReport[p.report_id] = inc.id;
    }
  }
  // New photos get their own ids, so a world photo can also be submitted as a new report.
  const newPhotos = await Promise.all(positionals.map((file) => loadImage(file, `${imageId(file)}_new`, `r_new_${path.basename(file)}`)));
  // Tools only compare a report's own photo, so each run names the new photo's report.
  const ctx: ToolContext = {
    reportId: "cli",
    runId: null,
    mode: defaultMode(),
    budget: { usdLeft: Infinity, deadline: Infinity },
    data: memoryData({
      asOf: world.asOf,
      incidents: world.incidents.map(({ photos: _, ...row }) => ({ ...row, representative_report_id: null })),
      photos,
    }),
    images: memoryImages({ images: [...seed, ...newPhotos], incidentByReport }),
  };

  const outDir = path.resolve(".cache/analyze");
  await mkdir(outDir, { recursive: true });
  for (const [i, file] of positionals.entries()) {
    const { row } = newPhotos[i]!;
    ctx.reportId = row.report_id;
    const a = await analyze(
      {
        report_id: row.report_id,
        image_id: row.id,
        ...world.report_at,
        observed_at: values.observed ?? world.asOf,
        description: null,
        category_hint: values.category ?? null,
        already_asked: values.asked,
      },
      ctx,
    );
    const d = a.decision;
    console.log(`\n${file}`);
    console.log(`  triage   ${a.triage.category} "${a.triage.sam_prompt}" quality=${a.triage.image_quality} damage=${a.triage.damage_present}`);
    console.log(`  search   ${a.candidates.map((c) => `${c.incident_id}(${c.status}, ${c.distance_m}m)`).join(", ") || "none"}`);
    for (const c of a.comparisons) {
      const r = c.result?.asset_match;
      console.log(`  stage ${c.stage}  ${c.incident_id}: ${r ? `${r.verdict} ${r.confidence}` : "failed"}${r?.evidence.length ? `: ${r.evidence.join(" | ")}` : ""}`);
    }
    for (const e of a.errors) console.log(`  error    ${e}`);
    console.log(`  → ${d.label}${d.incident_id ? ` ${d.incident_id}` : ""} [${d.rule_id}] conf=${d.confidence}${d.missing_info.length ? ` ask=${d.missing_info.join(",")}` : ""}`);
    for (const r of d.reasons) console.log(`    ${r.rule_id}: ${r.text}`);
    console.log(`  $${a.cost_usd.toFixed(4)} · ${(a.latency_ms / 1000).toFixed(1)}s`);
    await writeFile(path.join(outDir, `${path.basename(file)}.json`), JSON.stringify(a, null, 2));
  }
  console.log(`\nmode=${ctx.mode} · total $${spent().toFixed(4)} · results in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
