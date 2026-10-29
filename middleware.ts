import { NextResponse, type NextRequest } from "next/server";

// Optional password gate: set APP_PASSWORD to require HTTP Basic auth (any username).
// The scheduled check may instead send "Authorization: Bearer <CRON_SECRET>".
export function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();
  const header = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.nextUrl.pathname === "/api/tick" && header === `Bearer ${cronSecret}`) return NextResponse.next();
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = atob(encoded);
    if (decoded.slice(decoded.indexOf(":") + 1) === password) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Confluence Radar"' },
  });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
