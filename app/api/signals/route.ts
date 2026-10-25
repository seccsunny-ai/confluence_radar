import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { listSignals } from "@/lib/queries";
import { fail, list, num } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    const rows = await listSignals(await db(), {
      symbol: q.get("symbol") || undefined,
      codes: list(q.get("codes")),
      tfs: list(q.get("tfs")),
      source: q.get("source") || undefined,
      direction: q.get("direction") || undefined,
      sinceHours: num(q.get("sinceHours")),
      limit: num(q.get("limit")),
    });
    return NextResponse.json(rows);
  } catch (e) {
    return fail(e);
  }
}
