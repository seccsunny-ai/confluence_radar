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
  `);
}
