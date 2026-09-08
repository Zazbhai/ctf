-- Codeverse CTF Platform — SQLite Schema
-- Auto-run on server startup

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  role TEXT DEFAULT 'participant',
  approved INTEGER DEFAULT 0,
  disqualified INTEGER DEFAULT 0,
  team TEXT DEFAULT '',
  team_id TEXT DEFAULT '',
  score INTEGER DEFAULT 0,
  current_challenge TEXT,
  tab_switches INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Many-to-many: which challenges each user has solved
CREATE TABLE IF NOT EXISTS solved_challenges (
  user_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  solved_at TEXT NOT NULL,
  PRIMARY KEY (user_id, challenge_id)
);

-- Hints revealed per user per challenge
CREATE TABLE IF NOT EXISTS hint_reveals (
  user_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  hint_index INTEGER NOT NULL,
  revealed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, challenge_id, hint_index)
);

-- Full audit log of every submission attempt
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT NOT NULL
);

-- Vulnerability quiz answer selections (stored as JSON array)
CREATE TABLE IF NOT EXISTS vuln_selections (
  user_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  selections TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, challenge_id)
);

-- Tactical skips per user per challenge
CREATE TABLE IF NOT EXISTS skipped_challenges (
  user_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  skipped_at TEXT NOT NULL,
  PRIMARY KEY (user_id, challenge_id)
);
