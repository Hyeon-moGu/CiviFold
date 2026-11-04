// Author: HyeonMo Gu
// Created: 2026-10-27

import type { Box } from "@/lib/tools/types";
import { RealPhotoBadge, SyntheticBadge } from "./labels";

/** A real San Francisco 311 photo (lib/dataset/real.ts): its image id, or the dataset image a report photo came from. */
export const isRealPhoto = (p: { id: string; dataset_image_id?: string | null } | string | null | undefined): boolean =>
  typeof p === "string" ? p.startsWith("sf_") : Boolean(p && (p.id.startsWith("sf_") || p.dataset_image_id?.startsWith("sf_")));

// The outline is drawn as markup, so only the exact shape maskPath (lib/tools/segment-object.ts) builds is drawn:
// one path of move, line and close commands with plain numbers, placed by a translate and a scale.
const NUM = String.raw`-?\d+(?:\.\d+)?(?:e[-+]?\d+)?`;
const MASK = new RegExp(String.raw`^<path d="[MLZ0-9 .\-e]+" transform="translate\(${NUM} ${NUM}\) scale\(${NUM} ${NUM}\)"/>$`);
export const safeMask = (svg: string | null | undefined): string | null => (svg && MASK.test(svg) ? svg : null);

/** A report photo with SAM's mask and box drawn over it, in the photo's own pixel coordinates. */
export function MaskedPhoto({
  src,
  width,
  height,
  maskPath,
  box,
  synthetic,
  real,
  caption,
  variant = "light",
  className = "",
  style,
}: {
  src: string;
  width: number;
  height: number;
  maskPath?: string | null;
  box?: Box | null;
  synthetic?: boolean;
  real?: boolean;
  caption?: string;
  variant?: "light" | "ops";
  className?: string;
  style?: React.CSSProperties;
}) {
  const frame = variant === "ops" ? "overflow-hidden rounded-md border border-ops-line bg-black" : "overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50";
  const captionTone = variant === "ops" ? "text-ops-dim" : "text-zinc-600";
  const mask = safeMask(maskPath);
  return (
    <figure className={`${frame} ${className}`} style={style}>
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element -- photos come from our own image route, already sized */}
        <img src={src} alt={caption ?? "Report photo"} className="block h-auto w-full" />
        {(mask || box) && (
          <svg viewBox={`0 0 ${width} ${height}`} className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none">
            {/* vector-effect is not inherited, so it is set on the paths. */}
            {mask && (
              <>
                <g fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={4} className="[&_path]:[vector-effect:non-scaling-stroke]" dangerouslySetInnerHTML={{ __html: mask }} />
                <g fill="rgba(255,255,255,0.1)" stroke="#ffffff" strokeWidth={1.5} className="[&_path]:[vector-effect:non-scaling-stroke]" dangerouslySetInnerHTML={{ __html: mask }} />
              </>
            )}
            {box && <rect x={box.x1} y={box.y1} width={box.x2 - box.x1} height={box.y2 - box.y1} fill="none" stroke="#facc15" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
          </svg>
        )}
        {(synthetic || real) && <span className="absolute left-2 top-2">{synthetic ? <SyntheticBadge /> : <RealPhotoBadge />}</span>}
        {(mask || box) && variant === "ops" && (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">SAM 3.1</span>
        )}
      </div>
      {caption && <figcaption className={`px-3 py-2 text-xs ${captionTone}`}>{caption}</figcaption>}
    </figure>
  );
}
