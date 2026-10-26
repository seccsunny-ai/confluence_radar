import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { correctSignal } from "@/lib/ingest";
import { fail } from "@/lib/http";

/** Body: {"code": "GOLD_BUY"} to relabel a misread signal, or {"code": null} to remove it. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id)) return fail("Bad signal id.", 400);
    const { code } = (await req.json()) as { code?: string | null };
    if (code === undefined) return fail("Send the corrected code, or null to remove the signal.", 400);
    return NextResponse.json(await correctSignal(await db(), id, code));
  } catch (e) {
    return fail(e, 400);
  }
}
