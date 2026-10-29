import { after } from "next/server";

/**
 * After new signals are stored, run the check (trends, fib touches, Telegram alerts) once the response is sent.
 * It goes through /api/tick so the market data is fetched from that route's region.
 */
export function tickAfterUpload(req: Request) {
  const auth = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : req.headers.get("authorization");
  after(async () => {
    try {
      await fetch(new URL("/api/tick", req.url), { method: "POST", headers: auth ? { authorization: auth } : {} });
    } catch (e) {
      console.error("tick after upload failed", e);
    }
  });
}
