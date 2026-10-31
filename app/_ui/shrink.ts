// Author: HyeonMo Gu
// Created: 2026-10-27

// Phone photos run to 10 MB and more; a deployment's request limit is 4.5 MB. Large photos are turned
// upright and scaled down in the browser before upload (the EXIF is read beforehand, from the original).
const LIMIT = 4 * 1024 * 1024;
const MAX_SIDE = 1920;

export const EXIF_SLICE = 512 * 1024; // the EXIF sits at the start of a JPEG; this much is enough to read it

// Browsers other than Safari cannot decode HEIC, so it is refused up front rather than failing in the upload.
export const isHeic = (f: File) => /heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);

export async function shrinkForUpload(file: File): Promise<File> {
  if (file.size <= LIMIT) return file;
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error("The photo could not be prepared for upload.");
  return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
}
