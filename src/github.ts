import { Octokit } from "@octokit/rest";
import { createHmac, timingSafeEqual } from "crypto";
import "dotenv/config";
import type { ChangedFile, PRDiff } from "./types.js";

// Single shared GitHub client — all functions use this
export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// Validates the X-Hub-Signature-256 header GitHub sends with every webhook.
// Throws if the signature doesn't match — caller should return 401.
// Uses timingSafeEqual to prevent timing attacks (never use === for this).
export function verifySignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string
): void {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const actual = Buffer.from(signatureHeader, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");

  if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) {
    throw new Error("Invalid webhook signature");
  }
}

// Fetches all changed files for a PR, including their diffs (patches).
// Handles pagination — PRs with more than 30 files need multiple requests.
export async function fetchPRDiff(repo: string, prNumber: number): Promise<PRDiff> {
  const [owner, repoName] = repo.split("/");

  // Fetch PR metadata (title, etc.)
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo: repoName,
    pull_number: prNumber,
  });

  // Fetch all changed files with their patches
  // GitHub paginates at 30 files per page — we fetch all pages
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo: repoName,
    pull_number: prNumber,
    per_page: 100,
  });

  const changedFiles: ChangedFile[] = files.map((f) => ({
    filename: f.filename,
    status: f.status as ChangedFile["status"],
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));

  return {
    repo,
    prNumber,
    title: pr.title,
    totalAdditions: changedFiles.reduce((sum, f) => sum + f.additions, 0),
    totalDeletions: changedFiles.reduce((sum, f) => sum + f.deletions, 0),
    files: changedFiles,
  };
}

// Posts a comment on the PR timeline (not a code review — just a plain comment).
// Used in Phase 1 to confirm the harness received and processed the PR.
// In Phase 2+, we replace this with a full structured code review.
export async function postComment(repo: string, prNumber: number, body: string): Promise<void> {
  const [owner, repoName] = repo.split("/");

  await octokit.issues.createComment({
    owner,
    repo: repoName,
    issue_number: prNumber,
    body,
  });
}
