// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import Link from "next/link";
import { useEffect, useRef, type RefObject } from "react";
import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { Label } from "@/lib/tools/types";
import { LABEL_HEX } from "@/app/_ui/console";
import { DEMO_BASE } from "@/lib/dataset/place";
import { LABEL_TEXT } from "@/app/_ui/labels";
import { useSelection } from "./selection";

export type MapReport = {
  id: string;
  code: string;
  lat: number;
  lng: number;
  label: Label | null;
  urgent: boolean;
  incident_id: string | null;
  n: number | null;
};
export type MapIncident = { id: string; lat: number; lng: number; status: string; title: string; recurrence_of: string | null };

// Reports are dots in their suggestion's color; incidents are rings; a thin line folds a report onto the
// incident it was suggested for, and a dashed red line joins a recurrence to the incident it came back from.
export default function QueueMap({ reports, incidents }: { reports: MapReport[]; incidents: MapIncident[] }) {
  const { selected, select } = useSelection();
  const pins = useRef(new Map<string, L.Marker | L.CircleMarker>());
  const byId = new Map(incidents.map((i) => [i.id, i]));
  const focus = reports.filter((r) => r.n !== null);
  const points = (focus.length > 0 ? focus : reports.length > 0 ? reports : incidents).map((p) => [p.lat, p.lng] as [number, number]);

  return (
    <MapContainer center={points[0] ?? [DEMO_BASE.lat, DEMO_BASE.lng]} zoom={15} className="h-full w-full" zoomControl attributionControl scrollWheelZoom>
      {/* OpenStreetMap's standard tiles need no key; the console darkens them with a CSS filter (globals.css). */}
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={19}
      />
      <Fit points={points} />
      <FlyTo pins={pins} selected={selected} />
      {incidents
        .filter((i) => i.recurrence_of && byId.has(i.recurrence_of))
        .map((i) => {
          const parent = byId.get(i.recurrence_of!)!;
          return (
            <Polyline
              key={`chain-${i.id}`}
              positions={[
                [parent.lat, parent.lng],
                [i.lat, i.lng],
              ]}
              pathOptions={{ color: "#fb7185", weight: 1.5, dashArray: "4 4" }}
            />
          );
        })}
      {reports
        .filter((r) => r.incident_id && byId.has(r.incident_id))
        .map((r) => {
          const i = byId.get(r.incident_id!)!;
          return (
            <Polyline
              key={`fold-${r.id}`}
              positions={[
                [r.lat, r.lng],
                [i.lat, i.lng],
              ]}
              pathOptions={{ color: r.label ? LABEL_HEX[r.label] : "#6b7685", weight: 1, opacity: r.n !== null ? 0.9 : 0.25 }}
            />
          );
        })}
      {incidents.map((i) => (
        <CircleMarker
          key={i.id}
          center={[i.lat, i.lng]}
          radius={9}
          pathOptions={{
            color: i.status === "open" || i.status === "in_progress" ? "#e2e8f0" : "#34d399",
            weight: 1.5,
            fillOpacity: 0,
            dashArray: i.status === "open" || i.status === "in_progress" ? undefined : "2 3",
          }}
        >
          <Tooltip direction="top" offset={[0, -8]}>
            <span className="font-mono text-[11px]">{i.id}</span> · {i.status}
          </Tooltip>
          <Popup offset={[0, -6]} closeButton={false}>
            <span className="font-mono text-[12px] font-semibold">{i.id}</span> · {i.status}
            <br />
            {i.title}
            <br />
            <Link href={`/admin/incidents/${i.id}`} className="font-semibold">
              Open incident →
            </Link>
          </Popup>
        </CircleMarker>
      ))}
      {reports.map((r) => {
        const color = r.label ? LABEL_HEX[r.label] : "#6b7685";
        const ref = (m: L.Marker | L.CircleMarker | null) => {
          if (m) pins.current.set(r.id, m);
          else pins.current.delete(r.id);
        };
        const popup = (
          <Popup offset={[0, -4]} closeButton={false}>
            <span className="font-mono text-[12px] font-semibold">{r.code}</span>
            <br />
            {r.label ? LABEL_TEXT[r.label] : "not analyzed"}
            {r.incident_id ? ` · ${r.incident_id}` : ""}
            <br />
            <Link href={`/admin/reports/${r.id}`} className="font-semibold">
              Review →
            </Link>
          </Popup>
        );
        const events = { click: () => select(r.id), popupclose: () => select(null) };
        // Reports listed in the open tab carry their row number; the rest stay small dots for context.
        return r.n !== null ? (
          <Marker
            key={r.id}
            ref={ref}
            position={[r.lat, r.lng]}
            icon={numberPin(r.n, color, r.urgent, selected === r.id)}
            zIndexOffset={selected === r.id ? 1000 : 0}
            eventHandlers={events}
          >
            {popup}
          </Marker>
        ) : (
          <CircleMarker
            key={r.id}
            ref={ref}
            center={[r.lat, r.lng]}
            radius={4}
            pathOptions={{ color: r.urgent ? "#ef4444" : "#0b0d10", weight: r.urgent ? 3 : 1, fillColor: color, fillOpacity: 0.35 }}
            eventHandlers={events}
          >
            {popup}
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}

function Fit({ points }: { points: Array<[number, number]> }) {
  const map = useMap();
  const key = points.map((p) => p.join(",")).join(";");
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) map.setView(points[0]!, 17);
    else map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 17 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refit only when the set of points changes
  }, [key, map]);
  return null;
}

function numberPin(n: number, color: string, urgent: boolean, on: boolean): L.DivIcon {
  const ring = on ? "#ffffff" : urgent ? "#ef4444" : "#0b0d10";
  const size = on ? 28 : 22;
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
    html: `<span style="display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:9999px;background:${color};color:#0b0d10;border:2px solid ${ring};font:700 ${on ? 13 : 11}px ui-monospace,monospace;box-shadow:0 1px 4px rgb(0 0 0 / 0.6)">${n}</span>`,
  });
}

// Pans to the report a row's number picked (or a pin click) and opens its popup. The pins are read in the
// effect, not during render: markers register themselves once the map has rendered.
function FlyTo({ pins, selected }: { pins: RefObject<Map<string, L.Marker | L.CircleMarker>>; selected: string | null }) {
  const map = useMap();
  useEffect(() => {
    const target = selected ? pins.current.get(selected) : undefined;
    if (!target) return;
    map.flyTo(target.getLatLng(), Math.max(map.getZoom(), 17), { duration: 0.6 });
    if (!target.isPopupOpen()) target.openPopup();
  }, [selected, pins, map]);
  return null;
}
