// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { pauseFrom, usePaused } from "@/app/_ui/pause";

export function RepairButton({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = usePaused("staff");
  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        disabled={busy || paused}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await fetch(`/api/admin/incidents/${incidentId}/repair`, { method: "POST" });
            pauseFrom(res, "staff");
            if (res.ok) router.refresh();
            else {
              const body = (await res.json().catch(() => null)) as { error?: string } | null;
              setError(body?.error ?? `The repair was not saved (HTTP ${res.status}). Try again.`);
            }
          } catch {
            setError("The repair was not saved: the connection dropped. Try again.");
          } finally {
            setBusy(false);
          }
        }}
        className="rounded-md bg-emerald-500 px-3.5 py-1.5 text-[13px] font-semibold text-black hover:bg-emerald-400 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Record repair"}
      </button>
      {error && <p className="max-w-xs text-right text-sm text-rose-300">{error}</p>}
    </div>
  );
}
