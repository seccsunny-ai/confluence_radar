import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { alertSettings } from "@/lib/telegram";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Prime Oscillator: the latest value per symbol and timeframe, and its runs beyond ±level (the open ones, plus
 * those that ended within `days`, default 3).
 */
export async function GET(req: Request) {
  try {
    const sql = await db();
    const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days") ?? 3) || 3, 0), 30);
    const [settings, readings, signals] = await Promise.all([
      alertSettings(sql),
      sql`SELECT symbol, tf, candle_t, value, prev_value, updated_at FROM osc_readings ORDER BY symbol, tf`,
      sql`
        SELECT id, symbol, tf, side, level, started_t, last_t, last_value, peak, ended_t, detected_at FROM osc_signals
        WHERE ended_t IS NULL OR ended_t > now() - make_interval(days => ${days})
        ORDER BY started_t DESC`,
    ]);
    return NextResponse.json({ level: settings.oscLevel, readings, signals });
  } catch (e) {
    return fail(e);
  }
}
