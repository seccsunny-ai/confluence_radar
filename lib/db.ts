import postgres from "postgres";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;

declare global {
  // eslint-disable-next-line no-var
  var __sql: postgres.Sql | undefined;
  // eslint-disable-next-line no-var
  var __schemaReady: Promise<void> | undefined;
}

export function sql(): postgres.Sql {
  if (!url) throw new Error("DATABASE_URL is not set.");
  globalThis.__sql ??= postgres(url, {
    max: 3,
    idle_timeout: 20,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require",
    // Neon's pooled endpoints (PgBouncer) do not support prepared statements.
    prepare: false,
    onnotice: () => {},
  });
  return globalThis.__sql;
}

export async function db(): Promise<postgres.Sql> {
  const s = sql();
  globalThis.__schemaReady ??= migrate(s).catch((e) => {
    globalThis.__schemaReady = undefined;
    throw e;
  });
  await globalThis.__schemaReady;
  return s;
}

async function migrate(s: postgres.Sql) {
  await s.unsafe(`
    CREATE TABLE IF NOT EXISTS uploads (
      id            SERIAL PRIMARY KEY,
      filename      TEXT,
      source        TEXT NOT NULL,
      captured_at   TIMESTAMPTZ NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      tz_offset_min INTEGER NOT NULL,
      signal_count  INTEGER NOT NULL DEFAULT 0,
      new_count     INTEGER NOT NULL DEFAULT 0,
      warnings      JSONB NOT NULL DEFAULT '[]',
      raw           JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signals (
      id              SERIAL PRIMARY KEY,
      symbol          TEXT NOT NULL,
      source          TEXT NOT NULL,
      tf              TEXT NOT NULL,
      code            TEXT NOT NULL,
      family          TEXT NOT NULL,
      direction       TEXT NOT NULL,
      signal_time     TIMESTAMPTZ NOT NULL,
      first_seen_at   TIMESTAMPTZ NOT NULL,
      last_seen_at    TIMESTAMPTZ NOT NULL,
      UNIQUE (symbol, tf, code, signal_time)
    );
    CREATE INDEX IF NOT EXISTS signals_symbol_time ON signals (symbol, signal_time);
    CREATE INDEX IF NOT EXISTS signals_code_time ON signals (code, signal_time);
    CREATE TABLE IF NOT EXISTS sightings (
      upload_id     INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      signal_id     INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
      recent_badge  BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (upload_id, signal_id)
    );
    CREATE INDEX IF NOT EXISTS sightings_signal ON sightings (signal_id);
    -- Manual fixes for misread signals, applied again whenever a later upload reads the same cell the same wrong way.
    -- to_code NULL means the signal should not exist at all.
    CREATE TABLE IF NOT EXISTS corrections (
      symbol      TEXT NOT NULL,
      tf          TEXT NOT NULL,
      from_code   TEXT NOT NULL,
      signal_time TIMESTAMPTZ NOT NULL,
      to_code     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (symbol, tf, from_code, signal_time)
    );
    -- Fib retracements the user drew in TradingView. bull = green (bullish retest), bear = red.
    CREATE TABLE IF NOT EXISTS fibs (
      id          SERIAL PRIMARY KEY,
      symbol      TEXT NOT NULL,
      tf          TEXT NOT NULL,
      direction   TEXT NOT NULL,
      high        DOUBLE PRECISION NOT NULL,
      low         DOUBLE PRECISION NOT NULL,
      note        TEXT,
      active      BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- First time price reached a matching fib after a Gold signal, and the BOS/CHoCH that followed.
    CREATE TABLE IF NOT EXISTS fib_hits (
      gold_id         INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
      fib_id          INTEGER NOT NULL REFERENCES fibs(id) ON DELETE CASCADE,
      ratio           DOUBLE PRECISION NOT NULL,
      level           DOUBLE PRECISION NOT NULL,
      touched_at      TIMESTAMPTZ NOT NULL,
      at_signal       BOOLEAN NOT NULL,
      structure_id    INTEGER REFERENCES signals(id) ON DELETE SET NULL,
      detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (gold_id, fib_id)
    );
    CREATE TABLE IF NOT EXISTS trends (
      symbol      TEXT NOT NULL,
      tf          TEXT NOT NULL,
      trend       TEXT NOT NULL,
      potential   TEXT,
      since       TIMESTAMPTZ,
      last_high   JSONB,
      last_low    JSONB,
      price       DOUBLE PRECISION,
      note        TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (symbol, tf)
    );
    -- Fibs drawn from the swing structure (autofib.ts): one per leg, keyed by where the leg started.
    ALTER TABLE fibs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE fibs ADD COLUMN IF NOT EXISTS anchor_t TIMESTAMPTZ;
    ALTER TABLE fibs ADD COLUMN IF NOT EXISTS high_t TIMESTAMPTZ;
    ALTER TABLE fibs ADD COLUMN IF NOT EXISTS low_t TIMESTAMPTZ;
    ALTER TABLE fibs ADD COLUMN IF NOT EXISTS forming BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE fibs ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS fibs_auto_leg ON fibs (symbol, tf, direction, anchor_t) WHERE source = 'auto';
    -- The last closed candle the auto fibs were worked out from, so each timeframe is redone only after a new close.
    CREATE TABLE IF NOT EXISTS fib_runs (
      symbol       TEXT NOT NULL,
      tf           TEXT NOT NULL,
      last_closed  TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (symbol, tf)
    );
    -- Closed candles kept for timeframes where Bitget only serves about 90 days per call (4H, 1D), so the swing
    -- structure can see further back. done = the history has been fetched back as far as needed (or as it goes).
    CREATE TABLE IF NOT EXISTS candles (
      symbol  TEXT NOT NULL,
      tf      TEXT NOT NULL,
      t       BIGINT NOT NULL,
      o       DOUBLE PRECISION NOT NULL,
      h       DOUBLE PRECISION NOT NULL,
      l       DOUBLE PRECISION NOT NULL,
      c       DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (symbol, tf, t)
    );
    CREATE TABLE IF NOT EXISTS candle_sets (
      symbol  TEXT NOT NULL,
      tf      TEXT NOT NULL,
      done    BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (symbol, tf)
    );
    -- 1D and 1W fibs first drawn from only 90 days of candles: redo them once the longer history is in.
    DELETE FROM fib_runs WHERE tf IN ('1D', '1W') AND NOT EXISTS (SELECT 1 FROM candle_sets);
    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  JSONB NOT NULL
    );
    -- One row per Telegram alert sent, so nothing is sent twice.
    CREATE TABLE IF NOT EXISTS alerts (
      key      TEXT PRIMARY KEY,
      text     TEXT NOT NULL,
      sent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ticks (
      id          SERIAL PRIMARY KEY,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      summary     JSONB NOT NULL
    );
  `);
}
