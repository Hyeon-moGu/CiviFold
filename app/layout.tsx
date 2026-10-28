// Author: HyeonMo Gu
// Created: 2026-10-27

import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const sans = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: "CiviFold",
  description: "Groups repeat civic complaints about the same place without burying a recurrence.",
};

// The public pages and the staff console each bring their own shell (app/(public)/layout.tsx, app/admin/layout.tsx).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
