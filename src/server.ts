// server.ts: receive and verify webhooks, the way a real customer would.
//
//   npm run build && npm start          (or `npm run dev` while editing)
//
// Configuration is read from .env; see .env.example.
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { verifyEvent, SignatureError, type CardanoEvent } from "@liqbeacon/sdk";
import { config } from "./config";
import { record, stats, type Entry, type Outcome } from "./recorder";
import { cursors, initTracking, processEvent } from "./sequence";

const app = express();

// nginx sits in front on the same host; trust it for req.ip only.
app.set("trust proxy", "loopback");

// express.raw, not express.json: the signature covers the exact bytes the
// platform sent, and a re-serialized body will not match. Mount it on this
// route only. A single event is a few KB; 1 MB leaves plenty of room.
app.post(config.webhookPath, express.raw({ type: "*/*", limit: "1mb" }), async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  const answer = (status: number, outcome: Outcome, event: CardanoEvent | null, extra: Partial<Entry> = {}) => {
    record({
      received_at: new Date(startedAt).toISOString(),
      outcome,
      status,
      duration_ms: Date.now() - startedAt,
      ip: req.ip,
      event_id: event?.id ?? null,
      event_type: event?.type ?? null,
      seq: event?.seq ?? null,
      subscription_id: event?.subscription_id ?? null,
      headers: {
        "x-cardano-event-id": req.header("X-Cardano-Event-Id"),
        "x-cardano-event-type": req.header("X-Cardano-Event-Type"),
        "x-cardano-event-seq": req.header("X-Cardano-Event-Seq"),
        "x-cardano-subscription": req.header("X-Cardano-Subscription"),
        "x-cardano-signature": req.header("X-Cardano-Signature"),
        "idempotency-key": req.header("Idempotency-Key"),
        "user-agent": req.header("User-Agent"),
      },
      body: rawBody.toString("utf8"),
      ...extra,
    });
    res.status(status).send(status >= 400 ? "error" : "ok");
  };

  let event: CardanoEvent;
  try {
    event = verifyEvent({
      payload: rawBody,
      header: req.header("X-Cardano-Signature") ?? "",
      secret: config.secrets, // any one of them may match
    });
  } catch (error) {
    if (error instanceof SignatureError) {
      // Keep the reason server-side: it would tell a forger how close they got.
      console.warn(`[rejected] ${req.ip}: ${error.message}`);
      return answer(400, "rejected", null, { error: error.message });
    }
    // A TypeError here means this route is misconfigured (see the message).
    console.error(error);
    return answer(500, "failed", null, { error: String(error) });
  }

  // The headers are informational, but a mismatch with the signed body means
  // something between the platform and us rewrote one of them.
  const headerId = req.header("X-Cardano-Event-Id");
  if (headerId && headerId !== event.id) {
    console.warn(`[mismatch] header event id ${headerId} != body ${event.id}`);
  }

  // Sent by the "Send test event" button in the console. It has no seq.
  if (event.type === "test") {
    console.log(`[test]     ${event.id} for ${event.subscription_id}: signature ok`);
    return answer(200, "test", event);
  }

  if (config.simulateDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, config.simulateDelayMs));
  }

  if (config.simulateFailureRate > 0 && Math.random() < config.simulateFailureRate) {
    console.warn(`[simfail]  ${event.id} seq=${event.seq}: answering 500 on purpose`);
    return answer(500, "simulated_failure", event);
  }

  try {
    const { duplicate, missing } = await processEvent(event);
    return answer(200, duplicate ? "duplicate" : "processed", event, { missing }); // 2xx: delivered
  } catch (error) {
    // Any non-2xx is retried with backoff, and later events wait behind it.
    console.error(`handler failed for ${event.id}; it will be retried:`, error);
    return answer(500, "failed", event, { error: String(error) });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/status", (req, res) => {
  if (config.statusToken && !tokenMatches(req.header("Authorization") ?? "")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  res.json(stats(cursors()));
});

function tokenMatches(header: string): boolean {
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(config.statusToken);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function main(): Promise<void> {
  await initTracking();

  app.listen(config.port, config.host, () => {
    console.log(`listening on http://${config.host}:${config.port}${config.webhookPath}`);
    console.log(`secrets loaded: ${config.secrets.length}`);
    if (config.simulateFailureRate > 0) {
      console.log(`fault injection: failing ${config.simulateFailureRate * 100}% of events`);
    }
    if (config.simulateDelayMs > 0) {
      console.log(`fault injection: delaying every answer by ${config.simulateDelayMs} ms`);
    }
  });
}

main().catch((error) => {
  console.error("failed to start:", error);
  process.exit(1);
});
