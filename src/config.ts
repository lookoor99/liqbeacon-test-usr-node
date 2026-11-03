// config.ts: everything read from the environment, in one place.
import "dotenv/config";
import path from "node:path";

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

const secrets = [process.env.WEBHOOK_SECRET, process.env.WEBHOOK_SECRET_PREVIOUS]
  .map((s) => s?.trim())
  .filter((s): s is string => Boolean(s));

if (secrets.length === 0) {
  throw new Error("Set WEBHOOK_SECRET to the subscription's signing secret (whsec_...)");
}

const apiUrl = process.env.LIQBEACON_API_URL?.trim() || "";
const apiKey = process.env.LIQBEACON_API_KEY?.trim() || "";

export const config = {
  secrets,
  host: process.env.HOST || "127.0.0.1",
  port: number("PORT", 3000),
  webhookPath: process.env.WEBHOOK_PATH || "/webhooks/cardano",
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  statusToken: process.env.STATUS_TOKEN?.trim() || "",

  // Replay and snapshot need both. Without them, gaps are only logged.
  api: apiUrl && apiKey ? { baseUrl: apiUrl, apiKey } : null,
  subscriptionId: process.env.LIQBEACON_SUBSCRIPTION_ID?.trim() || "",

  simulateFailureRate: Math.min(1, Math.max(0, number("SIMULATE_FAILURE_RATE", 0))),
  simulateDelayMs: Math.max(0, number("SIMULATE_DELAY_MS", 0)),
};
