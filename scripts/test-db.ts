// End-to-end check against a real Postgres: ingest the sample transcriptions and verify the Gold → BOS/CHoCH matches.
// Run with DATABASE_URL pointing at a throwaway database. The tables are dropped first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { db, sql } from "../lib/db";
import { deleteUpload, flatten, store } from "../lib/ingest";
import { goldMatches, listSignals, symbolBoard } from "../lib/queries";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL not set, skipping db tests");
    return;
  }
  await sql().unsafe("DROP TABLE IF EXISTS sightings, signals, uploads");
  const s = await db();
  const offsets = { divergence: 330, structure: 0 };
  const ingest = async (file: string) => {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const flat = flatten(raw, offsets, new Date());
    return store(s, flat, raw, file, offsets[flat.source]);
  };

  const a = await ingest("scripts/fixtures/divergence.json");
  assert.equal(a.newCount, 59);
  const b = await ingest("scripts/fixtures/structure.json");
  assert.equal(b.newCount, 15);
  // Same screenshot again: nothing new, flagged as a duplicate
  const again = await ingest("scripts/fixtures/structure.json");
  assert.equal(again.newCount, 0);
  assert.equal(again.duplicateUpload, true);
  await deleteUpload(s, again.uploadId);
  assert.equal((await s`SELECT count(*)::int AS n FROM signals`)[0].n, 74);

  const all = await goldMatches(s, {});
  const key = (r: { symbol: string; tf: string; code: string }) => `${r.symbol} ${r.tf} ${r.code}`;
  const byKey = Object.fromEntries(all.map((r) => [key(r), r]));
  const conf = (k: string) => (byKey[k].confirmations as Array<{ tf: string; code: string }>).map((c) => `${c.tf} ${c.code}`);

  assert.equal(byKey["PEPEUSDT.P 15m GOLD_BUY"].status, "confirmed");
  assert.deepEqual(conf("PEPEUSDT.P 15m GOLD_BUY"), ["15m INT_CHOCH_BULL"]);
  assert.deepEqual(conf("FETUSDT.P 15m GOLD_SELL"), ["4h INT_CHOCH_BEAR", "1h SW_BOS_BEAR"]); // 15m BOS came after the 2-day window
  assert.deepEqual(conf("FETUSDT.P 1D GOLD_SELL"), ["4h INT_CHOCH_BEAR", "1h SW_BOS_BEAR", "15m INT_BOS_BEAR"]);
  assert.deepEqual(conf("PEPEUSDT.P 1h GOLD_SELL"), ["1h INT_CHOCH_BEAR", "4h INT_CHOCH_BEAR"]);
  assert.equal(byKey["LDOUSDT.P 15m GOLD_BUY"].status, "watching");
  assert.equal(byKey["JUPUSDT.P 1h GOLD_BUY"].status, "watching");
  assert.equal(byKey["BTCUSDT.P 4h GOLD_SELL"].status, "expired");
  assert.equal(byKey["FETUSDT.P 4h GOLD_SELL"].status, "expired");

  const same = Object.fromEntries((await goldMatches(s, { sameTfOnly: true })).map((r) => [key(r), r]));
  assert.equal(same["FETUSDT.P 15m GOLD_SELL"].status, "expired");
  assert.equal(same["FETUSDT.P 1D GOLD_SELL"].status, "watching");
  assert.equal(same["PEPEUSDT.P 1h GOLD_SELL"].confirmations.length, 1);

  const confirmedBuys = await goldMatches(s, { direction: "bull", status: "confirmed" });
  assert.deepEqual(confirmedBuys.map(key), ["PEPEUSDT.P 15m GOLD_BUY"]);

  const recentGold = await listSignals(s, { codes: ["GOLD_BUY"], sinceHours: 24 });
  assert.deepEqual(recentGold.map((r) => `${r.symbol} ${r.tf}`).sort(), ["JUPUSDT.P 15m", "JUPUSDT.P 1h", "LDOUSDT.P 15m", "PEPEUSDT.P 15m"]);

  const board = await symbolBoard(s);
  assert.equal(new Set(board.map((r) => r.symbol)).size, 5);

  // A later screenshot that no longer lists BTC keeps BTC's history, and updates JUP with a newer signal
  const later = {
    screener: "structure",
    header_text: "x created with TradingView.com, Oct 25, 2026 17:00 UTC+5:30",
    tables: [{ timeframes: ["15m", "1h", "4h"], rows: [{ symbol: "JUPUSDT.P", cells: [["⚡ Int BOS↑", "25 Oct 11:15"], [], []] }] }],
  };
  const flat = flatten(later as never, offsets, new Date());
  await store(s, flat, later as never, "later", 0);
  const jup = (await goldMatches(s, { symbol: "JUP", status: "confirmed" })).map(key).sort();
  assert.deepEqual(jup, ["JUPUSDT.P 15m GOLD_BUY", "JUPUSDT.P 1h GOLD_BUY"]);
  assert.ok((await listSignals(s, { symbol: "BTCUSDT" })).length > 0);

  console.log("db tests passed");
  await sql().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
