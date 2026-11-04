// Author: HyeonMo Gu
// Created: 2026-10-27

import Link from "next/link";
import { HELD_OUT, REAL_SF, RealScoreboard, Scoreboard } from "@/app/_ui/scoreboard";
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
const EVAL = "https://github.com/Hyeon-moGu/CiviFold/blob/main/eval/README.md";
const EVAL_REAL = `${EVAL}#real-311-photos-san-francisco`;

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
        <div className="mt-5 grid gap-x-10 gap-y-10 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Real San Francisco 311 photos</h3>
            <p className="mt-1 text-sm leading-relaxed text-zinc-600">
              Public requests with residents&apos; photos, picked by eye from the photos alone, with what counts as right written down before the runs.
              Location alone links a request to the earlier one at the same spot.
            </p>
            <div className="mt-4 overflow-hidden rounded-lg border border-zinc-200">
              <RealScoreboard compact />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">
              Of the {REAL_SF.afterCleanup} requests made after a cleanup, CiviFold flagged {REAL_SF.civifold.recurrence} as possible recurrences and kept the
              other {REAL_SF.afterCleanup - REAL_SF.civifold.recurrence} open: 2 as new problems, 7 with a question and 1 for staff. When both photos showed the same pile or damage, it merged fewer than location
              alone: without a sure match it asks for another photo or leaves the call to staff. Small checks, not a measurement:{" "}
              <a href={EVAL_REAL} className="underline underline-offset-2 hover:text-zinc-900">
                how they were picked and every result
              </a>
              .
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Pre-registered synthetic holdout</h3>
            <p className="mt-1 text-sm leading-relaxed text-zinc-600">
              The newest holdout: 80 reports at 16 places CiviFold had never seen, with look-alikes and repairs placed on purpose, scored on its first
              run. Location alone links a report to the nearest incident of the same kind within {SEARCH_CONFIG.radius_m.fire_hydrant} m.
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
        </div>
        <div className="mt-10 max-w-3xl">
          <p className="text-sm leading-relaxed text-zinc-600">
            Every unseen synthetic set, first run: of the reports that needed attention, the share that wrongly got a one-click &ldquo;duplicate, late or
            already fixed&rdquo; suggestion.
          </p>
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr className="border-b border-zinc-200">
                <th className="py-2 font-medium">Set</th>
                <th className="py-2 pl-3 text-right font-medium">Location alone</th>
                <th className="py-2 pl-3 text-right font-medium">CiviFold</th>
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
            Synthetic photos generated with Muse Image. Each set was unseen when it ran. Rules were changed after the test set and the first unseen set, so
            those two rows used earlier rules. Later, Muse Spark began boxing road damage and dumped piles for SAM; re-run on holdout3 after that change
            (photos already seen), the current version again suggested closing none of the 33. Every run is in the{" "}
            <a href={EVAL} className="underline underline-offset-2 hover:text-zinc-900">
              evaluation notes
            </a>
            .
          </p>
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
          Built during the Meta Global AI Developer Hackathon, October 26 to November 4, 2026. Sample photos are real San Francisco 311 requests (DataSF,
          PDDL 1.0) and synthetic ones made with Muse Image, each marked.
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

// Two real San Francisco 311 pairs from the demo, each two residents at one spot: the same panel a day later is
// suggested as a duplicate; new trash after Public Works' cleanup as a possible recurrence. Staff decide either way.
function SameBlock() {
  return (
    <figure className="rounded-xl border border-zinc-200 bg-white p-3">
      <p className="mb-3 flex items-center gap-2 px-1 text-xs font-medium text-zinc-600">
        <span className="rounded bg-sky-700/85 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white">SF 311 PHOTO</span>
        Real San Francisco 311 requests
      </p>
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-3">
        <Pair
          title="The same panel, a day later"
          before={{ src: "/api/images/sf_t058_1?w=480", alt: "The open request: a wooden panel left at a street tree on 24th Street", when: "Open, Sep 14" }}
          after={{ src: "/api/samples/sf_t058_2/image?w=480", alt: "A new request the next day: the same panel at the same tree", when: "New, Sep 15" }}
          verdict="Suggested: duplicate"
          tone="bg-sky-50 text-sky-800 ring-sky-300"
          dot="bg-sky-500"
          why="Same tree pit, curb and paint mark"
        />
        <Pair
          title="New trash after the cleanup"
          before={{ src: "/api/images/sf_a123_1?w=480", alt: "A request on Alemany Boulevard that Public Works cleared the same morning", when: "Cleared, Sep 9" }}
          after={{ src: "/api/samples/sf_a123_2/image?w=480", alt: "A new request six days later: different trash at the same corner tree", when: "New, Sep 15" }}
          verdict="Suggested: possible recurrence"
          tone="bg-rose-50 text-rose-800 ring-rose-300"
          dot="bg-rose-500"
          why="Same corner, different trash"
        />
      </div>
      <figcaption className="mt-3 px-1 text-[11px] leading-relaxed text-zinc-500">
        Location alone gets the first right too, but merges the second into the cleared request, closing it as already fixed. Photos: DataSF public
        records, people and plates blurred. Results from the demo, which you can run yourself.
      </figcaption>
    </figure>
  );
}

type Shot = { src: string; alt: string; when: string };

function Pair({ title, before, after, verdict, tone, dot, why }: { title: string; before: Shot; after: Shot; verdict: string; tone: string; dot: string; why: string }) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-zinc-900">{title}</p>
      <div className="grid grid-cols-2 gap-1.5">
        {[before, after].map((s) => (
          <div key={s.src}>
            <div className="relative overflow-hidden rounded-md bg-zinc-100">
              {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
              <img src={s.src} alt={s.alt} className="aspect-[3/4] w-full object-cover" />
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">{s.when}</p>
          </div>
        ))}
      </div>
      <p className={`mt-1.5 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        {verdict}
      </p>
      <p className="mt-1 text-[11px] text-zinc-500">{why}</p>
    </div>
  );
}
