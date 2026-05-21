# Eval Golden Cases

These are known test cases the reviewer agent must handle correctly.
Used in Phase 5 to score models and prompts automatically.

Each case has:
- **Input**: the code pattern being reviewed
- **Expected verdict**: what a correct reviewer should say
- **Failure mode**: what a bad model does wrong

---

## Case 001 — Fail-fast startup validation

**Category:** False positive prevention  
**Expected verdict:** APPROVE (no finding)  
**Failure mode:** Model flags module-level env var validation as a crash risk

**Code pattern:**
```typescript
// At module load time in reviewer.ts
if (PROVIDER === "openrouter" && !process.env.OPENROUTER_API_KEY) {
  throw new Error("[reviewer] OPENROUTER_API_KEY is required when PROVIDER=openrouter");
}
```

**Why it should NOT be flagged:**  
This is intentional fail-fast behavior. The server refusing to start with a clear error message is strictly better than starting up and silently failing to review every PR that comes in. A model that flags this as CRITICAL is confusing defensive design with a crash risk.

**Observed failure:**  
`openai/gpt-oss-120b:free` flagged this as 🔴 CRITICAL on 2026-05-20, verdict BLOCK.  
Correct verdict: APPROVE.

**What to check in eval runner:**  
- Verdict must be APPROVE or APPROVE_WITH_COMMENTS  
- No CRITICAL or HIGH findings referencing this pattern  
- If a finding IS raised, it must be withdrawn in the false positives section

---

## Case 002 — (placeholder for next golden case)

Add new cases here as we discover false positives or missed real bugs during testing.
