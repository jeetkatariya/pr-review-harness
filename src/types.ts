// Shared types used across the harness

// What the webhook handler passes to the orchestrator
export type PRJob = {
  repo: string;        // "owner/repo"
  prNumber: number;
  commitSha: string;
  deliveryId: string;  // GitHub's unique ID for this webhook delivery
};

// One changed file in a PR, as returned by GitHub API
export type ChangedFile = {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied";
  additions: number;
  deletions: number;
  patch?: string;      // the unified diff for this file (may be absent for binary files)
};

// The full diff for a PR, ready to hand to agents
export type PRDiff = {
  repo: string;
  prNumber: number;
  title: string;
  totalAdditions: number;
  totalDeletions: number;
  files: ChangedFile[];
};
