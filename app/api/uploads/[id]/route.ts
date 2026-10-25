import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deleteUpload } from "@/lib/ingest";
import { fail } from "@/lib/http";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id)) return fail("Bad upload id.", 400);
    await deleteUpload(await db(), id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
