---
name: deepjobs-setup
description: Interview someone and write their deepjobs config — config/rubric.md, config/gates.yaml and config/companies.yaml — from their answers instead of hand-editing the examples. Use when the user says "deepjobs setup", "set up deepjobs", "make the deepjobs rubric mine", or has just run `deepjobs init` and wants the fictional example replaced with their own.
---

# deepjobs setup

`deepjobs init` ships a rubric written for a fictional person so that a run
works cold. This skill replaces it with one written for the person in front of
you.

That gap is the whole reason this file exists. Hand-editing a thousand words of
rubric prose is where most people close the tab, and a rubric nobody rewrote
scores everyone the same way — which is the one thing the tool exists not to do.

## What you are producing

Three files, all in `config/`, all gitignored:

| file | what it decides |
|---|---|
| `config/rubric.md` | the LLM's system prompt — what a good role means for this person |
| `config/gates.yaml` | what gets thrown out for free, before anything is paid for |
| `config/companies.yaml` | which boards get crawled |

**Tell the user at the end that these three are gitignored, and why.** They
describe what someone wants from their career, what they will not accept, and
what they are paid — which is not something to publish by accident. In the
implementation this replaced, those three files were the three that *were*
tracked. Inverting that is the point.

## Rules that are not yours to change

1. **The rubric has exactly six dimensions, with these names and these
   maximums.** They are database columns, not prose:

   | dimension | max |
   |---|---|
   | Location viability | 25 |
   | Capability overlap | 25 |
   | Domain leverage | 15 |
   | Build latitude | 15 |
   | Seniority fit | 10 |
   | Signal quality | 10 |

   What each one *means for this person* is yours to write. The count, the
   names and the weights are not.

2. **Do not put an output format, a JSON envelope, or "return only JSON" in the
   rubric.** `src/score.js` appends that contract itself, to whatever the user
   wrote. A second copy in the rubric fights it. If you find one in an existing
   rubric, delete it.

3. **Never write a board slug you have not verified.** Every entry in
   `config/companies.yaml` must come from a `deepjobs discover` hit. A guessed
   slug does not error; it returns nothing, quietly, for as long as nobody
   checks. See step 5.

4. **The gate's bias is toward letting things through.** A gate that silently
   rejects a good role costs more than one that passes a bad role: the bad one
   dies for a fraction of a cent at the next stage, while the good one is never
   seen again. When the user is ambivalent about a rule, flag rather than
   reject.

## Step 1 — check where you are

Confirm the working directory is a deepjobs install: `bin/deepjobs.js` exists,
or `deepjobs --version` runs. If not, stop and say so.

Then run `deepjobs init` if `config/` is empty. It never overwrites, so this is
safe to run again. You need `examples/rubric.example.md` and
`examples/gates.example.yaml` in front of you as structural references — read
both before writing anything.

If `config/rubric.md` already exists and is not a copy of the example, **ask
before replacing it.** Someone may have spent an hour on it.

## Step 2 — offer to read something first

Ask whether they have a resume, CV, LinkedIn data export, portfolio site or
`about` page you can read. If they do, read it before asking anything.

This is worth doing. A resume answers the capability and domain questions
better than a person does — people describe the job they hold, and the file
shows what they actually spend the day doing. It also gives you real vocabulary
to write the rubric in, which matters because the rubric is a prompt: "lease
administration and vendor reconciliation" scores differently from "operations".

If they have nothing to offer, continue on questions alone. Do not stall on it.

## Step 3 — the interview

Six questions. Ask them conversationally, not as a form, and use whatever
structured-question tool is available rather than making them type prose where
a choice will do. Skip anything the resume already answered, and confirm rather
than re-ask.

1. **What do you want the work to be, day to day?** Push for the verbs. "A role
   in operations" is not usable; "taking a manual process apart and automating
   it" is. This becomes **Capability overlap (25)**.

2. **Where can you actually work?** Fully remote only, a home metro and how far
   they will drive, or both. Get the metro names they would accept as onsite,
   and whether a hybrid role inside their own metro is acceptable. This becomes
   **Location viability (25)** and most of `gates.yaml`.

3. **What is the compensation floor?** Ask for two numbers, and explain the
   difference: a soft floor that flags, and a hard floor that rejects. Most
   people want only the soft one, because most postings state no salary at all
   and a hard floor would throw them away unread.

4. **What is automatic noise?** Titles and role types they never want to see.
   Warn them that this list is the easiest way to make the gate quietly too
   tight, and that matching is word-boundary — `intern` will not kill
   "Internal Audit Manager", but `director` will kill "Director, Operations".

5. **Where is your experience leverage rather than background?** Industries,
   domains, systems, regulatory environments. This becomes **Domain leverage
   (15)**. Ask also what a domain where it counts for nothing looks like.

6. **What seniority, and does managing people count as the job?** Individual
   contributor, senior IC, lead, manager. Ask explicitly whether a manager who
   no longer builds is acceptable — it is the question people most often have a
   strong answer to and never volunteer. This becomes **Seniority fit (10)**.

**Build latitude (15)** usually falls out of question 1, but if it did not, ask
it directly: will they be allowed to build, or only to report? A recurring deck
where the tooling decisions are someone else's is a low score here even when
every other dimension is high.

**Signal quality (10)** needs no question. It scores how much the posting
actually says, and it is the same for everyone: a real day-in-the-life, named
tools and a stated band scores high; a description of the company's mission and
nothing about the job scores low, because there is nothing to judge.

## Step 4 — write `config/rubric.md`

Follow the structure of `examples/rubric.example.md`: a short candidate
paragraph, then one section per dimension with its maximum in the heading.

Make it specific. The rubric is a prompt, and the difference between a useful
score and a useless one is almost entirely how concretely it is written.

- **Anchor both ends of every dimension.** Say what a 25 looks like *and* what
  a 0 looks like. "How relevant the work is" is not a scoring instruction;
  "a role asking for five years of production Kubernetes is a zero here
  regardless of title" is.
- **Name real things** — tools, systems, job shapes, cities. Use the user's own
  vocabulary from the resume and the interview.
- **Write the hard cases down.** If a hybrid role with an unstated office
  should score 10 and be flagged rather than guessed at, say exactly that.
- Add an **automatic low scores** section if the user named conditions that
  override everything else. Be aware of what this does to the sub-scores: a cap
  lowers the total below the sum of the six dimensions, deliberately, and the
  gap between them is how the user later sees which rule fired.
- Add a **not disqualifying** section for the things that look bad and are not:
  undisclosed comp, contract work when they are open to it, staffing listings
  with a real role behind them, titles that do not match their history.

Length: the example is about 700 words and that is a reasonable target. Under
500 characters the loader rejects it as truncated.

## Step 5 — build `config/companies.yaml` from verified slugs

Ask which employers they want watched. Prompt them: companies they have applied
to, competitors of their current employer, companies in the domain they named
in question 5, anyone whose product they use.

Then, **for each one**, run discovery and use what comes back:

```bash
deepjobs discover "Palantir Technologies"
deepjobs discover --url https://www.example.com/careers
```

- Use `--url` whenever they can give you a careers page. It is slower and much
  more often right, and it is the only way to resolve a Workday board, whose
  three parts cannot be guessed.
- Paste the line it prints. It is already in the right shape.
- **A miss is information, not a failure.** Report which companies could not be
  resolved and why, rather than guessing a slug to fill the gap.
- Watch for a hit on a company of the same name. `discover linear` returns both
  `ashby/linear` (the software company) and `workable/linear` (someone else,
  with zero open roles). If two platforms hit and one has no postings, say so
  and let the user pick.
- SmartRecruiters is reported as a miss when it returns nothing, because it
  answers HTTP 200 with an empty list for *any* slug, real or invented. That is
  correct behaviour and worth explaining if they ask.

Ten to twenty boards is a good first list. It can grow later; `discover` is
there for exactly that.

## Step 6 — write `config/gates.yaml`

Copy `examples/gates.example.yaml` and change the values, keeping its comments
where they still apply. Every key in it matters:

- `home_metro_label` is printed inside reject reasons, so write it to read as a
  sentence: "onsite outside **the Denver metro**: Austin, TX".
- `onsite_metros_allowed` is the list from question 2. Lower case, no state.
- `soft_floor` and `min_annual` are the two numbers from question 3. Leave
  `min_annual: null` unless they were emphatic.
- `hard_rejects.titles_containing` is question 4. Keep
  `description_containing` empty unless they asked for something specific — it
  is the fastest way to make the gate too tight.
- Leave `check_remote_claim_against_body: true`. It costs nothing and catches
  the postings tagged Remote whose body asks for three days a week onsite,
  which every other job tool passes through.
- `staffing_agencies.mode` and `employment_type.contract_mode`: use `flag`
  unless the user was clear they never want to see one.

## Step 7 — prove it works, then hand it over

Run a free pass so they see their own config move real postings:

```bash
deepjobs run --no-score --limit 40
```

Read the funnel line back to them and interpret it:

```
570 crawled  ->  566 new  ->  80 taken  ->  5 ai-forward  ->  8 gated
```

- **Nothing gated** means the gate is too tight. The usual cause is a title in
  `titles_containing` that is more common than they thought, or an
  `onsite_metros_allowed` list that excludes remote-friendly postings by
  accident. Show them the reject reasons and loosen it.
- **Almost everything gated** is fine at this stage. The scorer is what sorts
  it, and the gate's job is to remove what was never viable, not to rank.

Then have them run the paid stage once, small:

```bash
deepjobs run --limit 40
deepjobs report --min 60
```

Scoring costs roughly $0.004 a posting and needs `ANTHROPIC_API_KEY` in the
environment or in a `.env` file. Everything before it is free.

Finish by telling them:

- The three files you wrote are in `config/`, which is **gitignored**. Their
  rubric, their board list and their salary floor do not get published by
  accident.
- The rubric is the thing to tune. When a score looks wrong, the fix is almost
  always a sentence in `config/rubric.md`, not a change to the code.
- `deepjobs discover` adds boards later without re-running any of this.

## What this skill does not do

It does not derive gate terms or rubric weights from scored postings. That
needs real verdicts to learn from, and the only thing in the system that
produces them is a human marking postings in the `application` table. Until
those exist there is nothing to calibrate against, and a rubric tuned to zero
examples is just a rubric.
