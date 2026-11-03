// Author: HyeonMo Gu
// Created: 2026-11-04

import { describe, expect, it } from "vitest";
import { safeMask } from "./photo";

describe("safeMask", () => {
  it("draws the outline maskPath builds", () => {
    const svg = '<path d="M53.5 0L54 -0.5L53 0.5Z M1 2L3 4Z" transform="translate(835 471) scale(1.25 0.8)"/>';
    expect(safeMask(svg)).toBe(svg);
    expect(safeMask('<path d="M0 0L1 1Z" transform="translate(-3 4) scale(1e-7 2.5e+3)"/>')).not.toBeNull();
  });

  it("draws nothing for any other markup", () => {
    for (const svg of [
      null,
      "",
      '<path d="M0 0Z" transform="translate(0 0) scale(1 1)"/><script>alert(1)</script>',
      '<path d="M0 0Z" onload="alert(1)" transform="translate(0 0) scale(1 1)"/>',
      '<path d="M0 0Z" transform="translate(NaN 0) scale(1 1)"/>',
      '<image href="x" onerror="alert(1)"/>',
      '<path d="M0 0Z"/>',
    ]) {
      expect(safeMask(svg)).toBeNull();
    }
  });
});
