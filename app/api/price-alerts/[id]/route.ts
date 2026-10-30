import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bitgetSymbol, lastPrices } from "@/lib/market";
import { directionTo } from "@/lib/price-alerts";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";

/** Body: {"rearm": true} to watch a triggered alert again from now, and/or {"note": "..."} to change its note. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id)) return fail("Bad alert id.", 400);
    const body = (await req.json()) as { rearm?: boolean; note?: string | null };
    const sql = await db();
    const [a] = await sql`SELECT * FROM price_alerts WHERE id = ${id}`;
    if (!a) return fail("That alert no longer exists.", 404);
    if (typeof body.note === "string" || body.note === null) {
      await sql`UPDATE price_alerts SET note = ${body.note?.trim().slice(0, 300) || null} WHERE id = ${id}`;
    }
    if (body.rearm) {
      let now: number | null = null;
      try {
        now = (await lastPrices()).get(bitgetSymbol(a.symbol)) ?? null;
      } catch { /* the first check works it out */ }
      await sql`
        UPDATE price_alerts SET direction = ${directionTo(a.level, now)}, created_at = now(), checked_to = NULL,
          triggered_at = NULL, detected_at = NULL, trigger_price = NULL, sent = false
        WHERE id = ${id}`;
    }
    const [row] = await sql`SELECT * FROM price_alerts WHERE id = ${id}`;
    return NextResponse.json(row);
  } catch (e) {
    return fail(e, 400);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id)) return fail("Bad alert id.", 400);
    await (await db())`DELETE FROM price_alerts WHERE id = ${id}`;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
