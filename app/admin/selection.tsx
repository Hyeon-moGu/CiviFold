// Author: HyeonMo Gu
// Created: 2026-10-28

"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// The queue row and the map pin staff last pointed at, so either one can show the other without opening the report.
const Selection = createContext<{ selected: string | null; select: (id: string | null) => void }>({ selected: null, select: () => {} });

export const useSelection = () => useContext(Selection);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selected, select] = useState<string | null>(null);
  return <Selection.Provider value={{ selected, select }}>{children}</Selection.Provider>;
}

export function QueueRow({ id, children }: { id: string; children: ReactNode }) {
  const { selected } = useSelection();
  const ref = useRef<HTMLLIElement>(null);
  const on = selected === id;
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [on]);
  return (
    <li ref={ref} className={`flex items-center transition ${on ? "bg-ops-raised shadow-[inset_3px_0_0_#fff]" : ""}`}>
      {children}
    </li>
  );
}

export function LocateButton({ id, n, color, urgent }: { id: string; n: number; color: string; urgent: boolean }) {
  const { selected, select } = useSelection();
  return (
    <button
      type="button"
      title="Show on the map"
      aria-label={`Show report ${n} on the map`}
      onClick={() => {
        select(selected === id ? null : id);
        // Below the large layout the map sits under the list.
        if (window.innerWidth < 1024) document.getElementById("queue-map")?.scrollIntoView({ behavior: "smooth", block: "center" });
      }}
      className={`ml-3 flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[12px] font-bold text-slate-950 ring-offset-2 ring-offset-ops-panel transition hover:ring-2 hover:ring-white ${
        selected === id ? "ring-2 ring-white" : ""
      } ${urgent ? "outline outline-2 outline-red-500" : ""}`}
      style={{ backgroundColor: color }}
    >
      {n}
    </button>
  );
}
