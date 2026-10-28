// Author: HyeonMo Gu
// Created: 2026-10-27

// Generates the synthetic dataset with Muse Image and records it in dataset/manifest.json.
// Existing files are kept, so a rerun resumes. --regen makes fresh samples of the named images.
// Usage: npm run gen-dataset -- [--split dev|val|test|holdout|holdout2|holdout3|all] [--only H1,W1] [--regen syn_H1_damaged_v1_across,...]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { imagePlan, loadAssets, type Asset, type ImageStep } from "../lib/dataset/assets";
import { spent } from "../lib/meta/call";
import { editImage, generateImage } from "../lib/meta/image";

const IMAGE_DIR = "dataset/images";
const MANIFEST = "dataset/manifest.json";
const CONCURRENCY = 4;

type ManifestEntry = Omit<ImageStep, "from"> & {
  file: string;
  source_image: string | null;
  width: number;
  height: number;
  synthetic: true;
  generator: "muse-image-1.0";
};

const fileOf = (id: string) => path.join(IMAGE_DIR, `${id}.webp`);

async function main() {
  const { values } = parseArgs({
    options: { split: { type: "string", default: "dev" }, only: { type: "string" }, regen: { type: "string" } },
  });
  const { assets } = await loadAssets();
  const byId = new Map(assets.map((a) => [a.id, a]));
  const only = values.only?.split(",");
  const regen = new Set(values.regen?.split(",") ?? []);
  const chosen = assets.filter((a) => (values.split === "all" || a.split === values.split) && (!only || only.includes(a.id)));

  await mkdir(IMAGE_DIR, { recursive: true });
  const manifest = new Map<string, ManifestEntry>(
    (JSON.parse(await readFile(MANIFEST, "utf8").catch(() => "[]")) as ManifestEntry[]).map((e) => [e.id, e]),
  );
  let writes = Promise.resolve();
  const record = (entry: ManifestEntry) => {
    manifest.set(entry.id, entry);
    const sorted = [...manifest.values()].sort((a, b) => a.id.localeCompare(b.id));
    writes = writes.then(() => writeFile(MANIFEST, JSON.stringify(sorted, null, 2) + "\n"));
  };

  const failed: string[] = [];
  const runAsset = async (a: Asset) => {
    for (const step of imagePlan(a, a.pair_of ? (byId.get(a.pair_of) ?? null) : null)) {
      const existing = await readFile(fileOf(step.id)).catch(() => null);
      if (existing && !regen.has(step.id)) continue;
      const input = step.from ? await readFile(fileOf(step.from)).catch(() => null) : null;
      if (step.from && !input) {
        failed.push(`${step.id}: missing input ${step.from}`);
        return;
      }
      try {
        const mode = regen.has(step.id) ? "live" : undefined;
        const { bytes, call } = input
          ? await editImage(input, step.prompt, { size: step.size, mode })
          : await generateImage(step.prompt, { size: step.size, mode });
        await writeFile(fileOf(step.id), bytes);
        const { width = 0, height = 0 } = await sharp(bytes).metadata();
        const { from, ...rest } = step;
        record({ ...rest, file: fileOf(step.id), source_image: from, width, height, synthetic: true, generator: "muse-image-1.0" });
        console.log(`✓ ${step.id} ${width}x${height}${call.cached ? " (cached)" : ""}`);
      } catch (err) {
        failed.push(`${step.id}: ${String(err).slice(0, 200)}`);
        return; // later steps of this asset depend on this one
      }
    }
  };

  // Look-alikes are edited from their pair's front photo, so main assets go first.
  for (const group of [chosen.filter((a) => a.role === "main"), chosen.filter((a) => a.role === "lookalike")]) {
    const queue = [...group];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (let a = queue.shift(); a; a = queue.shift()) await runAsset(a);
    }));
  }
  await writes;
  for (const f of failed) console.log(`✗ ${f}`);
  console.log(`\n${chosen.length} assets · ${failed.length} failed · spent $${spent().toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
