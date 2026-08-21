# Verification

This project is a port of a working private tool, so "it compiles" is not a
result. Every stage is diffed against the implementation it replaces, and the
numbers below are measurements rather than estimates.

Measured 2026-08-20 against 47 real boards.

## Collection

| | value |
|---|---|
| boards crawled | 47 (26 Greenhouse, 12 Ashby, 7 Lever, 2 SmartRecruiters) |
| board failures | 0 |
| postings returned | 2,929 |
| unique after dedupe | 2,897 |
| postings with a description body | 2,928 of 2,929 (99.97%) |
| elapsed | 21.2s |

The reference implementation, run against the same 47 boards on the same day,
returned **the same 2,929 postings, the same 2,897 unique hashes, and the same
0 failures**, in 76.7s.

Both crawls hit the boards directly and neither used a search API.

## Hash-set parity

The dedupe hash is `sha256(normCompany|normTitle|normLocation)`, so a
normalization difference between the two implementations shows up as a posting
present in one hash set and absent from the other.

| | value |
|---|---|
| unique hashes, this implementation | 2,897 |
| unique hashes, reference implementation | 2,897 |
| present in one and not the other | **0** |

Separately, and more strictly: all 2,929 collected postings had their company,
title and location run through both normalizers. **2,929 of 2,929 hashes
matched, 100.000%.** That isolates normalization from collection, so the result
does not depend on both crawls having seen the same postings.

## Description extraction

Both HTML-to-text implementations were given byte-identical Ashby markup and
returned strings of identical length (5,403 characters).

Description *lengths* differed on 202 of 2,929 postings across the two crawls,
which looked like an extraction difference and is not one:

> The same implementation, fetching the same board twice in a row, returned
> 6,636 characters and then 5,018 characters for the same posting.

An ATS can serve two different revisions of one posting seconds apart. So
description length is not a stable identity signal, and diffing on it chases
ghosts. The hash deliberately does not include the description.

## Reproducing

```bash
npm test                          # 78 tests, no API key, no network
node scripts/record-fixtures.js   # refresh the recorded board responses
```

Collector parity needs a board list and the reference implementation, neither
of which is in this repository.

## Workday, live

Measured 2026-08-20 against `jll.wd1` / `jllcareers`.

| | value |
|---|---|
| list page size | 20 (50 and 100 both return HTTP 400) |
| reported total | 2000, which is a display cap rather than a count |
| `searchText` | filters server-side, the only platform that does |
| postings fetched with `searchText: "facilities manager"` | 40 in 4.1s |
| detail bodies | 8,090 characters, real ISO `startDate`, `timeType` |
| postings without a detail call | still carry title, location, URL and remote type |

Tenant resolution from a careers page:

- `https://www.jll.com/en-us/careers` resolves to
  `{tenant: jll, host: wd1, site: jllcareers}`.
- `https://careers.fortive.com` resolves to **nothing**, and correctly so. It
  is a 300KB WordPress marketing site that never names a board; the job search
  is another click in. A guess here costs a 422 that reads as a dead board, so
  discovery returns null and the user pastes the board URL instead.

## Still to verify

- Gate parity, and the measured gain from body-based remote detection
- Scorer diff against a known-good scored set
- The ai-forward signal set reproducing its scoring split on a real corpus
- Following one level of careers-page links, to resolve boards like Fortive's
