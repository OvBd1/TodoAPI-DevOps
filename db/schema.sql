CREATE TABLE IF NOT EXISTS tasks (
  id          UUID PRIMARY KEY,
  description TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);
