# SF 311 photo pairs: selection and expectations

Written on 2026-11-04 before these runs. The picks below were made by eye from the photos alone, before any of them was given to a model. Four picked pairs (t052, t058, r085, a123) were run once, alone, before this file was written, to choose photos for the demo and the video; their results are part of this run as they came out, and no pick was changed after them.

## Source and sampling

Public San Francisco 311 requests with a resident's photo ([pairs.json](pairs.json) lists every candidate, its two cases and photo links). Two requests make a pair when they are within 6 m:

- **same trash**: street and sidewalk cleaning requests within 24 hours of each other;
- **same road damage**: pavement or sidewalk defect requests within 14 days;
- **after cleanup**: the earlier request closed by Public Works as "case_resolved - Resolved", the later one made 1 hour to 7 days after that.

One pair per spot (spots at least 40 m apart), a seeded random sample: 60 trash, 42 road, 40 after-cleanup. 8 pairs whose two photos are the same image sent twice were dropped (perceptual hash distance at most 10), leaving 140.

## Picks (by eye, before any run)

- **same**: both photos clearly show the same pile or the same damage. 18 of 58 trash pairs, 15 of 42 road pairs.
- **after cleanup**: both photos show the same fixed surroundings (a pole, a tree pit, a utility box) with different material. 4 of 40.

Most pairs were not picked because one photo shows nothing comparable: a close-up of pavement, a different item, or no material at all. Every picked pair is reported, whatever its result.

## Runs and what counts

Each later photo runs once through the unchanged fast path (`npm run analyze`), at its own location and time, with the category of its request (trash, or road damage).

**same pairs** (33): the earlier photo is an open incident. Public Works had closed many earlier requests by the time of the later one, often without a note, yet both photos show the problem still there; the incident is therefore open.
- Expected: a duplicate suggestion, one question to the resident, or staff review.
- Miss: a new problem (a second incident for the same pile or damage).
- No critical outcome is possible: the only incident is open.

**after-cleanup pairs** (4): the earlier photo is an incident resolved at Public Works' closing time.
- Expected: possible recurrence, new problem, one question, or staff review.
- **Critical**: duplicate, late report or already fixed. Location alone would close all 4.
