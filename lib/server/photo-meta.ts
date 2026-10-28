// Author: HyeonMo Gu
// Created: 2026-10-27

// Where and when a photo was taken, from its EXIF. A resident reporting later, from elsewhere, still
// gets the spot and the time of the photo rather than where they are now. Nothing here calls a model.
import exifReader from "exif-reader";
import sharp from "sharp";

export type PhotoMeta = { lat: number | null; lng: number | null; taken_at: string | null };

type Tags = ReturnType<typeof exifReader>;

const NONE: PhotoMeta = { lat: null, lng: null, taken_at: null };

/** `tzOffsetMin` is the browser's Date.getTimezoneOffset(), for photos that store local time without a zone. */
export async function photoMeta(bytes: Buffer, tzOffsetMin: number | null, now = Date.now()): Promise<PhotoMeta> {
  const { exif } = await sharp(bytes).metadata().catch(() => ({ exif: undefined }));
  if (!exif) return NONE;
  try {
    return fromExif(exifReader(exif), tzOffsetMin, now);
  } catch {
    return NONE;
  }
}

export function fromExif(tags: Tags, tzOffsetMin: number | null, now = Date.now()): PhotoMeta {
  const gps = tags.GPSInfo ?? {};
  const lat = degrees(gps.GPSLatitude, gps.GPSLatitudeRef, "S", 90);
  const lng = degrees(gps.GPSLongitude, gps.GPSLongitudeRef, "W", 180);
  // A camera with no fix may write 0,0: that is no location, not the Gulf of Guinea.
  const located = lat !== null && lng !== null && !(lat === 0 && lng === 0);
  const taken = takenAt(tags, tzOffsetMin);
  return {
    lat: located ? lat : null,
    lng: located ? lng : null,
    taken_at: taken !== null && taken <= now + 5 * 60_000 ? new Date(taken).toISOString() : null,
  };
}

function degrees(dms: number[] | undefined, ref: string | undefined, negative: string, max: number): number | null {
  if (!dms || dms.length < 3 || dms.some((x) => !Number.isFinite(x))) return null;
  const value = (dms[0]! + dms[1]! / 60 + dms[2]! / 3600) * (ref?.toUpperCase() === negative ? -1 : 1);
  return Math.abs(value) <= max ? Math.round(value * 1e6) / 1e6 : null;
}

// The GPS clock is UTC. Otherwise DateTimeOriginal is local time (exif-reader returns it as if it were UTC),
// corrected by OffsetTimeOriginal when the camera wrote one, or by the browser's own offset.
function takenAt(tags: Tags, tzOffsetMin: number | null): number | null {
  const gps = tags.GPSInfo;
  const date = gps?.GPSDateStamp?.match(/^(\d{4}):(\d{2}):(\d{2})$/);
  const time = gps?.GPSTimeStamp;
  if (date && time && time.length >= 3) {
    return Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), time[0]!, time[1]!, Math.floor(time[2]!));
  }
  const local = tags.Photo?.DateTimeOriginal;
  if (!(local instanceof Date) || Number.isNaN(local.getTime())) return null;
  const offset = tags.Photo?.OffsetTimeOriginal?.match(/^([+-])(\d{2}):(\d{2})$/);
  if (offset) return local.getTime() - (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000;
  if (tzOffsetMin === null) return null;
  return local.getTime() + tzOffsetMin * 60_000;
}
