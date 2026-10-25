// Screenshots TradingView chart layouts and uploads them to Confluence Radar.
//
//   node capture.mjs login <profile>   open a visible browser to sign in to TradingView once for that profile
//   node capture.mjs                   capture every layout in config.json and upload it
//
// Each profile keeps its own saved browser login under ./profiles/<profile>, so two TradingView accounts work side by side.
import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const profileDir = (name) => join(here, "profiles", name);
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function login(profile) {
  if (!profile) throw new Error("Usage: node capture.mjs login <profile>");
  mkdirSync(profileDir(profile), { recursive: true });
  const ctx = await chromium.launchPersistentContext(profileDir(profile), { headless: false, viewport: null });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://www.tradingview.com/accounts/signin/");
  log(`Sign in to TradingView as "${profile}" in the window that opened, then close the window.`);
  await new Promise((resolve) => ctx.on("close", resolve));
  log("Login saved.");
}

async function captureOne(layout) {
  const ctx = await chromium.launchPersistentContext(profileDir(layout.profile), {
    headless: true,
    viewport: config.viewport ?? { width: 1100, height: 1700 },
    deviceScaleFactor: 1,
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(layout.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    if (page.url().includes("/signin")) throw new Error(`Not signed in. Run: node capture.mjs login ${layout.profile}`);
    await page.waitForSelector("canvas", { timeout: 60_000 });
    // Screener tables are drawn after every symbol's data loads, which takes a while on a 10-symbol screener.
    await page.waitForTimeout((config.waitSeconds ?? 25) * 1000);
    await page.keyboard.press("Escape"); // dismiss any popup
    const png = await page.screenshot({ type: "png" });
    mkdirSync(join(here, "shots"), { recursive: true });
    writeFileSync(join(here, "shots", `${layout.name}.png`), png); // last capture, for checking by eye
    return png;
  } finally {
    await ctx.close();
  }
}

async function upload(layout, png, capturedAt) {
  const body = new FormData();
  body.append("file", new Blob([png], { type: "image/png" }), `${layout.name}-${capturedAt.toISOString()}.png`);
  body.append("capturedAt", capturedAt.toISOString());
  // The site reads each screener's printed times in the zone given here; both fields are sent so either screener works.
  body.append("divergenceTz", layout.tz ?? "+05:30");
  body.append("structureTz", layout.tz ?? "+00:00");
  const headers = config.password ? { authorization: "Basic " + Buffer.from(`radar:${config.password}`).toString("base64") } : {};
  const res = await fetch(new URL("/api/upload", config.site), { method: "POST", body, headers });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

async function main() {
  if (process.argv[2] === "login") return login(process.argv[3]);
  let failed = false;
  for (const layout of config.layouts) {
    try {
      const capturedAt = new Date();
      const png = await captureOne(layout);
      const r = await upload(layout, png, capturedAt);
      log(`${layout.name}: ${r.source}, ${r.signalCount} signals, ${r.newCount} new${r.warnings?.length ? `, ${r.warnings.length} warnings` : ""}`);
    } catch (e) {
      failed = true;
      log(`${layout.name}: FAILED: ${e.message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
