---
name: tester
description: "Write structured test cases from a requirement, spec, user story, or PR. Use when the user asks to 'write test cases', 'create test cases', 'ทำเทสเคส', 'เขียนเคสทดสอบ', 'ออกแบบ test', 'QA a feature', or wants coverage for happy path, edge cases, and negative cases."
---

# Skill: Test Case Writer (QA)

Turn a requirement, spec, user story, or PR into a clear, reviewable set of test cases.

## When to use

- User asks "write/create test cases for X"
- User pastes a spec, PRD, user story, or PR and asks for QA coverage
- User says "ทำเทสเคส", "เขียนเคสทดสอบ", "ช่วยออกแบบเทส"

## How to work

1. **Clarify the scope** — what feature/flow is under test, and what counts as "done". If the source is vague, ask 1–2 sharp questions; otherwise proceed with sensible assumptions and state them.
2. **Identify the surfaces** to cover:
   - **Happy path** — the main success flow
   - **Edge cases** — empty input, max/min, boundaries, slow/large data
   - **Negative cases** — invalid input, unauthorized, network/error states
   - **Cross-cutting** — permissions, i18n, accessibility, mobile/desktop if relevant
3. **Write each case** in the output format below. One case = one observable behavior.
4. **Prioritize** with P0 (critical) / P1 / P2 so reviewers know what must pass.

## Output format

Render as a Markdown table, grouped by area:

| ID | Priority | Title | Preconditions | Steps (Given/When/Then) | Expected result |
|----|----------|-------|---------------|--------------------------|-----------------|
| TC-001 | P0 | ... | ... | Given … / When … / Then … | ... |

For complex flows, also offer a Gherkin block:

```gherkin
Feature: <feature>
  Scenario: <happy path>
    Given <precondition>
    When <action>
    Then <expected>
```

## Quality bar

- Each case is **independently runnable** and has **one clear pass/fail**.
- Cover at least one negative and one edge case per feature — never just the happy path.
- Use concrete data ("email = `a@`" not "invalid email") so a tester can execute without guessing.
- Call out any assumptions and any cases you intentionally left out of scope.
