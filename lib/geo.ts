// Author: HyeonMo Gu
// Created: 2026-10-27

export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Great-circle distance in meters. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The point `northM` meters north and `eastM` meters east of `from` (flat-earth approximation, fine below a few km). */
export function offsetM(from: LatLng, northM: number, eastM: number): LatLng {
  return {
    lat: from.lat + northM / (EARTH_RADIUS_M * RAD),
    lng: from.lng + eastM / (EARTH_RADIUS_M * RAD * Math.cos(from.lat * RAD)),
  };
}
