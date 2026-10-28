// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RepairButton({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/admin/incidents/${incidentId}/repair`, { method: "POST" });
        setBusy(false);
        router.refresh();
      }}
      className="rounded-md bg-emerald-500 px-3.5 py-1.5 text-[13px] font-semibold text-black hover:bg-emerald-400 disabled:opacity-50"
    >
      {busy ? "Saving…" : "Record repair"}
    </button>
  );
}
