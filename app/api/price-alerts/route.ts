import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fibLevels } from "@/lib/fibs";
import { bitgetSymbol, lastPrices } from "@/lib/market";
import { directionTo, PriceAlertInput } from "@/lib/price-alerts";
import { normalizeSymbol } from "@/lib/signals";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";
// Bitget's API refuses some US addresses (see /api/tick)
export const preferredRegion = "sin1";

const tfLabel = (tf: string) => tf.replace(/h$/, "H");

/** Live prices, or an empty map when Bitget can't be reached right now. */
async function prices(): Promise<Map<string, number> | null> {
  try {
    return await lastPrices();
  } catch {
    return null;
  }
}

/**
 * Without parameters: every alert (waiting ones, and those triggered in the last 30 days) with the live price, and the
 * symbols the site knows. ?after=<ISO time>: only the alerts triggered since then, for the alarm.
 */
export async function GET(req: Request) {
  try {
    const after = new URL(req.url).searchParams.get("after");
    const sql = await db();
    if (after != null) {
      const since = new Date(after);
      if (Number.isNaN(since.getTime())) return fail("Bad time.", 400);
      return NextResponse.json(await sql`
        SELECT * FROM price_alerts WHERE detected_at > ${since} ORDER BY detected_at DESC LIMIT 50`);
    }
    const [alerts, symbols, live] = await Promise.all([
      sql`
        SELECT a.*, t.price AS last_price FROM price_alerts a
        LEFT JOIN trends t ON t.symbol = a.symbol AND t.tf = '15m'
        WHERE a.triggered_at IS NULL OR a.triggered_at > now() - interval '30 days'
        ORDER BY a.triggered_at IS NOT NULL, a.triggered_at DESC, a.symbol, a.level`,
      sql`
        SELECT symbol FROM signals WHERE signal_time > now() - interval '30 days'
        UNION SELECT symbol FROM fibs WHERE active
        UNION SELECT symbol FROM price_alerts ORDER BY symbol`,
      prices(),
    ]);
    return NextResponse.json({
      alerts: alerts.map((a) => ({ ...a, price: live?.get(bitgetSymbol(a.symbol)) ?? a.last_price ?? null })),
      symbols: symbols.map((r) => r.symbol as string),
    });
  } catch (e) {
    return fail(e);
  }
}

/** Body: {symbol, level, note} for a price typed in, or {symbol, fibId, ratio, note} for one of a fib's levels. */
export async function POST(req: Request) {
  try {
    const parsed = PriceAlertInput.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join(" "), 400);
    const a = parsed.data;
    const symbol = normalizeSymbol(a.symbol);
    const sql = await db();
    let level = a.level ?? 0, fibId: number | null = null, label: string | null = null;
    if (a.fibId != null) {
      const [f] = await sql`SELECT * FROM fibs WHERE id = ${a.fibId}`;
      if (!f) return fail("That fib is gone (price closed beyond it). Pick another level.", 400);
      const lv = fibLevels(f as never).find((l) => Math.abs(l.ratio - a.ratio!) < 1e-9);
      if (!lv) return fail(`That fib has no ${a.ratio} level.`, 400);
      level = Number(lv.price.toPrecision(10));
      fibId = f.id;
      label = `${tfLabel(f.tf)} ${f.direction === "bull" ? "green" : "red"} fib ${lv.ratio}${f.source === "auto" ? "" : " (mine)"}`;
    }
    const live = await prices();
    if (live && live.size && !live.has(bitgetSymbol(symbol))) {
      return fail(`Bitget has no ${bitgetSymbol(symbol)} perpetual. Check the symbol, e.g. BTCUSDT.P.`, 400);
    }
    const [trend] = await sql`SELECT price FROM trends WHERE symbol = ${symbol} AND tf = '15m'`;
    const now = live?.get(bitgetSymbol(symbol)) ?? trend?.price ?? null;
    const [row] = await sql`
      INSERT INTO price_alerts (symbol, level, direction, fib_id, fib_label, note)
      VALUES (${symbol}, ${level}, ${directionTo(level, now)}, ${fibId}, ${label}, ${a.note || null})
      RETURNING *`;
    return NextResponse.json({ ...row, price: now });
  } catch (e) {
    return fail(e, 400);
  }
}
