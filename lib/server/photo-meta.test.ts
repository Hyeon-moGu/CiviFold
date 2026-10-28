// Author: HyeonMo Gu
// Created: 2026-10-27

import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import { fromExif, photoMeta } from "./photo-meta";

const NOW = Date.parse("2026-10-28T00:00:00.000Z");

async function jpeg(exif?: Parameters<Sharp["withExif"]>[0]): Promise<Buffer> {
  const image = sharp({ create: { width: 32, height: 24, channels: 3, background: "#888" } });
  return (exif ? image.withExif(exif) : image).jpeg().toBuffer();
}

describe("photoMeta", () => {
  it("reads the spot and the time a phone wrote", async () => {
    const bytes = await jpeg({
      IFD2: { DateTimeOriginal: "2026:10:27 14:30:00", OffsetTimeOriginal: "+09:00" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "37/1 33/1 59/1", GPSLongitudeRef: "E", GPSLongitude: "126/1 58/1 40/1" },
    });
    expect(await photoMeta(bytes, null, NOW)).toEqual({ lat: 37.566389, lng: 126.977778, taken_at: "2026-10-27T05:30:00.000Z" });
  });

  it("uses the browser's offset when the photo stores local time only", async () => {
    const bytes = await jpeg({ IFD2: { DateTimeOriginal: "2026:10:27 14:30:00" } });
    expect(await photoMeta(bytes, -540, NOW)).toEqual({ lat: null, lng: null, taken_at: "2026-10-27T05:30:00.000Z" });
    expect((await photoMeta(bytes, null, NOW)).taken_at).toBeNull();
  });

  it("returns nothing for a photo without EXIF", async () => {
    expect(await photoMeta(await jpeg(), -540, NOW)).toEqual({ lat: null, lng: null, taken_at: null });
  });
});

type Tags = Parameters<typeof fromExif>[0];

describe("fromExif", () => {
  it("prefers the GPS clock, which is UTC, and signs southern and western coordinates", () => {
    const meta = fromExif(
      {
        bigEndian: false,
        GPSInfo: { GPSLatitude: [33, 52, 4], GPSLatitudeRef: "S", GPSLongitude: [151, 12, 36], GPSLongitudeRef: "E", GPSDateStamp: "2026:10:27", GPSTimeStamp: [3, 4, 5.6] },
        Photo: { DateTimeOriginal: new Date("2026-10-27T14:00:00.000Z") },
      } as Tags,
      -540,
      NOW,
    );
    expect(meta).toEqual({ lat: -33.867778, lng: 151.21, taken_at: "2026-10-27T03:04:05.000Z" });
  });

  it("drops a 0,0 location and a time in the future", () => {
    const meta = fromExif(
      { bigEndian: false, GPSInfo: { GPSLatitude: [0, 0, 0], GPSLatitudeRef: "N", GPSLongitude: [0, 0, 0], GPSLongitudeRef: "E" }, Photo: { DateTimeOriginal: new Date("2027-01-01T00:00:00.000Z") } } as Tags,
      0,
      NOW,
    );
    expect(meta).toEqual({ lat: null, lng: null, taken_at: null });
  });
});
