// Author: HyeonMo Gu
// Created: 2026-10-27

// Four reports, one of them different: the logo.
export function Mark({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="2" y="2" width="9" height="9" rx="2" fill="currentColor" opacity="0.9" />
      <rect x="13" y="2" width="9" height="9" rx="2" fill="currentColor" opacity="0.35" />
      <rect x="2" y="13" width="9" height="9" rx="2" fill="currentColor" opacity="0.35" />
      <rect x="13" y="13" width="9" height="9" rx="2" fill="#f43f5e" />
    </svg>
  );
}
