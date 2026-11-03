// handlers.ts: what to do with each event. A test receiver has no ledger of
// its own, so it logs what a real one would book.
import { isProduced, isSpent, isRollback, type CardanoEvent } from "@liqbeacon/sdk";

// Event ids already applied. Delivery is at-least-once, so the same event can
// arrive twice. In production keep this in your database, written in the same
// transaction as the change the event caused.
const applied = new Set<string>();

export async function handleEvent(event: CardanoEvent): Promise<void> {
  if (applied.has(event.id)) return;

  const where = `seq=${event.seq} block=${event.block?.height ?? "-"} conf=${event.confirmations ?? "-"}`;

  if (event.rolled_back) {
    // The chain abandoned this block before delivery. Don't apply it: a
    // rollback event naming it follows.
    console.log(`[skip]     ${event.id} ${where}: its block was rolled back`);
  } else if (isProduced(event)) {
    // A new output at a watched address.
    const { tx_id, index, address, value } = event.data.utxo;
    console.log(`[produced] ${event.id} ${where}: +${formatAda(value.lovelace)} ADA to ${address} (${tx_id}#${index})`);
    for (const [policyId, assets] of Object.entries(value.assets)) {
      for (const [assetName, quantity] of Object.entries(assets)) {
        console.log(`             + ${quantity} x ${policyId}.${assetName}`);
      }
    }
  } else if (isSpent(event)) {
    // A watched output was consumed. The spent output is included in full,
    // so there is nothing to look up.
    const { tx_id, index, value } = event.data.utxo;
    console.log(
      `[spent]    ${event.id} ${where}: -${formatAda(value.lovelace)} ADA from ${tx_id}#${index}, ` +
        `spent by ${event.data.spent_by_tx_id}`
    );
  } else if (isRollback(event)) {
    // Undo the event named here. It may be one skipped above because it was
    // already flagged rolled_back, so the undo must be idempotent.
    const { reverted_event_id, reverted_seq, reverted_type, reverted_block_height } = event.data;
    console.log(
      `[rollback] ${event.id} ${where}: undo ${reverted_type} ${reverted_event_id} ` +
        `(seq ${reverted_seq}), block ${reverted_block_height} was abandoned`
    );
  } else {
    // A type this receiver does not know yet. Acknowledge it, or it would
    // block the subscription's queue forever.
    console.warn(`[unknown]  ${event.id} ${where}: type ${event.type}`);
  }

  applied.add(event.id);
}

// Amounts are decimal strings, because lovelace can exceed
// Number.MAX_SAFE_INTEGER. BigInt keeps them exact.
function formatAda(lovelace: string): string {
  const amount = BigInt(lovelace);
  return `${amount / 1_000_000n}.${String(amount % 1_000_000n).padStart(6, "0")}`;
}
