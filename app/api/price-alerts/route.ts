import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bitgetSymbol, lastPrices } from "@/lib/market";
import { PriceAlertInput, resolveAlert } from "@/lib/price-alerts";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";
// Bitget's API refuses some US addresses (see /api/tick)
export const preferredRegion = "sin1";

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
    const sql = await db();
    const a = await resolveAlert(sql, parsed.data);
    const [row] = await sql`
      INSERT INTO price_alerts (symbol, level, direction, fib_id, fib_label, note)
      VALUES (${a.symbol}, ${a.level}, ${a.direction}, ${a.fibId}, ${a.label}, ${a.note})
      RETURNING *`;
    return NextResponse.json({ ...row, price: a.price });
  } catch (e) {
    return fail(e, 400);
  }
}
