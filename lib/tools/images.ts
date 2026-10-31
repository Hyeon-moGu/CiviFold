// Author: HyeonMo Gu
// Created: 2026-10-27

import type { Box, Category } from "./types";

export type ImageKind = "original" | "object_crop" | "context_crop";

export type ImageRow = {
  id: string;
  report_id: string; // crops point at the report of their source photo
  kind: ImageKind;
  source_image_id: string | null;
  width: number;
  height: number;
  mime: string;
  is_synthetic: boolean;
};

export type SegmentationRow = {
  image_id: string;
  noun_phrase: string;
  found: boolean;
  instances: number;
  box: Box | null;
  score: number | null;
  mask_svg_path: string | null; // for the UI overlay only, never sent to a model
  object_crop_id: string | null;
  context_crop_id: string | null;
};

export type ReportTriage = { category: Category; sam_prompt: string };

// Models refer to images only by ImageId. Which incident an image belongs to is resolved here
// (image → report → incident), never taken from a model's output.
export type ImageStore = {
  get(id: string): Promise<ImageRow | null>;
  bytes(id: string): Promise<Buffer>;
  /** Idempotent: crop ids are derived from source and box, so re-cropping returns the same row. */
  put(row: ImageRow, bytes: Buffer): Promise<void>;
  latestSegmentation(imageId: string): Promise<SegmentationRow | null>;
  saveSegmentation(row: SegmentationRow): Promise<void>;
  incidentOf(imageId: string): Promise<string | null>;
  triageOf(reportId: string): Promise<ReportTriage | null>;
  saveTriage(reportId: string, triage: ReportTriage): Promise<void>;
};

export function memoryImages(seed: {
  images?: Array<{ row: ImageRow; bytes: Buffer }>;
  incidentByReport?: Record<string, string>;
  triageByReport?: Record<string, ReportTriage>;
} = {}): ImageStore & { segmentations: SegmentationRow[] } {
  const images = new Map((seed.images ?? []).map((i) => [i.row.id, i]));
  const segmentations: SegmentationRow[] = [];
  const triage = { ...seed.triageByReport };
  return {
    segmentations,
    get: async (id) => images.get(id)?.row ?? null,
    bytes: async (id) => {
      const image = images.get(id);
      if (!image) throw new Error(`Unknown image ${id}`);
      return image.bytes;
    },
    put: async (row, bytes) => void images.set(row.id, { row, bytes }),
    latestSegmentation: async (imageId) => segmentations.findLast((s) => s.image_id === imageId) ?? null,
    saveSegmentation: async (row) => void segmentations.push(row),
    incidentOf: async (imageId) => {
      const reportId = images.get(imageId)?.row.report_id;
      return reportId === undefined ? null : (seed.incidentByReport?.[reportId] ?? null);
    },
    triageOf: async (reportId) => triage[reportId] ?? null,
    saveTriage: async (reportId, t) => void (triage[reportId] = t),
  };
}

/**
 * The same store, reading each image's row and bytes at most once. One analysis reads a photo for triage,
 * segmentation and every comparison, and on a deployment each read is a database or blob round trip.
 * Scope it to one analysis: rows never change once written, and a put fills the row in.
 */
export function memoizedImages(store: ImageStore): ImageStore {
  const rows = new Map<string, ImageRow>();
  const bytes = new Map<string, Promise<Buffer>>();
  return {
    ...store,
    get: async (id) => {
      const known = rows.get(id);
      if (known) return known;
      const row = await store.get(id);
      if (row) rows.set(id, row);
      return row;
    },
    bytes: (id) => {
      let pending = bytes.get(id);
      if (!pending) {
        pending = store.bytes(id);
        bytes.set(id, pending);
        pending.catch(() => bytes.delete(id));
      }
      return pending;
    },
    put: async (row, data) => {
      await store.put(row, data);
      rows.set(row.id, row);
      bytes.set(row.id, Promise.resolve(data));
    },
  };
}

export function dataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
