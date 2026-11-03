// send-test.ts: check the receiver itself before pointing the platform at it.
//
//   npm run send-test                                   # http://127.0.0.1:3000/webhooks/cardano
//   npm run send-test -- https://hook.example.com/webhooks/cardano
//
// Signs events exactly as the platform does (HMAC-SHA256 over "t.body",
// header "t=<unix>,v1=<hex>") with WEBHOOK_SECRET from .env, and checks each
// answer. Events use a fresh "sub_selftest_..." subscription id, so they never
// mix with the cursor of a real subscription.
import "dotenv/config";
import crypto from "node:crypto";

const secret = process.env.WEBHOOK_SECRET?.trim();
if (!secret) throw new Error("Set WEBHOOK_SECRET in .env first");

const url =
  process.argv[2] ??
  `http://127.0.0.1:${process.env.PORT || 3000}${process.env.WEBHOOK_PATH || "/webhooks/cardano"}`;

const subscriptionId = `sub_selftest_${Date.now().toString(16)}`;
const block = { height: 11_482_190, slot: 142_903_811, hash: "8f1c".padEnd(64, "0") };

function sign(body: string, timestamp: number, key = secret!): string {
  const digest = crypto.createHmac("sha256", key).update(`${timestamp}.${body}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function makeEvent(seq: number | null, type: string, data: unknown, id = `evt_selftest_${crypto.randomBytes(6).toString("hex")}`) {
  return {
    id,
    seq,
    type,
    subscription_id: subscriptionId,
    created_at: new Date().toISOString(),
    block: type === "test" ? null : block,
    tx_id: type === "test" ? null : "b71e".padEnd(64, "0"),
    confirmations: type === "test" ? null : 3,
    rolled_back: false,
    data,
  };
}

function utxo(index: number, lovelace: string) {
  return {
    tx_id: "a90d".padEnd(64, "0"),
    index,
    address: "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp",
    value: { lovelace, assets: { ["b0d07d45".padEnd(56, "0")]: { "4d494c4b": "120" } } },
    datum_hash: null,
    datum: null,
    script_hash: null,
  };
}

type Case = {
  name: string;
  expect: number;
  event: ReturnType<typeof makeEvent>;
  // Lets a case break the request on purpose.
  tamper?: (body: string, timestamp: number) => { body: string; header: string };
};

const produced1 = makeEvent(1, "utxo.produced", { utxo: utxo(0, "4821000") });
const spent2 = makeEvent(2, "utxo.spent", { utxo: utxo(0, "4821000"), spent_by_tx_id: "c3f0".padEnd(64, "0") });
const produced4 = makeEvent(4, "utxo.produced", { utxo: utxo(1, "1000000") });
const rollback3 = makeEvent(3, "rollback", {
  reverted_event_id: spent2.id,
  reverted_seq: 2,
  reverted_type: "utxo.spent",
  reverted_block_height: block.height,
  reverted_block_hash: block.hash,
});

const cases: Case[] = [
  { name: "test event (console button)", expect: 200, event: makeEvent(null, "test", { message: "self test" }) },
  {
    name: "wrong secret is rejected",
    expect: 400,
    event: produced1,
    tamper: (body, t) => ({ body, header: sign(body, t, "whsec_wrong") }),
  },
  {
    name: "timestamp 10 minutes old is rejected",
    expect: 400,
    event: produced1,
    tamper: (body, t) => ({ body, header: sign(body, t - 600) }),
  },
  {
    name: "body edited after signing is rejected",
    expect: 400,
    event: produced1,
    tamper: (body, t) => ({ body: body.replace("4821000", "9999999"), header: sign(body, t) }),
  },
  { name: "seq 1 utxo.produced", expect: 200, event: produced1 },
  { name: "seq 1 again (duplicate, still 2xx)", expect: 200, event: produced1 },
  { name: "seq 2 utxo.spent", expect: 200, event: spent2 },
  { name: "seq 4 utxo.produced (gap: 3 missing)", expect: 200, event: produced4 },
  { name: "seq 3 rollback (fills the gap)", expect: 200, event: rollback3 },
];

async function main(): Promise<void> {
  console.log(`target:       ${url}`);
  console.log(`subscription: ${subscriptionId}\n`);

  let failed = 0;
  for (const c of cases) {
    const body = JSON.stringify(c.event);
    const timestamp = Math.floor(Date.now() / 1000);
    const request = c.tamper ? c.tamper(body, timestamp) : { body, header: sign(body, timestamp) };

    let status: number | string;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "liqbeacon-webhook-selftest/1.0",
          "X-Cardano-Event-Id": c.event.id,
          "X-Cardano-Event-Type": c.event.type,
          "X-Cardano-Event-Seq": String(c.event.seq ?? ""),
          "X-Cardano-Subscription": subscriptionId,
          "X-Cardano-Signature": request.header,
          "Idempotency-Key": c.event.id,
        },
        body: request.body,
        signal: AbortSignal.timeout(15_000),
      });
      status = response.status;
    } catch (error) {
      status = (error as Error).message;
    }

    const ok = status === c.expect;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(42)} expected ${c.expect}, got ${status}`);
  }

  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  console.log("The receiver's log should show 'missed seq 3' for the gap case; GET /status lists it too.");
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
