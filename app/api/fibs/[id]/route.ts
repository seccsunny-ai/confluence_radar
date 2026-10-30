import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { FibInput } from "@/lib/fibs";
import { normalizeSymbol } from "@/lib/signals";
import { fail } from "@/lib/http";

/** Body: {"active": false} to retire a fib, or the full fib to change its levels. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id)) return fail("Bad fib id.", 400);
    const body = (await req.json()) as Record<string, unknown>;
    const sql = await db();
    if (Object.keys(body).length === 1 && typeof body.active === "boolean") {
      const [row] = await sql`UPDATE fibs SET active = ${body.active} WHERE id = ${id} RETURNING *`;
      return row ? NextResponse.json(row) : fail("That fib no longer exists.", 404);
    }
    const parsed = FibInput.safeParse(body);
    if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join(" "), 400);
    const f = parsed.data;
    const [row] = await sql.begin(async (tx) => {
      // New levels: earlier touches no longer apply, and price is checked against them from now on.
      await tx`DELETE FROM fib_hits WHERE fib_id = ${id}`;
      return tx`
        UPDATE fibs SET symbol = ${normalizeSymbol(f.symbol)}, tf = ${f.tf}, direction = ${f.direction},
          high = ${f.high}, low = ${f.low}, note = ${f.note || null}, created_at = now()
        WHERE id = ${id} RETURNING *`;
    });
    return row ? NextResponse.json(row) : fail("That fib no longer exists.", 404);
  } catch (e) {
    return fail(e, 400);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id)) return fail("Bad fib id.", 400);
    const sql = await db();
    await sql`DELETE FROM fibs WHERE id = ${id}`;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
