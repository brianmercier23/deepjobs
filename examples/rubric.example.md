# Scoring rubric

This file is an example, written for a fictional person so that `deepjobs init`
produces believable output on the first run. Replace it with your own, or run
`deepjobs setup` and answer six questions to have one written for you.

`config/rubric.md` is gitignored. It describes what you want out of your career
and what you will not accept, which is not something to publish by accident.

## The candidate

Eight years in operations analysis for a commercial services firm. Spends the
day inside a work-order platform, reporting on vendor performance, and has spent
the last two years automating that work: scripts that reconcile invoices,
dashboards that replaced a weekly deck, a scheduling tool the team now depends
on. Wants the automation to be the job rather than the thing done after hours.

Based in the Denver metro. Will take fully remote anywhere in the US, or onsite
within roughly 30 miles of home. Salary floor is $95,000.

## Dimensions

Score each 0 to its maximum. The total is the sum, out of 100.

### Location viability — 25

Full marks for genuinely remote-anywhere-in-US, or onsite inside the Denver
metro. Zero for onsite outside it. Read the body, not the location field:
a posting tagged "Remote" that requires three anchor days in San Francisco is
an onsite role and scores as one. Hybrid with an unstated office scores 10 and
gets flagged rather than guessed at.

### Capability overlap — 25

How much of the day is work already done well: process analysis, data
reconciliation, reporting, building internal tools, scripting. A role asking
for five years of production Kubernetes is a zero here regardless of title.
A role asking someone to take a manual process apart and automate it is a 25.

### Domain leverage — 15

Does eight years in commercial services and work-order platforms count for
something here? Facilities, property, field service, logistics and vendor
management all score high. A domain where the experience is irrelevant scores
low but not zero, because the process skills still transfer.

### Build latitude — 15

Will this person be allowed to build, or only to report? Full marks for a role
that names automation, internal tooling, or process engineering as the work.
Low marks for a role where the output is a recurring deck and the tooling
decisions are someone else's.

### Seniority fit — 10

Mid-career: senior individual contributor, analyst, or lead. Zero for entry
level. Zero for anything requiring a team to manage, unless the description
makes clear the manager still builds.

### Signal quality — 10

How much the posting actually says. A description with a real day-in-the-life,
named tools, and a stated comp band scores 10. A description of the company's
mission and nothing about the job scores 2, because there is nothing to judge.

## Output

Return the six sub-scores, the total, one sentence of rationale, and any flags.
Flags are for things a human should look at, not reasons to reject: unstated
comp, ambiguous hybrid arrangement, a title that does not match the body.
