// Reads the screeners' Pine Logs (or takes screenshots) from TradingView chart layouts and uploads them to
// Confluence Radar.
//
//   node capture.mjs login <profile>   open a visible browser to sign in to TradingView once for that profile
//   node capture.mjs                   capture every layout in config.json and upload it
//
// A layout with "mode": "pine" reads the "# Confluence Radar: …" entries the export versions of the
// screeners write to Pine Logs and uploads them as text. Otherwise ("mode": "screenshot") it uploads a screenshot.
//
// Config comes from config.json, or from the CAPTURE_CONFIG environment variable (used by the GitHub Actions job).
// Sign-in: a layout with "sessionid" and "sessionid_sign" (TradingView's login cookies) uses those; otherwise its
// profile's saved browser login under ./profiles/<profile> is used, so two TradingView accounts work side by side.
import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(process.env.CAPTURE_CONFIG || readFileSync(join(here, "config.json"), "utf8"));
const profileDir = (name) => join(here, "profiles", name);
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function login(profile) {
  if (!profile) throw new Error("Usage: node capture.mjs login <profile>");
  mkdirSync(profileDir(profile), { recursive: true });
  const ctx = await chromium.launchPersistentContext(profileDir(profile), { headless: false, viewport: null, ...browserChoice() });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://www.tradingview.com/accounts/signin/");
  log(`Sign in to TradingView as "${profile}" in the window that opened, then close the window.`);
  await new Promise((resolve) => ctx.on("close", resolve));
  log("Login saved.");
}

// "browser": "chrome" uses the installed Google Chrome instead of Playwright's Chromium (Google sign-in accepts it).
function browserChoice() {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH }; // optional: an already-installed Chromium
  return config.browser === "chrome" ? { channel: "chrome" } : {};
}

async function openContext(layout) {
  const options = { viewport: config.viewport ?? { width: 1100, height: 1700 }, deviceScaleFactor: 1 };
  const headless = config.headless ?? true;
  if (!layout.sessionid) return chromium.launchPersistentContext(profileDir(layout.profile), { headless, ...browserChoice(), ...options });
  const browser = await chromium.launch({ headless, ...browserChoice() });
  const ctx = await browser.newContext(options);
  const cookie = (name, value) => ({ name, value, domain: ".tradingview.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  await ctx.addCookies([cookie("sessionid", layout.sessionid), ...(layout.sessionid_sign ? [cookie("sessionid_sign", layout.sessionid_sign)] : [])]);
  ctx.on("close", () => browser.close());
  return ctx;
}

async function openLayout(ctx, layout) {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(layout.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  if (page.url().includes("/signin")) {
    throw new Error(layout.sessionid
      ? "TradingView rejected the saved login cookies. Copy fresh sessionid / sessionid_sign values into the config."
      : `Not signed in. Run: node capture.mjs login ${layout.profile}`);
  }
  await page.waitForSelector("canvas", { timeout: 60_000 });
  // Close TradingView's one-off notices ("Got it") so they don't cover the screener tables.
  page.getByRole("button", { name: /^got it$/i }).first().click({ timeout: 15_000 }).catch(() => {});
  return page;
}

function saveShot(layout, png) {
  mkdirSync(join(here, "shots"), { recursive: true });
  writeFileSync(join(here, "shots", `${layout.name}.png`), png); // last capture, for checking by eye
}

async function captureOne(layout) {
  const ctx = await openContext(layout);
  try {
    const page = await openLayout(ctx, layout);
    // Screener tables are drawn after every symbol's data loads, which takes a while on a 10-symbol screener.
    await page.waitForTimeout((config.waitSeconds ?? 25) * 1000);
    await page.keyboard.press("Escape"); // dismiss any popup
    const png = await page.screenshot({ type: "png" });
    saveShot(layout, png);
    return png;
  } finally {
    await ctx.close();
  }
}

const MARK = "# Confluence Radar:";

/** Every string inside a TradingView websocket frame ("~m~<len>~m~<json>" packets) that holds an export entry. */
function entriesInFrame(payload, found) {
  const text = typeof payload === "string" ? payload : payload.toString("utf8");
  if (!text.includes("Confluence Radar")) return;
  const walk = (v) => {
    if (typeof v === "string") { if (v.includes(MARK)) found.add(v.slice(v.indexOf(MARK))); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const part of text.split(/~m~\d+~m~/)) {
    try { walk(JSON.parse(part)); } catch { /* not JSON */ }
  }
}

/** Export entries shown in an open Pine Logs panel. Each entry runs until the next one or the next log timestamp. */
function entriesInText(text, found) {
  let i = text.indexOf(MARK);
  while (i >= 0) {
    const next = text.indexOf(MARK, i + MARK.length);
    let entry = text.slice(i, next < 0 ? undefined : next);
    entry = entry.split(/\[?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)[0]; // the next log line's timestamp
    found.add(entry.trim());
    i = next;
  }
}

// node capture.mjs --debug: writes debug/<layout>.txt with what the script saw, for finding out why nothing was read.
const DEBUG = process.argv.includes("--debug") || config.debug === true;

/** Opens Pine Logs for every indicator on the chart through its legend's "More" menu. */
async function openPineLogs(page, notes) {
  const items = page.locator('[data-name="legend-source-item"], [data-qa-id="legend-source-item"]');
  const n = await items.count();
  notes.push(`legend items: ${n}`);
  for (let k = 0; k < n; k++) {
    const item = items.nth(k);
    const title = (await item.innerText().catch(() => "")).split("\n")[0];
    try {
      await item.hover();
      const more = item.locator('[data-name="legend-more-action"], [data-qa-id="legend-more-action"], [aria-label="More"]').first();
      await more.click({ timeout: 3000 });
      await page.waitForTimeout(500);
      const menu = await page.locator('[role="menu"], [data-name="menu-inner"], [class*="menu"]').allInnerTexts().catch(() => []);
      notes.push(`legend ${k} "${title}": menu = ${JSON.stringify(menu.join(" | ").slice(0, 600))}`);
      const entry = page.getByText(/Pine Logs/i).first();
      if (await entry.isVisible({ timeout: 2000 }).catch(() => false)) {
        await entry.click();
        notes.push(`legend ${k}: clicked Pine Logs`);
        await page.waitForTimeout(4000);
      } else {
        notes.push(`legend ${k}: no Pine Logs item`);
        await page.keyboard.press("Escape");
      }
    } catch (e) {
      notes.push(`legend ${k} "${title}": ${e.message.split("\n")[0]}`);
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
}

async function capturePine(layout) {
  const ctx = await openContext(layout);
  const found = new Set();
  const notes = [];
  const frames = { total: 0, urls: new Set(), interesting: [] };
  const onFrame = (ws) => (f) => {
    frames.total++;
    entriesInFrame(f.payload, found);
    if (DEBUG && frames.interesting.length < 200) {
      const text = typeof f.payload === "string" ? f.payload : f.payload.toString("utf8");
      if (/pine|log|Confluence/i.test(text)) frames.interesting.push(`${ws.url()}\n${text.slice(0, 3000)}`);
    }
  };
  const watch = (p) => p.on("websocket", (ws) => { frames.urls.add(ws.url()); ws.on("framereceived", onFrame(ws)); });
  try {
    // The logs reach the browser over TradingView's websocket, so listen before the chart loads.
    ctx.on("page", watch);
    ctx.pages().forEach(watch);
    const page = await openLayout(ctx, layout);
    await page.waitForTimeout((config.waitSeconds ?? 25) * 1000);
    await page.keyboard.press("Escape");
    notes.push(`entries from websocket: ${found.size}`);
    if (!found.size || DEBUG) {
      await openPineLogs(page, notes);
      const body = await page.locator("body").innerText();
      entriesInText(body, found);
      notes.push(`entries after opening Pine Logs: ${found.size}`);
      if (DEBUG) notes.push("page text lines mentioning Pine or Confluence:", ...body.split("\n").filter((l) => /pine|confluence/i.test(l)).slice(0, 50));
    }
    saveShot(layout, await page.screenshot({ type: "png" }));
    return [...found];
  } finally {
    if (DEBUG) {
      mkdirSync(join(here, "debug"), { recursive: true });
      writeFileSync(join(here, "debug", `${layout.name}.txt`), [
        `websockets: ${[...frames.urls].join(", ")}`, `frames received: ${frames.total}`, ...notes,
        "", "---- frames mentioning pine/log/Confluence ----", ...frames.interesting,
      ].join("\n"));
    }
    await ctx.close();
  }
}

function authHeaders() {
  return config.password ? { authorization: "Basic " + Buffer.from(`radar:${config.password}`).toString("base64") } : {};
}

async function uploadText(entries) {
  const res = await fetch(new URL("/api/upload-text", config.site), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ text: entries.join("\n\n") }),
  });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json; // one result per screener
}

async function upload(layout, png, capturedAt) {
  const body = new FormData();
  body.append("file", new Blob([png], { type: "image/png" }), `${layout.name}-${capturedAt.toISOString()}.png`);
  body.append("capturedAt", capturedAt.toISOString());
  // The site reads each screener's printed times in the zone given here; both fields are sent so either screener works.
  body.append("divergenceTz", layout.tz ?? "+05:30");
  body.append("structureTz", layout.tz ?? "+00:00");
  const res = await fetch(new URL("/api/upload", config.site), { method: "POST", body, headers: authHeaders() });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

async function main() {
  if (process.argv[2] === "login") return login(process.argv[3]);
  let failed = false;
  for (const layout of config.layouts) {
    try {
      if (layout.mode === "pine") {
        const entries = await capturePine(layout);
        if (!entries.length) {
          throw new Error("No Confluence Radar entries in Pine Logs. Check that the export version of the screener is on this layout " +
            `(see pine/README.md), and look at shots/${layout.name}.png. Raising waitSeconds can help.`);
        }
        for (const r of await uploadText(entries)) {
          log(`${layout.name}: ${r.source}, ${r.signalCount} signals, ${r.newCount} new${r.warnings?.length ? `, ${r.warnings.length} warnings` : ""}`);
        }
        continue;
      }
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
