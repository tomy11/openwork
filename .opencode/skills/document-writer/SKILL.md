---
name: document-writer
description: "Draft a new document from a template — spec, PRD, design doc, meeting notes, report, proposal, or guide. Use when the user asks to 'write a document', 'create a doc/spec/PRD', 'ร่างเอกสาร', 'สร้างเอกสารใหม่', 'เขียน spec/รายงาน/คู่มือ', or wants a structured first draft to fill in."
---

# Skill: Document Writer

Produce a clean, structured first draft of a work document the user can edit, instead of a blank page.

## When to use

- User asks "write/draft a <doc type>" — spec, PRD, design doc, report, proposal, meeting notes, runbook, README, guide
- User says "ร่างเอกสาร", "สร้างเอกสารใหม่", "เขียน spec / รายงาน / คู่มือ"

## How to work

1. **Pick the template** that matches the request (see below). If unclear, ask which type — or pick the closest and say so.
2. **Gather just enough input** — title, audience, goal. Ask only what you can't reasonably infer.
3. **Fill what you can, mark the rest** — write real content where you have it; leave `> TODO: …` placeholders where the user must supply specifics. Never invent facts, numbers, or names.
4. **Keep it skimmable** — headings, short paragraphs, bullets, tables. Lead with the summary.

## Templates

**PRD / Spec**
```
# <Title>
## Summary           – one paragraph: what & why
## Problem           – who hurts, how much
## Goals / Non-goals
## Requirements      – numbered, testable
## UX / Flow
## Open questions
## Rollout & metrics
```

**Design doc**
```
# <Title>
## Context & problem
## Proposed approach
## Alternatives considered
## Trade-offs & risks
## Implementation plan
```

**Report / status**
```
# <Title> — <date>
## TL;DR
## What happened / progress
## Metrics
## Risks & blockers
## Next steps (owner + date)
```

**Meeting notes**
```
# <Meeting> — <date>
Attendees:
## Decisions
## Discussion
## Action items (owner + due date)
```

## Quality bar

- Open with a 1–3 sentence summary so a busy reader gets the point first.
- Every action item / requirement has an **owner** and is **testable or dated**.
- Mark unknowns as `> TODO:` rather than guessing.
- Match the user's language (Thai/English) and keep tone appropriate to the audience.
