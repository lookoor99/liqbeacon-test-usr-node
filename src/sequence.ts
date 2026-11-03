// sequence.ts: detect missed events and recover them with a replay.
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError, LiqbeaconClient, SequenceTracker, type CardanoEvent } from "@liqbeacon/sdk";
import { config } from "./config";
import { handleEvent } from "./handlers";

// Events sent by scripts/send-test.ts carry this prefix. They never existed on
// the platform, so a replay for them would only earn a 404.
export const SELF_TEST_PREFIX = "sub_selftest";

// The last processed seq per subscription. Any durable store works; a file
// keeps the example self-contained.
const CURSOR_FILE = path.join(config.dataDir, "cursors.json");

const client = config.api ? new LiqbeaconClient(config.api) : null;

let tracker = new SequenceTracker();

// The first missing seq a replay was requested for, per subscription, so a
// gap triggers one replay rather than one per event that arrives after it.
const replayRequested = new Map<string, number>();

export async function initTracking(): Promise<void> {
  tracker = new SequenceTracker(await loadCursors());
  console.log("cursors:", JSON.stringify(tracker.snapshot()));

  if (!client) {
    console.warn("LIQBEACON_API_URL / LIQBEACON_API_KEY not set: gaps will be logged, not replayed");
    return;
  }

  // First run for this subscription: load the outputs it already watches,
  // then resume events right after the snapshot.
  const subscriptionId = config.subscriptionId;
  if (subscriptionId && tracker.cursor(subscriptionId) === null) {
    const { utxos, nextSeq } = await client.loadSnapshot(subscriptionId);
    console.log(`snapshot: ${utxos.length} outputs, events resume at seq ${nextSeq}`);

    // The tracker stores the last processed seq, not the next expected one.
    tracker = new SequenceTracker({ ...tracker.snapshot(), [subscriptionId]: nextSeq - 1 });
    await saveCursors();
  }

  if (subscriptionId) {
    const range = await client.cursor(subscriptionId);
    console.log(
      `platform: latest seq ${range.latest_seq}, latest delivered ${range.latest_delivered_seq}, ` +
        `next ${range.next_seq}, replay window ${range.replay_window_days} days`
    );
  }
}

/** Returns the seqs found missing before this event, for the record. */
export async function processEvent(event: CardanoEvent): Promise<{ duplicate: boolean; missing: number[] }> {
  const { duplicate, missing } = tracker.check(event);
  if (duplicate) return { duplicate, missing }; // already handled; answer 2xx so it is not retried

  if (missing.length > 0 && replayRequested.get(event.subscription_id) !== missing[0]) {
    console.warn(`missed seq ${missing.join(", ")} on ${event.subscription_id}`);
    if (client && !event.subscription_id.startsWith(SELF_TEST_PREFIX)) {
      try {
        // Re-sends everything from missing[0] with the original ids. Events
        // already committed come back as duplicates and are skipped above.
        const result = await client.replay(event.subscription_id, missing[0]);
        console.warn(`replay requested from seq ${missing[0]}: ${result.message}`);
        replayRequested.set(event.subscription_id, missing[0]);
      } catch (error) {
        // Don't fail this delivery over it; the next event asks again.
        console.error("replay request failed:", error instanceof ApiError ? error.message : error);
      }
    }
  }

  await handleEvent(event); // throws? nothing is recorded, and the delivery is retried
  tracker.commit(event); // only after the handler succeeded
  await saveCursors();
  return { duplicate, missing };
}

export function cursors(): { [subscriptionId: string]: number } {
  return tracker.snapshot();
}

async function loadCursors(): Promise<{ [subscriptionId: string]: number }> {
  try {
    return JSON.parse(await readFile(CURSOR_FILE, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

// Write, then rename: a crash mid-write never leaves a truncated file.
async function saveCursors(): Promise<void> {
  await writeFile(`${CURSOR_FILE}.tmp`, JSON.stringify(tracker.snapshot()));
  await rename(`${CURSOR_FILE}.tmp`, CURSOR_FILE);
}
