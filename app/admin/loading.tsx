// Author: HyeonMo Gu
// Created: 2026-11-03

// Shown at once when the staff console opens, while the queue and the map load.
export default function Loading() {
  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6">
      <p className="flex items-center gap-2.5 text-sm text-ops-dim" role="status">
        <span aria-hidden className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
        Loading the staff queue…
      </p>
    </main>
  );
}
