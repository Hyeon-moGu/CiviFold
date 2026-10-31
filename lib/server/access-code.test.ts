// Author: HyeonMo Gu
// Created: 2026-10-31

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessCodeValid } from "./runtime";

const CODE = "correct-horse-battery";

describe("accessCodeValid", () => {
  beforeEach(() => void (process.env.DEMO_ACCESS_CODE = CODE));
  afterEach(() => void delete process.env.DEMO_ACCESS_CODE);

  it("accepts the code with surrounding spaces and rejects anything else", () => {
    expect(accessCodeValid(` ${CODE} `)).toBe(true);
    expect(accessCodeValid("correct-horse-battery-")).toBe(false);
    expect(accessCodeValid("correct-horse-batter")).toBe(false);
    expect(accessCodeValid("CORRECT-HORSE-BATTERY")).toBe(false);
  });

  it("rejects an empty code, and every code when none is configured", () => {
    expect(accessCodeValid(null)).toBe(false);
    expect(accessCodeValid("  ")).toBe(false);
    delete process.env.DEMO_ACCESS_CODE;
    expect(accessCodeValid(CODE)).toBe(false);
  });
});
