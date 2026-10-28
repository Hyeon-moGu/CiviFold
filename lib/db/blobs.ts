// Author: HyeonMo Gu
// Created: 2026-10-27

// Photo bytes: Vercel Blob when BLOB_READ_WRITE_TOKEN is set (a Vercel deployment), otherwise files under .cache/blobs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type BlobStore = {
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  has(key: string): Promise<boolean>;
};

export function fileBlobs(dir = path.join(process.cwd(), ".cache/blobs")): BlobStore {
  const file = (key: string) => path.join(dir, key);
  return {
    put: async (key, bytes) => {
      await mkdir(path.dirname(file(key)), { recursive: true });
      await writeFile(file(key), bytes);
    },
    get: (key) => readFile(file(key)),
    has: (key) => readFile(file(key)).then(() => true, () => false),
  };
}

// Vercel Blob, private: photos are read back through the app, never served straight from the store.
export async function vercelBlobs(token: string): Promise<BlobStore> {
  const { get, head, put } = await import("@vercel/blob");
  return {
    put: async (key, bytes, mime) => {
      await put(key, bytes, { access: "private", contentType: mime, addRandomSuffix: false, allowOverwrite: true, token });
    },
    get: async (key) => {
      const found = await get(key, { access: "private", token });
      if (!found) throw new Error(`blob ${key} not found`);
      return Buffer.from(await new Response(found.stream).arrayBuffer());
    },
    has: (key) => head(key, { token }).then(() => true, () => false),
  };
}

let opened: Promise<BlobStore> | undefined;

export function blobs(): Promise<BlobStore> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  opened ??= token ? vercelBlobs(token) : Promise.resolve(fileBlobs());
  return opened;
}
