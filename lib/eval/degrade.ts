// Author: HyeonMo Gu
// Created: 2026-10-27

import sharp from "sharp";
import type { Transform } from "./cases";

/** Spoils a photo the way a resident's phone might. Deterministic, so cached model calls stay valid. */
export async function degrade(bytes: Buffer, transform: Transform): Promise<{ bytes: Buffer; width: number; height: number; mime: string }> {
  const { width = 0, height = 0 } = await sharp(bytes).metadata();
  let img = sharp(bytes);
  switch (transform) {
    case "blur": // hand shake
      img = img.blur(6);
      break;
    case "low_res": // an old phone or a forwarded thumbnail
      img = img.resize({ width: 480 });
      break;
    case "jpeg": // recompressed by a messenger app
      return finish(await img.jpeg({ quality: 12 }).toBuffer(), "image/jpeg");
    case "off_center": // the subject near the edge, part of the scene cut off
      img = img.extract({ left: Math.round(width * 0.35), top: 0, width: Math.round(width * 0.65), height });
      break;
    case "dark": // underexposed at dusk
      img = img.modulate({ brightness: 0.3 }).gamma(1.2);
      break;
  }
  return finish(await img.webp({ quality: 85 }).toBuffer(), "image/webp");
}

async function finish(bytes: Buffer, mime: string) {
  const { width = 0, height = 0 } = await sharp(bytes).metadata();
  return { bytes, width, height, mime };
}
