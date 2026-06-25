---
name: bug-report
description: "Write a clear, reproducible bug report. Use when the user says 'report a bug', 'write a bug report', 'แจ้งบั๊ก', 'เขียนรายงานบั๊ก', 'something is broken', or describes unexpected behavior that needs to be filed for a developer to fix."
---

# Skill: Bug Report Writer

Turn a vague "it's broken" into a report a developer can act on without asking follow-ups.

## When to use

- User says "report/write a bug", "file this issue", "แจ้งบั๊ก", "เขียนรายงานบั๊ก"
- User describes something behaving unexpectedly and wants it documented

## How to work

1. **Extract the essentials.** If any are missing, ask before writing:
   - What did you do? (steps)
   - What did you expect?
   - What actually happened?
   - Where? (app/version, OS, browser, environment)
2. **Reproduce mentally** — make the steps numbered and minimal. Remove anything not needed to trigger the bug.
3. **Assess severity** — how many users, is there a workaround, is data at risk.
4. **Fill the template** below. Attach evidence (logs, screenshots, error text) when available; never fabricate them.

## Output format

```
## Title
<short, specific: "Save button does nothing on empty title">

**Severity:** Blocker / Critical / Major / Minor
**Environment:** <app + version, OS, browser/device>

### Steps to reproduce
1.
2.
3.

### Expected
<what should happen>

### Actual
<what happens instead — include exact error text>

### Evidence
<logs / screenshots / console output / network>

### Notes
<frequency: always/sometimes · workaround · first seen · related issues>
```

## Quality bar

- Title names the **symptom + context**, not just "bug".
- Steps are numbered, minimal, and reproducible by someone who's never seen the issue.
- Expected and Actual are both stated explicitly — the gap between them *is* the bug.
- Include exact error messages verbatim; don't paraphrase.
