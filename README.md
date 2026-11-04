<h1 align="center">CiviFold</h1>

<p align="center">
  <b>Fold the duplicates. Keep recurrences apart.</b><br>
  Photo-based duplicate and recurrence checks for city 311 staff, built on Muse Spark and SAM 3.1. It only suggests; staff decide.
</p>

<p align="center">
  <a href="https://civi-fold.vercel.app/demo"><b>Live demo</b></a> ·
  <a href="#results">Results</a> ·
  <a href="eval/README.md">Evaluation notes</a> ·
  <a href="#run-locally">Run locally</a>
</p>

![Still broken, or broken again? Two real San Francisco 311 photos of one corner tree: trash reported and cleared on September 9, and new trash at the same corner on September 15. Location alone closes the new request as already fixed; CiviFold keeps it apart as a possible recurrence for staff. On a controlled test of 80 pre-registered synthetic reports, repeats merged into the right incident: location alone 30 of 39, CiviFold 34 of 39; new or returning problems wrongly merged: location alone 24 of 33, CiviFold 0 of 33. Real requests made after a cleanup and closed as fixed: location alone 13 of 13, CiviFold 0 of 13.](media/hero.webp)

CiviFold groups duplicate photo reports for city staff and keeps a recurrence, or the look-alike next door, out of the pile. Its default pipeline (Muse Spark, SAM 3.1 and rules, called the fast path below) compares what the photos show, then applies the repair history. Every link and closure is a suggestion until a staff member approves it.

| Suggestions | Location alone | **CiviFold** |
|---|---|---|
| **Controlled test**, 80 synthetic reports, pre-registered: repeats merged into the right incident | 30 / 39 | **34 / 39** |
| **Controlled test**: new or returning problems wrongly merged | 24 / 33 | **0 / 33** |
| **Real SF 311** requests made after a cleanup, closed as already fixed | 13 / 13 | **0 / 13** |

The controlled test was generated with Muse Image, with look-alikes and repairs placed on purpose and every answer known, and scored on its first run. On real photos CiviFold suggests fewer merges than location alone: of 33 pairs showing the same pile or damage it suggested merging 14, asked or sent 17 to staff, and wrongly suggested 2 as new problems. The real checks are small and picked by eye ([results](#results)).

> [!TIP]
> **Try it in three minutes**
> 1. Open the [demo](https://civi-fold.vercel.app/demo). The first real San Francisco case is already shown; send the other three, or press "Run it live" on one.
> 2. Switch to Hard cases, send case 3, open it in the staff view and press "Verify with the agent".
> 3. Approve it: the demo card and the resident's page show the decision.

### Three rules it keeps

- **Nothing closes by itself.** The system never links or closes a report. It suggests, shows the evidence and waits for staff.
- **Models judge the photo, rules judge the time.** Muse Spark and SAM 3.1 decide whether two photos show the same fixture and the same damage. Rules then apply the observation time and the repair history. The comparison never sees a timestamp.
- **Closing takes two observations.** A duplicate, late report or already fixed suggestion needs a confident cut-out match or two distinct report photos.

## Why it matters

In September 2026, New York City's 311 recorded 3,662 street pothole requests. The Department of Transportation closed 454 of them (12%) as duplicates of an earlier complaint, and 63 after an inspection found the problem already fixed ([sources](#sources)). A location rule sorts them badly: the broken fixture next door and the problem that returned after repair both sit where the earlier report was filed.

| Incoming report | Suggested action | Evidence |
|---|---|---|
| Same leaking hydrant, another angle | **Duplicate** | Matching sign, bike rack and fixture details |
| Similar hydrant, 28 m away | **New problem** | Different shop sign, bollard and doorway |
| Same hydrant, damaged after repair | **Possible recurrence** | Matching location, new damage and a later observation |

![Synthetic hard cases from the demo: the open incident by the BAKERY, the same hydrant from across the street, a look-alike by the LAUNDRY, and new damage after repair.](media/scenes.webp)

*Synthetic hard cases from the demo, generated with Muse Image: look-alikes and repairs placed on purpose, which real records rarely contain.*

CiviFold is for the staff who review incoming reports at a 311 center or public works office. It puts the candidates' photos beside the new one, says what matched and what differed, and leads with the suggested action. To run for a city it needs the open and recently repaired incidents with photos and repair dates, read from the existing 311 or work-order system (an Open311-style API or an export, not built yet). Without repair dates, a late report and a recurrence cannot be told apart.

## What staff see

![Staff console: a possible recurrence on a real San Francisco 311 request, seen about six days (142 hours) after Public Works cleared the trash at the corner tree on Alemany Boulevard, with its suggested decision, both photos with Muse Spark's box, SAM outlines and cut-outs, and what the comparison found about the place (same) and the problem (not the same).](media/staff-review.webp)

It shows the suggestion and why (seen six days after the cleanup, with new trash), both photos with Muse Spark's box, SAM's outline and the cut-outs, and what the comparison found about the place and the problem. Staff accept it in one click or choose another action. *Real San Francisco 311 photos.*

## How it works

![From report to decision: a photo, text or voice report (voice transcribed by Muse Voice Transcribe) is read by Muse Spark and routed by rules, with emergencies and reports about people going straight to staff; photos go through triage (Muse Spark), a 40 m search (rules), cut-outs (SAM 3.1, with Muse Spark boxing road damage and piles first) and comparison (Muse Spark, no timestamps); rules then suggest duplicate, late report, already fixed, possible recurrence, new problem, one question or staff review, and staff decide. Staff may ask the agent to look for evidence against a closing suggestion.](media/report-flow.svg)

- **Route first.** Emergencies go to the top of the staff queue, reports about people skip image matching, and a report without a photo is never matched: the system asks for one when nearby incidents need telling apart. In San Francisco, 7 in 10 of the 311 cases opened in September 2026 came with an attachment, usually a photo; phone calls, 1 in 5, almost never did.
- **Compare, then apply time.** Muse Spark compares the whole photos and the SAM 3.1 cut-outs without any timestamp. For road damage and dumped trash, which have no fixture shape to name, Spark first boxes the damage or the pile and SAM segments inside the box. Rules then use the observation time and the repair history to tell a duplicate, a late report and a possible recurrence apart, or ask the resident one question.
- **Agents when staff ask (experimental).** A verification agent looks for evidence against a closing suggestion with the same tools, and can only make it more cautious. A brief agent writes the case summary staff read first; an item that cites no tool result or numbered fact is deleted. Neither decides anything ([how they work](eval/README.md#the-agents-in-the-app)).

| Meta model | What it does here |
|---|---|
| **Muse Spark** (`muse-spark-1.3`) | Reads the words, boxes road damage and dumped piles for SAM, compares photos whole and as cut-outs, runs the verification and brief agents with function tools |
| **SAM 3.1** | Cuts out the fixture or the boxed damage, and its surroundings, for the comparison |
| **Muse Voice Transcribe** | Turns a spoken report into text |
| **Muse Image** | Generated the 504-image synthetic evaluation set, for about $5 |

Muse Spark returns its judgment as structured fields the rules can check (same fixture, problem visible, signs of repair, the features that matched), not as a similarity score. Each view fails differently. On test, whole photos alone made 2 critical errors and cut-outs alone got only 50 of 78 right, against 1 and 69 with both. On the holdouts the gain is mixed: on holdout2, whole photos alone got more right (70 against 66) with the same one critical error, and on the first holdout each view alone made one critical error fewer. The fast path gives the rules both ([ablations](eval/README.md#results-base-sets)).

## Results

### Controlled test: synthetic holdouts

![Bar chart: wrong closing suggestions on reports that needed attention, location alone against CiviFold's fast path, on four evaluation sets. test 24 against 1 of 33, holdout 11 against 3 of 16, holdout2 22 against 1 of 33, holdout3 24 against 0 of 33.](media/results.svg)

*Wrong closing suggestions, first run of each set. Rules were improved after test and the first holdout, the fast path was frozen after holdout2 with one later change (finding road damage and dumped piles, below), and each holdout was pre-registered before it ran.*

The latest holdout has 80 reports from 16 assets (8 fixtures or places and their look-alikes). 33 of them describe a new problem or a recurrence that must not be closed. All images and resident answers are **simulated**, and the numbers count suggestions, not staff decisions.

| holdout3 · 80 reports | Location alone | **Fast path (default)** | Automatic agent¹ |
|---|---|---|---|
| Wrong closing suggestions on reports needing attention | 24 / 33 | **0 / 33** | 0 / 33 |
| Correct before any resident answer | 26 / 80 | **51 / 80** | 46 / 80 |
| Correct after simulated answers | 26 / 80 | **72 / 80** | 63 / 80 |
| Left to staff without a suggestion | 0 / 80 | **3 / 80** | 12 / 80 |
| API spend and time per report, live | $0 | $0.053, about 24 s | $0.053 + $0.025 |

¹ Verification run on every closing suggestion (`D_hybrid`), second run, with the neutral names the agent now sees (the first run, with identifiers visible: 49, 66 and 8). It does not measure the app's staff-requested mode.

- **0 / 33 is an observation, not a guarantee.** A second live run of the fast path repeated it (67 / 80 correct after answers); earlier sets had 1 to 3 misses. Location alone proposes the nearest incident of the same kind as a duplicate and stands for no city's actual system.
- **It asks rather than guesses.** The fast path asked one question (a wider shot, another angle, a close-up or the time) on 23 reports, and 21 ended correct after the simulated answer. Simulated residents always answer; reports nobody answers stay with staff.
- **Verification stays optional.** On holdout3 it left the critical count unchanged and raised deferrals from 3 to 12. Across all sets it stopped one wrong suggestion.
- **One change since.** SAM's noun phrase often missed a patched or lifted road surface and cut a dumped pile down to one bag, so those reports got a question even when the whole photos matched. Muse Spark now boxes the damage or the pile, and SAM segments inside the box. Re-run on holdout3, whose photos had been seen by then, the current version again made 0 / 33 wrong closing suggestions, got 60 of 80 right before any answer (51 before) and asked 14 questions instead of 23 ([details and the development-set check](eval/README.md#after-holdout3-road-damage-and-dumped-piles)).

### Real San Francisco 311 photos

Two checks on public San Francisco 311 requests. Requests were picked by eye from the photos alone, and what counts as right, a miss or critical was written down before the runs; four pairs had been run once earlier to choose the demo photos, and their results count as they came out. Each report ran once, live, through the unchanged fast path at its own place and time ([details](eval/README.md#real-311-photos-san-francisco)). Location alone links each request to the earlier one at its spot.

| Real SF 311 requests, suggestions | Location alone | **Fast path** |
|---|---|---|
| New trash after a cleanup at the same spot, closed as already fixed | 13 / 13 | **0 / 13** |
| Same pile or damage in both photos, merged (the right call) | 33 / 33 | 14 / 33 |

![Four real San Francisco 311 pairs from the demo, each two residents at one spot, with what CiviFold and location alone suggest: new trash at a corner tree after the cleanup, which CiviFold keeps apart as a possible recurrence and location alone closes as already fixed; the same wooden panel a day later, a duplicate for both; the same orange bags from a wider view, which CiviFold sends to staff; the same broken utility cover, where CiviFold asks for another angle. Photos: DataSF 311 public records, people and plates blurred.](media/real-sf.webp)

- **After a cleanup, no closing suggestion.** Of the 13 requests made within 7 days after Public Works' cleanup, it flagged 3 as possible recurrences and kept the other 10 open: 2 as new problems, 7 with a question to the resident and 1 for staff.
- **It suggests fewer merges on real duplicates and asks more.** When both photos clearly show the same pile or damage, it suggested merging 14 of 33, asked or sent 17 to staff, and suggested 2 as new problems. Road damage asked most: a cut-out of a broken cover or a crack in plain pavement rarely carries a sure match, and a merge needs two independent observations. Of 9 further requests that Public Works closed as duplicates, mostly different items at one corner, it suggested merging 1 and opening 3 as new.
- **Three real photos** of one dumped pile in Korea, run once with the expectations written first, gave no wrong link and no confirmed duplicate either: the views share no fixed feature, so the fast path asked for a wider shot ([details](eval/README.md#real-world-check)).
- These are small checks picked by eye, not a measurement, and the duplicate labels are Public Works' operational ones. The demo's four real cases are pairs from the second check.

**[Methods, ablations, every set and every recorded run →](eval/README.md)**

## Limitations

- **Mostly synthetic evaluation.** The real-photo checks are small (55 San Francisco 311 requests, picked by eye), there was no study with real residents or city staff, and no time savings were measured. The harness supplies the correct incident history rather than carrying earlier mistakes forward.
- **Four evaluated categories:** hydrants, street lights, dumped trash and road damage. Signs, benches and graffiti are accepted but not evaluated. Look-alikes in identical surroundings are not tested separately.
- **Fixtures far away.** SAM sometimes misses a thin street light pole from across the street, and the report then needs a second photo. Boxing fixtures with Muse Spark found them, but once matched a look-alike of the same model on the pole alone, so fixtures keep SAM's noun phrase.
- **Coarse evidence.** The evidence check counts lines, not independent features, and a problem is visible or not, with no "not observable" state. The search uses the category the resident chose; the analysis uses the one Muse Spark read from the photo.
- **Agents.** Staff-requested verification and the case brief have no separate evaluation. On holdout3 the fast path ran twice before the later change and once after, and the automatic agent twice; holdout2 was partly re-run after a harness fix; every other configuration ran once per set.
- **Demo deployment.** No login, no undo and no audit trail: anyone with the URL can act as staff, and anyone can reset the demo world (once a minute, and three times in 15 minutes from one network). Every action that writes or calls the models is paced per network, and repeated overuse holds that action back for an hour.

## Run locally

Requires **Node.js 22.9.0 or later** and a Meta Model API key; the local model cache is not in the repository.

```bash
npm install
cp .env.example .env.local   # add MODEL_API_KEY; empty settings use their defaults
npm run seed                # local PGlite database and demo world
npm run dev                 # http://localhost:3000
```

| Page | Purpose |
|---|---|
| `/demo` | Four real San Francisco 311 cases, five generated hard cases and five reports without a usable photo, each beside what grouping by location alone would do |
| `/report` | Resident reporting form |
| `/admin` | Staff queue and evidence review |

`npm run lint`, `npm run typecheck` and `npm test` need no API key, and CI runs them and the production build on every push to main. Evaluation commands are in [the evaluation guide](eval/README.md#running-the-evaluation).

The public deployment replays recorded model runs and allows live calls within a daily budget (`LIVE_DAILY_USD`). "Run it live" on a demo card always calls the models now, and so does anything with no recording yet, such as an upload made with the demo access code or an agent check on it. Live runs keep no recording, so a reset always replays the same world. Once the day's budget is spent, cases replay and say so, and a report with no recorded result is marked unavailable. The demo world sits on a map of San Francisco's Mission District; its four real 311 cases are at their own places in the city.

**Stack:** Next.js 16 · React 19 · Tailwind 4 · TypeScript · zod · Drizzle · Neon Postgres / local PGlite · Vercel Blob · Leaflet / OpenStreetMap · vitest. Meta calls share caching, retries and cost tracking through `lib/meta/`.

## Built during the hackathon

An entry in the Meta Global AI Developer Hackathon, Indie track, theme "Build for Your World". The code, prompts, synthetic evaluation dataset, generation scripts and evaluation harness were created during **October 26–November 4, 2026**. The first commit is dated October 26 in US Eastern time. No earlier project code is reused; third-party code comes from the open-source dependencies in `package.json`. The synthetic evaluation images and the generated demo photos were made with Muse Image and are marked **SYNTHETIC** in the app; the real San Francisco photos are public 311 records, marked **SF 311 PHOTO**.

## Sources

- **NYC 311 potholes.** [NYC Open Data, 311 Service Requests](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9): complaint type "Street Condition", descriptor "Pothole", created September 1–30, 2026, grouped by resolution description, queried October 29, 2026. Highway and bridge potholes are excluded, and open requests can still change the counts. The dataset has no photo field and its channel field reads UNKNOWN, so it does not show how duplicates were identified or whether a recurrence was merged by mistake.
- **San Francisco 311 channels.** [DataSF, 311 Cases](https://data.sfgov.org/City-Infrastructure/311-Cases/vw6y-z8j6): cases with `requested_datetime` in September 1–30, 2026, grouped by `source`, counting cases whose `media_url` is set, queried October 29, 2026. Of 76,457 cases, 69% carried an attachment (mobile 84%, web 89%, phone 0.2%); phone was 19% of cases. The real-photo checks use the same dataset's photo links for street cleaning and sidewalk or pavement defect requests, June 1 to November 3, 2026 (PDDL 1.0); the demo's eight real photos are in [dataset/real-sf/](dataset/real-sf/), with people and license plates blurred.
- **Evaluation numbers.** [eval/README.md](eval/README.md) and the JSON files in [eval/results/](eval/results/), each with the code and prompt fingerprints it ran with.
