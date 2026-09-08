'use strict';

const path = require('path');
const fs = require('fs');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('[DB] better-sqlite3 not installed. Run: npm install');
  process.exit(1);
}

const DB_PATH = path.join(__dirname, '..', 'codeverse.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema migrations
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// Migration: add tab_switches column if missing (for existing databases)
try {
  db.exec('ALTER TABLE users ADD COLUMN tab_switches INTEGER DEFAULT 0');
} catch (_) { /* column already exists */ }

/**
 * Seed default users on first run.
 * Passwords are bcrypt-hashed. We do this lazily (only if table is empty).
 */
async function seedDefaultUsers() {
  const bcrypt = require('bcrypt');
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  if (count > 0) return;

  console.log('[DB] Seeding default users...');

  const defaults = [
    { id: 'u1', username: 'demo',         password: 'demo123',   role: 'participant', approved: 1, team: 'Team Raven',    teamId: 't1', score: 0 },
    { id: 'u2', username: 'null_byte',     password: 'null123',   role: 'participant', approved: 1, team: 'Team Null',     teamId: 't2', score: 125 },
    { id: 'u3', username: 'kernel_panic',  password: 'kernel123', role: 'participant', approved: 1, team: 'Team Kernel',   teamId: 't3', score: 75  },
    { id: 'admin', username: 'admin',      password: 'admin123',  role: 'admin',       approved: 1, team: 'Organizers',   teamId: 'admin', score: 0 },
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO users
      (id, username, password_hash, name, phone, email, role, approved, disqualified, team, team_id, score, created_at)
    VALUES
      (@id, @username, @password_hash, '', '', '', @role, @approved, 0, @team, @teamId, @score, @createdAt)
  `);

  const insertSolve = db.prepare(`
    INSERT OR IGNORE INTO solved_challenges (user_id, challenge_id, solved_at) VALUES (?, ?, ?)
  `);

  const hashedDefaults = [];
  for (const u of defaults) {
    const hash = await bcrypt.hash(u.password, 10);
    hashedDefaults.push({ ...u, password_hash: hash, createdAt: new Date().toISOString() });
  }

  const insertMany = db.transaction(() => {
    for (const u of hashedDefaults) {
      insert.run(u);
    }
    // Seed some solved challenges for demo users
    const now = new Date().toISOString();
    insertSolve.run('u2', 'OSINT-01', now);
    insertSolve.run('u2', 'OSINT-02', now);
    insertSolve.run('u2', 'OSINT-03', now);
    insertSolve.run('u3', 'OSINT-01', now);
    insertSolve.run('u3', 'OSINT-02', now);
  });

  insertMany();
  console.log('[DB] Default users seeded.');
}

/**
 * Build a full user object (with solvedChallenges, revealedHints, submissions arrays)
 * from the normalized tables — matching the shape the frontend expects.
 */
function getFullUser(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  return hydrate(user);
}

function getFullUserByUsername(username) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  return hydrate(user);
}

function hydrate(row) {
  const solvedRows = db.prepare(
    'SELECT challenge_id, solved_at FROM solved_challenges WHERE user_id = ? ORDER BY solved_at ASC'
  ).all(row.id);
  const solvedChallenges = solvedRows.map(r => r.challenge_id);
  const solvedDetails = solvedRows.map(r => ({
    challengeId: r.challenge_id,
    solvedAt: r.solved_at,
  }));

  const revealedHints = db.prepare(
    'SELECT challenge_id, hint_index FROM hint_reveals WHERE user_id = ? ORDER BY revealed_at'
  ).all(row.id).map(r => `${r.challenge_id}:${r.hint_index}`);

  const submissions = db.prepare(
    'SELECT challenge_id, answer, correct, submitted_at FROM submissions WHERE user_id = ? ORDER BY submitted_at ASC LIMIT 500'
  ).all(row.id).map(s => ({
    challengeId: s.challenge_id,
    answer: s.answer,
    value: s.answer,
    correct: !!s.correct,
    submitted_at: s.submitted_at,
    timestamp: s.submitted_at,
  }));

  const skippedRows = db.prepare(
    'SELECT challenge_id FROM skipped_challenges WHERE user_id = ? ORDER BY skipped_at ASC'
  ).all(row.id);
  const skippedChallenges = skippedRows.map(r => r.challenge_id);
  const skipsUsed = skippedChallenges.length;

  return {
    id: row.id,
    username: row.username,
    name: row.name || '',
    phone: row.phone || '',
    email: row.email || '',
    role: row.role,
    approved: !!row.approved,
    disqualified: !!row.disqualified,
    team: row.team || row.username,
    teamId: row.team_id || row.id,
    score: row.score,
    currentChallenge: row.current_challenge || null,
    tabSwitches: row.tab_switches || 0,
    createdAt: row.created_at,
    solvedChallenges,
    solvedDetails,
    revealedHints,
    skippedChallenges,
    skipsUsed,
    submissions,
  };
}

/** Get all non-admin users (hydrated) for admin panel / leaderboard */
function getAllUsers({ includeAdmin = false } = {}) {
  let rows;
  if (includeAdmin) {
    rows = db.prepare('SELECT id FROM users ORDER BY score DESC, created_at ASC').all();
  } else {
    rows = db.prepare('SELECT id FROM users WHERE role != ? ORDER BY score DESC, created_at ASC').all('admin');
  }
  return rows.map(r => getFullUser(r.id));
}

module.exports = { db, seedDefaultUsers, getFullUser, getFullUserByUsername, getAllUsers };
