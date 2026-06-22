---
name: code-reviewer
description: "Review a code change or diff for correctness, clarity, security, and tests. Use when the user asks to 'review this code', 'review my PR', 'รีวิวโค้ด', 'ตรวจโค้ดให้หน่อย', 'check this diff', or wants feedback before merging."
---

# Skill: Code Reviewer

Give focused, actionable review feedback on a change — the kind a careful teammate would leave on a PR.

## When to use

- User asks "review this code / my PR / this diff"
- User says "รีวิวโค้ด", "ตรวจโค้ดให้หน่อย", "ดูโค้ดนี้หน่อย"

## How to work

1. **Understand the intent first.** What is the change supposed to do? Read the diff against that goal, not in a vacuum.
2. **Review in priority order** — stop at the first category that matters most:
   - **Correctness** — bugs, wrong logic, off-by-one, null/undefined, race conditions, wrong error handling
   - **Security** — injection, missing auth checks, secrets in code, unsafe input handling
   - **Tests** — is the change covered? are edge cases tested?
   - **Clarity & reuse** — naming, dead code, duplication, simpler equivalent, over-engineering
   - **Style** — only if it matters; defer to the project's conventions (e.g. AGENTS.md: no `any`/`as`, smallest diff, pnpm)
3. **Be specific.** Point to the exact line and show the fix, not just "this is wrong".
4. **Separate must-fix from nice-to-have** so the author knows what blocks merge.

## Output format

Group findings by severity:

```
## Review summary
<1–2 sentences: overall verdict + does it meet the goal>

### 🔴 Must fix (blocks merge)
- `path/to/file.ts:42` — <issue> → <suggested fix>

### 🟡 Should fix
- ...

### 🟢 Nit / optional
- ...

### ✅ What's good
- <call out something done well>
```

## Quality bar

- Every finding cites a **file:line** and proposes a concrete fix or asks a precise question.
- Don't nitpick style when there's a correctness or security issue unaddressed — lead with what matters.
- Distinguish facts ("this throws when `x` is null") from preferences ("I'd name this `y`").
- Acknowledge at least one thing done well — reviews are for people.
