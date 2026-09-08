'use strict';

/* ============================================================
   CODEVERSE — API + Static File Server
   Express + SQLite (better-sqlite3) + Redis (ioredis / fallback)
   ============================================================ */

const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const express = require('express');

const { db, seedDefaultUsers, getFullUser, getFullUserByUsername, getAllUsers } = require('./db');
const { createRedisClient, KEYS } = require('./redis');

let bcrypt, uuidv4;
try { bcrypt  = require('bcrypt');       } catch { bcrypt  = null; }
try { uuidv4  = require('uuid').v4;     } catch { uuidv4  = () => crypto.randomUUID(); }

const PORT  = process.env.PORT || 3000;
const SALT  = 10;

let redis;

// ── Helpers ───────────────────────────────────────────────

/** Hash a password (bcrypt if available, else SHA-256 fallback) */
async function hashPassword(plain) {
  if (bcrypt) return bcrypt.hash(plain, SALT);
  return crypto.createHash('sha256').update(plain).digest('hex');
}

/** Compare a plain password against a stored hash */
async function verifyPassword(plain, hash) {
  if (bcrypt) {
    // Handle both bcrypt hashes and legacy sha256 hashes
    if (hash.startsWith('$2')) return bcrypt.compare(plain, hash);
  }
  return crypto.createHash('sha256').update(plain).digest('hex') === hash;
}

/** Create a session token in Redis (TTL: 8 hours) */
async function createSession(user) {
  const token = uuidv4();
  await redis.hset(KEYS.session(token), 'userId', user.id, 'username', user.username, 'role', user.role);
  await redis.expire(KEYS.session(token), 8 * 3600); // 8 hours
  return token;
}

function getSeededRandom(seedStr) {
  let h = 0x811c9dc5;
  const s = String(seedStr || 'default_seed');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return function() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seedStr) {
  const result = [...arr];
  const rng = getSeededRandom(seedStr);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function resolveUserChallenge(challengesData, challengeId, userId) {
  let challenge = challengesData.challenges.find(c => c.id === challengeId);
  if (challengeId && challengeId.startsWith('CODE-') && userId) {
    const allCode = challengesData.challenges.filter(c => c.round === 3);
    const shuffled = seededShuffle(allCode, 'code_order_' + userId);
    const codeIdx = parseInt(challengeId.replace(/^CODE-0?/i, '')) - 1;
    if (codeIdx >= 0 && codeIdx < 5 && shuffled[codeIdx]) {
      challenge = { ...shuffled[codeIdx], id: challengeId, originalId: shuffled[codeIdx].id };
    }
  }
  return challenge;
}

/** Validate a session token; returns { userId, username, role } or null */
async function getSession(token) {
  if (!token) return null;
  return redis.hgetall(KEYS.session(token));
}

/** Auth middleware — reads Bearer token from Authorization header or cookie */
async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const cookieToken = req.headers['cookie']
    ? (req.headers['cookie'].split(';').find(c => c.trim().startsWith('cv_token=')) || '').split('=')[1]
    : '';
  const token = authHeader.replace('Bearer ', '').trim() || cookieToken;
  const session = await getSession(token);
  if (session && session.userId) {
    req.session = session;
    req.user = getFullUser(session.userId);
  }
  next();
}

/** Require a valid session */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

/** Require admin role */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

/** Invalidate leaderboard cache after any score change */
async function bustLeaderboard() {
  await redis.del(KEYS.leaderboard);
}

// ── Express App ───────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(authMiddleware);

// ── Auth Helpers ───────────────────────────────────────────

function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '');
}

function isPhoneTaken(phone) {
  const norm = normalizePhone(phone);
  if (!norm || norm.length < 6) return false;
  const rows = db.prepare("SELECT phone FROM users WHERE phone IS NOT NULL AND phone != ''").all();
  return rows.some(r => normalizePhone(r.phone) === norm);
}

function isUsernameTaken(username) {
  if (!username) return false;
  const row = db.prepare('SELECT id FROM users WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))').get(username);
  return !!row;
}

// ── Auth Routes ───────────────────────────────────────────

/** GET /api/auth/check — check if username or phone is already taken */
app.get('/api/auth/check', (req, res) => {
  const { username, phone } = req.query;
  const result = {};
  if (typeof username === 'string' && username.trim()) {
    result.usernameTaken = isUsernameTaken(username);
    result.usernameAvailable = !result.usernameTaken;
  }
  if (typeof phone === 'string' && phone.trim()) {
    result.phoneTaken = isPhoneTaken(phone);
    result.phoneAvailable = !result.phoneTaken;
  }
  res.json(result);
});

/** POST /api/auth/register */
app.post('/api/auth/register', async (req, res) => {
  let { username, password, name = '', phone = '' } = req.body;
  username = String(username || '').trim();
  password = String(password || '');
  name = String(name || '').trim();
  phone = String(phone || '').trim();

  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!/^[a-zA-Z0-9_\-\.]{3,32}$/.test(username))
    return res.status(400).json({ error: 'Username must be 3-32 chars (letters, numbers, _ - .).' });

  // 1. Check duplicate username (case-insensitive)
  if (isUsernameTaken(username)) {
    return res.status(409).json({ error: 'Username already taken. Please choose another codename.' });
  }

  // 2. Check duplicate phone number (normalized digits)
  const phoneNorm = normalizePhone(phone);
  if (phone && phoneNorm.length < 6) {
    return res.status(400).json({ error: 'Please enter a valid phone number (at least 6 digits).' });
  }

  if (phone && isPhoneTaken(phone)) {
    return res.status(409).json({ error: 'Phone number already registered. Please use another number or log in.' });
  }

  const id = 'u_' + Date.now();
  const password_hash = await hashPassword(password);
  const team_id = 't_' + Date.now();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (id, username, password_hash, name, phone, email, role, approved, disqualified, team, team_id, score, created_at)
    VALUES (?, ?, ?, ?, ?, '', 'participant', 0, 0, ?, ?, 0, ?)
  `).run(id, username, password_hash, name, phone, name || username, team_id, now);

  const user = getFullUser(id);
  const token = await createSession(user);
  res.json({ token, user });
});

/** POST /api/auth/login */
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row) return res.status(401).json({ error: 'Invalid credentials.' });

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

  const user = getFullUser(row.id);
  const token = await createSession(user);
  res.json({ token, user });
});

/** POST /api/auth/logout */
app.post('/api/auth/logout', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (token) await redis.del(KEYS.session(token));
  res.json({ ok: true });
});

/** GET /api/session — validate and refresh session */
app.get('/api/session', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

/** GET /api/auth/me — return current authenticated user */
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// ── User Routes ───────────────────────────────────────────

/** GET /api/users — admin: all users; participant: self only */
app.get('/api/users', requireAuth, (req, res) => {
  if (req.user.role === 'admin') {
    return res.json(getAllUsers({ includeAdmin: true }));
  }
  res.json([req.user]);
});

/** PUT /api/users/:id/approve */
app.put('/api/users/:id/approve', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET approved = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true, user: getFullUser(req.params.id) });
});

/** PUT /api/users/:id/disqualify */
app.put('/api/users/:id/disqualify', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET disqualified = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/** PUT /api/users/:id/restore */
app.put('/api/users/:id/restore', requireAuth, requireAdmin, async (req, res) => {
  db.prepare('UPDATE users SET disqualified = 0, approved = 1, tab_switches = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true, user: getFullUser(req.params.id) });
});

/** PUT /api/users/:id/reset-violations */
app.put('/api/users/:id/reset-violations', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET tab_switches = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true, user: getFullUser(req.params.id) });
});

/** DELETE /api/users/:id */
app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const uid = req.params.id;
  db.prepare('DELETE FROM users WHERE id = ?').run(uid);
  db.prepare('DELETE FROM solved_challenges WHERE user_id = ?').run(uid);
  db.prepare('DELETE FROM hint_reveals WHERE user_id = ?').run(uid);
  db.prepare('DELETE FROM submissions WHERE user_id = ?').run(uid);
  db.prepare('DELETE FROM vuln_selections WHERE user_id = ?').run(uid);
  await bustLeaderboard();
  res.json({ ok: true });
});

/** PUT /api/users/:id/reset — reset score + solves for a single user */
app.put('/api/users/:id/reset', requireAuth, requireAdmin, async (req, res) => {
  const uid = req.params.id;
  db.prepare('UPDATE users SET score = 0, current_challenge = NULL, disqualified = 0, tab_switches = 0 WHERE id = ?').run(uid);
  db.prepare('DELETE FROM solved_challenges WHERE user_id = ?').run(uid);
  db.prepare('DELETE FROM hint_reveals WHERE user_id = ?').run(uid);
  db.prepare('DELETE FROM submissions WHERE user_id = ?').run(uid);
  await bustLeaderboard();
  res.json({ ok: true, user: getFullUser(uid) });
});

/** PUT /api/users/reset-all — admin: reset all participants */
app.put('/api/users/reset-all', requireAuth, requireAdmin, async (req, res) => {
  db.prepare('UPDATE users SET score = 0, current_challenge = NULL, disqualified = 0, tab_switches = 0 WHERE role != ?').run('admin');
  db.prepare("DELETE FROM solved_challenges WHERE user_id IN (SELECT id FROM users WHERE role != 'admin')").run();
  db.prepare("DELETE FROM hint_reveals WHERE user_id IN (SELECT id FROM users WHERE role != 'admin')").run();
  db.prepare("DELETE FROM submissions WHERE user_id IN (SELECT id FROM users WHERE role != 'admin')").run();
  await bustLeaderboard();
  res.json({ ok: true });
});

/** POST /api/admin/clear-all — admin: permanently delete all participants, approvals, submissions, and progress */
app.post('/api/admin/clear-all', requireAuth, requireAdmin, async (req, res) => {
  try {
    const deleteParticipants = db.transaction(() => {
      db.prepare("DELETE FROM solved_challenges WHERE user_id != 'admin'").run();
      db.prepare("DELETE FROM hint_reveals WHERE user_id != 'admin'").run();
      db.prepare("DELETE FROM submissions WHERE user_id != 'admin'").run();
      db.prepare("DELETE FROM vuln_selections WHERE user_id != 'admin'").run();
      db.prepare("DELETE FROM skipped_challenges WHERE user_id != 'admin'").run();
      const result = db.prepare("DELETE FROM users WHERE role != 'admin'").run();
      return result.changes;
    });

    const deletedCount = deleteParticipants();
    await bustLeaderboard();

    // Clean up non-admin redis session & rate limit keys
    try {
      if (typeof redis.keys === 'function') {
        const keys = await redis.keys('*');
        for (const k of keys) {
          if (k.startsWith('rate:')) await redis.del(k);
          if (k.startsWith('session:')) {
            const userId = await redis.hget(k, 'userId');
            if (userId && userId !== 'admin') await redis.del(k);
          }
        }
      }
    } catch {}

    res.json({ ok: true, deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to clear users' });
  }
});

/** PUT /api/users/:id/current-challenge */
app.put('/api/users/:id/current-challenge', requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id)
    return res.status(403).json({ error: 'Forbidden' });
  const { challengeId } = req.body;
  db.prepare('UPDATE users SET current_challenge = ? WHERE id = ?').run(challengeId || null, req.params.id);
  res.json({ ok: true });
});

// ── Submission Route ──────────────────────────────────────

/** POST /api/submit — submit a flag answer */
app.post('/api/submit', requireAuth, async (req, res) => {
  const { challengeId, answer } = req.body;
  const user = req.user;

  if (!challengeId || !answer) return res.status(400).json({ error: 'challengeId and answer required.' });
  if (!user.approved) return res.status(403).json({ error: 'Account not approved yet.' });
  if (user.disqualified) return res.status(403).json({ error: 'Account disqualified.' });

  // Rate limit: 5 submissions per 10 minutes per challenge
  const rateKey = KEYS.rateLimit(user.id, challengeId);
  const count = await redis.incr(rateKey);
  if (count === 1) await redis.expire(rateKey, 10 * 60); // 10-minute window
  if (count > 5) {
    return res.status(429).json({ error: 'Rate limit: max 5 attempts per 10 minutes.', rateLimit: true });
  }

  // Already solved?
  const alreadySolved = db.prepare(
    'SELECT 1 FROM solved_challenges WHERE user_id = ? AND challenge_id = ?'
  ).get(user.id, challengeId);
  if (alreadySolved) return res.json({ correct: true, alreadySolved: true });

  // Load challenge from data files to check the flag
  // We return the raw answer to the frontend, which runs getUserChallengeFlag() on its side.
  // But the server also validates. We pass both the stored flag and the expected personalized flag.
  const challengesPath = path.join(__dirname, 'data', 'challenges.json');
  const challengesData = JSON.parse(fs.readFileSync(challengesPath, 'utf8'));
  const challenge = resolveUserChallenge(challengesData, challengeId, user.id);

  if (!challenge) return res.status(404).json({ error: 'Challenge not found.' });

  // Compute personalized flag (same algorithm as frontend getUserChallengeFlag)
  function getPersonalizedFlag(challengeId, userId) {
    const baseFlag = challenge.flag || challengeId;
    if (challengeId.startsWith('OSINT-') || challengeId.startsWith('CODE-') ||
        challenge.round === 1 || challenge.round === 3) {
      return baseFlag;
    }
    let h = 0x811c9dc5;
    const seed = `${userId}:${challengeId}:0xRAVEN_SALT_2026`;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const suffix = Math.abs(h).toString(16).toUpperCase().padStart(6, '0').slice(-6);
    return `${baseFlag}_${suffix}`;
  }

  const cleanAns = (s) => {
    if (!s) return '';
    return s.toString().trim().toUpperCase()
      .replace(/^FLAG\{/i, '')
      .replace(/\}$/, '')
      .replace(/[\s\-_]+/g, '_')
      .replace(/^_+|_+$/g, '');
  };

  const expectedFlag = getPersonalizedFlag(challengeId, user.id);
  const expectedNorm = cleanAns(expectedFlag);
  const expectedNormNoUnder = expectedNorm.replace(/_/g, '');
  const baseFlagNorm = cleanAns(challenge.flag || '');
  const baseFlagNormNoUnder = baseFlagNorm.replace(/_/g, '');

  const submissionCandidates = new Set();
  const rawTrimmed = String(answer || '').trim();
  submissionCandidates.add(cleanAns(rawTrimmed));
  submissionCandidates.add(cleanAns(rawTrimmed).replace(/_/g, ''));

  // 1. URL / Percent decoding
  if (rawTrimmed.includes('%')) {
    try {
      const uDec = decodeURIComponent(rawTrimmed);
      if (uDec && uDec !== rawTrimmed) {
        submissionCandidates.add(cleanAns(uDec));
        submissionCandidates.add(cleanAns(uDec).replace(/_/g, ''));
      }
    } catch (_) {}
  }

  // 2. Hexadecimal decoding
  const cleanHex = rawTrimmed.replace(/^0x/i, '').trim();
  if (/^[0-9A-Fa-f]{8,}$/.test(cleanHex) && cleanHex.length % 2 === 0) {
    try {
      let hexDec = '';
      for (let i = 0; i < cleanHex.length; i += 2) {
        hexDec += String.fromCharCode(parseInt(cleanHex.substr(i, 2), 16));
      }
      if (/^[\x20-\x7E]+$/.test(hexDec)) {
        submissionCandidates.add(cleanAns(hexDec));
        submissionCandidates.add(cleanAns(hexDec).replace(/_/g, ''));
      }
    } catch (_) {}
  }

  // 3. Base64 decoding
  if (/^[A-Za-z0-9+/=_-]{8,}$/.test(rawTrimmed)) {
    try {
      const b64Dec = Buffer.from(rawTrimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (b64Dec && /^[\x20-\x7E]+$/.test(b64Dec)) {
        submissionCandidates.add(cleanAns(b64Dec));
        submissionCandidates.add(cleanAns(b64Dec).replace(/_/g, ''));
      }
    } catch (_) {}
  }

  // 4. ROT13 decoding
  if (/[A-Za-z]/.test(rawTrimmed)) {
    try {
      const rotDec = rawTrimmed.replace(/[A-Za-z]/g, c => {
        const code = c.charCodeAt(0);
        const base = code >= 97 ? 97 : 65;
        return String.fromCharCode(((code - base + 13) % 26) + base);
      });
      if (rotDec && rotDec !== rawTrimmed) {
        submissionCandidates.add(cleanAns(rotDec));
        submissionCandidates.add(cleanAns(rotDec).replace(/_/g, ''));
      }
    } catch (_) {}
  }

  // 5. Morse code pulse decoding
  if (/^[.\-\s/]+$/.test(rawTrimmed) && rawTrimmed.includes('.')) {
    try {
      const morseMap = {
        '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E',
        '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J',
        '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O',
        '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T',
        '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y',
        '--..': 'Z', '-----': '0', '.----': '1', '..---': '2', '...--': '3',
        '....-': '4', '.....': '5', '-....': '6', '--...': '7', '---..': '8',
        '----.': '9'
      };
      const words = rawTrimmed.split(/\s{3,}|\s*\/\s*/);
      const decodedWords = words.map(w =>
        w.trim().split(/\s+/).map(token => morseMap[token] || '').join('')
      );
      const morseDec = decodedWords.join('_');
      if (morseDec) {
        submissionCandidates.add(cleanAns(morseDec));
        submissionCandidates.add(cleanAns(morseDec).replace(/_/g, ''));
      }
    } catch (_) {}
  }

  let correct = submissionCandidates.has(expectedNorm) ||
                submissionCandidates.has(expectedNormNoUnder) ||
                (baseFlagNorm && (submissionCandidates.has(baseFlagNorm) || submissionCandidates.has(baseFlagNormNoUnder)));

  if (!correct && challenge.acceptable_answers && Array.isArray(challenge.acceptable_answers)) {
    for (const ans of challenge.acceptable_answers) {
      const normAns = cleanAns(ans);
      if (submissionCandidates.has(normAns) || submissionCandidates.has(normAns.replace(/_/g, ''))) {
        correct = true;
        break;
      }
    }
  }

  if (!correct && challenge.options && challenge.correct_option !== undefined) {
    const optAns = cleanAns(challenge.options[challenge.correct_option]);
    if (submissionCandidates.has(optAns) || submissionCandidates.has(optAns.replace(/_/g, ''))) {
      correct = true;
    }
  }

  if (!correct && (challenge.round === 3 || challenge.type?.startsWith('code_') || challenge.id.startsWith('CODE-') || challenge.originalId?.startsWith('CODE-'))) {
    const rawLower = rawTrimmed.toLowerCase();
    const cleanNoUnder = cleanAns(rawTrimmed).replace(/_/g, '');
    if (
      (rawLower.startsWith('line_') && rawLower.includes('idor')) ||
      (rawLower.includes('idor') && (rawLower.includes('line 5') || rawLower.includes('line 3') || rawLower.includes('line 4') || rawLower.includes('5') || rawLower.includes('get_user'))) ||
      rawLower.includes('bola') ||
      rawLower.includes('broken access') ||
      rawLower.includes('broken object') ||
      rawLower.includes('authorization') ||
      cleanNoUnder === expectedNormNoUnder ||
      cleanNoUnder === baseFlagNormNoUnder
    ) {
      correct = true;
    }
  }

  // Log the submission
  db.prepare(`
    INSERT INTO submissions (user_id, challenge_id, answer, correct, submitted_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(user.id, challengeId, rawTrimmed, correct ? 1 : 0, new Date().toISOString());

  let totalAwarded = 0;
  if (correct) {
    // Check for code review bonus points if present
    let bonusPoints = 0;
    if (typeof req.body.bonusPoints === 'number' && req.body.bonusPoints > 0 && req.body.bonusPoints <= 100) {
      bonusPoints = req.body.bonusPoints;
    } else {
      const vulnRow = db.prepare('SELECT selections FROM vuln_selections WHERE user_id = ? AND challenge_id = ?').get(user.id, challengeId);
      if (vulnRow && challenge.vulnerabilities?.length > 0) {
        try {
          const selected = JSON.parse(vulnRow.selections);
          const expectedIds = challenge.vulnerabilities.map(v => v.id);
          bonusPoints = selected
            .filter(id => expectedIds.includes(id))
            .reduce((s, id) => {
              const v = challenge.vulnerabilities.find(v => v.id === id);
              return s + (v?.points || 0);
            }, 0);
        } catch (_) {}
      }
    }

    totalAwarded = (challenge.points || 0) + bonusPoints;

    // Atomically insert solve and update score ONLY if not already inserted (race-condition proof)
    const insertSolve = db.prepare(
      'INSERT OR IGNORE INTO solved_challenges (user_id, challenge_id, solved_at) VALUES (?, ?, ?)'
    );
    const result = insertSolve.run(user.id, challengeId, new Date().toISOString());
    if (result.changes > 0) {
      db.prepare('UPDATE users SET score = score + ? WHERE id = ?').run(totalAwarded, user.id);
      if (challenge.originalId && challenge.originalId !== challengeId) {
        insertSolve.run(user.id, challenge.originalId, new Date().toISOString());
      }
      await bustLeaderboard();
    }
  }

  const updatedUser = getFullUser(user.id);
  res.json({ correct, points: correct ? totalAwarded : 0, score: updatedUser.score });
});

// ── Hint Routes ───────────────────────────────────────────

/** POST /api/hints/reveal — reveal a hint (costs penalty, race-condition proof) */
app.post('/api/hints/reveal', requireAuth, async (req, res) => {
  const { challengeId, hintIndex } = req.body;
  const user = req.user;

  // Load hint to get cost
  const challengesPath = path.join(__dirname, 'data', 'challenges.json');
  const challengesData = JSON.parse(fs.readFileSync(challengesPath, 'utf8'));
  const challenge = resolveUserChallenge(challengesData, challengeId, user.id);
  const idx = parseInt(hintIndex, 10) || 0;
  const hint = challenge?.hints?.[idx];
  const penalty = hint?.cost || hint?.penalty || 0;

  // Atomically record hint reveal; changes > 0 only on first reveal
  const insertHint = db.prepare(
    'INSERT OR IGNORE INTO hint_reveals (user_id, challenge_id, hint_index, revealed_at) VALUES (?, ?, ?, ?)'
  );
  const result = insertHint.run(user.id, challengeId, idx, new Date().toISOString());

  if (result.changes > 0 && penalty > 0) {
    db.prepare('UPDATE users SET score = MAX(0, score - ?) WHERE id = ?').run(penalty, user.id);
    await bustLeaderboard();
  }

  const updatedUser = getFullUser(user.id);
  res.json({ ok: true, penalty, score: updatedUser.score, alreadyRevealed: result.changes === 0 });
});

// ── Tactical Skip Route ───────────────────────────────────

/** POST /api/skip — tactical skip (costs 30 PTS, max 3, race-condition proof) */
app.post('/api/skip', requireAuth, async (req, res) => {
  const { challengeId } = req.body;
  const user = req.user;

  if (!challengeId) return res.status(400).json({ error: 'challengeId required.' });
  if (!user.approved) return res.status(403).json({ error: 'Account not approved.' });
  if (user.disqualified) return res.status(403).json({ error: 'Account disqualified.' });

  const freshUser = getFullUser(user.id);
  if ((freshUser.skipsUsed || 0) >= 3) {
    return res.status(400).json({ error: 'All 3 tactical skips already exhausted.' });
  }
  if ((freshUser.score || 0) < 30) {
    return res.status(400).json({ error: 'Insufficient score to bypass (requires 30 PTS).' });
  }
  if (freshUser.solvedChallenges.includes(challengeId)) {
    return res.status(400).json({ error: 'Challenge already solved.' });
  }

  // Atomically record skip; changes > 0 only on first skip (prevents double deduction)
  const insertSkip = db.prepare(
    'INSERT OR IGNORE INTO skipped_challenges (user_id, challenge_id, skipped_at) VALUES (?, ?, ?)'
  );
  const result = insertSkip.run(user.id, challengeId, new Date().toISOString());

  if (result.changes > 0) {
    db.prepare('UPDATE users SET score = MAX(0, score - 30) WHERE id = ?').run(user.id);
    db.prepare(
      'INSERT INTO submissions (user_id, challenge_id, answer, correct, submitted_at) VALUES (?, ?, ?, ?, ?)'
    ).run(user.id, challengeId, 'SKIPPED_BY_USER', 0, new Date().toISOString());
    await bustLeaderboard();
  }

  const updatedUser = getFullUser(user.id);
  res.json({
    ok: true,
    score: updatedUser.score,
    skipsUsed: updatedUser.skipsUsed,
    skippedChallenges: updatedUser.skippedChallenges,
    alreadySkipped: result.changes === 0
  });
});

// ── Exam Status Routes ────────────────────────────────────

/** GET /api/exam/status */
app.get('/api/exam/status', async (req, res) => {
  const status = (await redis.get(KEYS.examStatus)) || 'waiting';
  const startTime = await redis.get(KEYS.examStartTime);
  res.json({ status, startTime });
});

/** POST /api/exam/status — admin only */
app.post('/api/exam/status', requireAuth, requireAdmin, async (req, res) => {
  const { status } = req.body;
  const valid = ['waiting', 'running', 'paused', 'stopped'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  await redis.set(KEYS.examStatus, status);
  if (status === 'running') {
    const existing = await redis.get(KEYS.examStartTime);
    if (!existing) {
      await redis.set(KEYS.examStartTime, new Date().toISOString());
    }
  } else if (status === 'waiting') {
    await redis.del(KEYS.examStartTime);
  }
  const startTime = await redis.get(KEYS.examStartTime);
  res.json({ ok: true, status, startTime });
});

// ── Leaderboard Route ─────────────────────────────────────

/** GET /api/leaderboard */
app.get('/api/leaderboard', async (req, res) => {
  const cached = await redis.get(KEYS.leaderboard);
  if (cached) return res.json(JSON.parse(cached));

  const users = getAllUsers({ includeAdmin: false }).filter(u => !u.disqualified);
  const board = users.map(u => {
    const solvedDetails = u.solvedDetails || [];
    const lastSolve = solvedDetails.length ? solvedDetails[solvedDetails.length - 1].solvedAt : null;
    return {
      id: u.id,
      username: u.username,
      team: u.team || u.username,
      score: u.score || 0,
      solvedChallenges: u.solvedChallenges || [],
      solvedDetails,
      lastSolve,
      skipsUsed: u.skipsUsed || 0,
      createdAt: u.createdAt,
      approved: u.approved,
    };
  });

  await redis.set(KEYS.leaderboard, JSON.stringify(board), 'EX', 3); // short cache 3s
  res.json(board);
});

// ── Vulnerability Quiz Selection Routes ───────────────────

/** GET /api/vuln/:challengeId */
app.get('/api/vuln/:challengeId', requireAuth, (req, res) => {
  const row = db.prepare(
    'SELECT selections FROM vuln_selections WHERE user_id = ? AND challenge_id = ?'
  ).get(req.user.id, req.params.challengeId);
  res.json({ selections: row ? JSON.parse(row.selections) : [] });
});

/** POST /api/vuln/:challengeId */
app.post('/api/vuln/:challengeId', requireAuth, (req, res) => {
  const { selections } = req.body;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO vuln_selections (user_id, challenge_id, selections, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, challenge_id) DO UPDATE SET selections = excluded.selections, updated_at = excluded.updated_at
  `).run(req.user.id, req.params.challengeId, JSON.stringify(selections || []), now);
  res.json({ ok: true });
});

// ── Admin: Clear Submissions ──────────────────────────────

/** DELETE /api/admin/submissions */
app.delete('/api/admin/submissions', requireAuth, requireAdmin, async (req, res) => {
  db.prepare("DELETE FROM submissions WHERE user_id IN (SELECT id FROM users WHERE role != 'admin')").run();
  res.json({ ok: true });
});
// ── Anti-Cheat: Tab Switch Tracking ──────────────────────

/** POST /api/anti-cheat/tab-switch — record a tab-switch violation */
app.post('/api/anti-cheat/tab-switch', requireAuth, async (req, res) => {
  const user = req.user;
  if (!user || user.role === 'admin') return res.status(400).json({ error: 'Not applicable.' });
  if (user.disqualified) return res.json({ tabSwitches: user.tabSwitches || 0, disqualified: true });

  // Increment tab_switches
  db.prepare('UPDATE users SET tab_switches = COALESCE(tab_switches, 0) + 1 WHERE id = ?').run(user.id);
  const updated = db.prepare('SELECT tab_switches, disqualified FROM users WHERE id = ?').get(user.id);
  const count = updated?.tab_switches ?? 1;

  // Auto-disqualify on 3rd violation
  if (count >= 3 && !updated?.disqualified) {
    db.prepare('UPDATE users SET disqualified = 1 WHERE id = ?').run(user.id);
    return res.json({ tabSwitches: count, disqualified: true, autoDisqualified: true });
  }

  res.json({ tabSwitches: count, disqualified: !!updated?.disqualified });
});

/** GET /api/anti-cheat/status — get current anti-cheat state for this user */
app.get('/api/anti-cheat/status', requireAuth, (req, res) => {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  const row = db.prepare('SELECT tab_switches, disqualified FROM users WHERE id = ?').get(user.id);
  res.json({
    tabSwitches: row?.tab_switches || 0,
    disqualified: !!(row?.disqualified),
  });
});

// ── Static File Server ────────────────────────────────────


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.webp': 'image/webp',
};

app.use((req, res, next) => {
  // Only handle GET requests for static files
  if (req.method !== 'GET') return next();
  // Don't intercept API routes
  if (req.path.startsWith('/api/')) return next();

  let reqPath = decodeURIComponent(req.path);
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  const safePath = path.normalize(reqPath).replace(/^(\.\.[\\/])+/, '');
  const filePath = path.join(__dirname, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.status(404).type('text/plain').send('404 Not Found: ' + reqPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct  = MIME[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    fs.createReadStream(filePath).pipe(res);
  });
});

// ── Server Startup ────────────────────────────────────────

async function start() {
  // Initialize Redis (or fallback)
  redis = await createRedisClient();

  // Seed DB with default users if empty
  await seedDefaultUsers();

  const httpServer = http.createServer(app);
  httpServer.listen(PORT, () => {
    console.log('\n============================================================');
    console.log(' CODEVERSE — Cybersecurity Contest Platform');
    console.log('============================================================');
    console.log(` > API + Static server: http://localhost:${PORT}`);
    console.log(` > Open in browser:     http://localhost:${PORT}/index.html`);
    console.log(' > Press Ctrl + C to stop\n');
  });
}

start().catch(err => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
