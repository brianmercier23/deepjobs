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
npm test                          # 174 tests, no API key, no network
node scripts/record-fixtures.js   # refresh the recorded board responses
```

Collector parity needs a board list and the reference implementation, neither
of which is in this repository.

## Gate parity

Both gates were run over one shared dump of the same 2,929 postings, so the
comparison isolates gate logic from collection and from any difference in what
the two crawls happened to see.

| | value |
|---|---|
| postings gated | 2,929 |
| passed, this implementation | 872 (29.8%) |
| passed, reference implementation | 872 |
| **decisions that differ** | **0** |
| **flag sets that differ** | **0** |
| reject reasons that differ | 77, all cosmetic |

The 77 are a deliberate improvement rather than a divergence: the reference
implementation reports the compiled pattern (`title contains 'director\s+of'`)
where this one reports the term a human wrote (`title contains 'director of'`).

## Reading the body instead of trusting the remote flag

Every job tool filters on structured remote metadata. An employer can tick
"remote" and then write a description asking for three days a week in an
office, so those postings pass every filter and are caught only by a person
reading the body, or by an LLM that has already been paid for.

Run over the 872 postings that pass the gate, of which 859 carry a REMOTE flag:

| flag | count | meaning |
|---|---|---|
| `REMOTE_CONTRADICTED` | 4 | declared remote, body requires time on site |
| `REMOTE_GEO_LIMITED` | 3 | declared remote, body restricts where you may live |

Real catches, all from postings whose location field says remote:

- *"Candidates located within commuting distance of NYC will work from our
  office 4-5 days per week"* — listed as "New York City / Remote"
- *"This is a remote position that must live near the Scottsdale, AZ or
  Chicago, IL office"* — listed as "Remote, AZ or IL"
- *"This person must be located in Eastern or Central Timezones"* — listed as
  "Remote, United States"

The first attempt reported 25 rather than 7, and 18 of those were wrong. A
bare `hybrid` pattern was matching *"a flexible hybrid work model that
balances remote focus with vibrant office collaboration"*, which is a benefits
blurb. Removing it took the count from 25 to 7. The number that matters here
is the one left after the false positives come out, because a gate that
mislabels a genuinely remote role is doing the one thing this gate must not do.

Known gap, left for tuning against the corpus: phrasing that puts the office
before the cadence, as in *"work in person at our office 4-5 days a week"*, is
not matched yet.

## The ai-forward signal set

Run over the same 2,897 unique postings. Tagging is regex over text already in
hand, so the cost is the whole point:

| | value |
|---|---|
| postings tagged | 2,897 |
| elapsed | 647ms |
| carrying a forward term | 994 (34.3%) |
| carrying a legacy term | 40 (1.4%) |
| carrying both | 7 |

34.3% is high because of what this corpus is: 47 hand-picked technology
employers in 2026, which is exactly the population that would name these tools.
It is not evidence that the set is loose. Precision was checked by pulling the
matched sentence for every high-frequency term, and the forward half held up:

- `agentic` (557) — *"own the quality infrastructure for our agentic product direction"*
- `mcp` (245) — *"Comfort with CLI-based tooling, MCP integrations, and AI agent frameworks"*
- `claude` (237) — *"use Claude Code, Cursor, and others as a core part of your workflow"*
- `rag` (115) — *"tool-calling agents, planning/execution loops, and RAG"*

The legacy half did not. `articulate` fired 245 times and was the English verb
essentially every time: *"you can articulate technical tradeoffs to engineers"*,
which is a communication requirement in half the job market rather than a
signal about an e-learning tool. Replacing the bare word with the product names
(`articulate storyline`, `articulate 360`) took legacy hits from 281 to 40.

Six terms never fired at all: `openai api`, `lms administration`, `nuvolo`,
`siebel`, `lotus notes`, `mail merge`. They are kept rather than pruned. This
corpus is technology employers; those terms belong to the facilities, CRE and
corporate-training postings the set exists to tell apart, and none of those
employers are in this board list yet.

### The tag does not predict the score, and that is the correct result

The working hypothesis was that forward-tagged postings would score 65-81 and
legacy-tagged ones 25-40. With the scorer in place it was measured directly: 45
forward-only, 10 legacy-only (all that exist) and 45 untagged postings, sampled
deterministically from the 942 that pass the gate, scored at temperature 0
against the same rubric.

| | forward | legacy | untagged |
|---|---|---|---|
| n | 45 | 10 | 45 |
| median | 18 | 28 | 15 |
| mean | 25.8 | 27.7 | 21.7 |
| scoring 60+ | 3 | 0 | 2 |

**The hypothesis does not hold.** There is no 65-81 band, and legacy-tagged
postings score slightly *higher* than forward-tagged ones.

The six sub-scores explain why, and they are the first thing in this repository
that could:

| dimension (max) | forward | legacy | untagged |
|---|---|---|---|
| Location viability (25) | 18.5 | 20.5 | 17.9 |
| Capability overlap (25) | 9.8 | 12.1 | 7.7 |
| Domain leverage (15) | 4.0 | 4.0 | 4.6 |
| **Build latitude (15)** | **7.2** | 6.9 | **5.0** |
| Seniority fit (10) | 4.8 | 7.4 | 5.4 |
| Signal quality (10) | 9.4 | 9.8 | 9.3 |
| sum of the six | 53.6 | 60.7 | 49.9 |
| total after rubric caps | 25.8 | 27.7 | 21.7 |

The tag moves build latitude by about 2 points of 15 and capability overlap by
2 of 25 — real, and in the expected direction — and then the rubric's caps
compress every total toward the same floor, because this corpus is technology
employers and the rubric is written for an operations candidate. A posting can
name every modern AI tool and still be a software engineering role the rubric
rejects on sight.

The legacy column is a second lesson. Its terms (`nuvolo`, `siebel`, `lms
administration`) mark facilities, CRE and corporate-training postings, and this
rubric *likes* those, so a legacy tag is not a negative signal about fit. It is
a signal about the tooling, which is a different question. Ten postings is too
few to say more.

So the tag is a free "worth reading" filter, and this repository describes it as
one. It is not a score proxy, and nothing here claims it is.

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

## Scorer parity

The 30 scored rows in the reference implementation's database are the only
independently-produced verdicts available to check against. 28 of them were
still live in the shared crawl dump, so they were rescored here against the
same rubric and the same model, and the totals compared.

Two changes matter before reading the numbers. The output contract is appended
by this implementation rather than written into the rubric, so any rubric
produces parseable JSON; and the six per-dimension sub-scores are new here.

### Sampling temperature is pinned, and that is most of the story

The reference implementation left sampling at the default. Rescoring the same
28 postings twice measures what that costs:

| | identical | mean move | worst move |
|---|---|---|---|
| default temperature | — | 5.3 points | 30 points |
| **temperature 0** | **25 of 28** | **0.8 points** | **10 points** |

A score that moves 30 points when nothing about the posting changed is not a
score. Everything below is measured at temperature 0.

### Against the reference implementation

| | value |
|---|---|
| baseline postings rescored | 28 of 30 (2 no longer posted) |
| failures | 0 |
| median absolute difference | **0** |
| mean absolute difference | 4.0 points |
| within 5 points | 21 of 28 |
| within 10 points | 26 of 28 |
| **moved more than 10** | **2** |
| run time, 4 concurrent | 17.4s |
| cost | $0.109, about $0.004 a posting |

Both outliers were read rather than waved off. In both, the two
implementations wrote **the same reasoning** and disagreed only on the number:

> reference: "Sales Engineer role with deep CRE domain fit and remote
> flexibility, but core job is customer-facing sales support and deal
> advancement, not operations or systems building." — scored 28
>
> this implementation: "Remote CRE software role where his domain expertise is
> a genuine asset, but Sales Engineer is customer-facing sales support, not
> process ownership or automation building." — scored 72

The rubric used for this comparison has an "automatic low scores" section that
caps sales roles. Both runs identified the disqualifier in prose; only one
applied the cap to the total. That is the rubric's rule firing unreliably, not
a difference in the port — and it is exactly what the sub-scores were added to
make visible, since the six dimensions summed to 72 and the cap should have
pulled the total to 28.

### The sub-scores explain the ceiling, not the score

The obvious assumption is that the six dimensions add up to the total. They do
not, and the gap is the useful part:

| | value |
|---|---|
| postings where the parts do not sum to the total | 22 of 28 |
| mean gap (subtotal above total) | 32.7 points |
| largest gap | 50 points |
| postings where the **total exceeded its own parts** | **0** |

The dimensions read the role; the total is the rubric's verdict on it, which a
cap or an automatic-low-score rule can push well below the sum. So the parser's
consistency check is one-sided: every override a rubric can state pushes the
number *down*, and nothing justifies a total the dimensions do not support.

A first attempt flagged the disagreement in both directions. It fired on 24 of
28 postings and meant nothing.

### Prompt caching is a no-op at this size

The rubric is byte-identical on every call in a run, so it carries a cache
breakpoint. On this model that breakpoint does nothing for a normal rubric,
measured directly:

| system prompt | cached |
|---|---|
| 2,081 tokens (the example rubric plus the output contract) | no |
| 3,689 tokens | no |
| 4,910 tokens | yes |

The minimum cacheable prefix is 4,096 tokens. The breakpoint stays because it
costs nothing and pays off for a user who writes a long rubric, but the run
summary reports the same figure with and without it and the README does not
claim a saving.

## End to end, cold

Run against the shipped example config, from `init` to a scored report, with no
hand-editing of anything:

```
$ node bin/deepjobs.js init
wrote    config/rubric.md, config/companies.yaml, config/gates.yaml

$ node bin/deepjobs.js run --limit 80
crawling 10 boards
  greenhouse/stripe: 570
  --limit reached, 9 boards not crawled
scoring 8 postings

570 crawled  ->  566 new  ->  80 taken  ->  5 ai-forward  ->  8 gated  ->  8 scored
8 scored, 0 failed, 14,657 in / 915 out, ~$0.019

1 posting scored 60 or better:
   62  Stripe - AutoFile Specialist, Tax
```

7.5 seconds and about two cents, on a rubric written for a fictional person.
The funnel line is the whole product: every number in it is the input to the
next stage, so where a run spent itself is readable at a glance.

**`--limit` stops the crawl, it does not trim afterwards.** Written the obvious
way, `--limit 20` on the example config still fetched all ten boards -- roughly
nine thousand postings, minutes of wall clock -- before throwing away all but
twenty. The check now runs between boards, counting *new* postings rather than
all of them, because on the tenth run of a day the first board is entirely
postings already seen and a limit counting those would stop having found
nothing.

`discover`, live:

```
$ node bin/deepjobs.js discover linear
  miss  greenhouse       linear      404
  miss  lever            linear      404
  HIT   ashby            linear       32
  HIT   workable         linear        0
  miss  smartrecruiters  linear      empty, and this platform returns empty for any slug

$ node bin/deepjobs.js discover --url https://www.jll.com/en-us/careers
  HIT   workday          jll/jllcareers
  - { platform: workday, tenant: jll, host: wd1, site: jllcareers }
```

Three things in that output are load-bearing. SmartRecruiters is reported as a
miss rather than a zero-posting hit, because its empty response is the same for
a real slug and an invented one. Workable answers for `linear` with a real board
holding zero jobs -- a different company of the same name, which is exactly why
every scraped slug is fetched before it is reported. And the Workday board is
resolved from a careers-page redirect, since none of its three parts is
guessable and a wrong site path returns 422 even when the tenant is real.

## The setup skill

`deepjobs setup` copies `skills/setup/SKILL.md` into `.claude/skills/`, because
a package is not somewhere Claude Code looks for a skill. Running it twice says
"already installed" rather than implying it did something.

The skill's output contract was checked by writing a rubric to its spec for a
different person entirely -- a litigation paralegal in Pittsburgh who moved into
document-review tooling, chosen to share nothing with the shipped example -- and
scoring real postings against it:

| | result |
|---|---|
| rubric loads | yes, 2,676 chars |
| contains a conflicting output section | no |
| postings returning all six sub-scores | 6 of 6 |
| automatic-low-score caps firing | yes: subtotals of 52 and 55 capped to totals of 8 and 15 |

That last row is the check that matters. The skill tells the interviewer to
write caps as an "automatic low scores" section, and the caps have to actually
reach the total while the six dimensions keep reading the role. They do.

Three constraints in the skill are enforced by a test rather than by hope,
because breaking any of them produces a rubric that scores without complaining:

- the six dimensions keep their names and maximums, since they are database
  columns
- the rubric contains no output format, because `src/score.js` appends one
- no board slug is written that `discover` has not verified

## Which platforms are worth having

Board count is not this tool's axis -- [ats-scrapers][a] carries 49 sources and
[job-board-aggregator][b] seven, and neither stores a description body. So the
question is not "how many" but "which ones answer with the posting". Every
candidate below was probed live on 2026-08-21.

| platform | list response | verdict |
|---|---|---|
| **Recruitee** | description **and** requirements, remote/hybrid/on-site, structured salary, ISO dates | **added** |
| Rippling | 748 postings, `name`/`url`/`workLocation` only | detail call per posting; not now |
| Breezy | JSON, no description field | same |
| BambooHR | JSON, no description field | same |
| iCIMS | HTML portal | out of scope |
| Taleo | tenant-specific, no reachable public JSON | out of scope |
| SuccessFactors | JavaScript-rendered HTML | out of scope |

Recruitee is the richest list response of any platform here. One
unauthenticated call to `https://{slug}.recruitee.com/api/offers/` returned, for
`channable`, a 5,287-character description **plus** an 8,560-character
requirements field, a three-way remote flag, and `{min, max, period, currency}`
salary -- with no detail call. Its docs state outright that the API needs no
authorization, because it is the endpoint a company's own careers page calls.
Like Workable and unlike SmartRecruiters, it 404s an unknown slug, so its zero
is honest.

The three enterprise platforms are absent on purpose, and that is a position
rather than a gap: they serve rendered HTML portals, and reading those needs a
headless browser, which is a different tool with a different failure mode.

**Two things Recruitee forced that no other board did.** It is the only platform
that answers the remote question in three parts, so `hybrid: true` folds to
*not remote* rather than being lost -- folding it the other way is exactly the
mistake the gate exists to catch in the body. And its salaries are frequently
monthly and in euros: `EUR 4,500 - 6,000 per month` is a perfectly good annual
salary and a catastrophic number to hand a gate comparing against a dollar
floor. Anything not USD-per-period-convertible keeps its text and leaves the
numeric columns null. Converting a currency would mean carrying an exchange
rate that is wrong the day after it is written.

[a]: https://github.com/kalil0321/ats-scrapers
[b]: https://github.com/Feashliaa/job-board-aggregator

## The verdict loop

`application.my_verdict` existed from the schema onward, `db.js` had
`setVerdict` and `getVerdict`, and nothing reached them. The column the setup
skill points at as the input to any future calibration was unwritable.

`deepjobs mark <id> yes|no|maybe --why "..."` is the door. Three things about it
are tested rather than assumed:

- **A crawl cannot overwrite it.** `recordPostings` never touches the
  application table, so re-running the pipeline over a posting you have already
  judged leaves the judgement intact. Verified by marking, re-running, and
  reading it back.
- **An ambiguous id lists candidates instead of picking one.** A verdict
  recorded against the wrong posting is worse than no verdict, and it is the
  one field in the database nothing else can reconstruct.
- **The posting is echoed back on success**, for the same reason.

`report` now prints the eight-character id and any verdict already recorded, so
the score and your own opinion sit on the same line. The two disagreeing is the
interesting case.

## Still to verify

- Following one level of careers-page links, to resolve boards like Fortive's
