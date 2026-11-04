// Author: HyeonMo Gu
// Created: 2026-10-27

import Link from "next/link";
import { imageId } from "@/lib/dataset/assets";
import { messageSample } from "@/lib/dataset/messages";
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
  return `${a.object.replace(/\s*\(.*\)$/, "")} by the ${a.sign_texts[0]}`;
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
    incident: { photo: incidentPhoto("W1"), caption: `Reported three days ago, cleared yesterday: the ${place("W1")}` },
    report: { photo: photoOf("dumping:3")!, caption: "New report, taken today" },
    expect: expectOf("dumping:3"),
    noun: "pile",
    boxed: true,
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
  { key: "voice:0", then: "voice:1", send: "Send the voice message", thenSend: "Answer with a photo", thenPhoto: photoOf("voice:1")!, thenExpect: expectOf("voice:1"), what: "A voice message with no photo", note: "Asks for a photo. With the photo, it is the same problem.", kind: "voice", ...messageOf("voice:0"), expect: expectOf("voice:0") },
  { key: "dumping:1", send: "Send the photo", what: "A cleaned-up spot, seen from across the street", note: "Asks for another photo before calling it fixed.", photo: photoOf("dumping:1")!, expect: expectOf("dumping:1") },
  { key: "closeup:0", send: "Send the photo", what: "A close-up with nothing around it", note: "Asks for a wider photo: nothing ties it to one place.", photo: photoOf("closeup:0")!, expect: expectOf("closeup:0") },
  { key: "messages:0", send: "Send the voice message", what: "Smoke from a street light", note: "A possible emergency goes straight to the top of the staff queue.", kind: "voice", urgent: true, ...messageOf("messages:0"), expect: expectOf("messages:0") },
  { key: "messages:1", send: "Send the message", what: "A noise complaint", note: "About people, not a place, so photos are never matched. Staff handle it.", kind: "text", ...messageOf("messages:1"), expect: expectOf("messages:1") },
];

export default function DemoPage() {
  // A replay-only deployment with no live budget offers no live run, rather than one that falls back to the replay.
  const live = defaultMode() !== "cached" || liveDailyUsd() > 0;
  return (
    <main className="mx-auto max-w-5xl px-4 pb-10 pt-8">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Same spot isn&apos;t always the same problem.</h1>
      <p className="mt-2 max-w-3xl text-lg leading-relaxed text-zinc-700">
        Grouping duplicate reports by location also folds in the look-alike next door and the hydrant that broke again after its repair, and either
        can be closed without anyone going back out. CiviFold checks the photos first. Staff make the call.
      </p>
      <div className="mt-4 max-w-3xl overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <Scoreboard />
        <p className="border-t border-zinc-100 bg-zinc-50 px-4 py-2 text-xs text-zinc-500">
          Pre-registered held-out test of 80 synthetic reports; every merge is a suggestion until staff approve it. Location alone also merged{" "}
          {HELD_OUT.location.wrongIncident} duplicates into the wrong incident; CiviFold none.{" "}
          {HELD_OUT.civifold.afterQuestion} of CiviFold&apos;s {HELD_OUT.civifold.right} correct merges came after one follow-up question, answered by a simulated resident;
          on earlier test sets, CiviFold made 1 to 3 wrong merges each. The other 8 reports were already fixed and sit in neither row.{" "}
          <Link href="/#results" className="font-medium text-zinc-900 underline underline-offset-2">
            How it was measured →
          </Link>
        </p>
      </div>
      <p className="mt-3 text-sm text-zinc-500">
        Synthetic photos, made with Muse Image. Each case replays its recorded run in seconds
        {live ? <>; &ldquo;Run it live&rdquo; calls the models now</> : null}.
      </p>
      <DemoRunner cases={CASES} others={OTHERS} live={live} />
    </main>
  );
}
