// Author: HyeonMo Gu
// Created: 2026-10-28

// Where the app puts the demo world: San Francisco's Mission District, the city whose 311 photos the demo's real
// cases come from (lib/dataset/real.ts, each at its own place, more than a kilometer from this world). The
// evaluation keeps the coordinates it was recorded with (dataset/assets.json); only the distances between places
// matter to it, and those are the same here.
export const DEMO_BASE = { lat: 37.764, lng: -122.422 };
// Times are shown in the demo world's own zone, the same on the server (UTC on a deployment) and in any browser.
export const DEMO_TIME_ZONE = "America/Los_Angeles";
