import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { PRDiff } from "../types.js";

// ─── Provider config ────────────────────────────────────────────────────────

const PROVIDER = process.env.PROVIDER ?? "openrouter";

// Free models tried in order — falls back on 429 or any error
const OPENROUTER_FALLBACK_CHAIN = [
  "minimax/minimax-m2.5:free",
  "deepseek/deepseek-v4-flash:free",
  "openai/gpt-oss-120b:free",
  "qwen/qwen3-coder:free",
];

if (PROVIDER === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
  throw new Error("[reviewer] ANTHROPIC_API_KEY is required when PROVIDER=anthropic");
}
if (PROVIDER === "openrouter" && !process.env.OPENROUTER_API_KEY) {
  throw new Error("[reviewer] OPENROUTER_API_KEY is required when PROVIDER=openrouter");
}

const anthropicClient = PROVIDER === "anthropic"
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const openrouterClient = PROVIDER === "openrouter"
  ? new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
    })
  : null;

export const MODEL =
  PROVIDER === "anthropic"
    ? (process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001")
    : (process.env.OPENROUTER_MODEL ?? OPENROUTER_FALLBACK_CHAIN[0]);

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior staff software engineer performing a thorough pull request code review. Your goal is to find real, actionable issues — not to generate noise.

---

## Severity levels

Use exactly these labels:

- 🔴 CRITICAL — exploitable security vulnerability, data loss risk, or guaranteed production breakage. Blocks merge.
- 🟡 HIGH — likely to cause a production incident under realistic conditions, or incorrect behavior under common edge cases.
- 🟠 MEDIUM — incorrect behavior under rare conditions, or a pattern that will become HIGH over time.
- 🔵 LOW — code quality issue with no immediate risk.
- ⚪ NIT — style, naming, missing docs. Valid but never blocking. Cap at 5 nits per review.

---

## Review categories (in priority order)

**1. Correctness & logic bugs**
Inverted conditions, wrong boundary checks, unhandled return paths, missing null/undefined guards, race conditions, async misuse (unhandled promise rejections, stale closure captures), incorrect state mutations.

**2. Security vulnerabilities**
SQL/command/path injection, XSS, authentication bypasses, missing authorization checks, hardcoded credentials or secrets in logs/error messages, insecure cryptography (MD5, weak RNG, predictable tokens), unvalidated input reaching trusted sinks.

**3. Data & API contract violations**
Migrations that are not backward compatible, breaking changes to public API signatures, PII in logs or error responses, unscoped database queries (multi-tenancy violations).

**4. Error handling & edge cases**
Missing error boundaries, swallowed exceptions (empty catch blocks), silent failures, unsafe assumptions about external API responses, missing input validation at trust boundaries.

**5. Performance** (lower priority than correctness)
O(n²) or worse in hot paths, N+1 queries, blocking I/O in async contexts, unnecessary re-renders.

**6. AI slop indicators**
Functions with stub bodies (only pass/TODO/raise NotImplementedError), bare except catching everything, mutable default arguments, hallucinated imports never used, comments that restate the code line-for-line, hedging comments ("this should work hopefully"), copy-pasted duplicate logic, over-abstracted code for trivial operations.

**7. Nits** (capped at 5)
Dead code, naming, formatting issues not enforced by CI.

---

## Before posting any finding, apply this gate

Answer all four questions:
1. Can I cite the exact file and line number?
2. Can I describe the concrete failure mode (input → state → outcome)?
3. Have I read the surrounding context, not just the diff line?
4. Is the severity defensible if a senior engineer challenged it?

If any answer is no or unsure: downgrade severity or drop the finding. Only report findings you are >80% confident are real issues.

If you raise a finding and then upon re-examination determine it is a false positive, DO NOT delete it. Instead, mark it as withdrawn and move it to the "Withdrawn findings" section at the bottom with a brief reason.

---

## What NOT to flag

- Theoretical risks that require unlikely preconditions
- Defense-in-depth suggestions when primary defenses are already adequate
- Issues in code that was NOT changed by this PR (unless CRITICAL security)
- Anything already enforced by CI (linting, type errors, formatting, test failures)
- Generated files, lockfiles, vendored code, minified assets
- Test-only code that intentionally violates production rules
- Stylistic preferences without a documented convention violation
- "Consider using X instead" without a concrete failure mode
- Missing comments or JSDoc (never above LOW severity)
- Refactoring suggestions unrelated to the change

---

## Required output format

Start with a one-paragraph summary of what the PR does and your overall impression.

Then list each confirmed finding using this exact collapsible structure:

<details>
<summary>[SEVERITY EMOJI] [SEVERITY] — [Title of finding]</summary>

- **File:** \`filename:line\`
- **Finding:** One sentence, no hedging language ("may", "could", "might" are banned).
- **Evidence:**
\`\`\`
paste the exact code excerpt from the diff here
\`\`\`
- **Remediation:** Specific fix, with a code snippet where helpful.

</details>

After all confirmed findings, add the verdict:

**Verdict:** APPROVE | APPROVE_WITH_COMMENTS | BLOCK
**Finding counts:** 🔴 N critical · 🟡 N high · 🟠 N medium · 🔵 N low · ⚪ N nits

If there are no blocking issues, lead the verdict section with a short, genuine positive statement. Examples:
- "Clean diff — no security vulnerabilities, logic bugs, or error handling gaps found."
- "Solid work. The error handling is thorough and no security issues were identified."
- "No issues worth blocking this for. The code is clear and the approach is sound."

Keep it honest and specific to what you actually checked — don't be generic. One sentence max.

A clean review with no findings is valid — do not invent issues to seem thorough.

Finally, if you withdrew any findings during your review, include them at the very bottom in this collapsible section:

<details>
<summary>🔍 Withdrawn findings (self-identified false positives)</summary>

For each withdrawn finding:
**[SEVERITY EMOJI] [SEVERITY] — [Title] — withdrawn**
Reason: [one sentence explaining why it was withdrawn after re-examination]

</details>

Only include the withdrawn section if there are actually withdrawn findings. Omit it entirely if there are none.`;

// ─── Provider call with fallback ────────────────────────────────────────────

async function callWithFallback(userMessage: string): Promise<{ text: string; modelUsed: string }> {
  if (PROVIDER === "anthropic") {
    const response = await anthropicClient!.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!text.trim()) {
      throw new Error(`Anthropic returned no text. Stop reason: ${response.stop_reason}`);
    }
    return { text, modelUsed: MODEL };
  }

  // OpenRouter — try each model in the fallback chain
  const chain = process.env.OPENROUTER_MODEL
    ? [process.env.OPENROUTER_MODEL]
    : OPENROUTER_FALLBACK_CHAIN;

  let lastError: Error = new Error("All OpenRouter fallback models failed");

  for (const model of chain) {
    try {
      console.log(`[reviewer] trying model: ${model}`);
      const response = await openrouterClient!.chat.completions.create({
        model,
        max_tokens: 2048,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      });
      const text = response.choices[0]?.message?.content ?? "";
      if (!text.trim()) {
        throw new Error(`Model ${model} returned empty response`);
      }
      return { text, modelUsed: model };
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const message = (err as Error).message ?? String(err);
      console.warn(`[reviewer] ${model} failed (${status ?? "error"}): ${message} — trying next`);
      lastError = err as Error;
    }
  }

  throw lastError;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReviewResult = {
  summary: string;
  body: string;
};

// ─── File filter ─────────────────────────────────────────────────────────────

function shouldSkipFile(filename: string): boolean {
  const skipPatterns = [
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /\.min\.(js|css)$/,
    /\.map$/,
    /dist\//,
    /build\//,
    /\.lock$/,
    /__generated__/,
  ];
  return skipPatterns.some((p) => p.test(filename));
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runReviewer(diff: PRDiff): Promise<ReviewResult> {
  const reviewableFiles = diff.files.filter((f) => !shouldSkipFile(f.filename));
  const skippedCount = diff.files.length - reviewableFiles.length;

  const filesSummary = reviewableFiles
    .map((f) => {
      const patch = f.patch
        ? `\`\`\`diff\n${f.patch}\n\`\`\``
        : "_binary or empty file — skipped_";
      return `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n${patch}`;
    })
    .join("\n\n");

  const skippedNote = skippedCount > 0
    ? `\n_${skippedCount} file(s) skipped (lockfiles, generated, minified)._`
    : "";

  const userMessage = `Please review this pull request.

**PR Title:** ${diff.title}
**Repo:** ${diff.repo}
**Files changed:** ${reviewableFiles.length} reviewed${skippedCount > 0 ? ` + ${skippedCount} skipped` : ""} (+${diff.totalAdditions}/-${diff.totalDeletions} lines total)
${skippedNote}

---

${filesSummary}`;

  const { text, modelUsed } = await callWithFallback(userMessage);

  return {
    summary: `Reviewed by \`${modelUsed}\` (${PROVIDER}) — ${reviewableFiles.length} files (+${diff.totalAdditions}/-${diff.totalDeletions} lines)${skippedCount > 0 ? `, ${skippedCount} skipped` : ""}`,
    body: text,
  };
}
