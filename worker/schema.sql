-- Survey access log. Apply with:
--   npx wrangler d1 execute survey-log --remote --file schema.sql
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,   -- UTC, ISO 8601
  token   TEXT NOT NULL,   -- survey link token
  event   TEXT NOT NULL,   -- "view" or "download"
  file    TEXT,            -- download path inside the survey folder
  visitor TEXT,            -- short hash of IP + browser, per survey (no raw IP kept)
  country TEXT,
  region  TEXT,
  city    TEXT,
  device  TEXT             -- e.g. "Windows · Chrome"
);
CREATE INDEX IF NOT EXISTS events_token_ts ON events (token, ts);
