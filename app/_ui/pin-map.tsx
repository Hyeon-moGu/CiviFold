// Author: HyeonMo Gu
// Created: 2026-10-28

"use client";

import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { CircleMarker, MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { DEMO_BASE } from "@/lib/dataset/place";

const START: [number, number] = [DEMO_BASE.lat, DEMO_BASE.lng];

/** A light map where a tap moves the pin. Without a pin it opens where the samples are. */
export default function PinMap({ lat, lng, onPick }: { lat: number | null; lng: number | null; onPick: (lat: number, lng: number) => void }) {
  const pin: [number, number] | null = lat !== null && lng !== null ? [lat, lng] : null;
  return (
    <MapContainer center={pin ?? START} zoom={pin ? 17 : 14} className="h-full w-full" scrollWheelZoom={false}>
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' maxZoom={19} />
      <Taps onPick={onPick} />
      <Follow pin={pin} />
      {pin && (
        <>
          <CircleMarker center={pin} radius={18} pathOptions={{ color: "#18181b", weight: 1, fillColor: "#18181b", fillOpacity: 0.08 }} />
          <CircleMarker center={pin} radius={7} pathOptions={{ color: "#ffffff", weight: 3, fillColor: "#18181b", fillOpacity: 1 }} />
        </>
      )}
    </MapContainer>
  );
}

function Taps({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

// Re-centers when the pin is set from outside the map (a sample, the photo's EXIF, the browser's location).
function Follow({ pin }: { pin: [number, number] | null }) {
  const map = useMap();
  const key = pin?.join(",");
  useEffect(() => {
    if (pin && !map.getBounds().pad(-0.2).contains(pin)) map.setView(pin, Math.max(map.getZoom(), 17));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow only when the pin moves
  }, [key, map]);
  return null;
}
