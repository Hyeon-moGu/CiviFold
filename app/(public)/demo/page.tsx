// Author: HyeonMo Gu
// Created: 2026-10-27

import Link from "next/link";
import { imageId } from "@/lib/dataset/assets";
import { messageSample } from "@/lib/dataset/messages";
import { REAL_CREDIT } from "@/lib/dataset/real";
import { ASSET_FILE } from "@/lib/dataset/static";
import { SCENARIOS } from "@/lib/demo/scenarios";
import { defaultMode } from "@/lib/meta/call";
import { liveDailyUsd } from "@/lib/server/runtime";
import { HELD_OUT, Scoreboard } from "@/app/_ui/scoreboard";
import type { Label } from "@/lib/tools/types";
import { DemoRunner, type CaseView, type OtherView } from "./demo-runner";


export const metadata = { title: "Demo · CiviFold" };
export const dynamic = "force-dynamic";

const assets = new Map(ASSET_FILE.assets.map((a) => [a.id, a]));
const place = (assetId: string) => {
  const a = assets.get(assetId)!;
  // The incident's own name, as the staff console shows it, without the dataset's "(same model as …)".
  return `${a.object.replace(/\s*\(.*\)$/, "")} by the ${a.sign_texts[0]} sign`;
};
const incidentPhoto = (assetId: string) => `/api/images/${imageId(assetId, "damaged_v1", "front")}?w=960`;

function stepOf(key: string) {
  const [id, index] = key.split(":");
  const step = SCENARIOS.find((s) => s.id === id)?.steps[Number(index)];
  if (!step) throw new Error(`Unknown demo step ${key}`);
  return step;
}
const expectOf = (key: string): Label => {
  const step = stepOf(key);
  if (!("expect" in step)) throw new Error(`Demo step ${key} expects no suggestion`);
  return step.expect;
};
const photoOf = (key: string) => {
  const step = stepOf(key);
  return "sample" in step ? `/api/samples/${step.sample}/image?w=960` : null;
};

const BRIEF = "In the staff view, “Write a brief” has a Muse Spark agent write a case brief that cites every claim.";

// The five cases that show the point. The two that location alone gets wrong come first, so the first report a
// visitor sends shows the difference; then the true duplicate, which CiviFold merges too, and a place problem
// (dumping) that location alone also gets wrong.
const CASES: CaseView[] = [
  {
    key: "lookalike:0",
    title: "A look-alike 28 m away",
    context: "Same hydrant model, same leak, a few doors down from an open incident.",
    evidence: "A laundry sign, a bollard and a blue door: a different hydrant.",
    incident: { photo: incidentPhoto("H1"), caption: `Already open: the ${place("H1")}` },
    report: { photo: photoOf("lookalike:0")!, caption: `New report: the ${place("H5")}` },
    expect: expectOf("lookalike:0"),
    noun: "hydrant",
    agent: BRIEF,
  },
  {
    key: "after-repair:3",
    title: "Broken again after the repair",
    context: "Staff fixed the hydrant by the flower shop yesterday. Today a resident photographs it with new damage.",
    evidence: "Same place, new damage after the fix. Staff should see it, not find it merged away.",
    incident: { photo: incidentPhoto("H2"), caption: `Reported three days ago, fixed yesterday: the ${place("H2")}` },
    report: { photo: photoOf("after-repair:3")!, caption: "New report, taken today" },
    expect: expectOf("after-repair:3"),
    noun: "hydrant",
  },
  {
    key: "duplicate:0",
    title: "The same hydrant, from across the street",
    context: "Another resident reports the leaking hydrant by the bakery.",
    evidence: "The bakery sign, the bike rack and the leak all match. CiviFold suggests merging it; staff confirm.",
    incident: { photo: incidentPhoto("H1"), caption: `Already open: the ${place("H1")}` },
    report: { photo: photoOf("duplicate:0")!, caption: "New report, from across the street" },
    expect: expectOf("duplicate:0"),
    noun: "hydrant",
    approve: "duplicate:3",
    verifyKey: "duplicate:1",
    agent: "Before approving, try “Verify with the agent” in the staff view: a Muse Spark agent looks for evidence against the merge, and can only make it more cautious.",
  },
  {
    key: "after-repair:1",
    title: "A photo from before the repair",
    context: "The same fixed hydrant by the flower shop. This photo was taken two days ago, before the repair.",
    evidence: "Same hydrant, same leak, seen before the fix. It belongs with the fixed incident.",
    incident: { photo: incidentPhoto("H2"), caption: `Reported three days ago, fixed yesterday: the ${place("H2")}` },
    report: { photo: photoOf("after-repair:1")!, caption: "New report, taken two days ago" },
    expect: expectOf("after-repair:1"),
    noun: "hydrant",
    verifyKey: "after-repair:2",
    agent: "Try “Verify with the agent” in the staff view: a Muse Spark agent looks for signs that the damage is new.",
  },
  {
    key: "dumping:3",
    title: "Dumped again after the cleanup",
    context: "Staff cleared the pile by the barber shop yesterday. Today a resident photographs a new pile at the same wall.",
    evidence: "Same wall and mural, a different pile after the cleanup. Staff should see it, not find it merged away.",
    incident: { photo: incidentPhoto("W1"), caption: `Reported three days ago, cleared yesterday: the pile by the ${assets.get("W1")!.sign_texts[0]} sign` },
    report: { photo: photoOf("dumping:3")!, caption: "New report, taken today" },
    expect: expectOf("dumping:3"),
    noun: "pile",
    boxed: true,
  },
];

// Real San Francisco 311 requests (lib/dataset/real.ts): each earlier request is on file, the later one is sent. The
// one location alone gets wrong comes first, so the first report a visitor sends shows the difference.
const realPhoto = (id: string) => `/api/images/${id}?w=960`;
const REAL: CaseView[] = [
  {
    key: "sf311:1",
    title: "New trash at the same corner after the cleanup",
    context: "Public Works cleared the trash at a corner tree on Alemany Boulevard. Six days later a resident reports new trash there.",
    evidence: "The same tree, pole and crosswalk, with different trash after the cleanup. Location alone would merge it into the cleared request, closing it as fixed; CiviFold keeps it apart for staff.",
    incident: { photo: realPhoto("sf_a123_1"), caption: "On file: request 202000046581, Sep 9, cleared that morning" },
    report: { photo: photoOf("sf311:1")!, caption: "New request 202000068065, Sep 15" },
    expect: expectOf("sf311:1"),
    noun: "trash",
    boxed: true,
    real: true,
  },
  {
    key: "sf311:0",
    title: "The same wooden panel, a day later",
    context: "Two residents report a panel left at a street tree on 24th Street, a day apart.",
    evidence: "The same tree pit, yellow curb and paint mark on the sidewalk. CiviFold suggests merging it; staff confirm.",
    incident: { photo: realPhoto("sf_t058_1"), caption: "On file: request 202000065099, Sep 14" },
    report: { photo: photoOf("sf311:0")!, caption: "New request 202000068943, Sep 15" },
    expect: expectOf("sf311:0"),
    noun: "panel",
    boxed: true,
    real: true,
  },
  {
    key: "sf311:2",
    title: "The same orange bags, in a wider view",
    context: "Two residents report bags at the Highland Avenue balustrade, 17 hours apart.",
    evidence: "The same balustrade and tree, so the same place. From this wider view Muse Spark reads the pile as changed, so it goes to a person instead of being merged.",
    incident: { photo: realPhoto("sf_t052_1"), caption: "On file: request 202000063217, Sep 13" },
    report: { photo: photoOf("sf311:2")!, caption: "New request 202000065126, Sep 14" },
    expect: expectOf("sf311:2"),
    noun: "bags",
    boxed: true,
    real: true,
  },
  {
    key: "sf311:3",
    title: "The same broken utility cover",
    context: "Two residents report a broken cover in the sidewalk on Pacific Avenue, two days apart.",
    evidence: "The same utility cover and curb paint, but the cut-outs are not a sure match, so CiviFold asks for another angle before merging.",
    incident: { photo: realPhoto("sf_r085_1"), caption: "On file: request 202000212553, Oct 23" },
    report: { photo: photoOf("sf311:3")!, caption: "New request 202000222488, Oct 25" },
    expect: expectOf("sf311:3"),
    noun: "damage",
    boxed: true,
    real: true,
  },
];

// What a resident said or typed, and the recording, for the reports that come without a photo.
function messageOf(key: string): { quote: string; audio: string | null } {
  const step = stepOf(key);
  const m = "message" in step ? messageSample(step.message) : null;
  if (!m) throw new Error(`Demo step ${key} sends no message`);
  return { quote: m.text, audio: m.kind === "voice" ? `/api/samples/messages/${m.id}/audio` : null };
}

// Situations where the right answer is to ask, or to hand over to a person.
const OTHERS: OtherView[] = [
  { key: "voice:0", then: "voice:1", send: "Send the voice message", thenSend: "Answer with a photo", thenPhoto: photoOf("voice:1")!, thenExpect: expectOf("voice:1"), what: "A voice message with no photo", note: "Asks for a photo. Once it arrives, the report matches the open incident.", kind: "voice", ...messageOf("voice:0"), expect: expectOf("voice:0") },
  { key: "dumping:1", send: "Send the photo", what: "A cleaned-up spot, seen from across the street", note: "Asks for another photo before calling it fixed.", photo: photoOf("dumping:1")!, expect: expectOf("dumping:1") },
  { key: "closeup:0", send: "Send the photo", what: "A close-up with nothing around it", note: "Asks for a wider photo: nothing ties it to one place.", photo: photoOf("closeup:0")!, expect: expectOf("closeup:0") },
  { key: "messages:0", send: "Send the voice message", what: "Smoke from a street light", note: "A possible emergency goes straight to the top of the staff queue.", kind: "voice", urgent: true, ...messageOf("messages:0"), expect: expectOf("messages:0") },
  { key: "messages:1", send: "Send the message", what: "A noise complaint", note: "About people, not a place, so photos are never matched. Staff handle it.", kind: "text", ...messageOf("messages:1"), expect: expectOf("messages:1") },
];

export default async function DemoPage({ searchParams }: { searchParams: Promise<{ cases?: string }> }) {
  const { cases } = await searchParams;
  // A replay-only deployment with no live budget offers no live run, rather than one that falls back to the replay.
  const live = defaultMode() !== "cached" || liveDailyUsd() > 0;
  const realIntro = (
    <p className="max-w-3xl text-sm text-zinc-500">
      Four pairs of real San Francisco 311 requests, chosen by looking at the photos only. In each, two residents reported the same spot, and the demo
      sends the second report with its real place and time. Case 1 is where location alone goes wrong. Cases 2 to 4 are true duplicates, so location
      alone is right too: CiviFold suggests merging one, sends one to staff and asks about one. Photos: {REAL_CREDIT}.{" "}
      <Link href="/#results" className="whitespace-nowrap font-medium text-zinc-900 underline underline-offset-2">
        How it was measured →
      </Link>
    </p>
  );
  const syntheticIntro = (
    <>
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <Scoreboard />
        <p className="border-t border-zinc-100 bg-zinc-50 px-4 py-2 text-xs text-zinc-500">
          Pre-registered synthetic holdout: 80 reports at 16 places CiviFold had never seen, scored on its first run. 8 were already fixed and are in neither row.{" "}
          {HELD_OUT.civifold.afterQuestion} of CiviFold&apos;s {HELD_OUT.civifold.right} correct merges came after one question, answered by a simulated resident.
          Location alone also merged {HELD_OUT.location.wrongIncident} duplicates into the wrong incident; on earlier sets, CiviFold made 1 to 3 wrong merges
          or closures each.{" "}
          <Link href="/#results" className="whitespace-nowrap font-medium text-zinc-900 underline underline-offset-2">
            How it was measured →
          </Link>
        </p>
      </div>
      <p className="max-w-3xl text-sm text-zinc-500">
        Real records rarely contain the cases that trip a location rule: the same hydrant model a few doors down, or one broken again the day after
        its repair. These were built on purpose with photos generated by Muse Image, like the holdout above.
      </p>
    </>
  );
  return (
    <main className="mx-auto max-w-5xl px-4 pb-10 pt-8">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Same spot isn&apos;t always the same problem.</h1>
      <p className="mt-2 max-w-3xl text-pretty text-lg leading-relaxed text-zinc-700">
        Grouping reports by location alone also sweeps in the look-alike next door and trash dumped again after a cleanup. Either can then be closed
        without anyone going back to look. CiviFold checks the photos first. Staff make the call.
      </p>
      <DemoRunner
        cases={CASES}
        real={REAL}
        others={OTHERS}
        live={live}
        initialSet={cases === "synthetic" ? "synthetic" : "real"}
        intro={{ real: realIntro, synthetic: syntheticIntro }}
      />
    </main>
  );
}
