import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storedCandles, weeklyFromDaily } from "@/lib/candle-store";
import { swingStructure } from "@/lib/structure";
import { legFibs } from "@/lib/autofib";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 60;
// Temporary: SOL weekly structure, to compare with the user's example fibs.
export async function GET() {
  const sql = await db();
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const got = await storedCandles(sql, "SOLUSDT.P", "1D", 2100, 0);
  const w = weeklyFromDaily(got.candles);
  const st = swingStructure(w);
  const runs = await sql`SELECT * FROM fib_runs WHERE symbol = 'SOLUSDT.P'`;
  const sets = await sql`SELECT * FROM candle_sets WHERE symbol = 'SOLUSDT.P'`;
  return NextResponse.json({
    days: got.candles.length, complete: got.complete, firstDay: got.candles[0] && iso(got.candles[0].t), weeks: w.length,
    highs: st.highs.map((p) => `${p.price} ${iso(p.t)}`), lows: st.lows.map((p) => `${p.price} ${iso(p.t)}`),
    breaks: st.breaks.map((b) => `${b.kind} ${b.direction} ${b.level.price} ${iso(b.t)}`),
    fibs: legFibs(w, st), runs, sets,
    weekly: w.map((c) => `${iso(c.t)} ${c.h} ${c.l} ${c.c}`).filter((_, i) => i % 4 === 0),
  });
}
