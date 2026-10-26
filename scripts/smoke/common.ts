// Author: HyeonMo Gu
// Created: 2026-10-27

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Smoke-test outputs stay local (.cache/ is gitignored).
export const OUT_DIR = path.resolve(".cache/smoke");

export async function save(name: string, data: Buffer | string): Promise<string> {
  await mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  await writeFile(file, data);
  return file;
}

export async function load(name: string): Promise<Buffer> {
  try {
    return await readFile(path.join(OUT_DIR, name));
  } catch {
    throw new Error(`${name} not found in ${OUT_DIR} — run \`npm run smoke:image\` first`);
  }
}

export function dataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Sniffs the container format so we never trust a file extension. */
export function mimeOf(bytes: Buffer): string {
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("ascii") === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return "application/octet-stream";
}

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    console.log(`✓ ${label} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    return result;
  } catch (err) {
    console.log(`✗ ${label} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    throw err;
  }
}
