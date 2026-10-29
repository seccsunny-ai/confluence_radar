// The periodic check: refreshes trends and the auto fibs from live candles, looks for Gold signals reaching a
// matching fib (and a BOS/CHoCH after that), and sends Telegram alerts for anything new.
import type postgres from "postgres";
import { AUTO_FIB_TFS, legFibs } from "./autofib";
import { storedCandles, weeklyFromDaily } from "./candle-store";
import { fibLevels, firstTouch, type Fib } from "./fibs";
import { candlesSince, recentCandles, TF_MS } from "./market";
import { GOLD_WINDOW_DAYS, SIGNAL_BY_CODE } from "./signals";
import { checkStale } from "./health";
import { alertSettings, esc, sendTelegram, telegramReady, type AlertSettings } from "./telegram";
import { analyzeTrend, fmtPrice, type Candle } from "./trend";

export const TREND_TFS = ["15m", "1h", "4h", "1D"];
const WEEKLY_DAYS = 2100; // daily candles kept per symbol: 300 weeks for the 1W structure
const TRACK_DAYS = 7; // symbols with a signal in this many days get trends
const ALERT_MAX_AGE_MS = 3 * 3600_000; // older events are recorded but not sent, so a first run doesn't flood the chat
const ALERT_TZ = process.env.ALERT_TZ || "Asia/Kolkata";

export interface TickSummary {
  symbols: number;
  trendsUpdated: number;
  fibsRedrawn: number; // symbol and timeframe pairs whose auto fibs were worked out again
  fibHits: number;
  structureAfterFib: number;
  alertsSent: number;
  errors: string[];
  ms: number;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

const tfLabel = (tf: string) => tf.replace(/h$/, "H");
const arrow = (t: string | null) => (t === "up" || t === "bull" ? "↑" : t === "down" || t === "bear" ? "↓" : "↔");

function when(t: Date | number | string): string {
  const s = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ALERT_TZ,
  }).format(new Date(t));
  return `${s} ${ALERT_TZ === "Asia/Kolkata" ? "IST" : ALERT_TZ}`;
}

const recent = (...times: Array<Date | number | string | null | undefined>) =>
  times.some((t) => t != null && Date.now() - new Date(t).getTime() < ALERT_MAX_AGE_MS);

export async function tick(sql: postgres.Sql): Promise<TickSummary> {
  const started = Date.now();
  const settings = await alertSettings(sql);
  const errors: string[] = [];
  let alertsSent = 0, trendsUpdated = 0, fibsRedrawn = 0, fibHits = 0, structureAfterFib = 0;

  const alert = async (enabled: boolean, key: string, html: string, isRecent: boolean) => {
    if (!enabled || !isRecent || !telegramReady()) return;
    const [row] = await sql`INSERT INTO alerts (key, text) VALUES (${key}, ${html}) ON CONFLICT DO NOTHING RETURNING key`;
    if (!row) return;
    try {
      await sendTelegram(sql, html);
      alertsSent++;
    } catch (e) {
      await sql`DELETE FROM alerts WHERE key = ${key}`; // try again on the next run
      errors.push(e instanceof Error ? e.message : String(e));
    }
  };

  // ── Trends ──
  const symbols = (await sql`
    SELECT symbol FROM signals WHERE signal_time > now() - make_interval(days => ${TRACK_DAYS})
    UNION SELECT symbol FROM fibs WHERE active AND source = 'manual'`).map((r) => r.symbol as string);
  const previous = new Map<string, postgres.Row>();
  for (const r of await sql`SELECT * FROM trends`) previous.set(`${r.symbol}|${r.tf}`, r);

  await pool(symbols.flatMap((s) => TREND_TFS.map((tf) => [s, tf] as const)), 4, async ([symbol, tf]) => {
    let candles: Candle[];
    try {
      candles = await recentCandles(symbol, tf, 300);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return;
    }
    if (candles.length < 20) return;
    const r = analyzeTrend(candles);
    await sql`
      INSERT INTO trends (symbol, tf, trend, potential, since, last_high, last_low, price, note, updated_at)
      VALUES (${symbol}, ${tf}, ${r.trend}, ${r.potential}, ${r.since ? new Date(r.since) : null},
        ${r.lastHigh ? sql.json({ ...r.lastHigh }) : null}, ${r.lastLow ? sql.json({ ...r.lastLow }) : null},
        ${r.price}, ${r.note || null}, now())
      ON CONFLICT (symbol, tf) DO UPDATE SET trend = EXCLUDED.trend, potential = EXCLUDED.potential,
        since = EXCLUDED.since, last_high = EXCLUDED.last_high, last_low = EXCLUDED.last_low,
        price = EXCLUDED.price, note = EXCLUDED.note, updated_at = now()`;
    trendsUpdated++;
    const prev = previous.get(`${symbol}|${tf}`);
    if (!prev || !settings.trendTfs.includes(tf)) return; // first sighting: nothing to compare with
    if (r.trend !== prev.trend && r.trend !== "range") {
      await alert(settings.trendChange, `trend:${symbol}:${tf}:${r.trend}:${r.since}`,
        `${arrow(r.trend)} <b>${esc(symbol)} ${tfLabel(tf)}</b> is now in an <b>${r.trend}trend</b> (was ${prev.trend}). Price ${fmtPrice(r.price)}`, true);
    }
    if (r.potential && r.potential !== prev.potential) {
      const swing = r.potential === "up" ? r.lastHigh : r.lastLow;
      await alert(settings.trendPotential, `potential:${symbol}:${tf}:${r.potential}:${swing?.t}`,
        `⚠️ <b>${esc(symbol)} ${tfLabel(tf)}</b> potential trend change ${arrow(r.potential)}: ${esc(r.note)}. Price ${fmtPrice(r.price)}`, true);
    }
  });

  const trendLine = async (symbol: string) => {
    const rows = await sql`SELECT tf, trend, potential FROM trends WHERE symbol = ${symbol}`;
    const by = new Map(rows.map((r) => [r.tf as string, r]));
    return TREND_TFS.map((tf) => {
      const r = by.get(tf);
      return `${tfLabel(tf)} ${r ? arrow(r.trend) + (r.potential ? `(→${arrow(r.potential)})` : "") : "?"}`;
    }).join(" · ");
  };

  // ── Fibs from each timeframe's swing structure, redone after each new candle close ──
  const lastRun = new Map<string, number>();
  for (const r of await sql`SELECT * FROM fib_runs`) lastRun.set(`${r.symbol}|${r.tf}`, new Date(r.last_closed).getTime());
  const due = symbols.flatMap((s) => AUTO_FIB_TFS.map((tf) => [s, tf] as const)).filter(([s, tf]) => {
    const last = lastRun.get(`${s}|${tf}`);
    return last == null || Date.now() >= last + 2 * TF_MS[tf]; // the candle after the last closed one has closed
  });
  const drawFibs = async ([symbol, tf]: readonly [string, string]) => {
    let candles: Candle[];
    try {
      if (tf === "1h" || tf === "2h") candles = (await recentCandles(symbol, tf, 1000)).slice(0, -1); // the last one is still forming
      else {
        // Bitget serves about 90 days per call, so these are built up over a few runs; 1W comes from the daily candles.
        const got = await storedCandles(sql, symbol, tf === "4h" ? "4h" : "1D", tf === "4h" ? 1000 : WEEKLY_DAYS, tf === "1W" ? 0 : 8);
        if (!got.complete) return; // older history still coming: draw once it's all there
        candles = tf === "1W" ? weeklyFromDaily(got.candles) : tf === "1D" ? got.candles.slice(-1000) : got.candles;
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!candles.length) return;
    const legs = legFibs(candles);
    const ids: number[] = [];
    for (const f of legs) {
      const [row] = await sql`
        INSERT INTO fibs (symbol, tf, direction, high, low, source, anchor_t, high_t, low_t, forming)
        VALUES (${symbol}, ${tf}, ${f.direction}, ${f.high}, ${f.low}, 'auto', ${new Date(f.anchorT)},
          ${new Date(f.highT)}, ${new Date(f.lowT)}, ${f.forming})
        ON CONFLICT (symbol, tf, direction, anchor_t) WHERE source = 'auto' DO UPDATE SET high = EXCLUDED.high,
          low = EXCLUDED.low, high_t = EXCLUDED.high_t, low_t = EXCLUDED.low_t, forming = EXCLUDED.forming,
          active = true, ended_at = NULL
        RETURNING id`;
      ids.push(row.id);
    }
    // Broken since (a leg that started before the candles we have can't be checked, so it stays)
    await sql`
      UPDATE fibs SET active = false, forming = false, ended_at = now()
      WHERE source = 'auto' AND symbol = ${symbol} AND tf = ${tf} AND active AND anchor_t >= ${new Date(candles[0].t)}
        ${ids.length ? sql`AND id NOT IN ${sql(ids)}` : sql``}`;
    await sql`
      INSERT INTO fib_runs (symbol, tf, last_closed) VALUES (${symbol}, ${tf}, ${new Date(candles[candles.length - 1].t)})
      ON CONFLICT (symbol, tf) DO UPDATE SET last_closed = EXCLUDED.last_closed`;
    fibsRedrawn++;
  };
  // 1W is built from the daily candles, so it goes after 1D has fetched them
  await pool(due.filter(([, tf]) => tf !== "1W"), 4, drawFibs);
  await pool(due.filter(([, tf]) => tf === "1W"), 4, drawFibs);

  // ── Gold signals reaching a matching fib ──
  const windowCase = sql.unsafe(
    "CASE g.tf " + Object.entries(GOLD_WINDOW_DAYS).map(([tf, d]) => `WHEN '${tf}' THEN interval '${d} days'`).join(" ") + " END",
  );
  const fibs = (await sql`SELECT * FROM fibs WHERE active`) as unknown as Array<Fib & { note: string | null }>;
  const fibName = (f: { tf: string; direction: string; source?: string; forming?: boolean; high: number; low: number }) =>
    `${tfLabel(f.tf)} ${f.direction === "bull" ? "🟢 green" : "🔴 red"} fib` +
    (f.source === "auto" ? ` (${f.direction === "bull" ? `${fmtPrice(f.low)} → ${fmtPrice(f.high)}` : `${fmtPrice(f.high)} → ${fmtPrice(f.low)}`}${f.forming ? ", leg still forming" : ""})` : "");
  const golds = await sql`
    SELECT g.*, g.signal_time + ${windowCase} AS window_end FROM signals g
    WHERE g.family = 'gold' AND g.tf IN ${sql(Object.keys(GOLD_WINDOW_DAYS))}
      AND g.signal_time + ${windowCase} > now() - interval '1 hour'
      AND g.symbol IN (SELECT symbol FROM fibs WHERE active)`;
  const done = new Set((await sql`SELECT gold_id, fib_id FROM fib_hits`).map((r) => `${r.gold_id}|${r.fib_id}`));
  const pending = golds.flatMap((g) => fibs
    .filter((f) => f.symbol === g.symbol && f.direction === g.direction && !done.has(`${g.id}|${f.id}`))
    .map((f) => ({ g, f })));
  const bySymbol = new Map<string, typeof pending>();
  for (const p of pending) bySymbol.set(p.g.symbol, [...(bySymbol.get(p.g.symbol) ?? []), p]);

  await pool([...bySymbol.entries()], 3, async ([symbol, pairs]) => {
    let candles: Candle[];
    try {
      const from = Math.min(...pairs.map((p) => new Date(p.g.signal_time).getTime()));
      candles = await candlesSince(symbol, "15m", from);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return;
    }
    for (const { g, f } of pairs) {
      const goldAt = new Date(g.signal_time).getTime();
      const touch = firstTouch(candles, fibLevels(f), goldAt, settings.fibTolerancePct);
      if (!touch || touch.t > new Date(g.window_end).getTime()) continue;
      const atSignal = touch.t < goldAt + (TF_MS[g.tf] ?? 0);
      await sql`
        INSERT INTO fib_hits (gold_id, fib_id, ratio, level, touched_at, at_signal)
        VALUES (${g.id}, ${f.id}, ${touch.ratio}, ${touch.level}, ${new Date(touch.t)}, ${atSignal})
        ON CONFLICT DO NOTHING`;
      fibHits++;
      const gold = SIGNAL_BY_CODE[g.code];
      await alert(settings.fibTouch, `fib:${g.id}:${f.id}`,
        `🎯 <b>${esc(symbol)}</b> ${tfLabel(g.tf)} <b>${gold.name}</b> (${when(g.signal_time)})\n` +
        `Price ${atSignal ? "was at" : "touched"} the ${fibName(f)} <b>${touch.ratio}</b> = ${fmtPrice(touch.level)} at ${when(touch.t)}` +
        `${f.note ? ` (${esc(f.note)})` : ""}\nTrend: ${await trendLine(symbol)}`,
        recent(touch.t, g.first_seen_at));
    }
  });

  // ── BOS/CHoCH after a fib touch: the stronger signal ──
  const open = await sql`
    SELECT h.*, g.symbol, g.tf AS gold_tf, g.code AS gold_code, g.direction, g.signal_time AS gold_time,
      g.signal_time + ${windowCase} AS window_end, f.tf AS fib_tf, f.direction AS fib_dir, f.source AS fib_source
    FROM fib_hits h JOIN signals g ON g.id = h.gold_id JOIN fibs f ON f.id = h.fib_id
    WHERE h.structure_id IS NULL AND g.signal_time + ${windowCase} > now() - interval '1 hour'`;
  for (const h of open) {
    const candidates = await sql`
      SELECT * FROM signals WHERE symbol = ${h.symbol} AND source = 'structure' AND direction = ${h.direction}
        AND signal_time > ${h.gold_time} AND signal_time <= ${h.window_end}
      ORDER BY signal_time`;
    // A structure signal is stamped with its bar's open time and confirms when that bar closes.
    const s = candidates.find((c) => new Date(c.signal_time).getTime() + (TF_MS[c.tf] ?? 0) > new Date(h.touched_at).getTime());
    if (!s) continue;
    await sql`UPDATE fib_hits SET structure_id = ${s.id} WHERE gold_id = ${h.gold_id} AND fib_id = ${h.fib_id}`;
    structureAfterFib++;
    await alert(settings.fibStructure, `fibs:${h.gold_id}:${h.fib_id}`,
      `💥 <b>Stronger: ${esc(h.symbol)}</b> ${tfLabel(h.gold_tf)} <b>${SIGNAL_BY_CODE[h.gold_code].name}</b> (${when(h.gold_time)})\n` +
      `→ ${tfLabel(h.fib_tf)} ${h.fib_dir === "bull" ? "🟢" : "🔴"} ${h.fib_source === "auto" ? "auto " : ""}fib ${h.ratio} touched ${when(h.touched_at)}\n` +
      `→ ${tfLabel(s.tf)} <b>${SIGNAL_BY_CODE[s.code].name}</b> ${when(s.signal_time)}\nTrend: ${await trendLine(h.symbol)}`,
      recent(s.first_seen_at));
  }

  // ── New Gold signals, and Gold followed by BOS/CHoCH ──
  if (telegramReady()) {
    if (settings.gold) {
      for (const g of await sql`SELECT * FROM signals WHERE family = 'gold' AND first_seen_at > now() - interval '3 hours'`) {
        await alert(true, `gold:${g.id}`,
          `${g.direction === "bull" ? "🔥" : "❄️"} <b>${esc(g.symbol)}</b> ${tfLabel(g.tf)} <b>${SIGNAL_BY_CODE[g.code].name}</b> ${when(g.signal_time)}\nTrend: ${await trendLine(g.symbol)}`,
          recent(g.first_seen_at));
      }
    }
    if (settings.goldStructure) {
      const pairs = await sql`
        SELECT g.id AS gold_id, g.symbol, g.tf AS gold_tf, g.code AS gold_code, g.signal_time AS gold_time,
          s.id AS s_id, s.tf AS s_tf, s.code AS s_code, s.signal_time AS s_time, s.first_seen_at AS s_seen
        FROM signals s JOIN signals g ON g.symbol = s.symbol AND g.family = 'gold' AND g.direction = s.direction
          AND g.tf IN ${sql(Object.keys(GOLD_WINDOW_DAYS))}
          AND s.signal_time > g.signal_time AND s.signal_time <= g.signal_time + ${windowCase}
        WHERE s.source = 'structure' AND s.first_seen_at > now() - interval '3 hours'`;
      for (const p of pairs) {
        await alert(true, `gs:${p.gold_id}:${p.s_id}`,
          `✅ <b>${esc(p.symbol)}</b> ${tfLabel(p.gold_tf)} <b>${SIGNAL_BY_CODE[p.gold_code].name}</b> (${when(p.gold_time)}) → ` +
          `${tfLabel(p.s_tf)} <b>${SIGNAL_BY_CODE[p.s_code].name}</b> ${when(p.s_time)}\nTrend: ${await trendLine(p.symbol)}`,
          recent(p.s_seen));
      }
    }
  }

  try {
    alertsSent += await checkStale(sql);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const summary: TickSummary = {
    symbols: symbols.length, trendsUpdated, fibsRedrawn, fibHits, structureAfterFib, alertsSent,
    errors: [...new Set(errors)].slice(0, 20), ms: Date.now() - started,
  };
  await sql`INSERT INTO ticks (summary) VALUES (${sql.json({ ...summary })})`;
  await sql`DELETE FROM ticks WHERE id < (SELECT max(id) - 200 FROM ticks)`;
  return summary;
}
