// Author: HyeonMo Gu
// Created: 2026-10-27

import type { Box } from "@/lib/tools/types";
import { SyntheticBadge } from "./labels";

/** A report photo with SAM's mask and box drawn over it, in the photo's own pixel coordinates. */
export function MaskedPhoto({
  src,
  width,
  height,
  maskPath,
  box,
  synthetic,
  caption,
  variant = "light",
}: {
  src: string;
  width: number;
  height: number;
  maskPath?: string | null;
  box?: Box | null;
  synthetic?: boolean;
  caption?: string;
  variant?: "light" | "ops";
}) {
  const frame = variant === "ops" ? "overflow-hidden rounded-md border border-ops-line bg-black" : "overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50";
  const captionTone = variant === "ops" ? "text-ops-dim" : "text-zinc-600";
  return (
    <figure className={frame}>
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element -- photos come from our own image route, already sized */}
        <img src={src} alt={caption ?? "Report photo"} className="block h-auto w-full" />
        {(maskPath || box) && (
          <svg viewBox={`0 0 ${width} ${height}`} className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none">
            {/* The path is built on our server from SAM's mask, not from user input. vector-effect is not inherited, so it is set on the paths. */}
            {maskPath && (
              <>
                <g fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={4} className="[&_path]:[vector-effect:non-scaling-stroke]" dangerouslySetInnerHTML={{ __html: maskPath }} />
                <g fill="rgba(255,255,255,0.28)" stroke="#ffffff" strokeWidth={1.5} className="[&_path]:[vector-effect:non-scaling-stroke]" dangerouslySetInnerHTML={{ __html: maskPath }} />
              </>
            )}
            {box && <rect x={box.x1} y={box.y1} width={box.x2 - box.x1} height={box.y2 - box.y1} fill="none" stroke="#facc15" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
          </svg>
        )}
        {synthetic && (
          <span className="absolute left-2 top-2">
            <SyntheticBadge />
          </span>
        )}
        {(maskPath || box) && variant === "ops" && (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">SAM 3.1</span>
        )}
      </div>
      {caption && <figcaption className={`px-3 py-2 text-xs ${captionTone}`}>{caption}</figcaption>}
    </figure>
  );
}
