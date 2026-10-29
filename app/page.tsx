"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GOLD_WINDOW_DAYS, SIGNAL_BY_CODE, SIGNALS } from "@/lib/signals";
import { ago, Chips, getJson, Sig } from "./ui";
import { Alerts, Fibs, FibSignals, Trends } from "./confluence";

type Tab = "matches" | "fib" | "trends" | "fibs" | "signals" | "symbols" | "uploads" | "alerts";

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

function Symbols({ fmt, refresh }: { fmt: (s: string) => string; refresh: number }) {
  const [rows, setRows] = useState<Signal[] | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<Signal[]>(`/api/symbols`).then(setRows).catch((e) => setErr(e.message));
  }, [refresh]);

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
    return {
      symbols,
      tfs: [...tfSet].sort(tfSort),
      cell: (s: string, tf: string) => (map.get(`${s}|${tf}`) ?? []).sort((a, b) => famOrder.indexOf(a.family) - famOrder.indexOf(b.family)),
    };
  }, [rows, q]);

  return (
    <>
      <div className="panel row">
        <input type="text" placeholder="Filter symbols" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="small muted">{symbols.length} symbols. Latest signal of each kind per timeframe; ⚡ rows are under 24 hours old.</span>
      </div>
      {err && <div className="panel status-err">{err}</div>}
      <div className="panel tablewrap">
        {rows && rows.length === 0 ? <div className="empty">Upload a screenshot to get started.</div> : (
          <table className="board">
            <thead><tr><th>Symbol</th>{tfs.map((t) => <th key={t}>{t}</th>)}</tr></thead>
            <tbody>
              {symbols.map((s) => (
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
                    </td>
                  ))}
                </tr>
              ))}
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

  useEffect(() => {
    setTab(load<Tab>("tab", "matches"));
    setTz(load("tz", "Asia/Kolkata"));
  }, []);

  const tabs: Array<[Tab, string]> = [
    ["matches", "Gold → BOS/CHoCH"],
    ["fib", "Gold → Fib"],
    ["trends", "Trends"],
    ["fibs", "My fibs"],
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
      {tab === "fib" && <FibSignals fmt={fmt} refresh={refresh} />}
      {tab === "trends" && <Trends fmt={fmt} refresh={refresh} />}
      {tab === "fibs" && <Fibs refresh={refresh} />}
      {tab === "alerts" && <Alerts fmt={fmt} />}
      {tab === "signals" && <Signals fmt={fmt} refresh={refresh} />}
      {tab === "symbols" && <Symbols fmt={fmt} refresh={refresh} />}
      {tab === "uploads" && <Uploads fmt={fmt} refresh={refresh} onChange={bump} />}
    </div>
  );
}
