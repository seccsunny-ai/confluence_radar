import { NextResponse } from "next/server";

export function fail(e: unknown, status = 500) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(e);
  return NextResponse.json({ error: message }, { status });
}

export function list(v: string | null): string[] | undefined {
  const items = v?.split(",").map((s) => s.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}

export function num(v: string | null): number | undefined {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
