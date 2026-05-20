import { fetchPRDiff, postComment } from "./github.js";
import { runReviewer, MODEL } from "./agents/reviewer.js";
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

    // Step 3: log each changed file
    console.log(`\n[harness] changed files:`);
    for (const file of diff.files) {
      const diffSize = file.patch?.length ?? 0;
      console.log(`  ${file.status.padEnd(9)} ${file.filename} (+${file.additions}/-${file.deletions}) [${diffSize} chars of diff]`);
    }

    // Step 4: run the AI reviewer agent
    console.log(`\n[harness] running reviewer agent (model: ${MODEL})...`);
    const review = await runReviewer(diff);
    console.log(`[harness] review complete`);

    // Step 5: post the review as a PR comment
    const comment = [
      `**PR Review Harness** — AI Code Review`,
      `_${review.summary}_`,
      ``,
      review.body,
    ].join("\n");

    await postComment(job.repo, job.prNumber, comment);

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`\n[harness] done in ${elapsed}s`);

  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.error(`[harness] failed after ${elapsed}s:`, err);
  }
}
