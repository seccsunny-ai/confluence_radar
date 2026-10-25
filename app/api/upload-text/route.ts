import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { store } from "@/lib/ingest";
import { parseOffset, type Source } from "@/lib/signals";
import { parseTextUpload } from "@/lib/textformat";
import { fail } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { text?: string; divergenceTz?: string; structureTz?: string };
    if (!body.text?.trim()) return fail("Paste some signal lines first.", 400);
    if (body.text.length > 500_000) return fail("That text is too long.", 400);
    const offsets: Record<Source, number> = {
      divergence: parseOffset(body.divergenceTz ?? "+05:30"),
      structure: parseOffset(body.structureTz ?? "+00:00"),
    };
    let groups;
    try {
      groups = parseTextUpload(body.text, offsets);
    } catch (e) {
      return fail(e, 400);
    }
    const sql = await db();
    const results = [];
    for (const flat of groups) {
      const offset = offsets[flat.source];
      const res = await store(sql, flat, { format: "text", text: body.text }, "pasted text", offset);
      results.push({
        uploadId: res.uploadId,
        source: flat.source,
        capturedAt: flat.capturedAt,
        signalCount: flat.signals.length,
        newCount: res.newCount,
        symbols: new Set(flat.signals.map((s) => s.symbol)).size,
        duplicateUpload: res.duplicateUpload,
        warnings: flat.warnings,
      });
    }
    return NextResponse.json(results);
  } catch (e) {
    return fail(e);
  }
}
