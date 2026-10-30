// Alerts the user sets by hand: a price level on any symbol (one of its drawn fib levels, or a price typed in), with
// an optional note. Each fires once, when a 1-minute candle after the alert was set reaches the level, and goes to
// Telegram as its own message. The site's alarm picks it up from the triggered rows.
import type postgres from "postgres";
import { z } from "zod";
import { candlesSince } from "./market";
import { esc, sendTelegram, telegramReady, type AlertSettings } from "./telegram";
import { fmtPrice, type Candle } from "./trend";

const MINUTE = 60_000;
const SEND_WINDOW = "2 hours"; // an alert found triggered later than this (the check was down) isn't sent any more
const LOOKBACK_MS = 48 * 3600_000; // 1-minute candles fetched at most this far back
const ALERT_TZ = process.env.ALERT_TZ || "Asia/Kolkata";

export interface PriceAlert {
  id: number;
  symbol: string;
  level: number;
  direction: "up" | "down" | null; // price has to rise (up) or fall (down) to the level; null until a price is known
  fib_id: number | null;
  fib_label: string | null; // "4H green fib 0.618" when the level came from a fib
  note: string | null;
  created_at: Date;
  checked_to: number | null; // open time of the last 1-minute candle checked
  triggered_at: Date | null;
  detected_at: Date | null;
  sent: boolean;
}

export const PriceAlertInput = z.object({
  symbol: z.string().trim().min(1).max(40),
  level: z.coerce.number().positive().optional(),
  fibId: z.coerce.number().int().positive().optional(),
  ratio: z.coerce.number().positive().optional(),
  note: z.string().trim().max(300).optional().nullable(),
}).refine((a) => a.level != null || (a.fibId != null && a.ratio != null), "Pick a fib level or type a price.");

/** Which way price has to move to reach the level from `price`. */
export const directionTo = (level: number, price: number | null | undefined): "up" | "down" | null =>
  price == null || !Number.isFinite(price) ? null : level >= price ? "up" : "down";

/** The first candle that opened after the alert was set and reached its level. */
export function firstReach(a: Pick<PriceAlert, "level" | "direction" | "created_at">, candles: Candle[]): Candle | null {
  const from = new Date(a.created_at).getTime();
  const after = candles.filter((c) => c.t >= from);
  const dir = a.direction ?? (after.length ? directionTo(a.level, after[0].o) : null);
  if (!dir) return null;
  return after.find((c) => (dir === "up" ? c.h >= a.level : c.l <= a.level)) ?? null;
}

type GetCandles = (symbol: string, from: number) => Promise<Candle[]>;
const oneMinute: GetCandles = (symbol, from) => candlesSince(symbol, "1m", from, 3);

/** Checks every waiting alert against the 1-minute candles since it was set (or last checked). Returns how many fired. */
export async function checkPriceAlerts(sql: postgres.Sql, errors: string[], getCandles: GetCandles = oneMinute): Promise<number> {
  const waiting = (await sql`SELECT * FROM price_alerts WHERE triggered_at IS NULL`) as unknown as PriceAlert[];
  const bySymbol = new Map<string, PriceAlert[]>();
  for (const a of waiting) bySymbol.set(a.symbol, [...(bySymbol.get(a.symbol) ?? []), a]);
  let fired = 0;
  for (const [symbol, list] of bySymbol) {
    const from = Math.max(Date.now() - LOOKBACK_MS, Math.min(...list.map((a) =>
      Math.max(new Date(a.created_at).getTime(), (a.checked_to ?? 0) - MINUTE))));
    let candles: Candle[];
    try {
      candles = await getCandles(symbol, from);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    if (!candles.length) continue;
    const last = candles[candles.length - 1];
    for (const a of list) {
      const after = candles.filter((c) => c.t >= new Date(a.created_at).getTime());
      const direction = a.direction ?? (after.length ? directionTo(a.level, after[0].o) : null);
      const hit = firstReach({ ...a, direction }, candles);
      if (hit) {
        await sql`
          UPDATE price_alerts SET direction = ${direction}, triggered_at = ${new Date(hit.t)},
            detected_at = date_trunc('milliseconds', now()), trigger_price = ${last.c}, checked_to = ${last.t}
          WHERE id = ${a.id} AND triggered_at IS NULL`;
        fired++;
      } else {
        await sql`UPDATE price_alerts SET direction = ${direction}, checked_to = ${last.t} WHERE id = ${a.id}`;
      }
    }
  }
  return fired;
}

function when(t: Date | number | string): string {
  const s = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ALERT_TZ,
  }).format(new Date(t));
  return `${s} ${ALERT_TZ === "Asia/Kolkata" ? "IST" : ALERT_TZ}`;
}

export function alertText(a: PriceAlert & { trigger_price: number | null }): string {
  const lines = [
    `⏰ <b>${esc(a.symbol.replace(/USDT\.P$/, ""))}</b> alert: price ${a.direction === "down" ? "fell to" : a.direction === "up" ? "rose to" : "reached"} <b>${fmtPrice(a.level)}</b>`,
  ];
  if (a.fib_label) lines.push(esc(a.fib_label));
  if (a.note) lines.push(`📝 ${esc(a.note)}`);
  lines.push(`${a.triggered_at ? when(a.triggered_at) : ""}${a.trigger_price != null ? ` · price now ${fmtPrice(a.trigger_price)}` : ""}`);
  return lines.join("\n");
}

/** One Telegram message per triggered alert. Returns how many were sent. */
export async function sendPriceAlerts(sql: postgres.Sql, settings: AlertSettings, errors: string[]): Promise<number> {
  // Too old, or switched off: never sent
  await sql`UPDATE price_alerts SET sent = true WHERE NOT sent AND triggered_at IS NOT NULL
    AND (detected_at <= now() - ${SEND_WINDOW}::interval OR ${!settings.priceAlerts})`;
  const due = (await sql`
    SELECT * FROM price_alerts WHERE NOT sent AND triggered_at IS NOT NULL ORDER BY triggered_at`) as unknown as Array<
    PriceAlert & { trigger_price: number | null }>;
  if (!due.length || !telegramReady()) return 0;
  let sent = 0;
  for (const a of due) {
    const text = alertText(a);
    try {
      await sendTelegram(sql, text);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      break; // try the rest on the next run
    }
    await sql`UPDATE price_alerts SET sent = true WHERE id = ${a.id}`;
    await sql`INSERT INTO alerts (key, text) VALUES (${`pa:${a.id}:${new Date(a.triggered_at!).getTime()}`}, ${text}) ON CONFLICT DO NOTHING`;
    sent++;
  }
  return sent;
}
