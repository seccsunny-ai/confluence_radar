import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fibLevels, type Fib } from "@/lib/fibs";
import { GOLD_WINDOW_DAYS } from "@/lib/signals";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Per symbol: its latest Gold signal on each timeframe (with whether it's still inside its window), and every
 * active fib with each level marked as already hit (when) or still waiting. Used by the Signals tab to order
 * symbols and show their fibs.
 */
export async function GET() {
  try {
    const sql = await db();
    const windowCase = sql.unsafe(
      "CASE tf " + Object.entries(GOLD_WINDOW_DAYS).map(([tf, d]) => `WHEN '${tf}' THEN interval '${d} days'`).join(" ") + " END",
    );
    const [gold, fibs, hits] = await Promise.all([
      sql`
        SELECT DISTINCT ON (symbol, tf) id, symbol, tf, code, direction, signal_time,
          signal_time + ${windowCase} > now() AS live
        FROM signals WHERE family = 'gold' AND tf IN ${sql(Object.keys(GOLD_WINDOW_DAYS))}
        ORDER BY symbol, tf, signal_time DESC`,
      sql`
        SELECT f.id, f.symbol, f.tf, f.direction, f.high, f.low, f.source, f.forming, f.note, t.price
        FROM fibs f LEFT JOIN trends t ON t.symbol = f.symbol AND t.tf = '15m'
        WHERE f.active
        ORDER BY f.symbol, array_position(ARRAY['5m','15m','1h','2h','4h','8h','1D','1W'], f.tf), f.anchor_t DESC NULLS FIRST, f.created_at DESC`,
      sql`SELECT h.fib_id, h.ratio, h.level, h.hit_at FROM level_hits h JOIN fibs f ON f.id = h.fib_id AND f.active`,
    ]);

    // A hit counts for a level only if it was at the level's current price (a forming fib's level can move).
    const hitAt = new Map<string, string>();
    for (const h of hits) hitAt.set(`${h.fib_id}|${h.ratio}|${Number(h.level)}`, new Date(h.hit_at).toISOString());

    const out = new Map<string, { symbol: string; gold: unknown[]; fibs: unknown[] }>();
    const entry = (symbol: string) => {
      let e = out.get(symbol);
      if (!e) out.set(symbol, (e = { symbol, gold: [], fibs: [] }));
      return e;
    };
    for (const g of gold) entry(g.symbol).gold.push(g);
    for (const f of fibs as unknown as Array<Fib & { note: string | null; price: number | null }>) {
      const levels = fibLevels(f).map((l) => ({
        ratio: l.ratio,
        price: l.price,
        hit_at: hitAt.get(`${f.id}|${l.ratio}|${Number(l.price.toPrecision(10))}`) ?? null,
      }));
      entry(f.symbol).fibs.push({ ...f, levels });
    }
    return NextResponse.json([...out.values()]);
  } catch (e) {
    return fail(e);
  }
}
