import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { GOLD_WINDOW_DAYS } from "@/lib/signals";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Fib levels price reached, newest first: ?days=3 (default), or ?after=<id> for only the ones newer than that id.
 * `confluence` = a Gold signal in the same direction on the symbol is still inside its window.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const after = Number(url.searchParams.get("after") ?? 0) || 0;
    const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 3) || 3, 1), 30);
    const sql = await db();
    const windowCase = sql.unsafe(
      "CASE g.tf " + Object.entries(GOLD_WINDOW_DAYS).map(([tf, d]) => `WHEN '${tf}' THEN interval '${d} days'`).join(" ") + " END",
    );
    const rows = await sql`
      SELECT h.id, h.symbol, h.tf, h.direction, h.ratio, h.level, h.hit_at, h.detected_at,
        f.high, f.low, f.source, f.forming, f.active, t.price,
        EXISTS (SELECT 1 FROM signals g WHERE g.symbol = h.symbol AND g.family = 'gold' AND g.direction = h.direction
          AND g.tf IN ${sql(Object.keys(GOLD_WINDOW_DAYS))} AND g.signal_time + ${windowCase} > now()) AS confluence
      FROM level_hits h JOIN fibs f ON f.id = h.fib_id
      LEFT JOIN trends t ON t.symbol = h.symbol AND t.tf = '15m'
      WHERE ${after ? sql`h.id > ${after}` : sql`h.hit_at > now() - make_interval(days => ${days})`}
      ORDER BY h.id DESC LIMIT 500`;
    return NextResponse.json(rows);
  } catch (e) {
    return fail(e);
  }
}
