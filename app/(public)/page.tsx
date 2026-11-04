// Author: HyeonMo Gu
// Created: 2026-10-27

import Link from "next/link";
import { HELD_OUT, Scoreboard } from "@/app/_ui/scoreboard";
import { SEARCH_CONFIG } from "@/lib/pipeline/config";
import { defaultMode } from "@/lib/meta/call";
import { liveDailyUsd } from "@/lib/server/runtime";

// Recorded evaluation runs on synthetic data: the share of reports that needed attention (a new problem or a
// recurrence) that got a one-click "duplicate / late / already fixed" suggestion. Location-only is the baseline.
const RESULTS = [
  { split: "holdout3, newest unseen places", n: 33, geo: 24, ours: 0 },
  { split: "holdout2", n: 33, geo: 22, ours: 1 },
  { split: "test, first run", n: 33, geo: 24, ours: 1 },
  { split: "holdout, first unseen set", n: 16, geo: 11, ours: 3 },
];

const FLOW = [
  { who: "Resident", what: "Sends a photo, a message, a voice note, or a mix.", model: "Muse Voice Transcribe" },
  { who: "Read", what: "Reads the message for danger, then names the fixture and the problem in the photo.", model: "Muse Spark" },
  { who: "Isolate", what: "Cuts out the hydrant or light, and a wider crop of what stands around it. Road damage and dumped piles are boxed first.", model: "Muse Spark + SAM 3.1" },
  { who: "Compare", what: "Compares the object and its surroundings with incidents nearby, then rules check dates and repairs.", model: "Muse Spark + rules" },
  { who: "Staff", what: "See the suggestion with its evidence and decide. Nothing is merged on its own.", model: "Human decision" },
];

const SCOPE = [
  { title: "Street fixtures", examples: "Fire hydrants, street lights; also accepted, not evaluated: traffic signs, benches", handled: "Matched by the fixture and its surroundings" },
  { title: "Problems at a place", examples: "Road damage, illegal dumping; also accepted, not evaluated: graffiti", handled: "Matched by the spot's fixed surroundings" },
  { title: "People or behavior", examples: "Noise, loitering, parking", handled: "Never matched by image; sent to staff" },
  { title: "Possible emergencies", examples: "Smoke, a gas smell, a fallen power line", handled: "No matching; top of the staff queue, resident told to call 911", urgent: true },
];

// Street Condition / Pothole requests created in September 2026, grouped by resolution description (queried 2026-10-29).
const NYC_311 = "https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9";

export const dynamic = "force-dynamic";

const pct = (a: number, n: number) => `${Math.round((a / n) * 100)}%`;

export default function Home() {
  const mode = defaultMode();
  return (
    <main>
      <section className="mx-auto grid max-w-6xl gap-10 px-4 pb-12 pt-10 md:grid-cols-[1.1fr_1fr] md:items-center md:pb-16 md:pt-14">
        <div>
          <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-zinc-900 sm:text-5xl">
            Fold the duplicates.
            <br />
            Keep recurrences apart.
          </h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-zinc-600">
            Of 3,662 street pothole requests recorded by NYC 311 in September 2026, 454 were closed as duplicates of an earlier one (
            <a href={NYC_311} className="underline underline-offset-2 hover:text-zinc-900">
              NYC Open Data
            </a>
            ). Matching by location alone cannot tell a duplicate from a look-alike a few doors down, or from the same fixture broken again after its
            repair. CiviFold compares what the photos show, checks the repair history, and suggests. Staff decide.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Link href="/demo" className="rounded-lg bg-zinc-900 px-5 py-3 text-sm font-semibold text-white hover:bg-zinc-800">
              Try the guided demo
            </Link>
            <Link href="/report" className="text-sm font-medium text-zinc-900 underline underline-offset-4 hover:text-zinc-600">
              Report a problem
            </Link>
          </div>
        </div>
        <SameBlock />
      </section>

      <section id="results" className="mx-auto max-w-6xl scroll-mt-16 border-t border-zinc-200 px-4 py-12">
        <h2 className="text-xl font-semibold tracking-tight text-zinc-900">What a location rule buries</h2>
        <div className="mt-5 grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div>
            <p className="text-sm leading-relaxed text-zinc-600">
              The newest held-out set: 80 synthetic reports at 16 places CiviFold had never seen, scored on its first run. Location alone links a
              report to the nearest incident of the same kind within {SEARCH_CONFIG.radius_m.fire_hydrant} m.
            </p>
            <div className="mt-4 overflow-hidden rounded-lg border border-zinc-200">
              <Scoreboard compact />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">
              Location alone also merged {HELD_OUT.location.wrongIncident} duplicates into the wrong incident; CiviFold none.{" "}
              {HELD_OUT.civifold.afterQuestion} of CiviFold&apos;s {HELD_OUT.civifold.right} correct merges came after one follow-up question, answered by a simulated
              resident. The other 8 of the 80 were already fixed and sit in neither row.
            </p>
          </div>
          <div>
            <p className="text-sm leading-relaxed text-zinc-600">
              Every unseen set, first run: of the reports that needed attention, the share that wrongly got a one-click &ldquo;duplicate, late or already
              fixed&rdquo; suggestion.
            </p>
            <table className="mt-4 w-full text-left text-sm">
              <thead className="text-xs text-zinc-500">
                <tr className="border-b border-zinc-200">
                  <th className="py-2 font-medium">Set</th>
                  <th className="py-2 text-right font-medium">Location alone</th>
                  <th className="py-2 text-right font-medium">CiviFold</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {RESULTS.map((r) => (
                  <tr key={r.split} className="border-b border-zinc-100">
                    <td className="py-2 font-sans">{r.split}</td>
                    <td className="py-2 text-right text-zinc-500">
                      <span className="hidden text-zinc-400 sm:inline">
                        {r.geo}/{r.n} ·{" "}
                      </span>
                      {pct(r.geo, r.n)}
                    </td>
                    <td className="py-2 text-right">
                      <span className="hidden text-zinc-400 sm:inline">
                        {r.ours}/{r.n} ·{" "}
                      </span>
                      {pct(r.ours, r.n)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">
              Synthetic photos generated with Muse Image. Each set was unseen when it ran. Rules were changed after the test set and the first unseen set,
              so those two rows used earlier rules. Later, Muse Spark began boxing road damage and dumped piles for SAM; re-run on holdout3 after that
              change (photos already seen), the current version again suggested closing none of the 33. Every run is in the{" "}
              <a href="https://github.com/Hyeon-moGu/CiviFold/blob/main/eval/README.md" className="underline underline-offset-2 hover:text-zinc-900">
                evaluation notes
              </a>
              .
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl border-t border-zinc-200 px-4 py-12">
        <h2 className="text-xl font-semibold tracking-tight text-zinc-900">How a report moves</h2>
        <ol className="mt-6 grid gap-x-6 gap-y-5 md:grid-cols-5">
          {FLOW.map((f, i) => (
            <li key={f.who} className="border-t border-zinc-300 pt-3">
              <h3 className="font-semibold text-zinc-900">
                <span className="mr-1.5 font-normal text-zinc-400">{i + 1}.</span>
                {f.who}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-zinc-600">{f.what}</p>
              <p className="mt-2 text-xs text-zinc-500">{f.model}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-6xl border-t border-zinc-200 px-4 py-12">
        <h2 className="text-xl font-semibold tracking-tight text-zinc-900">What it handles</h2>
        <dl className="mt-5 text-sm">
          {SCOPE.map((s) => (
            <div key={s.title} className="grid gap-x-6 gap-y-1 border-t border-zinc-200 py-3 sm:grid-cols-[12rem_1fr_1fr]">
              <dt className="font-semibold text-zinc-900">{s.title}</dt>
              <dd className="text-zinc-600">{s.examples}</dd>
              <dd className={s.urgent ? "font-medium text-rose-700" : "text-zinc-900"}>{s.handled}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-8 text-xs text-zinc-500">
          Built during the Meta Global AI Developer Hackathon, October 26 to November 4, 2026. Sample photos are synthetic, made with Muse Image.
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          Model calls:{" "}
          {mode === "cached"
            ? liveDailyUsd() > 0
              ? "recorded results first; live, within a daily budget, where no recording exists"
              : "recorded results only (no live calls)"
            : mode === "live"
              ? "live"
              : "recorded first, live on a miss"}
        </p>
      </section>
    </main>
  );
}

// The guided demo's first two scenarios: the same hydrant from another angle is suggested as a duplicate;
// the same model 28 m away is suggested as a new problem. Staff decide whether to apply either suggestion.
function SameBlock() {
  return (
    <figure className="rounded-xl border border-zinc-200 bg-white p-3">
      <div className="relative overflow-hidden rounded-lg">
        {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
        <img src="/api/images/syn_H1_damaged_v1_front?w=960" alt="The open incident: a leaking hydrant by the BAKERY" className="aspect-[16/9] w-full object-cover" />
        <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white">SYNTHETIC</span>
        <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pb-2.5 pt-8 text-white">
          <span className="block text-xs text-white/75">Open incident</span>
          <span className="text-sm font-medium">Leaking hydrant by the BAKERY</span>
        </figcaption>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Candidate
          src="/api/samples/syn_H1_damaged_v1_across/image?w=480"
          alt="A new report of the same hydrant from across the street"
          where="Same spot, from across the street"
          verdict="Suggested: duplicate"
          tone="bg-sky-50 text-sky-800 ring-sky-300"
          dot="bg-sky-500"
          why="Shop sign and bike rack match"
        />
        <Candidate
          src="/api/samples/syn_H5_damaged_v1_front/image?w=480"
          alt="A new report of a look-alike hydrant 28 m away"
          where="28 m away, by the LAUNDRY"
          verdict="Suggested: new problem"
          tone="bg-zinc-100 text-zinc-800 ring-zinc-300"
          dot="bg-zinc-500"
          why="Same model, different wall"
        />
      </div>
      <p className="mt-3 px-1 text-[11px] text-zinc-500">A distance-only rule would suggest both as duplicates. Results from the guided demo, which you can run yourself.</p>
    </figure>
  );
}

function Candidate({ src, alt, where, verdict, tone, dot, why }: { src: string; alt: string; where: string; verdict: string; tone: string; dot: string; why: string }) {
  return (
    <div>
      <div className="relative overflow-hidden rounded-lg">
        {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
        <img src={src} alt={alt} className="aspect-[3/2] w-full object-cover" />
        <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1 py-0.5 text-[9px] font-semibold tracking-wide text-white">SYNTHETIC</span>
      </div>
      <p className="mt-2 text-xs text-zinc-500">{where}</p>
      <p className={`mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {verdict}
      </p>
      <p className="mt-1 text-[11px] text-zinc-500">{why}</p>
    </div>
  );
}
