// recorder.ts: keep evidence of every delivery attempt, so a test run can be
// checked afterwards: what arrived, in what order, and what we answered.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config";

export type Outcome =
  | "test" //          the console's "Send test event" button
  | "processed" //     verified and handled
  | "duplicate" //     verified, already handled before
  | "rejected" //      signature check failed
  | "failed" //        handler threw; the platform will retry
  | "simulated_failure"; // SIMULATE_FAILURE_RATE said no

export type Entry = {
  received_at: string;
  outcome: Outcome;
  status: number;
  duration_ms: number;
  ip: string | undefined;
  event_id: string | null;
  event_type: string | null;
  seq: number | null;
  subscription_id: string | null;
  // Header values as sent. Comparing them with the body catches proxies
  // that rewrite one but not the other.
  headers: { [name: string]: string | undefined };
  missing?: number[];
  error?: string;
  body: string;
};

const RECORD_FILE = path.join(config.dataDir, "received.ndjson");
mkdirSync(config.dataDir, { recursive: true });

const startedAt = new Date().toISOString();
const counts: { [outcome: string]: number } = {};
const byType: { [type: string]: number } = {};
const gaps: { subscription_id: string; missing: number[]; at: string }[] = [];
const recent: Omit<Entry, "body" | "headers">[] = [];

export function record(entry: Entry): void {
  // Synchronous on purpose: low volume, and the line must be on disk before
  // we answer, or a crash could hide an event that we acknowledged.
  appendFileSync(RECORD_FILE, JSON.stringify(entry) + "\n");

  counts[entry.outcome] = (counts[entry.outcome] ?? 0) + 1;
  if (entry.event_type) byType[entry.event_type] = (byType[entry.event_type] ?? 0) + 1;
  if (entry.missing?.length && entry.subscription_id) {
    gaps.push({ subscription_id: entry.subscription_id, missing: entry.missing, at: entry.received_at });
    if (gaps.length > 50) gaps.shift();
  }

  const { body: _body, headers: _headers, ...summary } = entry;
  recent.unshift(summary);
  if (recent.length > 50) recent.pop();
}

export function stats(cursors: { [subscriptionId: string]: number }) {
  return {
    started_at: startedAt,
    record_file: RECORD_FILE,
    counts,
    by_type: byType,
    cursors,
    gaps,
    recent,
  };
}
