// Author: HyeonMo Gu
// Created: 2026-10-28

// Where the app puts the demo world: downtown Menlo Park, California, near Meta's campus. The evaluation keeps
// the coordinates it was recorded with (dataset/assets.json); only the distances between places matter to it,
// and those are the same here.
export const DEMO_BASE = { lat: 37.453, lng: -122.1817 };
// Times are shown in the demo world's own zone, the same on the server (UTC on a deployment) and in any browser.
export const DEMO_TIME_ZONE = "America/Los_Angeles";
