// Author: HyeonMo Gu
// Created: 2026-11-04

// Downloads the photos of the SF 311 real-photo check (eval/sf311/sets.json) and normalizes them the way the app
// normalizes an upload, into .cache/sf311/<set>_<first|dup|after>.jpg, where scripts/worlds/sf311/ expects them.
// The photos are residents' uploads that DataSF publishes; they are not copied into this repository.
// Usage: npx tsx scripts/sf311-photos.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

type Request = { case: string; photo_url: string };
type SpotSet = { set: string; selected: boolean; first: Request; dup: Request; after: Request };

async function main() {
  const { sets } = JSON.parse(await readFile("eval/sf311/sets.json", "utf8")) as { sets: SpotSet[] };
  await mkdir(".cache/sf311", { recursive: true });
  for (const s of sets.filter((x) => x.selected)) {
    for (const role of ["first", "dup", "after"] as const) {
      const res = await fetch(s[role].photo_url);
      if (!res.ok) throw new Error(`${s.set} ${role} (case ${s[role].case}): HTTP ${res.status}`);
      const original = Buffer.from(await res.arrayBuffer());
      // The same normalization as an upload (lib/server/http.ts): upright, longest side 1920 px, JPEG.
      const normalized = await sharp(original).rotate().resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
      await writeFile(`.cache/sf311/${s.set}_${role}.jpg`, normalized);
    }
    console.log(`${s.set}: 3 photos`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
