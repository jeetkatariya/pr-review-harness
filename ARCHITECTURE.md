# PR Review Multi-Agent Harness — Architecture

## What We're Building

A system that automatically reviews pull requests using multiple specialized AI agents
running in parallel. When a developer opens a PR on GitHub, the harness:

1. Receives a webhook notification from GitHub
2. Fetches the code diff
3. Runs 4 specialized agents simultaneously (security, performance, test coverage, breaking changes)
4. A synthesis agent combines their findings into one structured review comment
5. Posts the review back to the PR on GitHub

The developer sees a single, well-organized review comment — not 4 separate ones.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         GITHUB                                   │
│   Developer opens PR → GitHub fires webhook → your server       │
└──────────────────────────────┬──────────────────────────────────┘
                               │  POST /webhook
                               │  X-Hub-Signature-256: sha256=...
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    WEBHOOK SERVER (Express/Fastify)              │
│                                                                  │
│  1. Validate GitHub signature (security — reject fakes)         │
│  2. Check event type (only process pull_request: opened/sync)   │
│  3. Respond 200 OK immediately (GitHub needs < 10s response)    │
│  4. Enqueue job for background processing                       │
└──────────────────────────────┬──────────────────────────────────┘
                               │  enqueue job (async)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    JOB QUEUE (BullMQ + Redis)                   │
│                                                                  │
│  Stores: repo, PR number, commit SHA, installation ID           │
│  Config: 3 retry attempts, exponential backoff                  │
│  Idempotency: use X-GitHub-Delivery UUID as job ID             │
│              (prevents duplicate reviews on retry)              │
└──────────────────────────────┬──────────────────────────────────┘
                               │  worker picks up job
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    HARNESS ORCHESTRATOR                          │
│                                                                  │
│  1. Fetch PR diff from GitHub API                               │
│  2. Run guardrails (diff too large? cost cap reached?)          │
│  3. Split diff into focused context per agent                   │
│  4. Run 4 agents in PARALLEL (Promise.all)                      │
│  5. Collect results, check for errors                           │
│  6. Run synthesis agent with all findings                       │
│  7. Post review to GitHub API                                   │
│  8. Log metrics (latency, cost, token usage)                    │
└──────────────────────────────┬──────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │ parallel       │                │
              ▼                ▼                ▼                ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │   SECURITY   │  │ PERFORMANCE  │  │     TEST     │  │   BREAKING   │
    │    AGENT     │  │    AGENT     │  │   COVERAGE   │  │   CHANGES    │
    │              │  │              │  │    AGENT     │  │    AGENT     │
    │ Finds:       │  │ Finds:       │  │              │  │              │
    │ - SQL inject │  │ - N+1 query  │  │ Finds:       │  │ Finds:       │
    │ - XSS        │  │ - O(n²) algo │  │ - Missing    │  │ - Removed    │
    │ - Secrets    │  │ - Memory leak│  │   test cases │  │   exports    │
    │ - Auth issues│  │ - Unindexed  │  │ - Edge cases │  │ - API breaks │
    │ - Crypto bugs│  │   DB columns │  │   not tested │  │ - Type breaks│
    └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
           │                 │                  │                  │
           └─────────────────┴──────────────────┴──────────────────┘
                                       │
                                       ▼
                          ┌────────────────────────┐
                          │    SYNTHESIS AGENT      │
                          │                         │
                          │  Input: all 4 findings  │
                          │  Output: structured JSON │
                          │  {                       │
                          │    summary: string,      │
                          │    verdict: APPROVE |    │
                          │            COMMENT |     │
                          │            REQUEST_CHG,  │
                          │    comments: [{          │
                          │      file, line, body    │
                          │    }]                    │
                          │  }                       │
                          └───────────┬──────────────┘
                                      │
                                      ▼
                          ┌────────────────────────┐
                          │    GITHUB API           │
                          │                         │
                          │  POST /pulls/:n/reviews │
                          │  Posts one review with  │
                          │  all line comments      │
                          │  attached               │
                          └────────────────────────┘


                    ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

                         SEPARATE: EVAL PIPELINE

    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
    │  TEST DATASET│    │  EVAL RUNNER │    │   METRICS    │
    │              │    │              │    │   REPORT     │
    │  20-30 PRs   │───►│  Runs harness│───►│              │
    │  with known  │    │  against each│    │ - Catch rate │
    │  issues      │    │  test PR     │    │ - False pos  │
    │  labeled     │    │  Compares to │    │ - Latency    │
    │  by you      │    │  ground truth│    │ - Cost/review│
    └──────────────┘    └──────────────┘    └──────────────┘
```

---

## Component Breakdown

### 1. Webhook Server
**Purpose:** Receive GitHub notifications and hand off to background processing immediately.

**Why it exists:** GitHub expects a response within 10 seconds. LLM agent calls take 30-120 seconds. You cannot do the work inside the webhook handler — you must decouple.

**Tools:**
- **Fastify** (Node.js) — fast HTTP server, TypeScript-native
- **express** — alternative, more familiar, fine for this scale
- **crypto** (built-in Node.js) — for HMAC-SHA256 signature verification

**Key implementation detail:** Use `timingSafeEqual` for signature comparison — not `===`. Regular string comparison leaks timing information that attackers can exploit.

**Cost:** Free — just your server.

---

### 2. Job Queue
**Purpose:** Buffer webhook events so the server stays fast and agent work runs reliably in the background.

**Why it exists:** Decouples receipt from processing. Enables automatic retries if an agent call fails. Handles traffic spikes without dropping jobs.

**Tools:**
- **BullMQ** — the job queue library (Node.js)
- **Redis** — the data store BullMQ uses under the hood
- **Upstash Redis** — free tier, no server to manage (for development)
- **Redis Cloud** — free tier 30MB (also fine for development)

**Key config:**
- 3 retry attempts with exponential backoff
- Use `X-GitHub-Delivery` UUID as job ID to prevent duplicate reviews

**Cost:** Free (Upstash free tier: 10,000 commands/day, 256MB).

---

### 3. GitHub API Client
**Purpose:** Fetch the PR diff, post the review comment back.

**Why it exists:** The harness needs the actual code changes, and needs to write results back to GitHub.

**Tools:**
- **Octokit** (`@octokit/rest`) — official GitHub SDK for Node.js
- **GitHub App** authentication — preferred over personal access tokens for production

**Key APIs used:**
```
GET  /repos/{owner}/{repo}/pulls/{pr}/files   → fetch changed files + diffs
POST /repos/{owner}/{repo}/pulls/{pr}/reviews  → post the final review
```

**Cost:** Free — GitHub API has generous rate limits (5,000 requests/hour for authenticated apps).

---

### 4. Harness Orchestrator
**Purpose:** Own the full lifecycle of one PR review — from raw diff to posted review.

**Why it exists:** Same reason as mini-harness. Someone has to open the environment, run the loop, verify the output, and clean up. That's the orchestrator.

**What it does:**
1. Receives job from queue
2. Fetches diff from GitHub
3. Runs guardrails (size check, cost check)
4. Splits diff into agent-specific context
5. Runs 4 agents with `Promise.all()` (parallel)
6. Feeds all results to synthesis agent
7. Posts review
8. Logs cost + latency metrics

**Tools:** Pure TypeScript, no framework needed here. This is your harness pattern from mini-harness.

---

### 5. Specialized Review Agents (the 4 parallel agents)

Each agent is the same pattern: a model call with a focused system prompt and a slice of the diff. They run simultaneously.

| Agent | What it looks for | Key context it receives |
|---|---|---|
| Security | SQL injection, XSS, secrets in code, weak crypto, auth bypasses | Full diff, focus on input handling / DB queries / auth |
| Performance | N+1 queries, O(n²) algorithms, missing DB indexes, memory leaks | Full diff, focus on loops / DB calls / data structures |
| Test Coverage | Missing test cases, edge cases not tested, untested error paths | Diff + existing test files for context |
| Breaking Changes | Removed exports, changed function signatures, type breaks, API changes | Diff + focus on public interfaces |

**Tools:**
- OpenAI SDK or Anthropic SDK — direct API calls
- Structured output (JSON schema) — forces each agent to return `{issues: [{file, line, severity, description}]}` instead of prose

**Why structured output matters:** When 4 agents return JSON, the synthesis agent can merge them programmatically instead of asking another LLM to parse prose. Faster, cheaper, more reliable.

---

### 6. Synthesis Agent
**Purpose:** Take all 4 agents' structured findings and produce one final review.

**Why one agent and not just merge JSON:** The synthesis agent deduplicates (two agents might flag the same issue), prioritizes (surfaces critical issues first), writes human-readable comment bodies, and decides the overall verdict (APPROVE / COMMENT / REQUEST_CHANGES).

**Output:** A single JSON object matching GitHub's review API shape — ready to POST directly.

---

### 7. Guardrails
**Purpose:** Hard limits that stop the review before it runs, to prevent runaway costs or unhelpful reviews.

**Checks:**
- Diff size > 5,000 lines → skip (too large to review meaningfully)
- Total tokens estimated > 50,000 → skip or chunk
- Same PR reviewed in last 5 minutes → skip (deduplication)
- Daily cost cap exceeded → skip and alert

**Why they matter:** Without guardrails, a 50,000-line PR could cost $5+ in one review and still produce garbage output because the model context is overwhelmed.

---

### 8. Eval Pipeline
**Purpose:** Measure whether your harness is actually working, not just whether it runs.

**How it works:**
1. You curate 20-30 real PRs where you know the issues (past bugs, security fixes)
2. Label each with what should have been caught
3. Run harness against each PR
4. Score: did the agent flag the known issues? How many false positives?
5. Get a number: "87% catch rate, 12% false positive rate"
6. Change something (system prompt, context strategy) → run again → measure improvement

**This is the story you tell in interviews.** Not "I built a PR reviewer" but "I had 60% catch rate on security issues. I changed how the security agent receives context and got it to 85%. Here's the eval that showed me."

---

## Agent Framework Options

You have four choices. Here's an honest comparison:

### Option A: Raw (no framework) — what we built in mini-harness
```
Pros:  You understand every line. Full control. No dependency overhead.
Cons:  You write the parallel execution, state management, retry logic yourself.
When: Building to learn. Simple workflows. You want to know the internals.
```

### Option B: LangGraph.js ← recommended for this project
```
Pros:  Native parallel execution (fan-out/fan-in). State management built in.
       LangSmith for tracing + eval. Active development. Works in TypeScript.
Cons:  Learning curve. Abstracts away things you just learned.
When: Production systems. Complex branching. You need observability.
```

### Option C: CrewAI (Python only)
```
Pros:  Simplest API. Role-based (Security Auditor, Performance Reviewer).
       Quick to prototype.
Cons:  Python only. Weaker observability. Less control over parallel execution.
When: Prototype quickly. Linear workflows. Python is your language.
```

### Option D: AutoGen (Python, Microsoft)
```
Pros:  Agents talk to each other (conversational multi-agent).
Cons:  Maintenance mode as of Oct 2025 (merged into Microsoft Agent Framework).
       Expensive at scale — each turn passes full conversation history.
When: Research. Debate-style tasks. Microsoft ecosystem.
```

**Recommendation:** Start with **raw TypeScript** (you know the pattern). Once it works, migrate the orchestrator to **LangGraph.js** — this is exactly what the industry does, and it gives you the eval/observability story via LangSmith.

---

## Model Provider Options

For a typical PR (2,000-5,000 lines diff), running 5 agents (4 specialized + synthesis):

| Provider | Model | Speed | Cost per PR review | Best for |
|---|---|---|---|---|
| OpenRouter free | Various :free models | Slow, rate limited | $0 | Development only |
| OpenAI | GPT-4o-mini | Fast (~2s/call) | ~$0.01 | Default choice |
| Anthropic | Claude Haiku 3 | Fast (~2s/call) | ~$0.015 | Code tasks |
| Anthropic | Claude claude-sonnet-4-6 | Medium (~4s/call) | ~$0.18 | Best quality |
| OpenAI | GPT-4o | Medium | ~$0.25 | Best quality alt |

**For development:** OpenRouter free (no cost, rate limits are fine for testing)
**For demo/production:** GPT-4o-mini or Claude Haiku — fast, cheap, good enough

At 100 PR reviews: ~$1-2 total. Not a concern.

---

## Data Flow: What Happens Step by Step

```
1. Dev opens PR on GitHub
   └─► GitHub fires POST to your /webhook endpoint

2. Webhook server (< 1s)
   ├─► Validate X-Hub-Signature-256
   ├─► Filter: only pull_request opened/synchronize events
   ├─► Extract: repo, PR number, commit SHA
   ├─► Enqueue job in BullMQ (< 10ms)
   └─► Return 200 OK to GitHub

3. BullMQ worker picks up job (< 1s queue time in dev)

4. Harness orchestrator starts
   ├─► Fetch PR diff from GitHub API (~0.3s)
   ├─► Run guardrails (diff size, cost cap)
   ├─► Split diff into agent contexts
   └─► Launch 4 agents in parallel

5. 4 agents run simultaneously (~2-5s with fast models)
   ├─► Security agent → {issues: [...]}
   ├─► Performance agent → {issues: [...]}
   ├─► Test coverage agent → {issues: [...]}
   └─► Breaking changes agent → {issues: [...]}

6. Synthesis agent (~2-3s)
   ├─► Deduplicates findings
   ├─► Prioritizes by severity
   ├─► Formats as GitHub review JSON
   └─► Decides verdict (APPROVE / COMMENT / REQUEST_CHANGES)

7. Post review to GitHub API (~0.2s)
   └─► Developer sees structured review on their PR

Total time: ~8-12 seconds from PR open to review posted
```

---

## Tech Stack Summary

| Layer | Technology | Why |
|---|---|---|
| Language | TypeScript | You know it, type safety catches bugs early |
| HTTP server | Fastify | Fast, TypeScript-native |
| Job queue | BullMQ | Reliable, retries, deduplication |
| Queue backend | Redis (Upstash) | Free tier, managed, no server to run |
| Agent framework | LangGraph.js → raw first | Learn raw, then migrate for observability |
| Model API | OpenAI SDK | Works with OpenRouter too (same interface) |
| GitHub integration | Octokit | Official SDK, handles auth/pagination |
| Evals/tracing | LangSmith | Free tier, pairs with LangGraph |
| Structured output | JSON schema mode | Forces consistent agent output format |

---

## What This Project Demonstrates

For every concept in those LinkedIn posts, here's where it shows up:

| Concept | Where it lives in this project |
|---|---|
| "GitLab hooks triggering agents" | GitHub webhook → BullMQ → harness |
| "Parallel threads" | Promise.all on 4 agents simultaneously |
| "Humans reviewing instead of executing" | Developer reviews the posted comment, not the raw diff |
| "Feedback loops" | Eval pipeline measuring catch rate over time |
| "Orchestrating agents, not using them" | Harness orchestrator managing the full lifecycle |
| "Agent harness" | The orchestrator + guardrails + verify pattern |
| "Eval pipeline" | Test dataset + runner + metrics report |
