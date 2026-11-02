import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bitgetSymbol, lastPrices } from "@/lib/market";
import { directionTo, PriceAlertInput, resolveAlert, type PriceAlert } from "@/lib/price-alerts";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";

/**
 * Body: {"rearm": true} to watch a triggered alert again from now, {"note": "..."} to change only its note, or the whole
 * alert as for POST to edit it. An edit that moves the symbol or level watches again from now.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id)) return fail("Bad alert id.", 400);
    const body = (await req.json()) as { rearm?: boolean; note?: string | null; symbol?: string };
    const sql = await db();
    const [a] = await sql`SELECT * FROM price_alerts WHERE id = ${id}`;
    if (!a) return fail("That alert no longer exists.", 404);
    if (body.symbol !== undefined) {
      const parsed = PriceAlertInput.safeParse(body);
      if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join(" "), 400);
      const e = await resolveAlert(sql, parsed.data, a as unknown as PriceAlert);
      const moved = e.symbol !== a.symbol || Math.abs(e.level - a.level) > 1e-12;
      await sql`UPDATE price_alerts SET note = ${e.note}, fib_id = ${e.fibId}, fib_label = ${e.label} WHERE id = ${id}`;
      if (moved) {
        await sql`
          UPDATE price_alerts SET symbol = ${e.symbol}, level = ${e.level}, direction = ${e.direction}, created_at = now(),
            checked_to = NULL, triggered_at = NULL, detected_at = NULL, trigger_price = NULL, sent = false
          WHERE id = ${id}`;
      }
    } else if (typeof body.note === "string" || body.note === null) {
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
