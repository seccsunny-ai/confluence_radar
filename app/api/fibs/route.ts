import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { FibInput } from "@/lib/fibs";
import { listFibs } from "@/lib/queries";
import { normalizeSymbol } from "@/lib/signals";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await listFibs(await db()));
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const parsed = FibInput.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join(" "), 400);
    const f = parsed.data;
    const sql = await db();
    const [row] = await sql`
      INSERT INTO fibs (symbol, tf, direction, high, low, note)
      VALUES (${normalizeSymbol(f.symbol)}, ${f.tf}, ${f.direction}, ${f.high}, ${f.low}, ${f.note || null})
      RETURNING *`;
    return NextResponse.json(row);
  } catch (e) {
    return fail(e);
  }
}
