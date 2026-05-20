# PR Review Multi-Agent Harness — Product Requirements Document

---

## Problem Statement

Code review is the highest-leverage quality gate in software development. It catches bugs before they reach production, enforces security standards, and spreads knowledge across teams. But it is slow, inconsistent, and depends entirely on reviewer availability and expertise.

Current tools (Copilot, CodeRabbit) make a single pass at the code and post comments. They don't run specialized analysis in parallel, they don't have an eval story, and they don't expose the architecture for engineers to learn from or extend.

This project builds a PR review harness from first principles — multiple specialized agents, parallel execution, structured output, guardrails, and a measurable eval pipeline — using the same patterns that production AI systems use at scale.

---

## Goals

1. **Working review system** — when a PR is opened on a real GitHub repo, a structured AI review appears automatically within 15 seconds.

2. **Parallel multi-agent architecture** — 4 specialized agents run simultaneously, not sequentially. The review is richer and faster than a single-agent approach.

3. **Measurable quality** — a separate eval pipeline produces concrete metrics: catch rate, false positive rate, cost per review, latency. These numbers improve over time.

4. **Open-source ready** — clean codebase, documented architecture, easy local setup. Other engineers can run it and learn from it.

5. **Interview-ready story** — every architectural decision has a reason you can explain. You know what broke and how you fixed it.

---

## Non-Goals

- **Not a commercial product** — no billing, no multi-tenant auth, no SLA guarantees
- **Not a fine-tuned model** — we use existing models, no training
- **Not a full CI/CD pipeline** — no test running, no deployment blocking
- **Not a code formatter** — style/formatting is out of scope (tools like Prettier/ESLint handle this better)
- **Not real-time streaming** — batch review on PR open, not character-by-character suggestions

---

## User Stories

**As a developer:**
- When I open a PR, I want an AI review to appear automatically within 15 seconds
- I want the review to be structured and scannable — not a wall of text
- I want comments anchored to specific lines of code, not just general observations
- I want to know which issues are critical vs informational
- I do NOT want false positives that waste my time

**As the builder (you):**
- I want to be able to run the eval suite and see a score
- I want to know which agent found which issue so I can debug and improve
- I want to see cost and latency per review in logs
- I want to add a new carrier / new agent without rewriting the whole system

---

## Feature Requirements

### F1 — Webhook Integration
- [ ] Server listens on `POST /webhook`
- [ ] Validates `X-Hub-Signature-256` header using HMAC-SHA256
- [ ] Processes only `pull_request` events with action `opened` or `synchronize`
- [ ] Responds `200 OK` within 2 seconds regardless of processing time
- [ ] Uses `X-GitHub-Delivery` UUID for job idempotency (no duplicate reviews)

### F2 — Job Queue
- [ ] Webhook handler enqueues job to BullMQ immediately after validation
- [ ] Job retries up to 3 times with exponential backoff on failure
- [ ] Failed jobs after max retries land in a dead-letter queue (visible, not silent)
- [ ] Concurrency: up to 5 simultaneous PR reviews

### F3 — Diff Fetching
- [ ] Fetches per-file diffs from `GET /repos/{owner}/{repo}/pulls/{n}/files`
- [ ] Returns filename, status (added/modified/removed), and patch (unified diff)
- [ ] Handles pagination (PRs with > 30 changed files)

### F4 — Guardrails
- [ ] Skip PRs with diff > 5,000 lines (post a comment explaining why)
- [ ] Skip if estimated cost > $0.50 per review (configurable)
- [ ] Skip if same PR was reviewed within the last 5 minutes (deduplication)
- [ ] Log a reason whenever a guardrail fires

### F5 — Parallel Agent Execution
- [ ] 4 specialized agents run simultaneously via `Promise.all()`
- [ ] Each agent receives focused context (not the full diff blindly)
- [ ] Each agent returns structured JSON: `{issues: [{file, line, severity, description, suggestion}]}`
- [ ] If one agent fails, the others continue — partial results are posted with a failure note
- [ ] Per-agent timeout: 30 seconds (agent is skipped if it exceeds this)

### F6 — Agent Specializations

**Security Agent**
- Focus: auth bypasses, SQL injection, XSS, secrets hardcoded in code, weak crypto (MD5, SHA1 for passwords), SSRF, path traversal
- System prompt emphasizes: "Only flag confirmed issues, not theoretical possibilities. Be precise about which line and why."

**Performance Agent**
- Focus: N+1 database queries (loop with DB call inside), O(n²) algorithms where O(n) is possible, missing database indexes (querying by unindexed columns), large data loaded into memory unnecessarily
- System prompt emphasizes: "Estimate the real-world impact. A loop over 10 items is fine. A loop over 1M rows is not."

**Test Coverage Agent**
- Focus: new functions with no corresponding tests, error paths that aren't tested, edge cases (empty array, null, 0, negative numbers) that are missing
- System prompt emphasizes: "Focus on logic that could fail silently. Don't flag for 100% line coverage."

**Breaking Changes Agent**
- Focus: removed exported functions/types, changed function signatures (new required params), renamed API endpoints, changed response shapes, removed environment variables
- System prompt emphasizes: "Only flag changes that would break existing callers. Internal changes are fine."

### F7 — Synthesis Agent
- [ ] Receives all 4 agents' structured JSON outputs
- [ ] Deduplicates: if 2 agents flag the same issue, include it once
- [ ] Prioritizes: critical issues appear first (security > breaking changes > performance > coverage)
- [ ] Decides verdict: `REQUEST_CHANGES` if any critical issues, `COMMENT` otherwise, `APPROVE` only if no issues found
- [ ] Formats output as GitHub review API shape (ready to POST directly)
- [ ] Produces a 2-3 sentence summary for the top-level review body

### F8 — GitHub Review Posting
- [ ] Posts one review (not multiple separate comments)
- [ ] Each issue is anchored to the specific file and line number
- [ ] Review body contains: overall summary, agent breakdown (which agent found what), severity legend
- [ ] Verdict is set correctly (APPROVE / COMMENT / REQUEST_CHANGES)
- [ ] If no issues found, posts an APPROVE with a brief summary

### F9 — Logging and Observability
- [ ] Each review logs: total latency, per-agent latency, total tokens used, estimated cost
- [ ] Logs which guardrails fired and why
- [ ] Errors include full context (repo, PR number, which agent failed)
- [ ] (Optional) LangSmith trace for full agent call visualization

---

## Eval Requirements

### E1 — Test Dataset
- 20-30 real PRs with known issues, curated manually
- Minimum coverage: 5 security issues, 5 performance issues, 5 missing tests, 5 breaking changes
- Each issue labeled with: file, approximate line, severity, category
- Source: your own past PRs, open-source repos, or synthetic PRs you write yourself

### E2 — Eval Runner
- Script that runs the full harness against each test PR
- Compares agent output to labeled ground truth
- Scores: did the agent flag the known issue? (within ± 3 lines counts as a catch)
- Runs in < 5 minutes total

### E3 — Metrics Output

```
PR Review Harness — Eval Report
─────────────────────────────────────────────
Test PRs:              28
Issues in dataset:     42

CATCH RATE (recall)
  Security:            8/10  (80%)
  Performance:         7/10  (70%)
  Test Coverage:       9/12  (75%)
  Breaking Changes:    8/10  (80%)
  Overall:             32/42 (76%)

FALSE POSITIVE RATE
  Total comments posted:    89
  Valid:                    71
  Spurious:                 18
  False positive rate:      20%

PERFORMANCE
  Avg latency per review:   11.2s
  Avg cost per review:      $0.013
  Total eval cost:          $0.36
─────────────────────────────────────────────
```

### E4 — Improvement Loop
- Run eval → identify lowest catch-rate category → change system prompt or context strategy → run eval again → measure delta
- Document each iteration: what changed, what improved, what got worse
- Target: catch rate > 80%, false positive rate < 25%

---

## Technical Stack Decisions

### Language: TypeScript
Reason: Already familiar from mini-harness project. Type safety helps when working with complex GitHub API shapes and agent outputs.

### HTTP Server: Fastify
Reason: Fast, TypeScript-native, minimal boilerplate. Handles webhook parsing cleanly.

### Job Queue: BullMQ + Redis
Reason: GitHub webhooks timeout in 10 seconds. BullMQ decouples receipt from processing and provides automatic retries. Redis on Upstash free tier requires no server management.

### Agent Framework: Raw → LangGraph.js
Reason: Start raw (you already know the pattern from mini-harness). Migrate to LangGraph.js when the workflow becomes complex enough to need its state management and observability. LangGraph.js v0.2 is a full port, not a thin wrapper.

### Models: OpenAI SDK (OpenRouter-compatible)
Reason: Same SDK works with OpenRouter (dev, free), OpenAI direct (production, cheap), or Anthropic. Swap baseURL to switch providers.

### GitHub Auth: GitHub App
Reason: Apps have higher rate limits (15,000 req/hour vs 5,000 for personal tokens), are scoped to specific repos, and are the correct mechanism for bots. Requires registering an app at github.com/settings/apps.

### Structured Output: JSON Schema mode
Reason: Forces agents to return `{issues: [...]}` JSON, not prose. Makes synthesis deterministic instead of requiring another LLM to parse free text.

---

## Success Metrics

| Metric | Target | Measured by |
|---|---|---|
| Review posted latency | < 15 seconds | Log timestamps |
| Catch rate (overall) | > 80% | Eval pipeline |
| False positive rate | < 25% | Eval pipeline |
| Cost per review | < $0.05 | Token usage logs |
| Guardrail fire rate | < 10% of PRs | Guardrail logs |
| System uptime | > 95% | Job failure rate in BullMQ |

---

## Build Sequence

Build in this order. Each step is runnable and testable before moving to the next.

```
Phase 1 — Foundation (1-2 days)
├── Webhook server with signature validation
├── GitHub App setup and authentication  
├── Diff fetching from GitHub API
└── Basic logging

Phase 2 — Single Agent (1 day)
├── One agent (security) running on a fetched diff
├── Structured output (JSON schema mode)
└── Review posted to GitHub

Phase 3 — Multi-Agent Parallel (1-2 days)
├── All 4 specialized agents running in parallel
├── Per-agent timeout handling
├── Synthesis agent
└── Guardrails

Phase 4 — Queue + Reliability (1 day)
├── BullMQ integration
├── Retry logic
├── Deduplication
└── Dead-letter queue

Phase 5 — Eval Pipeline (2-3 days)
├── Curate test dataset (most time-consuming step)
├── Eval runner script
├── Metrics report
└── First iteration of improvement loop

Phase 6 — Observability (1 day)
├── LangSmith tracing
├── Cost + latency dashboard
└── Error alerting
```

---

## Open Questions to Resolve Before Building

1. **GitHub App vs Personal Access Token** — App is better for production. Personal token is faster to set up for dev. Decision: start with PAT, migrate to App in Phase 4.

2. **Which repo to test on?** — Use your own repos or create a test repo with intentionally buggy PRs. Do not run on other people's repos without their consent.

3. **Context splitting strategy** — Do all 4 agents see the full diff, or do we pre-filter (e.g., security agent only sees files that handle auth/DB)? Start with full diff. Optimize later based on eval results.

4. **How to handle large diffs** — Options: skip (guardrail), chunk into multiple reviews, summarize with a fast model first. Start with skip + explanation comment.

5. **LangSmith free tier limits** — 5,000 traces/month on free tier. Sufficient for development and eval.
