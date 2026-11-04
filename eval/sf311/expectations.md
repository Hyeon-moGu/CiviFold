# SF 311 real-photo check: selection and expectations

Written on 2026-11-04 before any of these photos was given to a model. Nothing below was changed after the run.

## Source and sets

Public San Francisco 311 requests ([DataSF 311 Cases](https://data.sf.gov/resource/vw6y-z8j6.json), PDDL 1.0) for street and sidewalk cleaning, requested from 2026-07-15 to 2026-11-03, with a resident's photo. A set is three requests at one spot, each with a photo:

- **first**: a request that Public Works later closed as "case_resolved - Resolved";
- **dup**: a request within 15 m and 48 hours of it, made while it was open, that Public Works closed as a duplicate;
- **after**: a request within 15 m, made within 7 days after the first was closed, not closed as a duplicate.

This gave 30 spots at least 30 m apart ([sets.json](sets.json)). The photos are not copied into this repository; sets.json lists each case and its photo link.

## Screening (photos only, before any model call)

A set was kept only if all three photos passed:

- **Q1** the photo clearly shows dumped material (a bare sidewalk, a tree base, stairs or an unclear dark spot fails);
- **Q2** the duplicate is a different photo from the first (8 sets were the same image sent twice, perceptual hash distance 0);
- **Q3** no encampment belongings and no identifiable person as the subject.

9 of 30 sets passed: sf04, sf05, sf08, sf13, sf14, sf15, sf18, sf26, sf29. The reason for each exclusion is in sets.json. Every kept set is reported, whatever its result.

## Runs and what counts

Each photo is normalized the way the app normalizes an upload (turned upright, longest side 1920 px, JPEG) and run through the fast path with `npm run analyze`, at the request's own location and time, category trash. Nothing in the fast path was changed for this check.

**dup run**: the first request's photo is an open incident; the duplicate arrives as a new report.
- Expected: a duplicate suggestion, one question to the resident, or staff review.
- Miss: a new problem (a second incident). Public Works merges requests by spot and request, so a different item a few meters away can be its duplicate and still be a different problem to CiviFold; a miss is reported as such, not as an error.
- No critical outcome is possible: the only incident is open.

**after run**: the first request's photo is an incident resolved at Public Works' closing time; the later request arrives as a new report.
- Expected: possible recurrence, new problem, one question, or staff review.
- **Critical**: duplicate, late report or already fixed, which would close a request about material dumped after the cleanup.
- Location alone: every later request is within 15 m of the resolved incident, so a location rule would close all 9.
