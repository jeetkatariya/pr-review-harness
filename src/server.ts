import Fastify from "fastify";
import "dotenv/config";
import { verifySignature } from "./github.js";
import { processReview } from "./harness.js";
import type { PRJob } from "./types.js";

const PORT = Number(process.env.PORT ?? 3000);

const fastify = Fastify({ logger: true });

// Store raw body on the request so we can verify GitHub's HMAC signature.
// Must be registered before routes.
fastify.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (req, body: Buffer, done) => {
    try {
      const parsed = JSON.parse(body.toString());
      // Attach raw buffer to request for signature verification
      (req as unknown as { rawBody: Buffer }).rawBody = body;
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  }
);

// Health check — useful to confirm the server is up
fastify.get("/", async () => {
  return { status: "PR Review Harness running" };
});

// The webhook endpoint GitHub calls
fastify.post("/webhook", async (request, reply) => {
  const rawBody = (request as unknown as { rawBody: Buffer }).rawBody;
  const sigHeader = request.headers["x-hub-signature-256"] as string | undefined;
  const event = request.headers["x-github-event"] as string | undefined;
  const deliveryId = request.headers["x-github-delivery"] as string | undefined;

  // Step 1: validate signature
  // Reject anything that didn't come from GitHub (or has wrong secret)
  if (!sigHeader) {
    return reply.code(401).send("Missing signature");
  }

  try {
    verifySignature(process.env.GITHUB_WEBHOOK_SECRET!, rawBody, sigHeader);
  } catch {
    return reply.code(401).send("Invalid signature");
  }

  // Step 2: reply 200 immediately — GitHub needs this within 10 seconds
  // All actual work happens after this reply
  reply.code(200).send("OK");

  // Step 3: only care about pull_request events
  if (event !== "pull_request") {
    fastify.log.info(`[webhook] ignored event: ${event}`);
    return;
  }

  const payload = request.body as {
    action: string;
    pull_request: { number: number; head: { sha: string } };
    repository: { full_name: string };
  };

  // Step 4: only process when a PR is opened or updated with new commits
  if (!["opened", "synchronize"].includes(payload.action)) {
    fastify.log.info(`[webhook] ignored PR action: ${payload.action}`);
    return;
  }

  const job: PRJob = {
    repo: payload.repository.full_name,
    prNumber: payload.pull_request.number,
    commitSha: payload.pull_request.head.sha,
    deliveryId: deliveryId ?? "unknown",
  };

  fastify.log.info(`[webhook] queuing review for ${job.repo} PR #${job.prNumber}`);

  // Step 5: process in background — fire and forget for Phase 1
  // Phase 4 replaces this with BullMQ for retries and reliability
  processReview(job).catch((err) => {
    fastify.log.error("[webhook] background review failed:", err);
  });
});

// Start the server
try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`\nPR Review Harness listening on http://localhost:${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log(`\nTo expose publicly for GitHub webhooks:`);
  console.log(`  npx smee-client --url https://smee.io/YOUR_CHANNEL --target http://localhost:${PORT}/webhook`);
  console.log(`  (create a channel at https://smee.io/new)\n`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
