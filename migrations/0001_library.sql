-- __ENV__ is replaced only by the deployment's fixed staging/production value.
CREATE TABLE __ENV___users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE __ENV___sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES __ENV___users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX __ENV___sessions_user ON __ENV___sessions(user_id);
CREATE INDEX __ENV___sessions_expiry ON __ENV___sessions(expires_at);

CREATE TABLE __ENV___maps (
  user_id TEXT PRIMARY KEY REFERENCES __ENV___users(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at INTEGER NOT NULL,
  share_id TEXT UNIQUE
);
