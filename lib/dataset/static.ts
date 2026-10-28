// Author: HyeonMo Gu
// Created: 2026-10-27

// The dataset definition bundled into the app (imports, not file reads, so a deployment carries them).
import assetsJson from "../../dataset/assets.json";
import manifestJson from "../../dataset/manifest.json";
import { assetLocation } from "../eval/cases";
import { AssetFile, imageId, type Asset, type State, type View } from "./assets";
import { DEMO_BASE } from "./place";

// The holdout stays out of the app (no seeded incident, no sample photo): it is run once, by the evaluation only.
const parsed = AssetFile.parse(assetsJson);
export const ASSET_FILE: AssetFile = { ...parsed, base: DEMO_BASE, assets: parsed.assets.filter((a) => !a.split.startsWith("holdout")) };

type ManifestEntry = { id: string; asset_id: string; state: State; view: View };
const MANIFEST = manifestJson as ManifestEntry[];

export type Sample = {
  id: string; // dataset image id
  asset_id: string;
  category: Asset["category"];
  state: State;
  view: View;
  title: string;
  lat: number;
  lng: number;
};

const STATE_TEXT: Record<State, string> = { damaged_v1: "problem", repaired: "after the fix", damaged_v2: "new problem" };
const VIEW_TEXT: Record<View, string> = {
  front: "from the front",
  across: "from across the street",
  sidewalk: "along the sidewalk",
  closeup: "close-up",
  closeup_side: "close-up from the side",
  across_night: "across the street at night",
  front_night: "from the front at night",
};

/** Photos a visitor can submit: every dataset image except the ones the seeded incidents already hold. */
export function samples(): Sample[] {
  const byId = new Map(ASSET_FILE.assets.map((a) => [a.id, a]));
  const seeded = new Set(ASSET_FILE.assets.filter((a) => a.role === "main").map((a) => imageId(a.id, "damaged_v1", "front")));
  return MANIFEST.filter((m) => !seeded.has(m.id) && byId.has(m.asset_id)).map((m) => {
    const asset = byId.get(m.asset_id)!;
    return {
      id: m.id,
      asset_id: m.asset_id,
      category: asset.category,
      state: m.state,
      view: m.view,
      title: `${asset.object_short} by the ${asset.sign_texts[0]} sign, ${STATE_TEXT[m.state]}, ${VIEW_TEXT[m.view]}`,
      ...assetLocation(ASSET_FILE, asset),
    };
  });
}

export function sample(id: string): Sample | null {
  return samples().find((s) => s.id === id) ?? null;
}
