import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { extractScreenshot } from "@/lib/extract";
import { flatten, store } from "@/lib/ingest";
import { parseOffset, type Source } from "@/lib/signals";
import { tickAfterUpload } from "@/lib/after-upload";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return fail("No image was sent.", 400);
    const type = TYPES.find((t) => t === file.type);
    if (!type) return fail(`Unsupported image type ${file.type || "(unknown)"}. Use PNG, JPEG, WebP or GIF.`, 400);
    if (file.size > 4.4 * 1024 * 1024) return fail("Images must be under 4.4 MB (Vercel request limit).", 400);

    const offsets: Record<Source, number> = {
      divergence: parseOffset(String(form.get("divergenceTz") ?? "+05:30")),
      structure: parseOffset(String(form.get("structureTz") ?? "+00:00")),
    };
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const data = await extractScreenshot(base64, type);
    const sentTime = Date.parse(String(form.get("capturedAt") ?? ""));
    const flat = Number.isFinite(sentTime) ? flatten(data, offsets, new Date(sentTime), true) : flatten(data, offsets, new Date());
    const sql = await db();
    const res = await store(sql, flat, data, file.name || null, offsets[flat.source]);
    tickAfterUpload(req);
    return NextResponse.json({
      uploadId: res.uploadId,
      source: flat.source,
      capturedAt: flat.capturedAt,
      signalCount: flat.signals.length,
      newCount: res.newCount,
      symbols: [...new Set(flat.signals.map((s) => s.symbol))].length,
      duplicateUpload: res.duplicateUpload,
      warnings: flat.warnings,
    });
  } catch (e) {
    return fail(e);
  }
}
