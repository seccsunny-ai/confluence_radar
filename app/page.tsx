"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GOLD_WINDOW_DAYS, SIGNAL_BY_CODE, SIGNALS } from "@/lib/signals";
import { ago, Chips, getJson, Sig } from "./ui";
import { Alerts, Fibs, FibSignals, Trends } from "./confluence";
import { FibAlarm, FibHits, useAlarm } from "./fib-alarm";
import { PriceAlerts } from "./price-alerts";

type Tab = "matches" | "fib" | "hits" | "myalerts" | "osc" | "trends" | "fibs" | "signals" | "symbols" | "uploads" | "alerts";

interface Signal {
  id: number;
  symbol: string;
  source: string;
  tf: string;
  code: string;
  family: string;
  direction: string;
  signal_time: string;
  first_seen_at: string;
  last_seen_at: string;
}

interface Match {
  id: number;
  symbol: string;
  tf: string;
  code: string;
  direction: string;
  signal_time: string;
  window_end: string;
  status: "confirmed" | "watching" | "expired";
  confirmations: Array<{ id: number; tf: string; code: string; signal_time: string; first_seen_at: string }>;
}

interface Upload {
  id: number;
  filename: string | null;
  source: string;
  captured_at: string;
  created_at: string;
  signal_count: number;
  new_count: number;
  warnings: string[];
}

const TF_ORDER = ["1m", "3m", "5m", "15m", "30m", "45m", "1h", "2h", "3h", "4h", "6h", "8h", "12h", "1D", "3D", "1W", "1M"];
const tfSort = (a: string, b: string) => (TF_ORDER.indexOf(a) + 1 || 99) - (TF_ORDER.indexOf(b) + 1 || 99);

const DISPLAY_TZS = [
  { v: "Asia/Kolkata", l: "IST (UTC+5:30)" },
  { v: "UTC", l: "UTC" },
  { v: "local", l: "This device" },
];

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

function useFmt(tz: string) {
  return useMemo(() => {
    const f = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
      ...(tz === "local" ? {} : { timeZone: tz }),
    });
    return (iso: string) => f.format(new Date(iso));
  }, [tz]);
}

function gap(fromIso: string, toIso: string): string {
  const m = Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d ? `${d}d` : "", h ? `${h}h` : "", !d && mm ? `${mm}m` : ""].filter(Boolean).join(" ") || "0m";
}

// ─────────────────────────────── Upload ───────────────────────────────

interface Job { name: string; state: "queued" | "reading" | "done" | "error"; msg?: string; warnings?: string[] }

const TZ_CHOICES = ["+05:30", "+00:00", "+01:00", "+02:00", "+03:00", "+04:00", "+05:00", "+08:00", "+09:00", "-04:00", "-05:00"];

function Uploader({ onDone }: { onDone: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [over, setOver] = useState(false);
  const [divTz, setDivTz] = useState("+05:30");
  const [bosTz, setBosTz] = useState("+00:00");
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setDivTz(load("divTz", "+05:30"));
    setBosTz(load("bosTz", "+00:00"));
  }, []);

  const run = useCallback(async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    const start = jobs.length;
    setJobs((j) => [...j, ...imgs.map((f) => ({ name: f.name, state: "queued" as const }))]);
    const update = (i: number, patch: Partial<Job>) =>
      setJobs((j) => j.map((x, k) => (k === start + i ? { ...x, ...patch } : x)));
    await Promise.all(imgs.map(async (f, i) => {
      update(i, { state: "reading" });
      const body = new FormData();
      body.append("file", f);
      body.append("divergenceTz", divTz);
      body.append("structureTz", bosTz);
      try {
        const r = await fetch("/api/upload", { method: "POST", body });
        const j = await r.json().catch(() => ({ error: `Server returned ${r.status}` }));
        if (!r.ok) throw new Error(j.error || r.statusText);
        const kind = j.source === "structure" ? "BOS/CHoCH" : "Divergence";
        update(i, {
          state: "done",
          msg: `${kind}: ${j.signalCount} signals across ${j.symbols} symbols, ${j.newCount} new.` +
            (j.duplicateUpload ? " A screenshot with the same time was already uploaded." : ""),
          warnings: j.warnings,
        });
      } catch (e) {
        update(i, { state: "error", msg: e instanceof Error ? e.message : String(e) });
      }
    }));
    onDone();
  }, [jobs.length, divTz, bosTz, onDone]);

  const sendText = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const at = jobs.length;
    setJobs((j) => [...j, { name: "Pasted text", state: "reading" }]);
    const set = (patch: Partial<Job>) => setJobs((j) => j.map((x, k) => (k === at ? { ...x, ...patch } : x)));
    try {
      const r = await fetch("/api/upload-text", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, divergenceTz: divTz, structureTz: bosTz }),
      });
      const j = await r.json().catch(() => ({ error: `Server returned ${r.status}` }));
      if (!r.ok) throw new Error(j.error || r.statusText);
      const parts = (j as Array<{ source: string; signalCount: number; symbols: number; newCount: number; warnings: string[] }>).map(
        (g) => `${g.source === "structure" ? "BOS/CHoCH" : "Divergence"}: ${g.signalCount} signals across ${g.symbols} symbols, ${g.newCount} new.`,
      );
      set({ state: "done", msg: parts.join(" "), warnings: j.flatMap((g: { warnings: string[] }) => g.warnings) });
      setText("");
    } catch (e) {
      set({ state: "error", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
      onDone();
    }
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) run(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [run]);

  return (
    <div className="panel">
      <div className={`drop ${over ? "over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); run([...e.dataTransfer.files]); }}>
        <strong>Drop screenshots here</strong>, click to choose, or paste. Both screeners can go in together.
        <input ref={input} type="file" accept="image/*" multiple hidden
          onChange={(e) => { run([...(e.target.files ?? [])]); e.target.value = ""; }} />
      </div>
      <details style={{ marginTop: 10 }}>
        <summary className="small">Or paste signals as text</summary>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} spellCheck={false}
          placeholder={"CAPTURED: 2026-10-25 16:00 +05:30\nBTCUSDT.P, 15m, G🔥, 22 Oct 15:15\nBTCUSDT.P, 1h, Int BOS↓, 24 Oct 14:00"}
          style={{ width: "100%", marginTop: 8, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 6, padding: 8, fontFamily: "ui-monospace, monospace", fontSize: 12.5, color: "inherit" }} />
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn primary" disabled={sending || !text.trim()} onClick={sendText}>{sending ? "Saving…" : "Save signals"}</button>
          <span className="small muted">One signal per line: SYMBOL, TIMEFRAME, SIGNAL, TIME. Lines without a TZ: line use the timezones below.</span>
        </div>
      </details>
      <div className="row small muted" style={{ marginTop: 10 }}>
        <span>Times printed in the tables:</span>
        <label>Divergence screener&nbsp;
          <select value={divTz} onChange={(e) => { setDivTz(e.target.value); save("divTz", e.target.value); }}>
            {TZ_CHOICES.map((t) => <option key={t} value={t}>UTC{t}</option>)}
          </select>
        </label>
        <label>BOS/CHoCH screener&nbsp;
          <select value={bosTz} onChange={(e) => { setBosTz(e.target.value); save("bosTz", e.target.value); }}>
            {TZ_CHOICES.map((t) => <option key={t} value={t}>UTC{t}</option>)}
          </select>
        </label>
      </div>
      {jobs.length > 0 && (
        <ul className="uploads small" style={{ margin: "10px 0 0", paddingLeft: 18 }}>
          {jobs.map((j, i) => (
            <li key={i}>
              {j.name}: {j.state === "reading" ? "reading…" : j.state === "queued" ? "queued" : null}
              {j.state === "done" && <span className="status-ok">{j.msg}</span>}
              {j.state === "error" && <span className="status-err">{j.msg}</span>}
              {j.warnings && j.warnings.length > 0 && (
                <details><summary className="warn">{j.warnings.length} warning(s)</summary>
                  {j.warnings.map((w, k) => <div key={k} className="warn">{w}</div>)}
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────── Matches ───────────────────────────────

function Matches({ fmt, refresh }: { fmt: (s: string) => string; refresh: number }) {
  const [status, setStatus] = useState<string>("");
  const [dir, setDir] = useState<string>("");
  const [tfs, setTfs] = useState<string[]>([]);
  const [sameTf, setSameTf] = useState(false);
  const [sinceDays, setSinceDays] = useState("30");
  const [symbol, setSymbol] = useState("");
  const [rows, setRows] = useState<Match[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (dir) q.set("direction", dir);
    if (tfs.length) q.set("tfs", tfs.join(","));
    if (sameTf) q.set("sameTf", "1");
    if (sinceDays) q.set("sinceDays", sinceDays);
    if (symbol) q.set("symbol", symbol);
    getJson<Match[]>(`/api/matches?${q}`).then((r) => { setRows(r); setErr(""); }).catch((e) => setErr(e.message));
  }, [status, dir, tfs, sameTf, sinceDays, symbol, refresh]);

  const counts = useMemo(() => {
    const c = { confirmed: 0, watching: 0, expired: 0 };
    rows?.forEach((r) => c[r.status]++);
    return c;
  }, [rows]);

  return (
    <>
      <div className="panel filters">
        <div className="muted small">
          Each Gold signal is watched for a same-direction BOS or CHoCH on the same symbol, printed after it:
          {" "}{Object.entries(GOLD_WINDOW_DAYS).map(([tf, d]) => `${tf} → ${d} days`).join(", ")}.
        </div>
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="confirmed">Confirmed</option>
            <option value="watching">Watching (window open, nothing yet)</option>
            <option value="expired">Expired without confirmation</option>
          </select>
          <select value={dir} onChange={(e) => setDir(e.target.value)}>
            <option value="">G🔥 and G❄</option>
            <option value="bull">G🔥 Gold Buy only</option>
            <option value="bear">G❄ Gold Sell only</option>
          </select>
          <select value={sinceDays} onChange={(e) => setSinceDays(e.target.value)}>
            <option value="3">Gold in last 3 days</option>
            <option value="7">Gold in last 7 days</option>
            <option value="30">Gold in last 30 days</option>
            <option value="90">Gold in last 90 days</option>
            <option value="">Any time</option>
          </select>
          <input type="text" placeholder="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
        </div>
        <div className="row">
          <span className="small muted">Gold timeframe</span>
          <Chips options={Object.keys(GOLD_WINDOW_DAYS)} value={tfs} onChange={setTfs} />
          <label className="small"><input type="checkbox" checked={sameTf} onChange={(e) => setSameTf(e.target.checked)} /> Only BOS/CHoCH on the same timeframe</label>
        </div>
      </div>
      {err && <div className="panel status-err">{err}</div>}
      <div className="panel tablewrap">
        <div className="small muted" style={{ marginBottom: 8 }}>
          {rows ? `${rows.length} Gold signals · ${counts.confirmed} confirmed · ${counts.watching} watching · ${counts.expired} expired` : "Loading…"}
        </div>
        {rows && rows.length === 0 ? <div className="empty">No Gold signals match these filters yet.</div> : (
          <table>
            <thead><tr>
              <th>Symbol</th><th>Gold</th><th className="nowrap">Gold time</th><th className="nowrap">Watching until</th>
              <th>Status</th><th>BOS / CHoCH that followed</th>
            </tr></thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id} className={r.status === "confirmed" && Date.now() - new Date(r.confirmations.at(-1)!.signal_time).getTime() < 864e5 ? "recent" : ""}>
                  <td><strong>{r.symbol}</strong></td>
                  <td className="nowrap"><Sig code={r.code} /> {r.tf}</td>
                  <td className="nowrap">{fmt(r.signal_time)}<div className="small muted">{ago(r.signal_time)}</div></td>
                  <td className="nowrap">{fmt(r.window_end)}</td>
                  <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                  <td>
                    {r.confirmations.map((c) => (
                      <div key={c.id} className="nowrap">
                        <Sig code={c.code} /> {c.tf} · {fmt(c.signal_time)} <span className="muted small">(+{gap(r.signal_time, c.signal_time)})</span>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────── Signals ───────────────────────────────

function Signals({ fmt, refresh }: { fmt: (s: string) => string; refresh: number }) {
  const [codes, setCodes] = useState<string[]>(["GOLD_BUY"]);
  const [tfs, setTfs] = useState<string[]>([]);
  const [since, setSince] = useState("168");
  const [latest, setLatest] = useState(true);
  const [symbol, setSymbol] = useState("");
  const [rows, setRows] = useState<Signal[] | null>(null);
  const [hidden, setHidden] = useState(0); // matches outside the time window, for the empty-state hint
  const [fixed, setFixed] = useState(0); // bumped after a correction to reload
  const [allTfs, setAllTfs] = useState<string[]>(["15m", "1h", "4h", "1D"]);
  const [err, setErr] = useState("");

  useEffect(() => {
    const q = new URLSearchParams();
    if (codes.length) q.set("codes", codes.join(","));
    if (tfs.length) q.set("tfs", tfs.join(","));
    if (since) q.set("sinceHours", since);
    if (symbol) q.set("symbol", symbol);
    if (latest) q.set("latest", "1");
    getJson<Signal[]>(`/api/signals?${q}`).then((r) => {
      setRows(r);
      setErr("");
      setHidden(0);
      if (!r.length && since) {
        q.delete("sinceHours");
        q.set("limit", "5000");
        getJson<Signal[]>(`/api/signals?${q}`).then((all) => setHidden(all.length)).catch(() => {});
      }
    }).catch((e) => setErr(e.message));
  }, [codes, tfs, since, latest, symbol, refresh, fixed]);

  const correct = async (r: Signal, code: string) => {
    if (!code) return;
    const res = await fetch(`/api/signals/${r.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code === "REMOVE" ? null : code }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setErr(j.error || res.statusText);
    setFixed((n) => n + 1);
  };

  useEffect(() => {
    getJson<Signal[]>(`/api/symbols`).then((r) => {
      const s = new Set(["15m", "1h", "4h", "1D", ...r.map((x) => x.tf)]);
      setAllTfs([...s].sort(tfSort));
    }).catch(() => {});
  }, [refresh]);

  // Signals that first appeared in the newest upload shown here.
  const newest = rows?.reduce((m, r) => (r.first_seen_at > m ? r.first_seen_at : m), "") ?? "";

  const groups = [
    { name: "Gold", codes: ["GOLD_BUY", "GOLD_SELL"] },
    { name: "Divergence", codes: ["VMC_BULL", "VMC_BEAR", "RSI_BULL", "RSI_BEAR"] },
    { name: "BOS", codes: ["INT_BOS_BULL", "SW_BOS_BULL", "INT_BOS_BEAR", "SW_BOS_BEAR"] },
    { name: "CHoCH", codes: ["INT_CHOCH_BULL", "SW_CHOCH_BULL", "INT_CHOCH_BEAR", "SW_CHOCH_BEAR"] },
  ];

  return (
    <>
      <div className="panel filters">
        {groups.map((g) => (
          <div key={g.name} className="row">
            <span className="small muted" style={{ width: 80 }}>{g.name}</span>
            <Chips options={g.codes} value={codes} onChange={setCodes} render={(c) => <Sig code={c} />} />
          </div>
        ))}
        <div className="row">
          <span className="small muted" style={{ width: 80 }}>Timeframe</span>
          <Chips options={allTfs} value={tfs} onChange={setTfs} />
        </div>
        <div className="row">
          <select value={since} onChange={(e) => setSince(e.target.value)}>
            <option value="6">Last 6 hours</option>
            <option value="24">Last 24 hours (⚡ recent)</option>
            <option value="48">Last 48 hours</option>
            <option value="168">Last 7 days</option>
            <option value="720">Last 30 days</option>
            <option value="">Any time</option>
          </select>
          <label className="small nowrap">
            <input type="checkbox" checked={latest} onChange={(e) => setLatest(e.target.checked)} /> Only what the latest upload shows
          </label>
          <input type="text" placeholder="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          <button className="btn" onClick={() => { setCodes([]); setTfs([]); setSince(""); setLatest(false); setSymbol(""); }}>Clear filters</button>
        </div>
      </div>
      {err && <div className="panel status-err">{err}</div>}
      <div className="panel tablewrap">
        <div className="small muted" style={{ marginBottom: 8 }}>{rows ? `${rows.length} signals` : "Loading…"}</div>
        {rows && rows.length === 0 ? (
          <div className="empty">
            No signals match these filters.
            {hidden > 0 && <> {hidden} older ones match outside the time window. <button className="btn" onClick={() => setSince("")}>Show any time</button></>}
          </div>
        ) : (
          <table>
            <thead><tr><th>Symbol</th><th>Signal</th><th>TF</th><th className="nowrap">Signal time</th><th>Age</th><th className="nowrap">First seen</th><th className="nowrap">Last seen in a screenshot</th><th title="Correct a signal that was read wrongly. The fix is remembered for later uploads.">Fix</th></tr></thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id} className={Date.now() - new Date(r.signal_time).getTime() < 864e5 ? "recent" : ""}>
                  <td><strong>{r.symbol}</strong></td>
                  <td><Sig code={r.code} /> <span className="small muted">{SIGNAL_BY_CODE[r.code]?.name}</span></td>
                  <td>{r.tf}</td>
                  <td className="nowrap">{fmt(r.signal_time)}</td>
                  <td className="nowrap small">{ago(r.signal_time)}</td>
                  <td className="nowrap small muted">{fmt(r.first_seen_at)}{r.first_seen_at === newest ? <span className="badge watching" style={{ marginLeft: 6 }}>new</span> : null}</td>
                  <td className="nowrap small muted">{fmt(r.last_seen_at)}</td>
                  <td>
                    <select className="small" value="" onChange={(e) => correct(r, e.target.value)} aria-label="Correct this signal">
                      <option value="">Wrong?</option>
                      {SIGNALS.filter((d) => d.source === r.source && d.code !== r.code).map((d) => (
                        <option key={d.code} value={d.code}>It's {d.label} {d.name}</option>
                      ))}
                      <option value="REMOVE">Not a signal, remove</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────── Symbols ───────────────────────────────

interface SymbolFibs {
  symbol: string;
  gold: Array<{ id: number; tf: string; code: string; direction: "bull" | "bear"; signal_time: string; live: boolean }>;
  fibs: Array<{
    id: number; tf: string; direction: "bull" | "bear"; source: "manual" | "auto"; forming: boolean; note: string | null;
    high: number; low: number; price: number | null;
    levels: Array<{ ratio: number; price: number; hit_at: string | null }>;
  }>;
}

const LTF_GOLD = ["15m", "1h"];
const HTF_GOLD = ["4h", "1D"];
const tfLabel = (tf: string) => tf.replace(/h$/, "H");

function fmtPrice(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "–";
  const abs = Math.abs(p);
  return String(Number(p.toFixed(abs >= 1000 ? 1 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8)));
}

/** tier 0 = live 15m/1H Gold, 1 = live 4H/1D Gold, 2 = none; t = newest such Gold time. */
function goldRank(info?: SymbolFibs): { tier: number; t: number } {
  const live = info?.gold.filter((g) => g.live) ?? [];
  for (const [tier, tfs] of [[0, LTF_GOLD], [1, HTF_GOLD]] as const) {
    const ts = live.filter((g) => tfs.includes(g.tf)).map((g) => new Date(g.signal_time).getTime());
    if (ts.length) return { tier, t: Math.max(...ts) };
  }
  return { tier: 2, t: 0 };
}

// Which Symbols-tab column each fib timeframe goes in.
const FIB_COLUMN: Record<string, string> = { "5m": "15m", "15m": "15m", "1h": "1h", "2h": "1h", "4h": "4h", "8h": "4h", "1D": "1D", "1W": "1D" };
const FIB_COLUMNS = ["15m", "1h", "4h", "1D"];

/** Fibs for one column, each level marked hit (✅) or waiting (⏳). Fibs against the newest live Gold are dimmed. */
function CellFibs({ fibs, goldDir, fmt }: { fibs: SymbolFibs["fibs"]; goldDir?: string; fmt: (s: string) => string }) {
  if (!fibs.length) return null;
  return (
    <div className="cellfibs">
      {fibs.map((f) => (
        <div key={f.id} className="small" style={{ opacity: goldDir && f.direction !== goldDir ? 0.6 : 1 }}>
          <span className={`sig ${f.direction}`}>{tfLabel(f.tf)} {f.direction === "bull" ? "🟢" : "🔴"}</span>
          <span className="muted"> {f.source === "auto" ? (f.forming ? "forming" : "") : "mine"}{f.note ? ` ${f.note}` : ""}</span>
          {f.levels.map((l) => {
            const dist = f.price ? ((f.price - l.price) / l.price) * 100 : null;
            return (
              <div key={l.ratio} className="nowrap" title={l.hit_at ? `Hit ${fmt(l.hit_at)}` : "Not hit yet"}>
                {l.hit_at ? "✅" : "⏳"} {l.ratio} {fmtPrice(l.price)}
                <span className="muted">{l.hit_at ? ` hit ${ago(l.hit_at)}` : dist != null ? ` (${dist > 0 ? "+" : ""}${dist.toFixed(2)}%)` : ""}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Symbols({ fmt, refresh }: { fmt: (s: string) => string; refresh: number }) {
  const [rows, setRows] = useState<Signal[] | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [order, setOrder] = useState<"gold" | "name">("gold");
  const [showFibs, setShowFibs] = useState(true);
  const [board, setBoard] = useState<SymbolFibs[]>([]);
  const [osc, setOsc] = useState<OscData | null>(null);
  useEffect(() => {
    setOrder(load("symbols.order", "gold"));
    setShowFibs(load("symbols.showFibs", true));
  }, []);
  useEffect(() => {
    getJson<Signal[]>(`/api/symbols`).then(setRows).catch((e) => setErr(e.message));
    getJson<SymbolFibs[]>("/api/symbol-fibs").then(setBoard).catch(() => {});
    getJson<OscData>("/api/osc?days=0").then(setOsc).catch(() => {});
  }, [refresh]);
  const oscBySymbol = useMemo(() => {
    const m = new Map<string, OscSignal[]>();
    for (const o of osc?.signals ?? []) if (!o.ended_t) m.set(o.symbol, [...(m.get(o.symbol) ?? []), o]);
    return m;
  }, [osc]);
  const boardBySymbol = useMemo(() => new Map(board.map((b) => [b.symbol, b])), [board]);

  const { symbols, tfs, cell } = useMemo(() => {
    const map = new Map<string, Signal[]>();
    const tfSet = new Set<string>();
    for (const r of rows ?? []) {
      const k = `${r.symbol}|${r.tf}`;
      map.set(k, [...(map.get(k) ?? []), r]);
      tfSet.add(r.tf);
    }
    const famOrder = ["gold", "vmc", "rsi", "bos", "choch"];
    const symbols = [...new Set((rows ?? []).map((r) => r.symbol))].sort().filter((s) => s.includes(q.toUpperCase()));
    if (order === "gold") {
      // Symbols whose latest live Gold is on 15m/1H first (newest first), then 4H/1D, then the rest A–Z.
      const rank = new Map(symbols.map((s) => [s, goldRank(boardBySymbol.get(s))]));
      symbols.sort((a, b) => rank.get(a)!.tier - rank.get(b)!.tier || rank.get(b)!.t - rank.get(a)!.t || a.localeCompare(b));
    }
    return {
      symbols,
      tfs: [...new Set([...tfSet, ...(showFibs ? FIB_COLUMNS : []), ...[...oscBySymbol.values()].flat().map((o) => OSC_COLUMN[o.tf])])].sort(tfSort),
      cell: (s: string, tf: string) => (map.get(`${s}|${tf}`) ?? []).sort((a, b) => famOrder.indexOf(a.family) - famOrder.indexOf(b.family)),
    };
  }, [rows, q, order, boardBySymbol, showFibs, oscBySymbol]);

  return (
    <>
      <div className="panel row">
        <input type="text" placeholder="Filter symbols" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={order} onChange={(e) => { const v = e.target.value as "gold" | "name"; setOrder(v); save("symbols.order", v); }}>
          <option value="gold">Latest 15m/1H Gold first, then 4H/1D</option>
          <option value="name">A–Z</option>
        </select>
        <label className="small nowrap">
          <input type="checkbox" checked={showFibs} onChange={(e) => { setShowFibs(e.target.checked); save("symbols.showFibs", e.target.checked); }} /> Show fibs (hit / waiting)
        </label>
        <span className="small muted">
          {symbols.length} symbols. Latest signal of each kind per timeframe; ⚡ rows are under 24 hours old.
          {order === "gold" && " A Gold counts for the order while it's inside its window (15m 2 days, 1H 7, 4H 14, 1D 21)."}
          {showFibs && " Fibs sit in their column: 5m/15m → 15m, 1H/2H → 1H, 4H/8H → 4H, 1D/1W → 1D. ✅ = level already hit, ⏳ = waiting, with the distance from the price now; fibs against the newest Gold are dimmed."}
          {" 🌡️/🧊 = Prime Oscillator above +" + (osc?.level ?? 80) + " / below -" + (osc?.level ?? 80) + " right now (2H shows in the 1H column)."}
        </span>
      </div>
      {err && <div className="panel status-err">{err}</div>}
      <div className="panel tablewrap">
        {rows && rows.length === 0 ? <div className="empty">Upload a screenshot to get started.</div> : (
          <table className="board">
            <thead><tr><th>Symbol</th>{tfs.map((t) => <th key={t}>{t}</th>)}</tr></thead>
            <tbody>
              {symbols.map((s) => {
                const info = boardBySymbol.get(s);
                const goldDir = (info?.gold ?? []).filter((g) => g.live).sort((a, b) => b.signal_time.localeCompare(a.signal_time))[0]?.direction;
                return (
                <tr key={s}>
                  <td><strong>{s}</strong></td>
                  {tfs.map((t) => (
                    <td key={t}>
                      {cell(s, t).map((r) => {
                        const recent = Date.now() - new Date(r.signal_time).getTime() < 864e5;
                        return (
                          <span key={r.family} className={`line ${recent ? "" : "old"}`}>
                            {recent ? "⚡ " : ""}<Sig code={r.code} /> {fmt(r.signal_time)}
                          </span>
                        );
                      })}
                      {(oscBySymbol.get(s) ?? []).filter((o) => OSC_COLUMN[o.tf] === t).sort((a, b) => tfSort(a.tf, b.tf)).map((o) => (
                        <OscLine key={o.id} o={o} fmt={fmt} withTf />
                      ))}
                      {showFibs && <CellFibs fibs={(info?.fibs ?? []).filter((f) => FIB_COLUMN[f.tf] === t)} goldDir={goldDir} fmt={fmt} />}
                    </td>
                  ))}
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────── Prime Oscillator ───────────────────────────────

interface OscSignal {
  id: number; symbol: string; tf: string; side: "ob" | "os"; level: number; started_t: string; last_t: string;
  last_value: number; peak: number; ended_t: string | null; detected_at: string;
}
interface OscData {
  level: number;
  readings: Array<{ symbol: string; tf: string; candle_t: string; value: number; prev_value: number | null }>;
  signals: OscSignal[];
}
const OSC_TFS = ["1h", "2h", "4h", "1D"];
// Which Symbols-tab column each oscillator timeframe goes in (2H sits with 1H, like its fibs).
const OSC_COLUMN: Record<string, string> = { "1h": "1h", "2h": "1h", "4h": "4h", "1D": "1D" };
const OSC_FIB_TFS = ["1h", "2h", "4h", "8h", "1D", "1W"];
const signed = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v)}`;

function OscLine({ o, fmt, withTf }: { o: OscSignal; fmt: (s: string) => string; withTf?: boolean }) {
  return (
    <span className={`line ${o.ended_t ? "old" : ""}`} title={`Peak ${signed(o.peak)}. Value at the last closed candle (${fmt(o.last_t)}).`}>
      <span className={`sig ${o.side === "ob" ? "bear" : "bull"}`}>
        {o.side === "ob" ? "🌡️" : "🧊"} {withTf ? `${tfLabel(o.tf)} ` : ""}Osc {signed(o.last_value)}
      </span>
      <span className="muted small"> {o.ended_t ? `${fmt(o.started_t)} → back inside ${fmt(o.ended_t)}` : `since ${fmt(o.started_t)}`}</span>
    </span>
  );
}

/** Every fib level on 1H–1W, split into already hit and still waiting. */
function fibStatus(info: SymbolFibs | undefined) {
  const fibs = (info?.fibs ?? []).filter((f) => OSC_FIB_TFS.includes(f.tf));
  const levels = fibs.flatMap((f) => f.levels.map((l) => ({
    f, l, dist: f.price ? ((f.price - l.price) / l.price) * 100 : null,
  })));
  const hit = levels.filter((x) => x.l.hit_at).sort((a, b) => b.l.hit_at!.localeCompare(a.l.hit_at!));
  const waiting = levels.filter((x) => !x.l.hit_at).sort((a, b) => Math.abs(a.dist ?? 1e9) - Math.abs(b.dist ?? 1e9));
  return { fibs, hit, waiting };
}

function PrimeOsc({ fmt, refresh }: { fmt: (s: string) => string; refresh: number }) {
  const [data, setData] = useState<OscData | null>(null);
  const [board, setBoard] = useState<SymbolFibs[]>([]);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [tfs, setTfs] = useState<string[]>(OSC_TFS);
  const [side, setSide] = useState<"all" | "ob" | "os">("all");
  const [days, setDays] = useState(0);
  useEffect(() => {
    setTfs(load("osc.tfs", OSC_TFS));
    setSide(load("osc.side", "all"));
    setDays(load("osc.days", 0));
  }, []);
  useEffect(() => {
    getJson<OscData>(`/api/osc?days=${Math.max(days, 0)}`).then(setData).catch((e) => setErr(e.message));
    getJson<SymbolFibs[]>("/api/symbol-fibs").then(setBoard).catch(() => {});
  }, [refresh, days]);
  const boardBySymbol = useMemo(() => new Map(board.map((b) => [b.symbol, b])), [board]);

  const rows = useMemo(() => {
    const by = new Map<string, OscSignal[]>();
    for (const o of data?.signals ?? []) {
      if (!tfs.includes(o.tf) || (side !== "all" && o.side !== side) || !o.symbol.includes(q.toUpperCase())) continue;
      if (o.ended_t && days === 0) continue;
      by.set(o.symbol, [...(by.get(o.symbol) ?? []), o]);
    }
    const reading = new Map((data?.readings ?? []).map((r) => [`${r.symbol}|${r.tf}`, r]));
    const newest = (list: OscSignal[]) => Math.max(...list.filter((o) => !o.ended_t).map((o) => new Date(o.started_t).getTime()), 0);
    return [...by.entries()]
      .map(([symbol, list]) => ({ symbol, list, reading: (tf: string) => reading.get(`${symbol}|${tf}`) }))
      .sort((a, b) => newest(b.list) - newest(a.list) || a.symbol.localeCompare(b.symbol));
  }, [data, tfs, side, q, days]);

  const level = data?.level ?? 80;
  return (
    <>
      <div className="panel row">
        <input type="text" placeholder="Filter symbols" value={q} onChange={(e) => setQ(e.target.value)} />
        <Chips options={OSC_TFS} value={tfs} onChange={(v) => { setTfs(v); save("osc.tfs", v); }} render={tfLabel} />
        <select value={side} onChange={(e) => { const v = e.target.value as "all" | "ob" | "os"; setSide(v); save("osc.side", v); }}>
          <option value="all">Above +{level} and below -{level}</option>
          <option value="ob">🌡️ Above +{level} only</option>
          <option value="os">🧊 Below -{level} only</option>
        </select>
        <select value={days} onChange={(e) => { const v = Number(e.target.value); setDays(v); save("osc.days", v); }}>
          <option value={0}>Only what&apos;s beyond the level now</option>
          <option value={1}>Also ones that ended in the last day</option>
          <option value={3}>… last 3 days</option>
          <option value={7}>… last 7 days</option>
        </select>
        <span className="small muted">
          {rows.length} symbols. The Prime Oscillator+ main line, worked out from Bitget candles at each candle close (same formula and default
          settings as your TradingView script: length 14, smoothing 3, sensitivity 1.1). The level is set on the Telegram tab.
          Fibs: every fib on 1H, 2H, 4H, 8H, 1D and 1W; ✅ = level already hit, ⏳ = waiting, with the distance from the price now.
        </span>
      </div>
      {err && <div className="panel status-err">{err}</div>}
      <div className="panel tablewrap">
        {data && rows.length === 0 ? (
          <div className="empty">
            {data.readings.length ? `No symbol has the oscillator beyond ±${level} on these timeframes right now.` : "No oscillator values yet. They appear after the next check (every 15 minutes)."}
          </div>
        ) : (
          <table className="board">
            <thead><tr><th>Symbol</th>{OSC_TFS.filter((t) => tfs.includes(t)).map((t) => <th key={t}>{tfLabel(t)}</th>)}<th>Fibs 1H–1W</th></tr></thead>
            <tbody>
              {rows.map(({ symbol, list, reading }) => {
                const st = fibStatus(boardBySymbol.get(symbol));
                const latestHit = st.hit[0];
                const nearest = st.waiting[0];
                return (
                  <tr key={symbol}>
                    <td><strong>{symbol}</strong></td>
                    {OSC_TFS.filter((t) => tfs.includes(t)).map((t) => {
                      const here = list.filter((o) => o.tf === t);
                      const r = reading(t);
                      return (
                        <td key={t}>
                          {here.map((o) => <OscLine key={o.id} o={o} fmt={fmt} />)}
                          {!here.some((o) => !o.ended_t) && r && <span className="line old small">now {signed(r.value)}</span>}
                        </td>
                      );
                    })}
                    <td>
                      {!st.fibs.length ? <span className="muted small">No fibs on 1H–1W</span> : (
                        <>
                          <div className="small">
                            {latestHit ? (
                              <div>✅ <b>Hit</b> {st.hit.length} level{st.hit.length === 1 ? "" : "s"} · latest {tfLabel(latestHit.f.tf)} {latestHit.f.direction === "bull" ? "🟢" : "🔴"} {latestHit.l.ratio} {fmtPrice(latestHit.l.price)} <span className="muted">{ago(latestHit.l.hit_at!)}</span></div>
                            ) : <div className="muted">✅ No level hit yet</div>}
                            {nearest ? (
                              <div>⏳ <b>Waiting</b> {st.waiting.length} level{st.waiting.length === 1 ? "" : "s"} · nearest {tfLabel(nearest.f.tf)} {nearest.f.direction === "bull" ? "🟢" : "🔴"} {nearest.l.ratio} {fmtPrice(nearest.l.price)}
                                {nearest.dist != null && <span className="muted"> ({nearest.dist > 0 ? "+" : ""}{nearest.dist.toFixed(2)}%)</span>}</div>
                            ) : <div className="muted">⏳ Nothing left waiting</div>}
                          </div>
                          <details>
                            <summary className="small muted">All {st.fibs.length} fibs</summary>
                            <CellFibs fibs={st.fibs} fmt={fmt} />
                          </details>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────── Uploads ───────────────────────────────

function Uploads({ fmt, refresh, onChange }: { fmt: (s: string) => string; refresh: number; onChange: () => void }) {
  const [rows, setRows] = useState<Upload[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<Upload[]>(`/api/uploads`).then(setRows).catch((e) => setErr(e.message));
  }, [refresh]);

  const remove = async (id: number) => {
    if (!window.confirm("Delete this upload and any signals only it contained?")) return;
    const r = await fetch(`/api/uploads/${id}`, { method: "DELETE" });
    if (!r.ok) setErr((await r.json()).error);
    onChange();
  };

  return (
    <div className="panel tablewrap">
      {err && <div className="status-err">{err}</div>}
      {rows && rows.length === 0 ? <div className="empty">No uploads yet.</div> : (
        <table>
          <thead><tr><th>Snapshot time</th><th>Screener</th><th>File</th><th>Signals</th><th>New</th><th>Warnings</th><th></th></tr></thead>
          <tbody>
            {rows?.map((u) => (
              <tr key={u.id}>
                <td className="nowrap">{fmt(u.captured_at)}<div className="small muted">uploaded {fmt(u.created_at)}</div></td>
                <td><span className={`badge ${u.source}`}>{u.source === "structure" ? "BOS/CHoCH" : "Divergence"}</span></td>
                <td className="small">{u.filename}</td>
                <td>{u.signal_count}</td>
                <td>{u.new_count}</td>
                <td>
                  {u.warnings.length > 0 && (
                    <details><summary className="warn">{u.warnings.length}</summary>
                      {u.warnings.map((w, k) => <div key={k} className="warn">{w}</div>)}
                    </details>
                  )}
                </td>
                <td><button className="btn danger small" onClick={() => remove(u.id)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─────────────────────────────── Page ───────────────────────────────

export default function Page() {
  const [tab, setTab] = useState<Tab>("matches");
  const [tz, setTz] = useState("Asia/Kolkata");
  const [refresh, setRefresh] = useState(0);
  const fmt = useFmt(tz);
  const bump = useCallback(() => setRefresh((n) => n + 1), []);
  const [alarm, setAlarm] = useAlarm();

  useEffect(() => {
    setTab(load<Tab>("tab", "matches"));
    setTz(load("tz", "Asia/Kolkata"));
  }, []);

  const tabs: Array<[Tab, string]> = [
    ["matches", "Gold → BOS/CHoCH"],
    ["hits", "Fib hits 🔔"],
    ["myalerts", "My alerts ⏰"],
    ["fib", "Gold → Fib"],
    ["osc", "Prime Osc 🌡️"],
    ["trends", "Trends"],
    ["fibs", "Fibs"],
    ["signals", "Signals"],
    ["symbols", "Symbols"],
    ["uploads", "Uploads"],
    ["alerts", "Telegram"],
  ];

  return (
    <div className="wrap">
      <header className="top">
        <h1>Confluence Radar</h1>
        <span className="spacer" />
        <FibAlarm alarm={alarm} setAlarm={setAlarm} onHits={bump} />
        <label className="small muted">Show times in&nbsp;
          <select value={tz} onChange={(e) => { setTz(e.target.value); save("tz", e.target.value); }}>
            {DISPLAY_TZS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
          </select>
        </label>
      </header>
      <Uploader onDone={bump} />
      <nav className="tabs">
        {tabs.map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => { setTab(k); save("tab", k); }}>{l}</button>
        ))}
      </nav>
      {tab === "matches" && <Matches fmt={fmt} refresh={refresh} />}
      {tab === "hits" && <FibHits fmt={fmt} refresh={refresh} alarm={alarm} setAlarm={setAlarm} />}
      {tab === "myalerts" && <PriceAlerts fmt={fmt} refresh={refresh} alarm={alarm} setAlarm={setAlarm} />}
      {tab === "fib" && <FibSignals fmt={fmt} refresh={refresh} />}
      {tab === "osc" && <PrimeOsc fmt={fmt} refresh={refresh} />}
      {tab === "trends" && <Trends fmt={fmt} refresh={refresh} />}
      {tab === "fibs" && <Fibs fmt={fmt} refresh={refresh} />}
      {tab === "alerts" && <Alerts fmt={fmt} />}
      {tab === "signals" && <Signals fmt={fmt} refresh={refresh} />}
      {tab === "symbols" && <Symbols fmt={fmt} refresh={refresh} />}
      {tab === "uploads" && <Uploads fmt={fmt} refresh={refresh} onChange={bump} />}
    </div>
  );
}
