// Checks for trend detection, fib levels and touches, and (with DATABASE_URL) a full run of the periodic check
// against fake Bitget candles and a fake Telegram.
import assert from "node:assert/strict";
import { legFibs } from "../lib/autofib";
import { weeklyFromDaily } from "../lib/candle-store";
import { FibInput, fibLevels, firstTouch } from "../lib/fibs";
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

// ── auto fibs: a new leg at every swing BOS/CHoCH, gone once a close goes beyond either end ──
const legs = path([100, 80, 95, 70, 90, 120, 100, 130, 105, 115, 95, 108], 8, H);
const fibsNow = legFibs(legs, swingStructure(legs, 4));
assert.deepEqual(fibsNow.map((f) => `${f.direction} ${f.low.toFixed(2)}-${f.high.toFixed(2)} ${f.forming ? "forming" : "done"}`),
  ["bear 94.99-115.01 forming"]); // the up legs' fibs went when price closed below 100 (and 70 → 130 above 120's leg)
assert.equal(fibsNow[0].anchorT, fibsNow[0].highT); // a red fib starts at its high
// Your VIRTUAL 4H example: green 0.50 → 0.68, a close above 0.68 → green 0.514 → 0.837, a close above 0.837 →
// green 0.5746 → 0.886, a close below 0.5746 → red from 0.886 down to the new low
const virtual = path([0.50, 0.68, 0.514, 0.837, 0.5746, 0.886, 0.55, 0.60], 8, H);
const steps = (n: number) => legFibs(virtual.slice(0, n), swingStructure(virtual.slice(0, n), 4))
  .map((f) => `${f.direction} ${f.low.toFixed(3)}-${f.high.toFixed(3)}`);
assert.deepEqual(steps(21), ["bull 0.490-0.690", "bear 0.504-0.690"]); // before the first break: swing low → high
assert.deepEqual(steps(33), ["bull 0.504-0.847"]); // closed above 0.69: green from the low after it, 0.514
assert.deepEqual(steps(48), ["bull 0.565-0.896"]); // closed above 0.837: green from the 0.5746 retest low
assert.deepEqual(steps(virtual.length), ["bear 0.540-0.896"]);

// Weekly candles from daily ones: Monday to Sunday UTC, and the week still running is left out
const DAY = 24 * H;
const mon = Date.UTC(2026, 9, 5); // Monday 5 Oct 2026
const days = Array.from({ length: 17 }, (_, i) => ({ t: mon + i * DAY, o: 10 + i, h: 20 + i, l: 5 + i, c: 11 + i }));
const weeks = weeklyFromDaily(days, mon + 16.5 * DAY);
assert.deepEqual(weeks.map((w) => [new Date(w.t).toISOString().slice(0, 10), w.o, w.h, w.l, w.c]),
  [["2026-10-05", 10, 26, 5, 17], ["2026-10-12", 17, 33, 12, 24]]);

// Before any break (the weekly charts): the last swing low to high is the leg, and the move since is in progress
const noBreak = path([50, 10, 100, 60], 8, H);
assert.deepEqual(legFibs(noBreak, swingStructure(noBreak, 4)).map((f) => `${f.direction} ${f.low.toFixed(2)}-${f.high.toFixed(2)} ${f.forming ? "forming" : "done"}`),
  ["bull 9.99-100.01 done", "bear 59.99-100.01 forming"]);

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
// Fibs entered by hand: 15m, 1H, 4H and 1D
for (const tf of ["15m", "60", "4h", "1D"]) assert.ok(FibInput.safeParse({ symbol: "X", tf, direction: "bull", high: 2, low: 1 }).success, tf);
assert.equal(FibInput.safeParse({ symbol: "X", tf: "2h", direction: "bull", high: 2, low: 1 }).success, false);

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
  let legsEarly = 0;
  let recent15: Candle[] | null = null; // the latest 15m candles the fib-hit check sees // legs the data stops short of now, so adding a leg later keeps the earlier candles' times
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
        : recent15 && g === "15m" && url.searchParams.get("limit") === "12" ? recent15
        : legPoints && url.searchParams.get("limit") === "1000" ? path(legPoints, 60, step, now - legsEarly * 60 * step) : path(trendPoints, 8, step, now);
      return Response.json({ code: "00000", data: candles.map((c) => [String(c.t), String(c.o), String(c.h), String(c.l), String(c.c), "1", "1"]) });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  await sql().unsafe("DROP TABLE IF EXISTS level_hits, candles, candle_sets, fib_runs, fib_hits, fibs, trends, settings, alerts, ticks, sightings, signals, uploads, corrections");
  const s = await db();
  // The older one-message alerts (now off by default) are checked first; the digest has its own section below.
  const { setSetting, DEFAULT_SETTINGS } = await import("../lib/telegram");
  await setSetting(s, "alerts", { ...DEFAULT_SETTINGS, goldNew: false, fibHit: false, structureNew: false, goldStructure: true, fibTouch: true,
    fibStructure: true, trendChange: true, trendPotential: true, captureHealth: true });
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
  assert.equal(auto.length, 4); // 1H, 2H, 4H, 1D (1W is built from these daily candles: too few weeks here)
  assert.ok(auto.every((f) => f.active && f.direction === "bear" && f.forming && f.low < 95)); // only the latest leg is left
  // Redrawn after a close above the red fibs' high: they end, and the up move that broke them is the new leg
  legPoints = [...legPoints, 140];
  legsEarly = 0;
  await s`DELETE FROM fib_runs`;
  await tick(s);
  auto = await s`SELECT direction, active, ended_at FROM fibs WHERE source = 'auto' AND tf <> '1W'`;
  assert.equal(auto.filter((f) => f.direction === "bear").length, 4);
  assert.ok(auto.every((f) => (f.direction === "bear") === !f.active && (f.direction === "bear") === !!f.ended_at));
  assert.equal(auto.filter((f) => f.active).length, 4);

  // ── The Telegram digest: new Gold signals and every fib level hit, one block per symbol ──
  const { setSetting: set2, DEFAULT_SETTINGS: defaults } = await import("../lib/telegram");
  await set2(s, "alerts", { ...defaults, captureHealth: false }); // the digest only
  await s`DELETE FROM fibs`;
  await s`DELETE FROM alerts`;
  trendPoints = [95, 98]; // inside both fibs below: neither is broken
  await s`UPDATE settings SET value = ${s.json(Date.now() - 3 * 3600_000)} WHERE key = 'level_hits_checked'`; // as if the last run was long ago
  await s`INSERT INTO fibs (symbol, tf, direction, high, low, created_at) VALUES ('TESTUSDT.P', '4h', 'bull', 100, 80, now() - interval '1 day')`;
  await s`INSERT INTO fibs (symbol, tf, direction, high, low, created_at) VALUES ('TESTUSDT.P', '1h', 'bear', 120, 100, now() - interval '1 day')`;
  await s`
    INSERT INTO signals (symbol, source, tf, code, family, direction, signal_time, first_seen_at, last_seen_at)
    VALUES ('TESTUSDT.P', 'divergence', '1h', 'GOLD_BUY', 'gold', 'bull', now() - interval '1 hour', now(), now()),
      ('TESTUSDT.P', 'divergence', '4h', 'GOLD_SELL', 'gold', 'bear', now() - interval '20 days', now() - interval '20 days', now())`;
  recent15 = path([95, 89.5, 95], 4, M15, now); // dips to the green fib's 0.5 (90), nowhere near the red fib's levels
  sent.length = 0;
  sum = await tick(s);
  assert.equal(sum.levelHits, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], [
    "<b>TEST</b>",
    "🔥 Gold Buy - 15m 🆕, 1H 🆕",
    "❄️ Gold Sell - 4H",
    "🟡 Fib - 4H 0.5 fib hit · 90 🆕 (Gold Buy confluence)",
  ].join("\n"));
  // Nothing new: nothing sent. The same level again doesn't count twice.
  sent.length = 0;
  sum = await tick(s);
  assert.equal(sum.levelHits, 0);
  assert.equal(sent.length, 0);
  // A new hit (the red fib's 0.5 at 110, from below) repeats the Gold lines and the earlier hit. The 4H Gold Sell is
  // past its 14-day window, so this is no confluence, but it still shows as the latest 4H Gold.
  recent15 = path([105, 110.05], 4, M15, now + M15);
  sum = await tick(s);
  assert.equal(sum.levelHits, 1);
  assert.equal(sent[0], [
    "<b>TEST</b>",
    "🔥 Gold Buy - 15m, 1H",
    "❄️ Gold Sell - 4H",
    "🔴 Fib - 1H 0.5 fib hit · 110 🆕",
    "🟡 Fib - 4H 0.5 fib hit · 90 (Gold Buy confluence)",
  ].join("\n"));
  recent15 = null;
  // A fib entered by hand goes once a candle on its timeframe closes beyond its start after it was added
  trendPoints = [95, 70]; // closes below the green fib's 80 low, never above the red fib's 120 high
  sum = await tick(s);
  assert.equal(sum.manualFibsRemoved, 1);
  assert.deepEqual((await s`SELECT tf, direction FROM fibs WHERE source = 'manual'`).map((f) => `${f.tf} ${f.direction}`), ["1h bear"]);
  // ...but not for a close before it was added
  await s`INSERT INTO fibs (symbol, tf, direction, high, low) VALUES ('TESTUSDT.P', '15m', 'bull', 100, 80)`;
  sum = await tick(s);
  assert.equal(sum.manualFibsRemoved, 0);

  // Older daily candles are paged in a few at a time (Bitget serves 90 days per call) and kept
  const { storedCandles } = await import("../lib/candle-store");
  const D = 24 * H, today = Math.floor(now / D) * D;
  const series = Array.from({ length: 400 }, (_, i) => ({ t: today - (399 - i) * D, o: i, h: i + 1, l: i - 1, c: i }));
  const tickFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const end = url.pathname.endsWith("history-candles") ? +url.searchParams.get("endTime")! : now;
    const rows = series.filter((c) => c.t <= end).slice(-90);
    return Response.json({ code: "00000", data: rows.map((c) => [String(c.t), String(c.o), String(c.h), String(c.l), String(c.c), "1", "1"]) });
  }) as typeof fetch;
  await s`DELETE FROM candles`;
  await s`DELETE FROM candle_sets`;
  let st = await storedCandles(s, "TESTUSDT.P", "1D", 280, 2);
  assert.equal(st.complete, false);
  assert.equal(st.candles.length, 269); // 89 closed recent + 2 pages of 90
  st = await storedCandles(s, "TESTUSDT.P", "1D", 280, 2);
  assert.equal(st.complete, true);
  assert.equal(st.candles.length, 280);
  assert.ok(st.candles.every((c, i) => !i || c.t - st.candles[i - 1].t === D));
  assert.equal(st.candles.at(-1)!.t, today - D); // today's candle is still forming
  globalThis.fetch = tickFetch;

  // ── capture health ──
  const { captureReport, checkStale } = await import("../lib/health");
  await set2(s, "alerts", defaults); // capture warnings are on by default
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
