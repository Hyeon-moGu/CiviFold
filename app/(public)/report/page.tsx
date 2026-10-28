// Author: HyeonMo Gu
// Created: 2026-10-27

import { messageSamples } from "@/lib/dataset/messages";
import { samples } from "@/lib/dataset/static";
import { ReportForm } from "./report-form";

export const metadata = { title: "Report a problem · CiviFold" };

export default function ReportPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Report a problem</h1>
      <p className="mt-1.5 text-sm text-zinc-600">A broken fixture or a problem at a place: a hydrant, a street light, a pothole, dumped trash. Three steps, under a minute.</p>
      <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
        This is a hackathon demo. Reports are not sent to any city or 311 service, and anything you send, photos and recordings included, can be seen by
        anyone who opens the staff console. Leave out faces, license plates and personal details.
      </p>
      <ReportForm samples={samples()} messages={messageSamples()} />
    </main>
  );
}
