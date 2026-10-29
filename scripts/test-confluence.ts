// Checks for trend detection, fib levels and touches, and (with DATABASE_URL) a full run of the periodic check
// against fake Bitget candles and a fake Telegram.
import assert from "node:assert/strict";
import { fibLevels, firstTouch } from "../lib/fibs";
import { analyzeTrend, type Candle } from "../lib/trend";

/** Straight-line legs between turning points, `leg` bars each, as candles one `step` apart ending at `end`. */
function path(points: number[], leg: number, step: number, end = Date.now()): Candle[] {
  const closes: number[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    for (let k = 1; k <= leg; k++) closes.push(points[i - 1] + ((points[i] - points[i - 1]) * k) / leg);
  }
  const last = Math.floor(end / step) * step;
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: last - (closes.length - 1 - i) * step, o, c, h: Math.max(o, c) + 0.01, l: Math.min(o, c) - 0.01 };
  });
}

const H = 3600_000;

// ── trends ──
const down = [100, 80, 95, 75, 90, 70, 87];
let r = analyzeTrend(path(down, 8, H));
assert.equal(r.trend, "down");
assert.equal(r.potential, null);
assert.equal(r.lastHigh?.kind, "LH");
assert.equal(r.lastLow?.kind, "LL");

// Price goes above the last lower high (90) before a new swing high confirms
r = analyzeTrend(path([...down.slice(0, -1), 93], 8, H));
assert.equal(r.trend, "down");
assert.equal(r.potential, "up");
assert.match(r.note, /above the last lower high 90/);

// A confirmed higher high: still a downtrend, potential change up
r = analyzeTrend(path([...down.slice(0, -1), 93, 88], 8, H));
assert.equal(r.trend, "down");
assert.equal(r.potential, "up");
assert.equal(r.lastHigh?.kind, "HH");

// Then a higher low confirms it: uptrend
r = analyzeTrend(path([...down.slice(0, -1), 93, 82, 97, 90], 8, H));
assert.equal(r.trend, "up");
assert.equal(r.potential, null);

// Mirror image: an uptrend with a lower low
const up = [70, 90, 75, 95, 80, 100, 85];
assert.equal(analyzeTrend(path(up, 8, H)).trend, "up");
r = analyzeTrend(path([...up.slice(0, -1), 78, 84], 8, H));
assert.equal(r.trend, "up");
assert.equal(r.potential, "down");

// ── fibs ──
const bull = fibLevels({ direction: "bull", high: 100, low: 80 });
assert.deepEqual(bull.map((l) => +l.price.toFixed(2)), [90, 87.64, 84.28]);
const bear = fibLevels({ direction: "bear", high: 100, low: 80 });
assert.deepEqual(bear.map((l) => +l.price.toFixed(2)), [90, 92.36, 95.72]);

const drop = path([100, 100, 85], 20, 15 * 60_000);
const goldAt = drop[10].t;
let t = firstTouch(drop, bull, goldAt, 0);
assert.ok(t);
assert.equal(t.ratio, 0.5);
assert.ok(t.t > goldAt);
assert.ok(drop.find((c) => c.t === t!.t)!.l <= 90);
// Not before the Gold signal, and not when price never gets there
assert.equal(firstTouch(path([100, 95], 10, 60_000), bull, 0, 0), null);
// Within the tolerance counts
assert.ok(firstTouch(path([100, 90.1], 10, 60_000), bull, 0, 0.15));

console.log("confluence unit checks passed");

// ── full check against Postgres ──
async function e2e() {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL not set, skipping the full check");
    return;
  }
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "42";
  const { db, sql } = await import("../lib/db");
  const { tick } = await import("../lib/radar");
  const { fibSignals } = await import("../lib/queries");

  const now = Date.now();
  const M15 = 15 * 60_000;
  const priceDrop = path([100, 100, 85], 20, M15, now); // 41 bars: flat, then falling through 90
  let trendPoints = down;
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "api.telegram.org") {
      sent.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true, result: {} });
    }
    if (url.hostname === "api.bitget.com") {
      assert.equal(url.searchParams.get("symbol"), "TESTUSDT");
      const g = url.searchParams.get("granularity")!;
      const step = { "15m": M15, "1H": H, "4H": 4 * H, "1Dutc": 24 * H }[g]!;
      const candles = g === "15m" && url.searchParams.has("startTime") ? priceDrop : path(trendPoints, 8, step, now);
      return Response.json({ code: "00000", data: candles.map((c) => [String(c.t), String(c.o), String(c.h), String(c.l), String(c.c), "1", "1"]) });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  await sql().unsafe("DROP TABLE IF EXISTS fib_hits, fibs, trends, settings, alerts, ticks, sightings, signals, uploads, corrections");
  const s = await db();
  const goldTime = new Date(priceDrop[15].t);
  const bosTime = new Date(priceDrop[36].t);
  const insert = (code: string, family: string, source: string, time: Date) => s`
    INSERT INTO signals (symbol, source, tf, code, family, direction, signal_time, first_seen_at, last_seen_at)
    VALUES ('TESTUSDT.P', ${source}, '15m', ${code}, ${family}, 'bull', ${time}, now(), now()) RETURNING id`;
  const [gold] = await insert("GOLD_BUY", "gold", "divergence", goldTime);
  await s`INSERT INTO fibs (symbol, tf, direction, high, low) VALUES ('TESTUSDT.P', '4h', 'bull', 100, 80)`;
  await s`INSERT INTO fibs (symbol, tf, direction, high, low) VALUES ('TESTUSDT.P', '1h', 'bear', 100, 80)`; // wrong direction for a Gold Buy

  let sum = await tick(s);
  assert.deepEqual(sum.errors, []);
  assert.equal(sum.trendsUpdated, 4);
  assert.equal(sum.fibHits, 1);
  assert.equal(sum.structureAfterFib, 0);
  let rows = await fibSignals(s, 14);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gold_id, gold.id);
  assert.equal(rows[0].status, "touched");
  assert.equal(rows[0].ratio, 0.5);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /🎯 <b>TESTUSDT\.P<\/b> 15m <b>Gold Buy<\/b>[\s\S]*green fib <b>0\.5<\/b> = 90/);
  assert.match(sent[0], /Trend: 15m ↓ · 1H ↓ · 4H ↓ · 1D ↓/);

  // A BOS after the touch makes it the stronger signal (and is also a plain Gold → BOS match)
  await insert("INT_BOS_BULL", "bos", "structure", bosTime);
  sent.length = 0;
  sum = await tick(s);
  assert.equal(sum.structureAfterFib, 1);
  rows = await fibSignals(s, 14);
  assert.equal(rows[0].status, "stronger");
  assert.equal(rows[0].structure_code, "INT_BOS_BULL");
  assert.equal(sent.length, 2);
  assert.ok(sent.some((m) => m.startsWith("💥 <b>Stronger: TESTUSDT.P</b>")));
  assert.ok(sent.some((m) => m.startsWith("✅ <b>TESTUSDT.P</b> 15m <b>Gold Buy</b>")));

  // Nothing new: nothing sent again. Then price breaks above the last lower high: potential change alerts.
  sent.length = 0;
  await tick(s);
  assert.equal(sent.length, 0);
  trendPoints = [...down.slice(0, -1), 93];
  await tick(s);
  assert.deepEqual(sent.map((m) => m.match(/TESTUSDT\.P (\w+)<\/b> potential trend change ↑/)?.[1]).sort(), ["1D", "1H", "4H"]);
  assert.equal(sent.length, 3); // 15m is off by default
  assert.equal((await s`SELECT count(*)::int AS n FROM ticks`)[0].n, 4);

  globalThis.fetch = realFetch;
  await sql().end();
  console.log("confluence full check passed");
}

e2e().catch((e) => {
  console.error(e);
  process.exit(1);
});
