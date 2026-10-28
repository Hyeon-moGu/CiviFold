// Author: HyeonMo Gu
// Created: 2026-10-27

// Sample messages a visitor can send without a photo: typed text, or a recording made with the macOS
// text-to-speech voices (scripts/gen-voices.ts). Each one is placed at a dataset asset, so the incidents
// around it are the seeded ones.
import { assetLocation } from "../eval/cases";
import type { Category } from "../tools/types";
import { ASSET_FILE } from "./static";

export type MessageSample = {
  id: string;
  kind: "voice" | "text";
  asset_id: string;
  title: string;
  text: string; // what is typed, or the script that was spoken
  voice: string | null; // macOS `say` voice for recordings
  category_hint: Category | null;
  lat: number;
  lng: number;
};

const DEFS: Array<Omit<MessageSample, "lat" | "lng">> = [
  {
    id: "msg_H1_voice_en",
    kind: "voice",
    asset_id: "H1",
    title: "Voice: hydrant leaking by the bakery",
    text: "Hi, the fire hydrant in front of the bakery is leaking all over the sidewalk. I saw it this morning around eight.",
    voice: "Samantha",
    category_hint: null,
  },
  {
    id: "msg_W1_voice_ko",
    kind: "voice",
    asset_id: "W1",
    title: "Voice (Korean): trash dumped by the barber",
    text: "이발소 앞에 쓰레기가 잔뜩 버려져 있어요. 매트리스도 있어요.",
    voice: "Yuna",
    category_hint: null,
  },
  {
    id: "msg_S1_voice_smoke",
    kind: "voice",
    asset_id: "S1",
    title: "Voice: smoke from a street light",
    text: "There's smoke coming out of the base of the street light by the bookstore, and it smells like something is burning.",
    voice: "Daniel",
    category_hint: null,
  },
  {
    id: "msg_P1_text",
    kind: "text",
    asset_id: "P1",
    title: "Text: pothole by the GELATO shop",
    text: "Pothole by the GELATO shop near the curb. My bike tire went into it yesterday.",
    voice: null,
    category_hint: null,
  },
  {
    id: "msg_W1_text_noise",
    kind: "text",
    asset_id: "W1",
    title: "Text: people yelling outside the BARBER",
    text: "A group of people is yelling and drinking outside the BARBER every night.",
    voice: null,
    category_hint: null,
  },
];

export function messageSamples(): MessageSample[] {
  const byId = new Map(ASSET_FILE.assets.map((a) => [a.id, a]));
  return DEFS.map((d) => ({ ...d, ...assetLocation(ASSET_FILE, byId.get(d.asset_id)!) }));
}

export function messageSample(id: string): MessageSample | null {
  return messageSamples().find((m) => m.id === id) ?? null;
}

export const VOICE_DIR = "dataset/voice";
export const voiceBlobKey = (id: string) => `voice/${id}.wav`;
