import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { listUploads } from "@/lib/queries";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await listUploads(await db()));
  } catch (e) {
    return fail(e);
  }
}
