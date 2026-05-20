import { fetchPRDiff, postComment } from "./github.js";
import type { PRJob, PRDiff } from "./types.js";

// GUARDRAILS — hard limits checked before any processing
const MAX_CHANGED_LINES = 5000;

function checkGuardrails(diff: PRDiff): { pass: boolean; reason?: string } {
  const totalLines = diff.totalAdditions + diff.totalDeletions;

  if (totalLines > MAX_CHANGED_LINES) {
    return {
      pass: false,
      reason: `PR has ${totalLines} changed lines — too large to review (limit: ${MAX_CHANGED_LINES}). Consider splitting into smaller PRs.`,
    };
  }

  return { pass: true };
}

// Phase 1 orchestrator — no agents yet.
// Fetches the diff, runs guardrails, logs everything, posts a confirmation comment.
// Phase 2 will replace the log + comment with real agent analysis.
export async function processReview(job: PRJob): Promise<void> {
  const start = Date.now();
  console.log(`\n[harness] starting review — ${job.repo} PR #${job.prNumber}`);
  console.log(`[harness] delivery: ${job.deliveryId}`);

  try {
    // Step 1: fetch the diff
    console.log(`[harness] fetching diff...`);
    const diff = await fetchPRDiff(job.repo, job.prNumber);
    console.log(`[harness] fetched: "${diff.title}"`);
    console.log(`[harness] ${diff.files.length} files changed — +${diff.totalAdditions} / -${diff.totalDeletions} lines`);

    // Step 2: run guardrails
    const guard = checkGuardrails(diff);
    if (!guard.pass) {
      console.log(`[guardrail] fired — ${guard.reason}`);
      await postComment(job.repo, job.prNumber, `> **PR Review Harness**\n\n${guard.reason}`);
      return;
    }

    // Step 3: log each changed file (Phase 1 — no agents yet)
    console.log(`\n[harness] changed files:`);
    for (const file of diff.files) {
      const diffSize = file.patch?.length ?? 0;
      console.log(`  ${file.status.padEnd(9)} ${file.filename} (+${file.additions}/-${file.deletions}) [${diffSize} chars of diff]`);
    }

    // Step 4: post a Phase 1 placeholder comment so you can see it working end-to-end
    const fileList = diff.files
      .slice(0, 10)
      .map((f) => `- \`${f.filename}\` (+${f.additions}/-${f.deletions})`)
      .join("\n");

    const comment = [
      `**PR Review Harness** — Phase 1 (foundation working ✓)`,
      ``,
      `Received this PR and fetched the diff successfully.`,
      `**${diff.files.length} files changed** | +${diff.totalAdditions} additions | -${diff.totalDeletions} deletions`,
      ``,
      `**Changed files:**`,
      fileList,
      diff.files.length > 10 ? `_...and ${diff.files.length - 10} more_` : "",
      ``,
      `_Phase 2 will replace this with real agent analysis._`,
    ].join("\n");

    await postComment(job.repo, job.prNumber, comment);

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`\n[harness] done in ${elapsed}s`);

  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.error(`[harness] failed after ${elapsed}s:`, err);
  }
}
