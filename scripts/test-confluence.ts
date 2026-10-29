// Checks for trend detection, fib levels and touches, and (with DATABASE_URL) a full run of the periodic check
// against fake Bitget candles and a fake Telegram.
import assert from "node:assert/strict";
import { legFibs } from "../lib/autofib";
import { fibLevels, firstTouch } from "../lib/fibs";
import { swingStructure } from "../lib/structure";
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

// ── swing structure (LuxAlgo SMC rules, swing length 4 here) ──

const st = swingStructure(path([120, 100, 115, 90, 105, 85, 100, 125, 110, 130], 8, H), 4);
assert.deepEqual(st.highs.map((p) => +p.price.toFixed(2)), [115.01, 105.01, 125.01]);
assert.deepEqual(st.lows.map((p) => +p.price.toFixed(2)), [99.99, 89.99, 84.99, 109.99]);
assert.deepEqual(st.breaks.map((b) => `${b.kind} ${b.direction} ${b.level.price.toFixed(2)}`),
  ["BOS bear 99.99", "BOS bear 89.99", "CHoCH bull 105.01", "BOS bull 125.01"]);
assert.equal(st.trend, "bull");

// ── auto fibs: one per leg between swing CHoCHs ──
const legs = path([100, 80, 95, 70, 90, 120, 100, 130, 105, 115, 95, 108], 8, H);
const fibsNow = legFibs(legs, swingStructure(legs, 4));
assert.deepEqual(fibsNow.map((f) => `${f.direction} ${f.low.toFixed(2)}-${f.high.toFixed(2)} ${f.forming ? "forming" : "done"}`),
  ["bull 69.99-130.01 done", "bear 94.99-130.01 forming"]);
assert.equal(fibsNow[0].anchorT, legs.find((c) => c.l === fibsNow[0].low)!.t);
// A close below the up leg's start breaks its green fib
const broken = path([100, 80, 95, 70, 90, 120, 100, 130, 105, 115, 95, 108, 65], 8, H);
assert.deepEqual(legFibs(broken, swingStructure(broken, 4)).map((f) => f.direction), ["bear"]);

// Your examples: 1H/2H/4H are linear with 0.5/0.618/0.786; 1D/1W are log scale and add 0.382
// (the 1D/1W anchors are read off the chart, so those levels are checked to within 0.05%)
const near = (f: Parameters<typeof fibLevels>[0], want: number[]) => {
  const got = fibLevels(f).map((l) => l.price).slice(-want.length);
  assert.ok(got.every((p, i) => Math.abs(p / want[i] - 1) < 5e-4), `${got} vs ${want}`);
};
near({ tf: "1h", direction: "bull", high: 103.818, low: 98.552 }, [101.185, 100.563, 99.679]);
near({ tf: "2h", direction: "bear", high: 109.157, low: 98.552 }, [103.855, 105.106, 106.888]);
near({ tf: "4h", direction: "bear", high: 124.93, low: 98.554 }, [111.743, 114.855, 119.287]);
near({ tf: "1D", direction: "bear", high: 295.7, low: 60.03 }, [133.229, 160.803, 210.188]);
near({ tf: "1D", direction: "bull", high: 124.95, low: 60.03 }, [86.607, 79.433, 70.232]);
near({ tf: "1W", direction: "bull", high: 295.6, low: 7.86 }, [48.22, 31.431, 17.09]);
assert.equal(fibLevels({ tf: "1D", direction: "bull", high: 124.95, low: 60.03 })[0].ratio, 0.382);

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
  let legPoints: number[] | null = null; // swing legs long enough for swing length 50, for the auto fibs
  let legsEarly = 0; // legs the data stops short of now, so adding a leg later keeps the earlier candles' times
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
      const step = { "15m": M15, "1H": H, "2H": 2 * H, "4H": 4 * H, "1Dutc": 24 * H, "1Wutc": 168 * H }[g]!;
      const candles = g === "15m" && url.searchParams.has("startTime") ? priceDrop
        : legPoints && url.searchParams.get("limit") === "1000" ? path(legPoints, 60, step, now - legsEarly * 60 * step) : path(trendPoints, 8, step, now);
      return Response.json({ code: "00000", data: candles.map((c) => [String(c.t), String(c.o), String(c.h), String(c.l), String(c.c), "1", "1"]) });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  await sql().unsafe("DROP TABLE IF EXISTS fib_runs, fib_hits, fibs, trends, settings, alerts, ticks, sightings, signals, uploads, corrections");
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
  assert.equal(sum.fibsRedrawn, 5); // too few candles for swing length 50, so no auto fibs, but each timeframe ran
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
  assert.equal(sum.fibsRedrawn, 0); // no new candle has closed since
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

  // ── auto fibs ──
  legPoints = [100, 80, 95, 70, 90, 120, 100, 130, 105, 115, 95, 108];
  legsEarly = 1;
  await s`DELETE FROM fib_runs`;
  sum = await tick(s);
  assert.equal(sum.fibsRedrawn, 5);
  let auto = await s`SELECT tf, direction, low, high, forming, active FROM fibs WHERE source = 'auto' ORDER BY tf, direction`;
  assert.equal(auto.length, 10);
  assert.ok(auto.every((f) => f.active && (f.direction === "bull" ? !f.forming && f.low < 70 : f.forming && f.low < 95)));
  // Redrawn after a close below the up leg's start: the green fibs end, the red ones stay
  legPoints = [...legPoints, 65];
  legsEarly = 0;
  await s`DELETE FROM fib_runs`;
  await tick(s);
  auto = await s`SELECT direction, active, ended_at FROM fibs WHERE source = 'auto'`;
  assert.equal(auto.length, 10);
  assert.ok(auto.every((f) => (f.direction === "bull") === !f.active && (f.direction === "bull") === !!f.ended_at));

  // ── capture health ──
  const { captureReport, checkStale } = await import("../lib/health");
  sent.length = 0;
  for (const n of [239, 240, 239]) assert.deepEqual(await captureReport(s, { charts: [{ name: "divergence", ok: true, signals: n }] }), []);
  assert.equal(sent.length, 0);
  const t0 = new Date("2026-01-01T10:33:00Z");
  let problems = await captureReport(s, {
    charts: [{ name: "divergence", ok: true, signals: 119 }, { name: "smc", ok: false, signals: 0, error: "No Confluence Radar entries" }],
  }, t0);
  assert.equal(problems.length, 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Capture missed something[\s\S]*divergence<\/b> read only 119 signals \(usually 239\)[\s\S]*smc<\/b> failed: No Confluence/);
  // The short read didn't lower the usual count, and the same hour isn't sent twice
  problems = await captureReport(s, { charts: [{ name: "divergence", ok: true, signals: 120 }] }, t0);
  assert.equal(problems.length, 1);
  assert.equal(sent.length, 1);

  // No upload for 2 hours: one warning per gap
  sent.length = 0;
  await s`INSERT INTO uploads (source, captured_at, created_at, tz_offset_min, raw) VALUES ('structure', now(), now() - interval '2 hours', 0, '{}')`;
  assert.equal(await checkStale(s), 1);
  assert.match(sent[0], /No BOS\/CHoCH signals for 2h 0m/);
  assert.equal(await checkStale(s), 0);
  await s`INSERT INTO uploads (source, captured_at, tz_offset_min, raw) VALUES ('structure', now(), 0, '{}')`;
  assert.equal(await checkStale(s), 0);

  globalThis.fetch = realFetch;
  await sql().end();
  console.log("confluence full check passed");
}

e2e().catch((e) => {
  console.error(e);
  process.exit(1);
});
