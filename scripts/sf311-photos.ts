// Author: HyeonMo Gu
// Created: 2026-11-04

// Downloads the photos of the SF 311 real-photo checks and normalizes them the way the app normalizes an upload:
// the sets (eval/sf311/sets.json) into .cache/sf311/<set>_<first|dup|after>.jpg for scripts/worlds/sf311/, and the
// pairs picked by eye (eval/sf311/pairs.json) into .cache/sf311pairs/<pair>_<1|2>.jpg for scripts/worlds/sf311-pairs/.
// The photos are residents' uploads that DataSF publishes; they are not copied into this repository.
// Usage: npx tsx scripts/sf311-photos.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

type Request = { case: string; photo_url: string };
type SpotSet = { set: string; selected: boolean; first: Request; dup: Request; after: Request };
type Pair = { pair: string; picked: boolean; earlier: Request; later: Request };

// The same normalization as an upload (lib/server/http.ts): upright, longest side 1920 px, JPEG.
async function fetchPhoto(url: string, label: string, out: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const original = Buffer.from(await res.arrayBuffer());
  const normalized = await sharp(original).rotate().resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  await writeFile(out, normalized);
}

async function main() {
  const { sets } = JSON.parse(await readFile("eval/sf311/sets.json", "utf8")) as { sets: SpotSet[] };
  await mkdir(".cache/sf311", { recursive: true });
  for (const s of sets.filter((x) => x.selected)) {
    for (const role of ["first", "dup", "after"] as const) {
      await fetchPhoto(s[role].photo_url, `${s.set} ${role} (case ${s[role].case})`, `.cache/sf311/${s.set}_${role}.jpg`);
    }
    console.log(`${s.set}: 3 photos`);
  }
  const { pairs } = JSON.parse(await readFile("eval/sf311/pairs.json", "utf8")) as { pairs: Pair[] };
  await mkdir(".cache/sf311pairs", { recursive: true });
  for (const p of pairs.filter((x) => x.picked)) {
    await fetchPhoto(p.earlier.photo_url, `${p.pair} earlier (case ${p.earlier.case})`, `.cache/sf311pairs/${p.pair}_1.jpg`);
    await fetchPhoto(p.later.photo_url, `${p.pair} later (case ${p.later.case})`, `.cache/sf311pairs/${p.pair}_2.jpg`);
  }
  console.log(`${pairs.filter((x) => x.picked).length} pairs: 2 photos each`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
