// Author: HyeonMo Gu
// Created: 2026-10-27

// QC contact sheets, written to .cache/qc/.
//   Per asset, every image in plan order:   npm run contact-sheet -- [--only H1,W1]
//   One view across assets, larger tiles:   npm run contact-sheet -- --view damaged_v2_front [--split test]
// Small tiles miss damage that the model never drew, so check recurrence and night views with --view.
import { mkdir, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { imagePlan, loadAssets } from "../lib/dataset/assets";

const GAP = 6;

type Tile = { data: Buffer; width: number };

async function tile(id: string, label: string, height: number): Promise<Tile | null> {
  const bytes = await readFile(`dataset/images/${id}.webp`).catch(() => null);
  if (!bytes) return null;
  const { data, info } = await sharp(bytes).resize({ height }).jpeg().toBuffer({ resolveWithObject: true });
  const caption = Buffer.from(
    `<svg width="${info.width}" height="22"><rect width="100%" height="22" fill="black" opacity="0.6"/>` +
      `<text x="6" y="16" font-size="14" font-family="sans-serif" fill="white">${label}</text></svg>`,
  );
  return { data: await sharp(data).composite([{ input: caption, top: 0, left: 0 }]).jpeg().toBuffer(), width: info.width };
}

async function sheet(rows: Tile[][], height: number, out: string) {
  const width = Math.max(...rows.map((r) => r.reduce((s, t) => s + t.width + GAP, -GAP)));
  const composites = rows.flatMap((row, y) => {
    let left = 0;
    return row.map((t) => {
      const c = { input: t.data, left, top: y * (height + GAP) };
      left += t.width + GAP;
      return c;
    });
  });
  await sharp({ create: { width, height: rows.length * (height + GAP) - GAP, channels: 3, background: "#ffffff" } })
    .composite(composites)
    .jpeg({ quality: 80 })
    .toFile(out);
}

async function main() {
  const { values } = parseArgs({ options: { only: { type: "string" }, view: { type: "string" }, split: { type: "string" } } });
  const { assets } = await loadAssets();
  const byId = new Map(assets.map((a) => [a.id, a]));
  const chosen = assets.filter((a) => (!values.only || values.only.split(",").includes(a.id)) && (!values.split || a.split === values.split));
  await mkdir(".cache/qc", { recursive: true });

  if (values.view) {
    const height = 420;
    const tiles: Tile[] = [];
    for (const a of chosen) {
      const step = imagePlan(a, a.pair_of ? (byId.get(a.pair_of) ?? null) : null).find((s) => `${s.state}_${s.view}` === values.view);
      const t = step && (await tile(step.id, `${a.id} ${values.view}`, height));
      if (t) tiles.push(t);
    }
    const rows = Array.from({ length: Math.ceil(tiles.length / 3) }, (_, i) => tiles.slice(i * 3, i * 3 + 3));
    const out = `.cache/qc/view-${values.view}.jpg`;
    if (tiles.length > 0) await sheet(rows, height, out);
    console.log(`${values.view}: ${tiles.length} images → ${out}`);
    return;
  }

  for (const a of chosen) {
    const tiles: Tile[] = [];
    for (const s of imagePlan(a, a.pair_of ? (byId.get(a.pair_of) ?? null) : null)) {
      const t = await tile(s.id, `${s.state} / ${s.view}`, 260);
      if (t) tiles.push(t);
    }
    if (tiles.length === 0) continue;
    await sheet([tiles], 260, `.cache/qc/${a.id}.jpg`);
    console.log(`${a.id}: ${tiles.length} images → .cache/qc/${a.id}.jpg`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
