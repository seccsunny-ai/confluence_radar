// What goes to Telegram: new Gold and BOS/CHoCH signals (once each) and every fib level price reaches, checked on each
// run, sent as one message with a block per symbol. Each block also repeats the symbol's latest Gold and BOS/CHoCH
// signal on every timeframe and its latest fib hit, so the earlier picture stays visible until something replaces it.
import type postgres from "postgres";
import { fibLevels, type Fib } from "./fibs";
import { recentCandles, TF_MS } from "./market";
import { GOLD_WINDOW_DAYS, SIGNAL_BY_CODE, SIGNALS } from "./signals";
import { esc, sendTelegram, telegramReady, type AlertSettings } from "./telegram";
import { fmtPrice, type Candle } from "./trend";

const NEW_WINDOW = "2 hours"; // a Gold signal or fib hit older than this when first seen isn't sent (no backlog floods)
const TF_ORDER = ["5m", "15m", "30m", "1h", "2h", "4h", "1D", "1W"];
const tfSort = (a: string, b: string) => (TF_ORDER.indexOf(a) + 1 || 99) - (TF_ORDER.indexOf(b) + 1 || 99);
const tfLabel = (tf: string) => tf.replace(/h$/, "H");
export const shortSymbol = (s: string) => s.replace(/USDT\.P$/, "");

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

/** Gold signals still inside their window (15m 2 days, 1H 7, 4H 14, 1D 21), by symbol and direction. */
async function liveGold(sql: postgres.Sql): Promise<Set<string>> {
  const windowCase = sql.unsafe(
    "CASE tf " + Object.entries(GOLD_WINDOW_DAYS).map(([tf, d]) => `WHEN '${tf}' THEN interval '${d} days'`).join(" ") + " END",
  );
  const rows = await sql`
    SELECT DISTINCT symbol, direction FROM signals
    WHERE family = 'gold' AND tf IN ${sql(Object.keys(GOLD_WINDOW_DAYS))} AND signal_time + ${windowCase} > now()`;
  return new Set(rows.map((r) => `${r.symbol}|${r.direction}`));
}

/**
 * Records every fib level a 15m candle has reached since the last run, once per level. Only candles after the fib's
 * far end count (an auto fib's levels exist from the candle after its swing high or low). Returns how many are new.
 */
export async function findLevelHits(sql: postgres.Sql, tolerancePct: number, errors: string[]): Promise<number> {
  const fibs = (await sql`SELECT * FROM fibs WHERE active`) as unknown as Array<Fib & {
    high_t: Date | null; low_t: Date | null; created_at: Date;
  }>;
  const last = (await sql`SELECT value FROM settings WHERE key = 'level_hits_checked'`)[0]?.value as number | undefined;
  // Overlap one candle with the last run. The very first run only records what's already been hit, without alerts.
  const from = Math.max(last ?? 0, Date.now() - 2 * 3600_000) - 15 * 60_000;
  const started = Date.now();
  const gold = await liveGold(sql);
  const bySymbol = new Map<string, typeof fibs>();
  for (const f of fibs) bySymbol.set(f.symbol, [...(bySymbol.get(f.symbol) ?? []), f]);
  let found = 0;

  await pool([...bySymbol.entries()], 4, async ([symbol, list]) => {
    let candles: Candle[];
    try {
      candles = (await recentCandles(symbol, "15m", 12)).filter((c) => c.t >= from); // includes the candle still forming
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return;
    }
    for (const f of list) {
      const drawnAt = f.high_t && f.low_t
        ? Math.max(new Date(f.high_t).getTime(), new Date(f.low_t).getTime()) + (TF_MS[f.tf] ?? 0)
        : new Date(f.created_at).getTime();
      for (const lv of fibLevels(f)) {
        const tol = (lv.price * tolerancePct) / 100;
        const c = candles.find((k) => k.t >= drawnAt && k.l <= lv.price + tol && k.h >= lv.price - tol);
        if (!c) continue;
        const [row] = await sql`
          INSERT INTO level_hits (fib_id, symbol, tf, direction, ratio, level, hit_at, confluence, sent)
          VALUES (${f.id}, ${symbol}, ${f.tf}, ${f.direction}, ${lv.ratio}, ${Number(lv.price.toPrecision(10))},
            ${new Date(c.t)}, ${gold.has(`${symbol}|${f.direction}`)}, ${last == null})
          ON CONFLICT (fib_id, ratio, level) DO NOTHING RETURNING id`;
        if (row) found++;
      }
    }
  });
  await sql`
    INSERT INTO settings (key, value) VALUES ('level_hits_checked', ${sql.json(started)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  return found;
}

interface Hit { id: number; symbol: string; tf: string; direction: string; ratio: number; level: number; hit_at: Date }

/** The Telegram digest. Returns how many messages were sent. */
export async function sendDigest(sql: postgres.Sql, settings: AlertSettings, errors: string[]): Promise<number> {
  const newGold = settings.goldNew ? await sql`
    SELECT s.* FROM signals s
    WHERE s.family = 'gold' AND s.first_seen_at > now() - ${NEW_WINDOW}::interval
      AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.key = 'g2:' || s.id)` : [];
  const newStructure = settings.structureNew ? await sql`
    SELECT s.* FROM signals s
    WHERE s.source = 'structure' AND s.first_seen_at > now() - ${NEW_WINDOW}::interval
      AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.key = 's2:' || s.id)` : [];
  const newHits = settings.fibHit ? (await sql`
    SELECT h.* FROM level_hits h JOIN fibs f ON f.id = h.fib_id AND f.active
    WHERE NOT h.sent AND h.detected_at > now() - ${NEW_WINDOW}::interval
    ORDER BY h.hit_at`) as unknown as Hit[] : [];
  // Anything older, or with its alert switched off, is never sent.
  await sql`UPDATE level_hits SET sent = true WHERE NOT sent AND (detected_at <= now() - ${NEW_WINDOW}::interval OR ${!settings.fibHit})`;
  if (!newGold.length && !newStructure.length && !newHits.length) return 0;
  if (!telegramReady()) return 0;

  const symbols = [...new Set([
    ...newGold.map((g) => g.symbol as string), ...newStructure.map((g) => g.symbol as string), ...newHits.map((h) => h.symbol),
  ])].sort();
  const gold = await liveGold(sql);
  const newGoldIds = new Set([...newGold, ...newStructure].map((g) => g.id as number));
  const newHitIds = new Set(newHits.map((h) => h.id));
  const blocks: string[] = [];

  for (const symbol of symbols) {
    const lines = [`<b>${esc(shortSymbol(symbol))}</b>`];
    // Latest Gold signal on each timeframe
    const latest = await sql`
      SELECT DISTINCT ON (tf) * FROM signals WHERE symbol = ${symbol} AND family = 'gold' ORDER BY tf, signal_time DESC`;
    for (const code of ["GOLD_BUY", "GOLD_SELL"]) {
      const tfs = latest.filter((g) => g.code === code).sort((a, b) => tfSort(a.tf, b.tf))
        .map((g) => `${tfLabel(g.tf)}${newGoldIds.has(g.id) ? " 🆕" : ""}`);
      if (tfs.length) lines.push(`${code === "GOLD_BUY" ? "🔥" : "❄️"} ${SIGNAL_BY_CODE[code].name} - ${tfs.join(", ")}`);
    }
    // Latest BOS/CHoCH on each timeframe (shown once the BOS/CHoCH alert is on)
    if (settings.structureNew) {
      const structure = await sql`
        SELECT DISTINCT ON (tf) * FROM signals WHERE symbol = ${symbol} AND source = 'structure' ORDER BY tf, signal_time DESC`;
      for (const def of SIGNALS.filter((d) => d.source === "structure")) {
        const tfs = structure.filter((g) => g.code === def.code).sort((a, b) => tfSort(a.tf, b.tf))
          .map((g) => `${tfLabel(g.tf)}${newGoldIds.has(g.id) ? " 🆕" : ""}`);
        if (tfs.length) lines.push(`${def.direction === "bull" ? "📈" : "📉"} ${def.name} - ${tfs.join(", ")}`);
      }
    }
    // The new fib hits, and the latest earlier hit on each other timeframe
    const shown = newHits.filter((h) => h.symbol === symbol);
    const earlier = (await sql`
      SELECT DISTINCT ON (h.tf) h.* FROM level_hits h JOIN fibs f ON f.id = h.fib_id AND f.active
      WHERE h.symbol = ${symbol} AND h.sent ORDER BY h.tf, h.hit_at DESC`) as unknown as Hit[];
    for (const h of earlier) if (!shown.some((s) => s.tf === h.tf)) shown.push(h);
    shown.sort((a, b) => tfSort(a.tf, b.tf) || a.ratio - b.ratio);
    for (const h of shown) {
      const confluence = gold.has(`${symbol}|${h.direction}`);
      const dot = confluence ? "🟡" : h.direction === "bull" ? "🟢" : "🔴";
      lines.push(`${dot} Fib - ${tfLabel(h.tf)} ${h.ratio} fib hit · ${fmtPrice(h.level)}${newHitIds.has(h.id) ? " 🆕" : ""}` +
        (confluence ? ` (Gold ${h.direction === "bull" ? "Buy" : "Sell"} confluence)` : ""));
    }
    blocks.push(lines.join("\n"));
  }

  // Telegram allows 4096 characters per message
  const messages: string[] = [];
  for (const b of blocks) {
    if (messages.length && messages[messages.length - 1].length + b.length + 2 < 3800) messages[messages.length - 1] += `\n\n${b}`;
    else messages.push(b);
  }
  let sent = 0;
  try {
    for (const m of messages) {
      await sendTelegram(sql, m);
      await sql`INSERT INTO alerts (key, text) VALUES (${`digest:${Date.now()}:${sent}`}, ${m}) ON CONFLICT DO NOTHING`;
      sent++;
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    if (!sent) return 0; // nothing went out: try again next run
  }
  for (const g of newGold) await sql`INSERT INTO alerts (key, text) VALUES (${"g2:" + g.id}, '') ON CONFLICT DO NOTHING`;
  for (const g of newStructure) await sql`INSERT INTO alerts (key, text) VALUES (${"s2:" + g.id}, '') ON CONFLICT DO NOTHING`;
  if (newHits.length) await sql`UPDATE level_hits SET sent = true WHERE id IN ${sql(newHits.map((h) => h.id))}`;
  return sent;
}
