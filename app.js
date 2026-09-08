/* ============================================================
   CODEVERSE — Cybersecurity Contest Platform
   Main Application Logic
   ============================================================ */

'use strict';
// ── Server Note ───────────────────────────────────────────────
// This file is the browser-side application. The backend is server.js
// Run: node server.js   (or: npm start)
// The server uses Express + SQLite + Redis for persistent multi-user data.

/* ── Globals ─────────────────────────────────────────────── */
let contestData = null;
let challengesData = null;
let currentUser = null;
let currentView = 'dashboard';
let currentChallenge = null;
let adminView = 'overview';
let submissionRateLimits = {}; // { challengeId: { count, resetAt } }
let _examPollInterval = null;  // participant-side status poller

// ── Exam Status Cache (synced from API) ───────────────────────
// All Store.get('examStatus') calls read from here;
// all Store.set('examStatus', ...) calls write to the API.
let _examStatusCache = 'waiting';

async function syncExamStatus() {
  try {
    const { status } = await Api.get('/api/exam/status');
    _examStatusCache = status || 'waiting';
  } catch {}
}

async function setExamStatus(status) {
  try {
    await Api.post('/api/exam/status', { status });
    _examStatusCache = status;
  } catch (err) {
    console.warn('[examStatus] Failed to set status:', err.message);
  }
}

// ── Patch Store to intercept examStatus ───────────────────────
// We monkey-patch after Store is defined (below) so that all existing
// Store.get('examStatus') / Store.set('examStatus', ...) calls
// automatically go through the API cache without needing to rewrite every call site.
function _patchStoreForExamStatus() {
  const _origGet = Store.get.bind(Store);
  const _origSet = Store.set.bind(Store);
  Store.get = (k, def) => {
    if (k === 'examStatus') return _examStatusCache;
    return _origGet(k, def);
  };
  Store.set = (k, v) => {
    if (k === 'examStatus') { setExamStatus(v); return; }
    if (k === 'users') { /* user writes now go to API directly — ignore Store.set('users') */ return; }
    _origSet(k, v);
  };
  Store.remove = (k) => { if (k === 'examStatus' || k === 'currentUser' || k === 'users') return; };
}

// ── All-Users Cache (for admin panel rendering) ───────────────
// Store.get('users') returns this; it's refreshed from the API before each admin panel render.
let _cachedAllUsers = [];
let _allUsersFetched = false;

async function syncAllUsers() {
  try {
    const data = await Api.get('/api/users');
    if (Array.isArray(data)) {
      _cachedAllUsers = data;
      _allUsersFetched = true;
    }
  } catch {}
  return _cachedAllUsers;
}

// ── Leaderboard Telemetry Cache (accessible by all participants)
let _cachedLeaderboard = [];
async function syncLeaderboard() {
  try {
    const data = await Api.get('/api/leaderboard');
    if (Array.isArray(data) && data.length > 0) {
      _cachedLeaderboard = data;
    }
  } catch {}
  return _cachedLeaderboard;
}

// Extended patch: also intercept Store.get('users')
function _extendPatchForUsers() {
  const _origGet = Store.get.bind(Store);
  Store.get = (k, def) => {
    if (k === 'examStatus') return _examStatusCache;
    if (k === 'users') return _allUsersFetched ? _cachedAllUsers : (_cachedAllUsers.length > 0 ? _cachedAllUsers : (def || []));
    return _origGet(k, def);
  };
}


/* ── Sound System (inline Web Audio API) ─────────────────── */
const Sound = (() => {
  let ctx = null, master = null, on = true, inited = false;
  const init = () => {
    if (inited) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0.35; master.connect(ctx.destination);
      inited = true;
    } catch (e) {}
  };
  const resume = () => { init(); if (ctx?.state === 'suspended') ctx.resume(); };
  const osc = (type, f, t, dur, g = 0.28) => {
    if (!ctx || !on) return;
    const o = ctx.createOscillator(), gain = ctx.createGain();
    o.type = type; o.frequency.value = f;
    gain.gain.setValueAtTime(g, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(gain); gain.connect(master);
    o.start(t); o.stop(t + dur);
  };
  const sw = (type, f1, f2, t, dur, g = 0.28) => {
    if (!ctx || !on) return;
    const o = ctx.createOscillator(), gain = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f1, t);
    o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    gain.gain.setValueAtTime(g, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(gain); gain.connect(master);
    o.start(t); o.stop(t + dur);
  };
  const plays = {
    boot:     t => { sw('sawtooth',80,160,t,0.4,0.18); sw('sine',200,400,t+0.3,0.5,0.12); osc('square',440,t+0.7,0.1,0.1); osc('sine',1320,t+1.0,0.3,0.18); },
    correct:  t => { osc('sine',523,t,0.1,0.3); osc('sine',659,t+0.1,0.1,0.3); osc('sine',784,t+0.2,0.1,0.3); osc('sine',1047,t+0.3,0.25,0.35); sw('sine',1047,2093,t+0.55,0.2,0.12); },
    wrong:    t => { sw('sawtooth',220,100,t,0.3,0.28); osc('square',100,t+0.05,0.25,0.18); },
    unlock:   t => { sw('sine',440,880,t,0.15,0.22); osc('triangle',1320,t+0.1,0.2,0.25); osc('sine',1760,t+0.25,0.15,0.2); },
    hint:     t => { sw('sine',660,440,t,0.15,0.18); osc('triangle',330,t+0.1,0.2,0.2); },
    click:    t => { osc('square',440,t,0.05,0.1); osc('sine',660,t+0.02,0.05,0.07); },
    hover:    t => { osc('sine',880,t,0.04,0.07); },
    victory:  t => { [523,659,784,1047,784,1047,1319].forEach((f,i) => osc('sine',f,t+i*0.12,0.2,0.3)); },
    round:    t => { [523,659,784,1047].forEach((f,i) => osc('sine',f,t+i*0.12,0.25,0.3)); sw('sine',1047,2093,t+0.5,0.3,0.2); },
    notify:   t => { osc('sine',1047,t,0.08,0.18); osc('sine',1319,t+0.1,0.08,0.18); },
    login:    t => { sw('sine',330,660,t,0.2,0.22); osc('sine',880,t+0.15,0.2,0.25); },
    rate:     t => { for(let i=0;i<3;i++) osc('square',200,t+i*0.15,0.1,0.18); },
    tick:     t => {
      const f = 1900 + Math.random() * 500;
      sw('triangle', f, 700, t, 0.016, 0.14);
      osc('sine', 380 + Math.random() * 60, t, 0.014, 0.09);
    },
    type:     t => {
      const f = 1500 + Math.random() * 400;
      sw('triangle', f, 600, t, 0.02, 0.15);
      osc('square', 240, t, 0.015, 0.07);
    },
    mascot_type: t => {
      const f = 1350 + Math.random() * 500;
      sw('triangle', f, f * 0.42, t, 0.018, 0.13);
      osc('sine', 350 + Math.random() * 80, t, 0.013, 0.07);
    },
    flag:     t => {
      [587, 740, 880, 1174, 1480].forEach((f, i) => osc('sine', f, t + i * 0.08, 0.22, 0.25));
      sw('sine', 880, 1760, t + 0.35, 0.25, 0.15);
    },
    register: t => {
      [440, 554, 659, 880].forEach((f, i) => osc('sine', f, t + i * 0.1, 0.2, 0.28));
      sw('sine', 880, 1320, t + 0.35, 0.3, 0.2);
    },
    step:     t => {
      sw('sine', 400, 950, t, 0.12, 0.15);
      osc('triangle', 950, t + 0.06, 0.08, 0.1);
    },
    back:     t => {
      sw('sine', 800, 350, t, 0.12, 0.15);
      osc('triangle', 350, t + 0.06, 0.08, 0.1);
    }
  };
  return {
    init, resume,
    toggle: () => { on = !on; return on; },
    isOn: () => on,
    play(name) { init(); resume(); const t = ctx?.currentTime || 0; plays[name]?.(t); }
  };
})();

/* ── API Client (replaces localStorage Store) ───────────────
   All calls go to the Express server at /api/*
   Session token is stored in sessionStorage under 'cv_token'.
   ─────────────────────────────────────────────────────────── */
const API_BASE = '';

const Api = {
  _token: null,

  getToken() {
    if (this._token) return this._token;
    try { this._token = sessionStorage.getItem('cv_token'); } catch {}
    return this._token;
  },

  setToken(t) {
    this._token = t;
    try { if (t) sessionStorage.setItem('cv_token', t); else sessionStorage.removeItem('cv_token'); } catch {}
  },

  async _fetch(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(API_BASE + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
    return data;
  },

  get(path)         { return this._fetch('GET',    path);       },
  post(path, body)  { return this._fetch('POST',   path, body); },
  put(path, body)   { return this._fetch('PUT',    path, body); },
  del(path)         { return this._fetch('DELETE', path);       },
};

/* Legacy sync Store shim — kept for any non-critical local preferences
   (sound on/off, UI tweaks, etc.) that don't need server persistence */
const Store = {
  get: (k, def = null) => { try { const v = localStorage.getItem('cv_' + k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set: (k, v) => { try { localStorage.setItem('cv_' + k, JSON.stringify(v)); } catch {} },
  del: (k) => { try { localStorage.removeItem('cv_' + k); } catch {} },
  remove: (k) => { try { localStorage.removeItem('cv_' + k); } catch {} }
};

/* ── Dynamic Per-Operative Flag Derivation ────────────────── */
function getUserChallengeFlag(challengeId, user = currentUser) {
  const challenge = (typeof challengesData !== 'undefined' && challengesData?.challenges)
    ? challengesData.challenges.find(c => c.id === challengeId)
    : null;
  const baseFlag = challenge?.flag || challengeId;
  if (!user) return baseFlag;

  // OSINT (Round 1) and Code Review (Round 3) challenges are static finding tokens
  if (challengeId.startsWith('OSINT-') || challengeId.startsWith('CODE-') || challenge?.round === 1 || challenge?.round === 3) {
    return baseFlag;
  }

  const uid = String(user.id || user.username || 'operative');
  let h = 0x811c9dc5;
  const seed = `${uid}:${challengeId}:0xRAVEN_SALT_2026`;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const suffix = Math.abs(h).toString(16).toUpperCase().padStart(6, '0').slice(-6);
  return `${baseFlag}_${suffix}`;
}
window.getUserChallengeFlag = getUserChallengeFlag;

/* ── Device & Exam Access Guard ──────────────────────────── */
const DeviceGuard = {
  check() {
    const ua = navigator.userAgent || navigator.vendor || window.opera || '';
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    // iPadOS 13+ detection (reports platform as MacIntel but has touch points)
    const isIpadOS = (navigator.platform === 'MacIntel' || ua.includes('Macintosh')) && navigator.maxTouchPoints > 1;

    // Direct User-Agent matching
    const isMobileUA = /Android.*Mobile|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Windows Phone/i.test(ua);
    const isTabletUA = /iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) || isIpadOS;

    const screenMin = Math.min(window.screen.width || 0, window.screen.height || 0);
    const screenWidth = window.screen.width || window.innerWidth;
    const currentWidth = window.innerWidth;

    // Physical and viewport classifications
    const isPhone = isMobileUA || (screenMin > 0 && screenMin < 600) || (isTouch && currentWidth < 640);
    const isTablet = isTabletUA || (!isPhone && isTouch && (currentWidth < 1024 || screenMin < 900));
    const isSmallViewport = currentWidth < 1024;

    // Any mobile, tablet, or viewport < 1024 cannot open the exam
    const isRestricted = isPhone || isTablet || isSmallViewport;

    let deviceType = 'laptop';
    if (isPhone) deviceType = 'mobile';
    else if (isTablet) deviceType = 'tablet';
    else if (isSmallViewport) deviceType = 'small_screen';

    return {
      isRestricted,
      deviceType,
      isPhone,
      isTablet,
      isTouch,
      currentWidth,
      screenWidth,
      label: isPhone ? 'Mobile Phone' : (isTablet ? 'Tablet' : (isSmallViewport ? 'Small Screen (<1024px)' : 'Laptop / Desktop PC'))
    };
  },

  isRestricted() {
    return this.check().isRestricted;
  },

  isMobileOrTablet() {
    const c = this.check();
    return c.isPhone || c.isTablet;
  }
};

/* ── Helpers ──────────────────────────────────────────────── */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const el = (tag, cls = '', html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };

function toast(title, msg, type = 'info', duration = 4000) {
  const icons = { success: '✓', error: '✗', info: 'ℹ', warning: '⚠' };
  const t = el('div', `toast ${type}`);
  t.innerHTML = `<span class="toast-icon">${icons[type]}</span><div class="toast-content"><div class="toast-title">${withAnimEmojis(title)}</div><div class="toast-msg">${withAnimEmojis(msg)}</div></div>`;
  $('#toast-container').appendChild(t);
  setTimeout(() => { t.classList.add('toast-exit'); setTimeout(() => t.remove(), 300); }, duration);
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '—';
  if (ms <= 0) return '< 1s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 1) return '< 1s';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Computes timing statistics for all steps and each individual question/step.
 */
function calculateContestantTimings(user, challenges, examStartTime = null) {
  const chList = challenges || (user && typeof getUserChallenges === 'function' ? getUserChallenges(user) : (typeof challengesData !== 'undefined' && challengesData?.challenges)) || [];
  const solvedDetails = user?.solvedDetails || [];
  const solvedChallenges = user?.solvedChallenges || [];
  const submissions = user?.submissions || [];

  // Build lookup maps
  const solveMap = new Map();
  solvedDetails.forEach(s => {
    if (s.challengeId) solveMap.set(s.challengeId, s.solvedAt);
  });
  // Fallback for solvedChallenges if not in solvedDetails
  solvedChallenges.forEach(id => {
    if (!solveMap.has(id)) {
      solveMap.set(id, user?.createdAt || new Date().toISOString());
    }
  });

  const subsByChallenge = new Map();
  submissions.forEach(s => {
    if (!s.challengeId) return;
    const arr = subsByChallenge.get(s.challengeId) || [];
    arr.push(s);
    subsByChallenge.set(s.challengeId, arr);
  });

  // Calculate base start time for the contestant
  const candidateStarts = [];
  if (examStartTime) {
    const t = new Date(examStartTime).getTime();
    if (!isNaN(t)) candidateStarts.push(t);
  }
  if (user?.createdAt) {
    const t = new Date(user.createdAt).getTime();
    if (!isNaN(t)) candidateStarts.push(t);
  }
  if (submissions.length > 0) {
    const t = new Date(submissions[0].submitted_at || submissions[0].timestamp).getTime();
    if (!isNaN(t)) candidateStarts.push(t);
  }
  if (solvedDetails.length > 0) {
    const t = new Date(solvedDetails[0].solvedAt).getTime();
    if (!isNaN(t)) candidateStarts.push(t);
  }

  const userStartTime = candidateStarts.length > 0 ? Math.min(...candidateStarts) : Date.now();

  const steps = [];
  let prevStepFinishTime = userStartTime;

  chList.forEach((ch, idx) => {
    const stepNum = idx + 1;
    const isSolved = solveMap.has(ch.id);
    const solvedAtStr = solveMap.get(ch.id) || null;
    const chSubs = subsByChallenge.get(ch.id) || [];
    const attempts = chSubs.length;
    const wrongAttempts = chSubs.filter(s => !s.correct).length;
    const hintsCount = (user?.revealedHints || []).filter(h => h.startsWith(ch.id + ':')).length;

    let stepStartTime = null;
    let stepEndTime = null;
    let durationMs = null;
    let status = 'locked';

    if (idx === 0) {
      stepStartTime = userStartTime;
    } else {
      stepStartTime = prevStepFinishTime;
    }

    if (isSolved) {
      status = 'completed';
      stepEndTime = new Date(solvedAtStr).getTime();
      // Ensure positive duration; if solvedAt is earlier or same as start, fallback gracefully
      durationMs = Math.max(1000, stepEndTime - stepStartTime);
      prevStepFinishTime = stepEndTime;
    } else {
      // Not solved yet: is it the current in-progress question?
      const isWorkingOn = (user?.currentChallenge === ch.id) || (idx === 0) || (steps[idx - 1]?.status === 'completed');
      if (isWorkingOn && !user?.disqualified) {
        status = 'in_progress';
        stepEndTime = Date.now();
        durationMs = Math.max(0, stepEndTime - (stepStartTime || userStartTime));
      } else {
        status = 'locked';
        durationMs = null;
      }
    }

    steps.push({
      stepNum,
      challengeId: ch.id,
      name: ch.name || ch.id,
      round: ch.round,
      roundName: ['OSINT', 'WEB CTF', 'CODE REVIEW'][ch.round - 1] || `Round ${ch.round}`,
      points: ch.points || 0,
      difficulty: ch.difficulty || 'medium',
      status,
      startTime: stepStartTime ? new Date(stepStartTime).toISOString() : null,
      solvedAt: solvedAtStr,
      durationMs,
      attempts,
      wrongAttempts,
      hintsCount,
    });
  });

  const completedSteps = steps.filter(s => s.status === 'completed');
  const inProgressStep = steps.find(s => s.status === 'in_progress');
  const isAllCompleted = chList.length > 0 && completedSteps.length === chList.length;

  // Total time across completed steps
  let totalCompletedTimeMs = 0;
  if (completedSteps.length > 0) {
    const latestFinish = Math.max(...completedSteps.map(s => new Date(s.solvedAt).getTime()));
    totalCompletedTimeMs = Math.max(0, latestFinish - userStartTime);
  }

  // Active elapsed time including current step if in progress
  const elapsedActiveTimeMs = isAllCompleted
    ? totalCompletedTimeMs
    : Math.max(0, Date.now() - userStartTime);

  const avgTimePerStepMs = completedSteps.length > 0
    ? Math.round(totalCompletedTimeMs / completedSteps.length)
    : 0;

  // Fastest and slowest steps among completed steps
  let fastestStep = null;
  let slowestStep = null;
  if (completedSteps.length > 0) {
    const sortedByDuration = [...completedSteps].sort((a, b) => a.durationMs - b.durationMs);
    fastestStep = sortedByDuration[0];
    slowestStep = sortedByDuration[sortedByDuration.length - 1];
  }

  return {
    totalSteps: chList.length,
    completedSteps: completedSteps.length,
    isAllCompleted,
    startTime: userStartTime,
    totalCompletedTimeMs,
    elapsedActiveTimeMs,
    avgTimePerStepMs,
    fastestStep,
    slowestStep,
    inProgressStep,
    steps,
  };
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Animated Vector Graphics Suite (Animations instead of Emojis) ── */
const ANIM_VECTORS = {
  '✅': `<svg class="anim-svg svg-check" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#10b981" stroke-width="2.2" fill="#ecfdf5"/><path d="M7.5 12.5L10.5 15.5L16.5 9" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  'check': `<svg class="anim-svg svg-check" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#10b981" stroke-width="2.2" fill="#ecfdf5"/><path d="M7.5 12.5L10.5 15.5L16.5 9" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  '🆕': `<svg class="anim-svg svg-new" viewBox="0 0 24 24" fill="none"><rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="#f5f3ff" stroke="#7c3aed" stroke-width="2"/><path d="M12 7.5v9M7.5 12h9" stroke="#7c3aed" stroke-width="2.4" stroke-linecap="round"/></svg>`,
  'new': `<svg class="anim-svg svg-new" viewBox="0 0 24 24" fill="none"><rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="#f5f3ff" stroke="#7c3aed" stroke-width="2"/><path d="M12 7.5v9M7.5 12h9" stroke="#7c3aed" stroke-width="2.4" stroke-linecap="round"/></svg>`,

  '🚀': `<svg class="anim-svg svg-rocket" viewBox="0 0 24 24" fill="none"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" fill="#f43f5e"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" fill="#6366f1" stroke="#4338ca" stroke-width="1.2"/><circle cx="15.5" cy="8.5" r="1.8" fill="#38bdf8"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" stroke="#a855f7" stroke-width="1.5" fill="#c084fc"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" stroke="#a855f7" stroke-width="1.5" fill="#c084fc"/><path class="rocket-flame" d="M3.5 19.5l-2 2.5 3.5-.5" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/></svg>`,
  'rocket': `<svg class="anim-svg svg-rocket" viewBox="0 0 24 24" fill="none"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" fill="#f43f5e"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" fill="#6366f1" stroke="#4338ca" stroke-width="1.2"/><circle cx="15.5" cy="8.5" r="1.8" fill="#38bdf8"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" stroke="#a855f7" stroke-width="1.5" fill="#c084fc"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" stroke="#a855f7" stroke-width="1.5" fill="#c084fc"/><path class="rocket-flame" d="M3.5 19.5l-2 2.5 3.5-.5" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/></svg>`,

  '⚡': `<svg class="anim-svg svg-bolt" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h8l-1 8 11-12h-8l2-8z" fill="#f59e0b" stroke="#d97706" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  'bolt': `<svg class="anim-svg svg-bolt" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h8l-1 8 11-12h-8l2-8z" fill="#f59e0b" stroke="#d97706" stroke-width="1.5" stroke-linejoin="round"/></svg>`,

  '⚙': `<svg class="anim-svg svg-gear" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" fill="#ede9fe"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  '⚙️': `<svg class="anim-svg svg-gear" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" fill="#ede9fe"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  'gear': `<svg class="anim-svg svg-gear" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" fill="#ede9fe"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,

  '🔐': `<svg class="anim-svg svg-lock" viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="16" height="12" rx="3" fill="#6366f1" stroke="#4338ca" stroke-width="1.8"/><path class="lock-shackle" d="M7 10V7a5 5 0 0 1 10 0v3" stroke="#e0e7ff" stroke-width="2.5" stroke-linecap="round"/><circle cx="12" cy="15" r="1.5" fill="#ffffff"/><path d="M12 16.5V18.5" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  '🔒': `<svg class="anim-svg svg-lock" viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="16" height="12" rx="3" fill="#6366f1" stroke="#4338ca" stroke-width="1.8"/><path class="lock-shackle" d="M7 10V7a5 5 0 0 1 10 0v3" stroke="#e0e7ff" stroke-width="2.5" stroke-linecap="round"/><circle cx="12" cy="15" r="1.5" fill="#ffffff"/><path d="M12 16.5V18.5" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  'lock': `<svg class="anim-svg svg-lock" viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="16" height="12" rx="3" fill="#6366f1" stroke="#4338ca" stroke-width="1.8"/><path class="lock-shackle" d="M7 10V7a5 5 0 0 1 10 0v3" stroke="#e0e7ff" stroke-width="2.5" stroke-linecap="round"/><circle cx="12" cy="15" r="1.5" fill="#ffffff"/><path d="M12 16.5V18.5" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/></svg>`,

  '🔓': `<svg class="anim-svg svg-unlock" viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="16" height="12" rx="3" fill="#10b981" stroke="#059669" stroke-width="1.8"/><path class="unlock-shackle" d="M7 10V6a5 5 0 0 1 9.9-1" stroke="#10b981" stroke-width="2.5" stroke-linecap="round"/><circle cx="12" cy="15" r="1.5" fill="#ffffff"/><path d="M12 16.5V18.5" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  'unlock': `<svg class="anim-svg svg-unlock" viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="16" height="12" rx="3" fill="#10b981" stroke="#059669" stroke-width="1.8"/><path class="unlock-shackle" d="M7 10V6a5 5 0 0 1 9.9-1" stroke="#10b981" stroke-width="2.5" stroke-linecap="round"/><circle cx="12" cy="15" r="1.5" fill="#ffffff"/><path d="M12 16.5V18.5" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/></svg>`,

  '🔍': `<svg class="anim-svg svg-search" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="#0284c7" stroke-width="2.5" fill="#e0f2fe"/><line x1="16.5" y1="16.5" x2="21.5" y2="21.5" stroke="#0284c7" stroke-width="3" stroke-linecap="round"/><circle class="search-ping" cx="11" cy="11" r="3.5" stroke="#38bdf8" stroke-width="1.5" fill="none"/></svg>`,
  'search': `<svg class="anim-svg svg-search" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="#0284c7" stroke-width="2.5" fill="#e0f2fe"/><line x1="16.5" y1="16.5" x2="21.5" y2="21.5" stroke="#0284c7" stroke-width="3" stroke-linecap="round"/><circle class="search-ping" cx="11" cy="11" r="3.5" stroke="#38bdf8" stroke-width="1.5" fill="none"/></svg>`,

  '👋': `<svg class="anim-svg svg-wave" viewBox="0 0 24 24" fill="none"><path d="M18 11V6a2 2 0 0 0-4 0v4M14 10V4a2 2 0 0 0-4 0v7M10 10.5V3a2 2 0 0 0-4 0v10M6 13v-2a2 2 0 0 0-4 0v5a7 7 0 0 0 7 7h3a7 7 0 0 0 7-7v-5a2 2 0 0 0-4 0v2" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="#fef3c7"/></svg>`,
  'wave': `<svg class="anim-svg svg-wave" viewBox="0 0 24 24" fill="none"><path d="M18 11V6a2 2 0 0 0-4 0v4M14 10V4a2 2 0 0 0-4 0v7M10 10.5V3a2 2 0 0 0-4 0v10M6 13v-2a2 2 0 0 0-4 0v5a7 7 0 0 0 7 7h3a7 7 0 0 0 7-7v-5a2 2 0 0 0-4 0v2" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="#fef3c7"/></svg>`,

  '📱': `<svg class="anim-svg svg-phone" viewBox="0 0 24 24" fill="none"><rect x="6" y="2" width="12" height="20" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/><line x1="11" y1="19" x2="13" y2="19" stroke="#7c3aed" stroke-width="2" stroke-linecap="round"/><line class="phone-signal" x1="9" y1="5" x2="15" y2="5" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  'phone': `<svg class="anim-svg svg-phone" viewBox="0 0 24 24" fill="none"><rect x="6" y="2" width="12" height="20" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/><line x1="11" y1="19" x2="13" y2="19" stroke="#7c3aed" stroke-width="2" stroke-linecap="round"/><line class="phone-signal" x1="9" y1="5" x2="15" y2="5" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round"/></svg>`,

  '😎': `<svg class="anim-svg svg-cool" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#fef08a" stroke="#ca8a04" stroke-width="1.8"/><path d="M4 10h16v1.5a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3V10zm0 0l2 3h4l-2-3H4zm16 0l-2 3h-4l2-3h4z" fill="#0f172a"/><path d="M8 17a4 4 0 0 0 8 0" stroke="#854d0e" stroke-width="2" stroke-linecap="round"/></svg>`,
  'cool': `<svg class="anim-svg svg-cool" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#fef08a" stroke="#ca8a04" stroke-width="1.8"/><path d="M4 10h16v1.5a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3V10zm0 0l2 3h4l-2-3H4zm16 0l-2 3h-4l2-3h4z" fill="#0f172a"/><path d="M8 17a4 4 0 0 0 8 0" stroke="#854d0e" stroke-width="2" stroke-linecap="round"/></svg>`,

  '🦅': `<svg class="anim-svg svg-eagle" viewBox="0 0 24 24" fill="none"><path d="M12 2l3 5 5 1-4 4 1 5-5-2.5L7 17l1-5-4-4 5-1 3-5z" fill="#7c3aed" stroke="#5b21b6" stroke-width="1.2"/><circle cx="12" cy="9" r="1.5" fill="#38bdf8"/><path class="eagle-wing" d="M3 11c3-2 6-2 9 0M21 11c-3-2-6-2-9 0" stroke="#c084fc" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  'eagle': `<svg class="anim-svg svg-eagle" viewBox="0 0 24 24" fill="none"><path d="M12 2l3 5 5 1-4 4 1 5-5-2.5L7 17l1-5-4-4 5-1 3-5z" fill="#7c3aed" stroke="#5b21b6" stroke-width="1.2"/><circle cx="12" cy="9" r="1.5" fill="#38bdf8"/><path class="eagle-wing" d="M3 11c3-2 6-2 9 0M21 11c-3-2-6-2-9 0" stroke="#c084fc" stroke-width="1.5" stroke-linecap="round"/></svg>`,

  '🎉': `<svg class="anim-svg svg-party" viewBox="0 0 24 24" fill="none"><path d="M3 21l8.5-4.5L7.5 12 3 21z" fill="#ec4899" stroke="#be185d" stroke-width="1.5"/><path class="party-confetti-1" d="M14 6l1.5-2M18 10l2-1M15 13l3 1M11 4l1 2M19 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/><circle cx="18" cy="14" r="1.5" fill="#38bdf8"/><circle cx="14" cy="9" r="1.5" fill="#a855f7"/></svg>`,
  'party': `<svg class="anim-svg svg-party" viewBox="0 0 24 24" fill="none"><path d="M3 21l8.5-4.5L7.5 12 3 21z" fill="#ec4899" stroke="#be185d" stroke-width="1.5"/><path class="party-confetti-1" d="M14 6l1.5-2M18 10l2-1M15 13l3 1M11 4l1 2M19 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/><circle cx="18" cy="14" r="1.5" fill="#38bdf8"/><circle cx="14" cy="9" r="1.5" fill="#a855f7"/></svg>`,

  '🏆': `<svg class="anim-svg svg-trophy" viewBox="0 0 24 24" fill="none"><path d="M6 3h12v6a6 6 0 0 1-12 0V3z" fill="#facc15" stroke="#ca8a04" stroke-width="1.8"/><path d="M6 5H3a2 2 0 0 0-2 2v1a4 4 0 0 0 4 4h1M18 5h3a2 2 0 0 1 2 2v1a4 4 0 0 1-4 4h-1" stroke="#ca8a04" stroke-width="1.8"/><path d="M12 15v3M8 21h8" stroke="#ca8a04" stroke-width="2" stroke-linecap="round"/><polygon class="trophy-star" points="12,6 13,8.5 15.5,8.5 13.5,10 14,12.5 12,11 10,12.5 10.5,10 8.5,8.5 11,8.5" fill="#ffffff"/></svg>`,
  'trophy': `<svg class="anim-svg svg-trophy" viewBox="0 0 24 24" fill="none"><path d="M6 3h12v6a6 6 0 0 1-12 0V3z" fill="#facc15" stroke="#ca8a04" stroke-width="1.8"/><path d="M6 5H3a2 2 0 0 0-2 2v1a4 4 0 0 0 4 4h1M18 5h3a2 2 0 0 1 2 2v1a4 4 0 0 1-4 4h-1" stroke="#ca8a04" stroke-width="1.8"/><path d="M12 15v3M8 21h8" stroke="#ca8a04" stroke-width="2" stroke-linecap="round"/><polygon class="trophy-star" points="12,6 13,8.5 15.5,8.5 13.5,10 14,12.5 12,11 10,12.5 10.5,10 8.5,8.5 11,8.5" fill="#ffffff"/></svg>`,

  '🔊': `<svg class="anim-svg svg-sound" viewBox="0 0 24 24" fill="none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="#0284c7" stroke="#0369a1" stroke-width="1.5"/><path class="sound-wave-1" d="M15.5 8.5a5 5 0 0 1 0 7" stroke="#0284c7" stroke-width="2" stroke-linecap="round"/><path class="sound-wave-2" d="M19 5a10 10 0 0 1 0 14" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/></svg>`,
  'sound': `<svg class="anim-svg svg-sound" viewBox="0 0 24 24" fill="none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="#0284c7" stroke="#0369a1" stroke-width="1.5"/><path class="sound-wave-1" d="M15.5 8.5a5 5 0 0 1 0 7" stroke="#0284c7" stroke-width="2" stroke-linecap="round"/><path class="sound-wave-2" d="M19 5a10 10 0 0 1 0 14" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/></svg>`,

  '🔇': `<svg class="anim-svg svg-mute" viewBox="0 0 24 24" fill="none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="#94a3b8" stroke="#64748b" stroke-width="1.5"/><line x1="22" y1="9" x2="16" y2="15" stroke="#f43f5e" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="9" x2="22" y2="15" stroke="#f43f5e" stroke-width="2" stroke-linecap="round"/></svg>`,
  'mute': `<svg class="anim-svg svg-mute" viewBox="0 0 24 24" fill="none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="#94a3b8" stroke="#64748b" stroke-width="1.5"/><line x1="22" y1="9" x2="16" y2="15" stroke="#f43f5e" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="9" x2="22" y2="15" stroke="#f43f5e" stroke-width="2" stroke-linecap="round"/></svg>`,

  '💻': `<svg class="anim-svg svg-laptop" viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="11" rx="2" fill="#1e293b" stroke="#6366f1" stroke-width="1.8"/><path d="M2 19h20v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-1z" fill="#475569" stroke="#334155" stroke-width="1.5"/><line class="laptop-scan" x1="7" y1="9.5" x2="17" y2="9.5" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  'laptop': `<svg class="anim-svg svg-laptop" viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="11" rx="2" fill="#1e293b" stroke="#6366f1" stroke-width="1.8"/><path d="M2 19h20v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-1z" fill="#475569" stroke="#334155" stroke-width="1.5"/><line class="laptop-scan" x1="7" y1="9.5" x2="17" y2="9.5" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round"/></svg>`,

  '🕐': `<svg class="anim-svg svg-clock" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="#f8fafc" stroke="#7c3aed" stroke-width="2"/><polyline class="clock-hands" points="12 6 12 12 15.5 12" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  '⏳': `<svg class="anim-svg svg-clock" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="#f8fafc" stroke="#7c3aed" stroke-width="2"/><polyline class="clock-hands" points="12 6 12 12 15.5 12" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  'clock': `<svg class="anim-svg svg-clock" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="#f8fafc" stroke="#7c3aed" stroke-width="2"/><polyline class="clock-hands" points="12 6 12 12 15.5 12" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  '🚫': `<svg class="anim-svg svg-block" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#f43f5e" stroke-width="2.5" fill="#ffe4e6"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" stroke="#f43f5e" stroke-width="2.5" stroke-linecap="round"/></svg>`,
  'block': `<svg class="anim-svg svg-block" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#f43f5e" stroke-width="2.5" fill="#ffe4e6"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" stroke="#f43f5e" stroke-width="2.5" stroke-linecap="round"/></svg>`,

  '⚠️': `<svg class="anim-svg svg-warn" viewBox="0 0 24 24" fill="none"><path d="m10.29 3.86-8.58 14.86A2 2 0 0 0 3.44 21h17.12a2 2 0 0 0 1.73-2.28l-8.58-14.86a2 2 0 0 0-3.42 0z" fill="#fef3c7" stroke="#f59e0b" stroke-width="2"/><line x1="12" y1="9" x2="12" y2="14" stroke="#b45309" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.5" r="1.2" fill="#b45309"/></svg>`,
  'warn': `<svg class="anim-svg svg-warn" viewBox="0 0 24 24" fill="none"><path d="m10.29 3.86-8.58 14.86A2 2 0 0 0 3.44 21h17.12a2 2 0 0 0 1.73-2.28l-8.58-14.86a2 2 0 0 0-3.42 0z" fill="#fef3c7" stroke="#f59e0b" stroke-width="2"/><line x1="12" y1="9" x2="12" y2="14" stroke="#b45309" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.5" r="1.2" fill="#b45309"/></svg>`,

  '💡': `<svg class="anim-svg svg-bulb" viewBox="0 0 24 24" fill="none"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-5 11.9v2.1h10v-2.1A7 7 0 0 0 12 2z" fill="#fef08a" stroke="#eab308" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line class="bulb-ray" x1="12" y1="5" x2="12" y2="8" stroke="#ca8a04" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  'bulb': `<svg class="anim-svg svg-bulb" viewBox="0 0 24 24" fill="none"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-5 11.9v2.1h10v-2.1A7 7 0 0 0 12 2z" fill="#fef08a" stroke="#eab308" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line class="bulb-ray" x1="12" y1="5" x2="12" y2="8" stroke="#ca8a04" stroke-width="1.5" stroke-linecap="round"/></svg>`,

  '📄': `<svg class="anim-svg svg-doc" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="#f8fafc" stroke="#64748b" stroke-width="1.8"/><polyline points="14 2 14 8 20 8" stroke="#64748b" stroke-width="1.8" stroke-linejoin="round"/><line x1="8" y1="13" x2="16" y2="13" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="17" x2="13" y2="17" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  'doc': `<svg class="anim-svg svg-doc" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="#f8fafc" stroke="#64748b" stroke-width="1.8"/><polyline points="14 2 14 8 20 8" stroke="#64748b" stroke-width="1.8" stroke-linejoin="round"/><line x1="8" y1="13" x2="16" y2="13" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="17" x2="13" y2="17" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/></svg>`,

  '🥇': `<svg class="anim-svg svg-medal" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="14" r="7" fill="#fef08a" stroke="#eab308" stroke-width="1.8"/><path d="M8.5 2l2.5 6M15.5 2l-2.5 6" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/><polygon points="12,11 13,13 15.5,13 13.5,14.5 14,16.5 12,15 10,16.5 10.5,14.5 8.5,13 11,13" fill="#ca8a04"/></svg>`,
  '🥈': `<svg class="anim-svg svg-medal" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="14" r="7" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.8"/><path d="M8.5 2l2.5 6M15.5 2l-2.5 6" stroke="#64748b" stroke-width="2" stroke-linecap="round"/><polygon points="12,11 13,13 15.5,13 13.5,14.5 14,16.5 12,15 10,16.5 10.5,14.5 8.5,13 11,13" fill="#64748b"/></svg>`,
  '🥉': `<svg class="anim-svg svg-medal" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="14" r="7" fill="#ffedd5" stroke="#ea580c" stroke-width="1.8"/><path d="M8.5 2l2.5 6M15.5 2l-2.5 6" stroke="#c2410c" stroke-width="2" stroke-linecap="round"/><polygon points="12,11 13,13 15.5,13 13.5,14.5 14,16.5 12,15 10,16.5 10.5,14.5 8.5,13 11,13" fill="#9a3412"/></svg>`,

  '📊': `<svg class="anim-svg svg-chart" viewBox="0 0 24 24" fill="none"><line x1="18" y1="20" x2="18" y2="10" stroke="#7c3aed" stroke-width="3" stroke-linecap="round" class="bar-3"/><line x1="12" y1="20" x2="12" y2="4" stroke="#0284c7" stroke-width="3" stroke-linecap="round" class="bar-2"/><line x1="6" y1="20" x2="6" y2="14" stroke="#10b981" stroke-width="3" stroke-linecap="round" class="bar-1"/></svg>`,
  'chart': `<svg class="anim-svg svg-chart" viewBox="0 0 24 24" fill="none"><line x1="18" y1="20" x2="18" y2="10" stroke="#7c3aed" stroke-width="3" stroke-linecap="round" class="bar-3"/><line x1="12" y1="20" x2="12" y2="4" stroke="#0284c7" stroke-width="3" stroke-linecap="round" class="bar-2"/><line x1="6" y1="20" x2="6" y2="14" stroke="#10b981" stroke-width="3" stroke-linecap="round" class="bar-1"/></svg>`,

  '👁️': `<svg class="anim-svg svg-eye" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="#0284c7" stroke-width="2" fill="#f0f9ff"/><circle cx="12" cy="12" r="3" fill="#0284c7" class="eye-iris"/><circle cx="12" cy="12" r="1" fill="#ffffff"/></svg>`,
  '👁': `<svg class="anim-svg svg-eye" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="#0284c7" stroke-width="2" fill="#f0f9ff"/><circle cx="12" cy="12" r="3" fill="#0284c7" class="eye-iris"/><circle cx="12" cy="12" r="1" fill="#ffffff"/></svg>`,
  'eye': `<svg class="anim-svg svg-eye" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="#0284c7" stroke-width="2" fill="#f0f9ff"/><circle cx="12" cy="12" r="3" fill="#0284c7" class="eye-iris"/><circle cx="12" cy="12" r="1" fill="#ffffff"/></svg>`,

  '🎯': `<svg class="anim-svg svg-target" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#f43f5e" stroke-width="2" fill="#fff1f2"/><circle cx="12" cy="12" r="6" stroke="#f43f5e" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="#f43f5e" class="target-center"/></svg>`,
  'target': `<svg class="anim-svg svg-target" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#f43f5e" stroke-width="2" fill="#fff1f2"/><circle cx="12" cy="12" r="6" stroke="#f43f5e" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="#f43f5e" class="target-center"/></svg>`,

  '📋': `<svg class="anim-svg svg-doc" viewBox="0 0 24 24" fill="none"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" stroke="#64748b" stroke-width="2" fill="#f8fafc"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1" stroke="#7c3aed" stroke-width="1.8" fill="#ede9fe"/><line x1="8" y1="12" x2="16" y2="12" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="16" x2="13" y2="16" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/></svg>`,

  '🔄': `<svg class="anim-svg svg-spin" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l6.73-1.19"/></svg>`,
  'spin': `<svg class="anim-svg svg-spin" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l6.73-1.19"/></svg>`
};

const CLASS_MAP = {
  '✅': 'icon-check', 'check': 'icon-check',
  '🆕': 'icon-new', 'new': 'icon-new',
  '🚀': 'icon-rocket', 'rocket': 'icon-rocket',
  '⚡': 'icon-bolt', 'bolt': 'icon-bolt',
  '⚙': 'icon-gear', '⚙️': 'icon-gear', 'gear': 'icon-gear',
  '🔐': 'icon-lock', '🔒': 'icon-lock', 'lock': 'icon-lock',
  '🔓': 'icon-unlock', 'unlock': 'icon-unlock',
  '🔍': 'icon-search', 'search': 'icon-search',
  '👋': 'icon-wave', 'wave': 'icon-wave',
  '📱': 'icon-phone', 'phone': 'icon-phone',
  '😎': 'icon-cool', 'cool': 'icon-cool',
  '🦅': 'icon-eagle', 'eagle': 'icon-eagle',
  '🎉': 'icon-party', 'party': 'icon-party',
  '🏆': 'icon-trophy', 'trophy': 'icon-trophy',
  '🔊': 'icon-sound', 'sound': 'icon-sound',
  '🔇': 'icon-mute', 'mute': 'icon-mute',
  '💻': 'icon-laptop', 'laptop': 'icon-laptop',
  '🕐': 'icon-clock', '⏳': 'icon-clock', 'clock': 'icon-clock',
  '🚫': 'icon-block', 'block': 'icon-block',
  '⚠️': 'icon-warn', 'warn': 'icon-warn',
  '💡': 'icon-bulb', 'bulb': 'icon-bulb',
  '📄': 'icon-doc', 'doc': 'icon-doc', '📋': 'icon-doc',
  '🥇': 'icon-medal', '🥈': 'icon-medal', '🥉': 'icon-medal',
  '📊': 'icon-chart', 'chart': 'icon-chart',
  '👁️': 'icon-eye', '👁': 'icon-eye', 'eye': 'icon-eye',
  '🎯': 'icon-target', 'target': 'icon-target',
  '🔄': 'icon-spin', 'spin': 'icon-spin'
};

function animEmoji(key, extraCls = '') {
  const iconCls = CLASS_MAP[key] || 'icon-bolt';
  const svg = ANIM_VECTORS[key] || ANIM_VECTORS['⚡'];
  return `<span class="anim-icon ${iconCls} ${extraCls}" aria-hidden="true">${svg}</span>`;
}

function withAnimEmojis(text) {
  if (!text) return '';
  const regex = /(👋|🚀|⚡|⚙️|⚙|✅|🔐|🔒|🔓|😎|📱|🔍|🦅|🎉|🏆|🔊|🔇|💻|✨|🕐|⏳|🆕|🚫|⚠️|💡|📄|🥇|🥈|🥉|📊|👁️|👁|🎯|📋|🔄)/gu;
  return String(text).replace(regex, match => animEmoji(match));
}


/* Markdown-lite renderer for challenge descriptions */
function renderDescription(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

/* ── Mascot ───────────────────────────────────────────────── */
const Mascot = (() => {
  const emotions = {
    idle:    "Initializing secure connection...",
    worried: "That clue looks dangerous. Be careful.",
    smug:    "Called it. I knew you'd figure that out.",
    hype:    "ANSWER ACCEPTED! Points incoming!",
    happy:   "Solid work. You're tracking well.",
    sad:     "Incorrect. Think harder. I believe in you.",
    annoyed: "Solve the previous challenge first."
  };
  let current = null, typeTimer = null, visible = false;

  const SPRITES = {}; // will be loaded from mascot script

  function getSpriteData() {
    // Try to get from the mascot's SPRITES global (loaded from mascot/dist/script.js via inline)
    if (window.MASCOT_SPRITES) return window.MASCOT_SPRITES;
    return null;
  }

  function type(text) {
    const lineEl = $('#mascot-line');
    if (!lineEl) return;
    clearInterval(typeTimer);
    lineEl.textContent = '';
    let i = 0;
    let lastTick = 0;
    typeTimer = setInterval(() => {
      lineEl.textContent = text.slice(0, ++i);
      const ch = text[i - 1];
      const now = performance.now();
      if (ch && ch.trim().length > 0 && (now - lastTick >= 28)) {
        lastTick = now;
        Sound.play('mascot_type');
      }
      if (i >= text.length) clearInterval(typeTimer);
    }, 24);
  }

  function setEmotion(name, customText = null) {
    if (!visible) return;
    const sprite = $('#mascot-sprite');
    const bubble = $('#mascot-bubble');
    if (!sprite) return;
    current = name;
    const sprites = getSpriteData();
    if (sprites && sprites[name]) {
      sprite.src = sprites[name];
    }
    sprite.className = 'mascot-sprite';
    void sprite.offsetWidth;
    sprite.classList.add('pop');
    sprite.addEventListener('animationend', () => {
      sprite.className = 'mascot-sprite m-' + name;
    }, { once: true });
    const text = customText || emotions[name] || emotions.idle;
    type(text);
    if (bubble) {
      bubble.style.display = 'block';
    }
  }

  function hide() {
    clearInterval(typeTimer);
    const bubble = $('#mascot-bubble');
    if (bubble) bubble.style.display = 'none';
  }

  function react(event, customText = null) {
    if (event === 'wrong') {
      if (typeof window.showMascotSprite === 'function') {
        window.showMascotSprite('sad', customText || 'Not quite. That flag is wrong. Think again.');
        return;
      }
    }
    if (!visible) return;
    const map = {
      correct:    'hype',
      wrong:      'sad',
      hint:       'worried',
      locked:     'annoyed',
      roundDone:  'smug',
      login:      'happy',
      idle:       'idle',
      rateLimit:  'annoyed',
      challenge:  'idle',
      solved:     'smug',
      victory:    'hype',
      loading:    'idle',
    };
    setEmotion(map[event] || 'idle', customText);
  }

  // Cursor follow
  function initCursorFollow() {
    let tx = 0, ty = 0, cx = 0, cy = 0;
    document.addEventListener('pointermove', e => {
      const rig = $('#mascot-rig');
      if (!rig) return;
      const r = rig.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / window.innerWidth;
      const dy = (e.clientY - (r.top + r.height / 2)) / window.innerHeight;
      tx = Math.max(-1, Math.min(1, dx * 2.2));
      ty = Math.max(-1, Math.min(1, dy * 2.2));
    });
    (function follow() {
      cx += (tx - cx) * 0.08;
      cy += (ty - cy) * 0.08;
      const rig = $('#mascot-rig');
      if (rig) rig.style.transform = `rotateY(${cx * 14}deg) rotateX(${-cy * 8}deg) translateX(${cx * 10}px)`;
      requestAnimationFrame(follow);
    })();
  }

  return { setEmotion, react, type, initCursorFollow, hide, setVisible: (v) => { visible = v; }, isVisible: () => visible };
})();

/* ── Matrix Suction Engine (CODEVERSE X CBC, Wobbly, Back-Depth, Green) ── */
function initMatrixSuction(canvas) {
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  let animationId;
  let width, height, cx, cy;

  // Custom text phrases instead of random characters
  const phrases = [
    'CODEVERSE X CBC ',
    'codeverse x cbc ',
    'CODEVERSE · X · CBC '
  ];
  const primaryPhrase = 'CODEVERSE X CBC ';
  const phraseLen = primaryPhrase.length;

  // Inward wobbly suction particle streams (receding into the depth behind the logo)
  const PARTICLE_COUNT = 280;
  const particles = [];

  // Matrix falling rain columns that wobble and get pulled into back of logo
  let rainCols = [];

  // Absorption sparks when matter vanishes behind the logo
  const sparks = [];

  let frameCount = 0;

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    cx = width / 2;
    cy = height / 2;

    const colWidth = 24;
    const numCols = Math.floor(width / colWidth);
    rainCols = [];
    for (let i = 0; i < numCols; i++) {
      const colPhrase = phrases[i % phrases.length];
      const startIdx = Math.floor(Math.random() * colPhrase.length);
      const charsList = [];
      for (let j = 0; j < 16; j++) {
        charsList.push(colPhrase[(startIdx + j) % colPhrase.length]);
      }
      rainCols.push({
        baseX: i * colWidth + 12,
        y: Math.random() * -height,
        speed: 2.8 + Math.random() * 4.5,
        phase: Math.random() * Math.PI * 2,
        colPhrase: colPhrase,
        startIdx: startIdx,
        chars: charsList,
        nextCharTimer: 0
      });
    }
  }

  function createParticle(initial = false) {
    const maxDist = Math.hypot(width || 1000, height || 800) * 0.7;
    const minDist = 18; // deep focal point behind the logo
    const dist = initial ? minDist + Math.random() * (maxDist - minDist) : maxDist * (0.85 + Math.random() * 0.25);
    
    // Fixed radial angle: strictly inward motion (NO circular rotation!)
    const angle = Math.random() * Math.PI * 2;

    // Inward linear speed (accelerates as it gets sucked back behind the logo)
    const baseSpeed = 2.4 + Math.random() * 2.6;
    
    // Wobbly oscillation settings
    const amp = 14 + Math.random() * 18; // amplitude of wobble
    const freq = 0.02 + Math.random() * 0.015;
    const phase = Math.random() * Math.PI * 2;

    // Classic Matrix Green color palette
    const colorType = Math.random();
    let color;
    if (colorType < 0.28) color = '#00ff66'; // bright neon green
    else if (colorType < 0.60) color = '#10b981'; // emerald green
    else if (colorType < 0.85) color = '#059669'; // deep matrix green
    else color = '#047857'; // dark forest matrix green

    const particlePhrase = phrases[Math.floor(Math.random() * phrases.length)];
    const phraseIdx = Math.floor(Math.random() * particlePhrase.length);

    return {
      dist,
      angle,
      baseSpeed,
      amp,
      freq,
      phase,
      color,
      phrase: particlePhrase,
      phraseIdx: phraseIdx,
      char: particlePhrase[phraseIdx],
      trail: [],
      maxTrail: Math.floor(5 + Math.random() * 5),
      timer: 0
    };
  }

  resize();
  window.addEventListener('resize', resize);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push(createParticle(true));
  }

  // Inward suction shockwaves contracting straight towards center
  const pulses = [
    { r: 420, maxR: 420, speed: 2.8 },
    { r: 280, maxR: 420, speed: 2.8 },
    { r: 140, maxR: 420, speed: 2.8 }
  ];

  function render() {
    frameCount++;

    // Crisp light background clear with subtle green-tinted motion trail
    ctx.fillStyle = 'rgba(248, 250, 252, 0.28)';
    ctx.fillRect(0, 0, width, height);

    // 1. Inward collapsing green matrix shockwaves (contracting into back of logo)
    pulses.forEach(p => {
      p.r -= p.speed;
      if (p.r <= 48) {
        p.r = p.maxR;
      }
      const progress = p.r / p.maxR;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, p.r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(16, 185, 129, ${0.45 * (1 - progress * 0.5)})`;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 8]);
      ctx.stroke();
      ctx.restore();
    });

    // 2. Matrix falling rain columns spelling "CODEVERSE X CBC" with side-to-side WOBBLE
    ctx.font = '13px "Share Tech Mono", monospace';
    rainCols.forEach(col => {
      col.y += col.speed;
      col.nextCharTimer++;
      if (col.nextCharTimer > 5) {
        col.startIdx = (col.startIdx + 1) % col.colPhrase.length;
        for (let j = 0; j < col.chars.length; j++) {
          col.chars[j] = col.colPhrase[(col.startIdx + j) % col.colPhrase.length];
        }
        col.nextCharTimer = 0;
      }

      // Lateral wobble oscillation
      const wobbleX = Math.sin(col.y * 0.025 + frameCount * 0.06 + col.phase) * 14;
      let drawX = col.baseX + wobbleX;
      let drawY = col.y;

      // Gravitational pull toward center back of logo if within range
      const dx = cx - drawX;
      const dy = cy - drawY;
      const dist = Math.hypot(dx, dy);

      if (dist < 480 && dist > 45) {
        const pull = Math.pow((480 - dist) / 480, 1.8) * 75;
        drawX += (dx / dist) * pull;
        drawY += (dy / dist) * (pull * 0.6);
      }

      // Draw stream characters in Matrix Green
      for (let j = 0; j < col.chars.length; j++) {
        const charY = drawY - (j * 16);
        if (charY < -20 || charY > height + 20) continue;

        const alpha = Math.max(0, 1 - (j / col.chars.length));
        if (j === 0) {
          ctx.fillStyle = '#00ff66';
          ctx.shadowColor = 'rgba(0, 255, 102, 0.7)';
          ctx.shadowBlur = 8;
        } else if (j < 3) {
          ctx.fillStyle = `rgba(16, 185, 129, ${alpha * 0.95})`;
          ctx.shadowBlur = 0;
        } else {
          ctx.fillStyle = `rgba(5, 150, 105, ${alpha * 0.7})`;
          ctx.shadowBlur = 0;
        }
        ctx.fillText(col.chars[j], drawX, charY);
      }

      if (col.y - (col.chars.length * 16) > height) {
        col.y = Math.random() * -100;
        col.speed = 2.8 + Math.random() * 4.5;
      }
    });

    // 3. Inward Wobbly Matrix Streams carrying "CODEVERSE X CBC" (Receding into depth behind logo)
    const maxR = Math.hypot(width, height) * 0.7;

    particles.forEach(p => {
      // Inward acceleration as it nears the center
      const accel = Math.max(1, Math.pow(380 / Math.max(p.dist, 35), 0.7));
      p.dist -= p.baseSpeed * accel;

      // Wobbly sine oscillation perpendicular to the radial direction vector (NO CIRCULAR SPIN!)
      const uX = Math.cos(p.angle);
      const uY = Math.sin(p.angle);
      const nX = -uY; // perpendicular normal
      const nY = uX;

      // Wobbly sine wave
      const wobble = Math.sin(p.dist * p.freq + frameCount * 0.08 + p.phase) * p.amp;

      const px = cx + uX * p.dist + nX * wobble;
      const py = cy + uY * p.dist + nY * wobble;

      // 3D Depth perception: as it gets sucked back behind the logo, scale shrinks
      const depthFactor = Math.min(1, Math.max(0.2, p.dist / 380));
      const charSize = Math.round(4 + depthFactor * 11);

      // Track trail for glowing wobbly green streak
      p.trail.unshift({ x: px, y: py });
      if (p.trail.length > p.maxTrail) p.trail.pop();

      p.timer++;
      if (p.timer % 6 === 0) {
        p.phraseIdx = (p.phraseIdx + 1) % p.phrase.length;
        p.char = p.phrase[p.phraseIdx];
      }

      // Draw light streaking wobbly trail
      if (p.trail.length > 1) {
        ctx.beginPath();
        ctx.moveTo(p.trail[0].x, p.trail[0].y);
        for (let t = 1; t < p.trail.length; t++) {
          ctx.lineTo(p.trail[t].x, p.trail[t].y);
        }
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 0.6 + depthFactor * 1.2;
        ctx.globalAlpha = 0.2 + depthFactor * 0.35;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      // Draw matrix green character with perspective depth
      ctx.font = `bold ${charSize}px "Share Tech Mono", monospace`;
      ctx.fillStyle = p.dist < 80 ? '#00ff66' : p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = p.dist < 100 ? 8 : 3;
      ctx.fillText(p.char, px, py);
      ctx.shadowBlur = 0;

      // When particle enters deep behind the logo (< 24px), it is fully absorbed!
      if (p.dist <= 24) {
        // Spawn green absorption sparks vanishing behind the logo
        for (let s = 0; s < 2; s++) {
          sparks.push({
            x: px,
            y: py,
            vx: (Math.random() - 0.5) * 4,
            vy: (Math.random() - 0.5) * 4,
            color: '#00ff66',
            life: 1.0,
            decay: 0.09 + Math.random() * 0.08
          });
        }
        Object.assign(p, createParticle(false));
      }
    });

    // 4. Draw & update green absorption sparks
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.x += s.vx;
      s.y += s.vy;
      s.life -= s.decay;
      if (s.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2 * s.life, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.globalAlpha = s.life;
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }

    // 5. Central Singularity Vanishing Point Halo (Behind Logo in Matrix Green)
    const vortexGrad = ctx.createRadialGradient(cx, cy, 10, cx, cy, 150);
    vortexGrad.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
    vortexGrad.addColorStop(0.35, 'rgba(5, 150, 105, 0.18)');
    vortexGrad.addColorStop(0.7, 'rgba(16, 185, 129, 0.06)');
    vortexGrad.addColorStop(1, 'transparent');

    ctx.fillStyle = vortexGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, 150, 0, Math.PI * 2);
    ctx.fill();

    animationId = requestAnimationFrame(render);
  }

  animationId = requestAnimationFrame(render);

  return function stop() {
    cancelAnimationFrame(animationId);
    window.removeEventListener('resize', resize);
  };
}

/* ── Loading Screen ──────────────────────────────────────── */
async function runLoadingScreen() {
  const screen = $('#loading-screen');
  const canvas = $('#matrix-canvas');

  let stopMatrix = null;
  if (canvas) {
    stopMatrix = initMatrixSuction(canvas);
  }

  // Real-time whole logo jitter/glitch coordinator
  const glitchInterval = setInterval(() => {
    const stage = $('#whole-glitch-stage');
    if (!stage) return;
    if (Math.random() > 0.4) {
      const dx = (Math.random() - 0.5) * 32;
      const dy = (Math.random() - 0.5) * 16;
      const rot = (Math.random() - 0.5) * 8;
      const skew = (Math.random() - 0.5) * 20;
      const scale = 0.92 + Math.random() * 0.22;
      stage.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg) skewX(${skew}deg) scale(${scale})`;
      stage.style.filter = Math.random() > 0.4
        ? `drop-shadow(${dx > 0 ? -12 : 12}px 0 #00ff66) drop-shadow(${dx > 0 ? 12 : -12}px 0 #10b981)`
        : `invert(0.65) contrast(1.6) drop-shadow(0 0 20px #00ff66)`;
      setTimeout(() => {
        if (stage) {
          stage.style.transform = '';
          stage.style.filter = '';
        }
      }, 65);
    }
  }, 180);

  Sound.play('boot');

  // Let the cyber matrix suction and violent glitch effect run smoothly for ~2.6s
  await new Promise(r => setTimeout(r, 2600));

  // Exit effect: final suction collapse into center singularity
  if (screen) {
    screen.classList.add('loading-exit');
    await new Promise(r => setTimeout(r, 620));
    clearInterval(glitchInterval);
    if (stopMatrix) stopMatrix();
    screen.remove();
  } else {
    clearInterval(glitchInterval);
  }

  Sound.play('login');
  if (currentUser) {
    loginUser(currentUser);
  } else {
    showAuthScreen();
  }
}


/* ── Auth Screen ─────────────────────────────────────────── */
function showAuthScreen() {
  const app = $('#app');

  // ── inject auth styles ──────────────────────────────────
  if (!$('#auth-styles')) {
    const s = document.createElement('style');
    s.id = 'auth-styles';
    s.textContent = `
      @keyframes auth-float {
        0%,100% { transform: translateY(0px) rotate(-1deg); }
        50%      { transform: translateY(-18px) rotate(1deg); }
      }
      @keyframes auth-glow-pulse {
        0%,100% { box-shadow: 0 0 30px #7c3aed33, 0 0 60px #7c3aed11; }
        50%      { box-shadow: 0 0 60px #7c3aed55, 0 0 120px #7c3aed22; }
      }
      @keyframes auth-slide-up {
        from { opacity:0; transform: translateY(28px); }
        to   { opacity:1; transform: translateY(0); }
      }
      @keyframes auth-step-in {
        from { opacity:0; transform: translateX(32px) scale(0.97); }
        to   { opacity:1; transform: translateX(0) scale(1); }
      }
      @keyframes auth-shake {
        0%,100% { transform: translateX(0); }
        20%,60% { transform: translateX(-6px); }
        40%,80% { transform: translateX(6px); }
      }
      @keyframes mascot-bubble-pop {
        0%   { opacity:0; transform: scale(0.7) translateY(10px); }
        60%  { transform: scale(1.05) translateY(-2px); }
        100% { opacity:1; transform: scale(1) translateY(0); }
      }
      .auth-root {
        min-height: 100vh;
        background: linear-gradient(135deg, #e2e8f0 0%, #ede9fe 50%, #e0f2fe 100%);
        display: flex; align-items: center; justify-content: center;
        padding: 24px 16px;
        position: relative; overflow: hidden;
      }
      .auth-root::before {
        content: '';
        position: absolute; inset: 0;
        background-image: radial-gradient(circle at 20% 20%, #7c3aed08 0%, transparent 50%),
                          radial-gradient(circle at 80% 80%, #0284c708 0%, transparent 50%);
        pointer-events: none;
      }
      .auth-grid {
        display: grid;
        grid-template-columns: 1fr 440px;
        gap: 48px;
        width: 100%;
        max-width: 900px;
        align-items: center;
      }
      @media (max-width: 720px) {
        .auth-grid { grid-template-columns: 1fr; gap: 24px; }
        .auth-mascot-col { order: -1; }
      }
      /* Mascot column */
      .auth-mascot-col {
        display: flex; flex-direction: column; align-items: center; gap: 20px;
        animation: auth-slide-up 0.6s cubic-bezier(.4,0,.2,1) both;
      }
      .auth-brand {
        text-align: center;
      }
      .auth-brand-title {
        font-family: 'Plus Jakarta Sans', sans-serif;
        font-size: 26px; font-weight: 800;
        color: #0f172a; letter-spacing: -0.5px;
        line-height: 1.2;
      }
      .auth-brand-sub {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; color: #64748b;
        margin-top: 4px;
      }
      .auth-mascot-rig {
        width: 220px; height: 220px;
        display: flex; align-items: center; justify-content: center;
        animation: auth-float 4s ease-in-out infinite;
        filter: drop-shadow(0 24px 40px #7c3aed33);
        cursor: default;
      }
      .auth-mascot-rig img {
        width: 100%; height: 100%; object-fit: contain;
      }
      .auth-mascot-bubble {
        background: #f8fafc;
        border: 2px solid #ddd6fe;
        border-radius: 16px;
        padding: 10px 16px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px; color: #4c1d95;
        max-width: 260px; text-align: center;
        position: relative;
        animation: mascot-bubble-pop 0.5s cubic-bezier(.4,0,.2,1) both;
        box-shadow: 0 4px 20px #7c3aed18;
      }
      .auth-mascot-bubble::before {
        content: '';
        position: absolute; top: -10px; left: 50%; transform: translateX(-50%);
        border: 10px solid transparent;
        border-bottom-color: #ddd6fe;
        border-top: none;
      }
      .auth-mascot-bubble::after {
        content: '';
        position: absolute; top: -8px; left: 50%; transform: translateX(-50%);
        border: 9px solid transparent;
        border-bottom-color: #f8fafc;
        border-top: none;
      }
      /* Card column */
      .auth-card-col {
        animation: auth-slide-up 0.7s 0.1s cubic-bezier(.4,0,.2,1) both;
      }
      .auth-card {
        background: white;
        border-radius: 24px;
        border: 1.5px solid #cbd5e1;
        box-shadow: 0 20px 60px rgba(124, 58, 237, 0.12), 0 4px 20px rgba(0, 0, 0, 0.05);
        padding: 32px 28px;
        animation: auth-glow-pulse 3s ease-in-out infinite;
      }
      /* Gate (yes/no) */
      .auth-gate {
        text-align: center;
        animation: auth-slide-up 0.4s cubic-bezier(.4,0,.2,1) both;
      }
      .auth-gate-q {
        font-family: 'Plus Jakarta Sans', sans-serif;
        font-size: 22px; font-weight: 800; color: #0f172a;
        margin-bottom: 6px; line-height: 1.3;
      }
      .auth-gate-sub {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; color: #64748b; margin-bottom: 28px;
      }
      .auth-gate-btns { display: flex; gap: 14px; justify-content: center; }
      .auth-gate-yes, .auth-gate-no {
        flex: 1; max-width: 160px; padding: 16px 12px;
        border-radius: 16px; font-weight: 800;
        font-family: 'Plus Jakarta Sans', sans-serif;
        font-size: 15px; cursor: pointer;
        border: 2px solid transparent;
        transition: all 0.18s cubic-bezier(.4,0,.2,1);
        display: flex; flex-direction: column; align-items: center; gap: 6px;
      }
      .auth-gate-yes {
        background: linear-gradient(135deg, #7c3aed, #4f46e5);
        color: white;
        box-shadow: 0 8px 24px #7c3aed30;
      }
      .auth-gate-yes:hover {
        transform: translateY(-3px) scale(1.03);
        box-shadow: 0 12px 32px #7c3aed50;
      }
      .auth-gate-no {
        background: white; color: #7c3aed;
        border-color: #c4b5fd;
        box-shadow: 0 4px 16px #7c3aed12;
      }
      .auth-gate-no:hover {
        background: #f5f3ff;
        transform: translateY(-3px) scale(1.03);
        box-shadow: 0 8px 24px #7c3aed20;
      }
      .auth-gate-icon { font-size: 28px; display: flex; align-items: center; justify-content: center; min-height: 36px; }
      .auth-gate-icon .anim-icon { width: 34px; height: 34px; }
      /* Panel transitions */
      .auth-panel {
        animation: auth-step-in 0.35s cubic-bezier(.4,0,.2,1) both;
      }
      .auth-panel-title {
        font-family: 'Plus Jakarta Sans', sans-serif;
        font-size: 20px; font-weight: 800; color: #0f172a;
        margin-bottom: 4px;
      }
      .auth-panel-sub {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; color: #64748b; margin-bottom: 24px;
      }
      /* Back link */
      .auth-back {
        display: inline-flex; align-items: center; gap-4px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; color: #7c3aed; cursor: pointer;
        background: none; border: none; padding: 0;
        margin-bottom: 20px;
        opacity: 0.8;
        transition: opacity 0.15s;
      }
      .auth-back:hover { opacity:1; text-decoration: underline; }
      /* Form fields */
      .auth-field { margin-bottom: 16px; }
      .auth-label {
        display: block;
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
        color: #475569; margin-bottom: 6px; text-transform: uppercase;
      }
      .auth-input-wrap { position: relative; display: flex; align-items: center; }
      .auth-input-icon {
        position: absolute; left: 12px;
        font-size: 18px; color: #94a3b8;
        pointer-events: none;
      }
      .auth-input {
        width: 100%; padding: 13px 14px 13px 42px;
        background: #edf2f7;
        border: 1.5px solid #cbd5e1;
        border-radius: 12px;
        font-family: 'Inter', sans-serif;
        font-size: 14px; color: #0f172a;
        outline: none;
        transition: all 0.18s;
      }
      .auth-input:focus {
        background: white;
        border-color: #7c3aed;
        box-shadow: 0 0 0 3px #7c3aed18;
      }
      /* Buttons */
      .auth-btn-primary {
        width: 100%; padding: 14px;
        background: linear-gradient(135deg, #7c3aed, #4f46e5);
        color: white;
        border: none; border-radius: 12px;
        font-family: 'Plus Jakarta Sans', sans-serif;
        font-size: 14px; font-weight: 700;
        cursor: pointer; letter-spacing: 0.02em;
        transition: all 0.18s cubic-bezier(.4,0,.2,1);
        box-shadow: 0 6px 20px #7c3aed30;
        display: flex; align-items: center; justify-content: center; gap: 8px;
        margin-top: 8px;
      }
      .auth-btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 10px 28px #7c3aed40;
      }
      .auth-btn-primary:active { transform: translateY(0); }
      .auth-btn-ghost {
        background: none; border: 1.5px solid #e2e8f0;
        color: #475569; border-radius: 10px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; font-weight: 600;
        padding: 8px 14px; cursor: pointer;
        transition: all 0.15s;
      }
      .auth-btn-ghost:hover { border-color: #7c3aed; color: #7c3aed; background: #f5f3ff; }
      /* Error */
      .auth-error {
        background: #fff1f2; border: 1.5px solid #fecdd3;
        color: #be123c; border-radius: 10px;
        padding: 10px 14px; font-family: 'JetBrains Mono', monospace;
        font-size: 11px; font-weight: 600;
        margin-top: 8px; display: none;
        animation: auth-shake 0.4s cubic-bezier(.4,0,.2,1);
      }
      .auth-error.show { display: block; }
      /* Progress dots */
      .auth-progress {
        display: flex; gap: 6px; justify-content: center;
        margin-bottom: 24px;
      }
      .auth-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #e2e8f0;
        transition: all 0.25s;
      }
      .auth-dot.active { background: #7c3aed; transform: scale(1.3); }
      .auth-dot.done   { background: #10b981; }
      /* Demo strip */
      .auth-demo-strip {
        margin-top: 20px; padding-top: 16px;
        border-top: 1.5px solid #f1f5f9;
        display: flex; align-items: center; justify-content: center; gap: 12px;
        flex-wrap: wrap;
      }
      .auth-demo-btn {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; font-weight: 700;
        background: none; border: none; cursor: pointer;
        padding: 4px 8px; border-radius: 6px;
        transition: all 0.15s;
      }
      .auth-demo-btn.cyan  { color: #0284c7; }
      .auth-demo-btn.cyan:hover  { background: #e0f2fe; }
      .auth-demo-btn.purple{ color: #7c3aed; }
      .auth-demo-btn.purple:hover{ background: #f5f3ff; }
      /* Online badge */
      .auth-online-badge {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 3px 9px; border-radius: 6px;
        background: #ecfdf5; border: 1px solid #bbf7d0;
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px; font-weight: 700; color: #10b981;
        margin-left: 8px; vertical-align: middle;
      }
      .auth-online-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #10b981;
        animation: pulse 1.5s infinite;
      }
    `;
    document.head.appendChild(s);
  }

  // ── get mascot sprite ───────────────────────────────────
  const sprites = window.MASCOT_SPRITES || {};
  const mascotSrc = sprites.idle || sprites.happy || '';
  const devInfo = DeviceGuard.check();
  const mobileNoticeHtml = devInfo.isRestricted ? `
            <div class="auth-device-info-banner">
              <div class="auth-device-info-icon">${animEmoji('📱', 'text-2xl')}</div>
              <div class="auth-device-info-text">
                <div class="auth-device-info-title">Mobile / Tablet Mode Active</div>
                <div class="auth-device-info-desc">Operatives can register and log in on mobile/tabs. A laptop is required to open the live exam.</div>
              </div>
            </div>
  ` : '';

  app.innerHTML = `
    <div class="auth-root">
      <div class="auth-grid">

        <!-- Mascot column (always visible) -->
        <div class="auth-mascot-col">
          <div class="auth-brand">
            <div class="auth-brand-title">
              CASEFILE // 0xRAVEN
              <span class="auth-online-badge"><span class="auth-online-dot"></span>ONLINE</span>
            </div>
            <div class="auth-brand-sub">Hybrid Cybersecurity CTF · Operation 0xRAVEN</div>
          </div>

          <div class="auth-mascot-rig" id="auth-mascot-rig">
            ${mascotSrc
              ? `<img id="auth-mascot-img" src="${mascotSrc}" alt="Mascot">`
              : `<div style="width:180px;height:180px;background:linear-gradient(135deg,#7c3aed,#4f46e5);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:80px;">${animEmoji('🦅', 'text-6xl')}</div>`
            }
          </div>

          <div class="auth-mascot-bubble" id="auth-bubble">
            <span id="auth-bubble-text">Hey agent! Ready to begin your investigation? ${animEmoji('🔍')}</span>
          </div>
        </div>

        <!-- Card column -->
        <div class="auth-card-col">
          <div class="auth-card">
            ${mobileNoticeHtml}
            <div id="auth-panel-gate">
              ${_buildAuthGate()}
            </div>
            <div id="auth-panel-login" style="display:none;"></div>
            <div id="auth-panel-register" style="display:none;"></div>
          </div>
        </div>

      </div>
    </div>
  `;

  // enter-key on login inputs
  document.addEventListener('keydown', _authKeyHandler);
}

function _authKeyHandler(e) {
  if (e.key !== 'Enter') return;
  const lp = document.getElementById('login-panel-active');
  if (lp) doLogin();
}

function _buildAuthGate() {
  return `
    <div class="auth-gate auth-panel">
      <div class="auth-gate-q" id="gate-q-title">Have you registered before?</div>
      <div class="auth-gate-sub" id="gate-q-sub">// Select your operative status</div>
      <div class="auth-gate-btns">
        <button class="auth-gate-yes" onclick="authShowLogin()" id="gate-yes-btn">
          <span class="auth-gate-icon">${animEmoji('✅')}</span>
          <span>YES, LOG IN</span>
          <span style="font-size:11px;opacity:.8;font-family:'JetBrains Mono',monospace">I have an account</span>
        </button>
        <button class="auth-gate-no" onclick="authShowRegister()" id="gate-no-btn">
          <span class="auth-gate-icon">${animEmoji('🆕')}</span>
          <span>NO, SIGN UP</span>
          <span style="font-size:11px;opacity:.8;font-family:'JetBrains Mono',monospace">Create account</span>
        </button>
      </div>
    </div>
  `;
}

window.authShowLogin = () => {
  Sound.play('click');
  _authSetBubble(`Welcome back, agent! Enter your credentials. ${animEmoji('🔐')}`);
  _authUpdateMascot('happy');
  document.getElementById('auth-panel-gate').style.display = 'none';
  document.getElementById('auth-panel-register').style.display = 'none';
  const panel = document.getElementById('auth-panel-login');
  panel.style.display = 'block';
  panel.id = 'auth-panel-login';
  panel.innerHTML = `
    <div class="auth-panel" id="login-panel-active">
      <button class="auth-back" onclick="authShowGate()">← Back</button>
      <div class="auth-panel-title" id="login-panel-title">Welcome Back</div>
      <div class="auth-panel-sub" id="login-panel-sub">// Authenticate to access the investigation</div>

      <div class="auth-field">
        <label class="auth-label">Username / Operative Handle</label>
        <div class="auth-input-wrap">
          <span class="material-symbols-outlined auth-input-icon">person</span>
          <input type="text" id="login-username" class="auth-input" placeholder="Enter operative handle" autocomplete="username">
        </div>
      </div>

      <div class="auth-field">
        <label class="auth-label">Security Passcode</label>
        <div class="auth-input-wrap">
          <span class="material-symbols-outlined auth-input-icon">key</span>
          <input type="password" id="login-password" class="auth-input" placeholder="••••••••" autocomplete="current-password">
        </div>
      </div>

      <div id="login-error" class="auth-error"></div>

      <button onclick="doLogin()" class="auth-btn-primary">
        <span class="material-symbols-outlined" style="font-size:18px">login</span>
        ENTER THE REPOSITORY →
      </button>
    </div>
  `;
  const titleEl = document.getElementById('login-panel-title');
  const subEl = document.getElementById('login-panel-sub');
  if (titleEl) _typewriter(titleEl, 'Welcome Back', 18, false);
  if (subEl) _typewriter(subEl, '// Authenticate to access the investigation', 12, false);
  document.getElementById('login-username')?.focus();
};

window.authShowGate = () => {
  Sound.play('click');
  _authSetBubble(`Hey agent! Ready to begin your investigation? ${animEmoji('🔍')}`);
  _authUpdateMascot('idle');
  document.getElementById('auth-panel-login').style.display = 'none';
  document.getElementById('auth-panel-register').style.display = 'none';
  const gatePanel = document.getElementById('auth-panel-gate');
  gatePanel.style.display = 'block';
  gatePanel.innerHTML = _buildAuthGate();
  const qEl = document.getElementById('gate-q-title');
  const subEl = document.getElementById('gate-q-sub');
  if (qEl) _typewriter(qEl, 'Have you registered before?', 18, false);
  if (subEl) _typewriter(subEl, '// Select your operative status', 12, false);
};

// ── Registration wizard state ─────────────────────────────
let _regData = { name: '', phone: '', username: '', password: '' };
let _regStep = 0;

window.authShowRegister = () => {
  Sound.play('click');
  _regData = { name: '', phone: '', username: '', password: '' };
  _regStep = 0;
  document.getElementById('auth-panel-gate').style.display = 'none';
  document.getElementById('auth-panel-login').style.display = 'none';
  const panel = document.getElementById('auth-panel-register');
  panel.style.display = 'block';
  _renderRegStep();
};

function _renderRegStep() {
  const steps = [
    { label: 'Your Full Name',     icon: 'badge',      id: 'reg-name',     type: 'text',     placeholder: 'e.g. Alex Mercer', bubble: "Nice to meet you! What's your name? 👋" },
    { label: 'Phone Number',       icon: 'phone',      id: 'reg-phone',    type: 'tel',      placeholder: 'e.g. +91 98765 43210', bubble: "Your phone, agent. Stay reachable. 📱" },
    { label: 'Choose a Username',  icon: 'person',     id: 'reg-username', type: 'text',     placeholder: 'e.g. agent_zero', bubble: "Pick a cool codename, agent. 😎" },
    { label: 'Create a Password',  icon: 'key',        id: 'reg-password', type: 'password', placeholder: '••••••••', bubble: "Make it strong. No 1234s! 🔐" },
  ];
  const total = steps.length;
  const step = steps[_regStep];
  _authSetBubble(step.bubble);
  _authUpdateMascot(_regStep >= 3 ? 'hype' : 'idle');

  const dots = Array.from({length: total}, (_,i) =>
    `<div class="auth-dot${i < _regStep ? ' done' : i === _regStep ? ' active' : ''}"></div>`
  ).join('');

  const panel = document.getElementById('auth-panel-register');
  panel.innerHTML = `
    <div class="auth-panel">
      <button class="auth-back" onclick="_authRegBack()">
        ${_regStep === 0 ? '← Cancel' : '← Back'}
      </button>
      <div class="auth-progress">${dots}</div>
      <div class="auth-panel-title" id="reg-step-title" style="margin-bottom:2px">Step ${_regStep + 1} of ${total}</div>
      <div class="auth-panel-sub" id="reg-step-sub" style="margin-bottom:20px">${step.label}</div>

      <div class="auth-field">
        <label class="auth-label">${step.label}</label>
        <div class="auth-input-wrap">
          <span class="material-symbols-outlined auth-input-icon">${step.icon}</span>
          <input type="${step.type}" id="${step.id}" class="auth-input"
            placeholder="${step.placeholder}"
            value="${step.type !== 'password' ? (_regData[step.id.replace('reg-','')] || '') : ''}">
        </div>
      </div>

      <div id="reg-step-error" class="auth-error"></div>

      <button onclick="_authRegNext()" class="auth-btn-primary">
        ${_regStep < total - 1 ? 'NEXT STEP →' : `${animEmoji('🚀', 'mr-1.5')} CREATE ACCOUNT`}
      </button>
    </div>
  `;
  const stepSub = document.getElementById('reg-step-sub');
  if (stepSub) _typewriter(stepSub, step.label, 16, false);

  const inp = document.getElementById(step.id);
  if (inp) { inp.focus(); inp.addEventListener('keydown', e => { if (e.key === 'Enter') _authRegNext(); }); }
}

window._authRegBack = () => {
  Sound.play('back');
  if (_regStep === 0) { authShowGate(); return; }
  _regStep--;
  _renderRegStep();
};

window._authRegNext = async () => {
  const fields = ['name','phone','username','password'];
  const ids    = ['reg-name','reg-phone','reg-username','reg-password'];
  const inp    = document.getElementById(ids[_regStep]);
  const val    = inp?.value?.trim();
  const errEl  = document.getElementById('reg-step-error');

  // validation
  if (!val) { _authRegError(errEl, 'This field is required.'); return; }

  // Step 1: Phone
  if (_regStep === 1) {
    if (!/^[\d\s\+\-\(\)]{6,}$/.test(val)) {
      _authRegError(errEl, 'Enter a valid phone number (at least 6 digits).');
      return;
    }
    try {
      const res = await Api.get(`/api/auth/check?phone=${encodeURIComponent(val)}`);
      if (res && res.phoneTaken) {
        _authRegError(errEl, 'This phone number is already registered. Please log in or use another number.');
        return;
      }
    } catch (_) {}
  }

  // Step 2: Username
  if (_regStep === 2) {
    if (!/^[a-zA-Z0-9_\-\.]{3,32}$/.test(val)) {
      _authRegError(errEl, 'Username must be 3-32 characters (letters, numbers, _ - .).');
      return;
    }
    try {
      const res = await Api.get(`/api/auth/check?username=${encodeURIComponent(val)}`);
      if (res && res.usernameTaken) {
        _authRegError(errEl, 'Username already taken. Please choose another codename.');
        return;
      }
    } catch (_) {}
  }

  // Step 3: Password
  if (_regStep === 3 && val.length < 6) {
    _authRegError(errEl, 'Password must be at least 6 characters.');
    return;
  }

  _regData[fields[_regStep]] = val;
  errEl.classList.remove('show');

  if (_regStep < 3) {
    Sound.play('step');
    _regStep++;
    _renderRegStep();
  } else {
    doRegister();
  }
};

function _authRegError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  Sound.play('wrong');
  el.parentElement?.classList.add('auth-shake');
  setTimeout(() => el.parentElement?.classList.remove('auth-shake'), 450);
}

// ── Typewriter & Keyboard Tick System ─────────────────────
let _bubbleTypeTimer = null;
let _lastTickTime = 0;

function playTypingTick() {
  const now = performance.now();
  if (now - _lastTickTime > 30) {
    _lastTickTime = now;
    Sound.play('mascot_type');
  }
}

// Play mechanical tick tick sound on typing in login & signup inputs
document.addEventListener('keydown', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('auth-input')) {
    if (!['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Escape'].includes(e.key)) {
      playTypingTick();
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('auth-input')) {
    playTypingTick();
  }
});

function _tokenizeHtml(html) {
  const tokens = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const tagEnd = html.indexOf('>', i);
      if (tagEnd !== -1) {
        if (html.slice(i, i + 35).includes('anim-emoji')) {
          const closeTag = html.indexOf('</span>', tagEnd);
          if (closeTag !== -1) {
            tokens.push(html.slice(i, closeTag + 7));
            i = closeTag + 7;
            continue;
          }
        }
        tokens.push(html.slice(i, tagEnd + 1));
        i = tagEnd + 1;
        continue;
      }
    }
    const code = html.codePointAt(i);
    const char = String.fromCodePoint(code);
    tokens.push(char);
    i += char.length;
  }
  return tokens;
}

function _typewriter(el, rawText, speed = 22, playTick = true, onComplete = null) {
  if (!el) return;
  if (el._typeTimer) {
    clearInterval(el._typeTimer);
    el._typeTimer = null;
  }
  const processed = withAnimEmojis(rawText);
  const tokens = _tokenizeHtml(processed);
  el.innerHTML = '';
  let idx = 0;
  let accumulated = '';
  el._typeTimer = setInterval(() => {
    if (idx >= tokens.length) {
      clearInterval(el._typeTimer);
      el._typeTimer = null;
      if (onComplete) onComplete();
      return;
    }
    const token = tokens[idx];
    accumulated += token;
    el.innerHTML = accumulated;
    if (playTick && !token.startsWith('<') && token.trim().length > 0) {
      playTypingTick();
    }
    idx++;
  }, speed);
}

function _authSetBubble(text) {
  const el = document.getElementById('auth-bubble-text');
  if (!el) return;
  _typewriter(el, text, 22, true);
}

function _authUpdateMascot(emotion) {
  const sprites = window.MASCOT_SPRITES || {};
  const img = document.getElementById('auth-mascot-img');
  if (img && sprites[emotion]) {
    img.style.transition = 'opacity 0.2s';
    img.style.opacity = '0';
    setTimeout(() => { img.src = sprites[emotion]; img.style.opacity = '1'; }, 200);
  }
}

// ── Legacy tab switcher (kept for compatibility) ─────────
window.switchAuthTab = (tab) => {
  if (tab === 'login') authShowLogin();
  else authShowRegister();
};


window.doLogin = async () => {
  const username = $('#login-username')?.value?.trim();
  const password = $('#login-password')?.value;
  if (!username || !password) {
    showAuthError('login', 'Username and password required.');
    return;
  }
  try {
    const { token, user } = await Api.post('/api/auth/login', { username, password });
    Api.setToken(token);
    Sound.play('login');
    loginUser(user);
  } catch (err) {
    showAuthError('login', err.message || 'Invalid credentials. Please verify your username and passcode.');
    Sound.play('wrong');
  }
};


window.doDemoLogin = async () => {
  Sound.play('click');
  try {
    const { token, user } = await Api.post('/api/auth/login', { username: 'demo', password: 'demo123' });
    Api.setToken(token);
    loginUser(user);
  } catch (err) {
    toast('Demo Login', 'Demo account unavailable: ' + err.message, 'error');
  }
};

window.doAdminLogin = async () => {
  Sound.play('click');
  try {
    const { token, user } = await Api.post('/api/auth/login', { username: 'admin', password: 'admin123' });
    Api.setToken(token);
    loginUser(user);
  } catch (err) {
    toast('Admin Login', 'Admin login failed: ' + err.message, 'error');
  }
};

window.doRegister = async () => {
  // Support both new wizard flow and any legacy call
  const username = _regData?.username || document.getElementById('reg-username')?.value?.trim();
  const password = _regData?.password || document.getElementById('reg-password')?.value;
  const name     = _regData?.name || '';
  const phone    = _regData?.phone || '';

  if (!username || !password) {
    const errEl = document.getElementById('reg-step-error');
    if (errEl) _authRegError(errEl, 'All fields required.');
    return;
  }
  if (password.length < 6) {
    const errEl = document.getElementById('reg-step-error');
    if (errEl) _authRegError(errEl, 'Password must be at least 6 characters.');
    return;
  }

  try {
    const { token, user } = await Api.post('/api/auth/register', { username, password, name, phone });
    Api.setToken(token);
    Sound.play('register');
    _authUpdateMascot('worried');
    _authSetBubble(`Account created! Waiting for admin to approve you, ${username}. 🕐`);
    toast('Account Created!', `Welcome, ${username}! Waiting for admin approval.`, 'info');
    setTimeout(() => loginUser(user), 1200);
  } catch (err) {
    const errEl = document.getElementById('reg-step-error');
    if (errEl) _authRegError(errEl, err.message || 'Registration failed.');
    else toast('Registration Error', err.message, 'error');
  }
};

function showAuthError(form, msg) {
  // New auth-error style (login panel)
  const newErrEl = form === 'login' ? document.getElementById('login-error') : document.getElementById('reg-step-error');
  if (newErrEl) {
    newErrEl.textContent = msg;
    newErrEl.classList.add('show');
    setTimeout(() => { newErrEl.classList.remove('show'); newErrEl.textContent = ''; }, 4000);
    return;
  }
  // Fallback legacy
  const errEl = $(`#${form === 'login' ? 'login' : 'reg'}-error`);
  if (errEl) {
    errEl.textContent = msg;
    setTimeout(() => { if (errEl) errEl.textContent = ''; }, 4000);
  }
}

/** Returns in-memory defaults only for display/compatibility; real users are in SQLite */
function getDefaultUsers() {
  return [];
}

/* ============================================================
   PAGE TRANSITION ENGINE — True Multi-Direction Wipe
   Clones old content into a snapshot overlay, updates real DOM
   underneath, then clip-paths the snapshot away while a purple
   glow line sweeps at the clip boundary. Both old & new content
   are visible simultaneously, split by the line.
   ============================================================ */
const PageTransition = (() => {
  const DURATION = 680; // ms
  const DIRECTIONS = ['down', 'up', 'left', 'right'];

  function wipe(fn) {
    // Clean up any existing transition elements
    const oldOverlay = document.getElementById('pt-wipe-overlay');
    if (oldOverlay) oldOverlay.remove();
    const oldLine = document.getElementById('pt-wipe-line');
    if (oldLine) oldLine.remove();

    // Pick a random direction
    const dir = DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    const scrollX = window.scrollX || document.documentElement.scrollLeft;

    // ── Snapshot the old page ──────────────────────────────────
    const overlay = document.createElement('div');
    overlay.id = 'pt-wipe-overlay';
    overlay.dataset.dir = dir;

    const snapshot = document.createElement('div');
    snapshot.className = 'pt-snapshot';
    // Offset to match current scroll so the clone lines up visually
    snapshot.style.transform = `translate(${-scrollX}px, ${-scrollY}px)`;

    // Clone every body child except our own transition elements
    for (const child of document.body.children) {
      if (child.id === 'pt-wipe-overlay' || child.id === 'pt-wipe-line') continue;
      snapshot.appendChild(child.cloneNode(true));
    }
    overlay.appendChild(snapshot);
    document.body.appendChild(overlay);

    // ── Glow line (separate element so it isn't clip-pathed) ──
    const line = document.createElement('div');
    line.id = 'pt-wipe-line';
    line.dataset.dir = dir;
    document.body.appendChild(line);

    // ── Update real content underneath ────────────────────────
    if (typeof fn === 'function') fn();

    // ── Start animations next frame ──────────────────────────
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.classList.add('pt-wipe-active');
        line.classList.add('pt-wipe-active');
      });
    });

    // ── Clean up when done ───────────────────────────────────
    setTimeout(() => {
      if (overlay.parentNode) overlay.remove();
      if (line.parentNode) line.remove();
    }, DURATION + 180);
  }

  const run = wipe;
  return { wipe, run };
})();



function loginUser(user) {
  currentUser = user;
  // Note: session token is already set in Api by doLogin/doRegister
  // The user object comes directly from the API response

  if (user.role === 'admin') {
    PageTransition.run(() => initApp(true));
    return;
  }
  if (user.disqualified)      { PageTransition.run(() => showDisqualifiedScreen()); return; }
  if (user.approved === false) { PageTransition.run(() => showWaitingApproval()); return; }
  if (DeviceGuard.isRestricted()) { PageTransition.run(() => showMobileRestrictedScreen()); return; }
  PageTransition.run(() => initApp(false));
}



/* ── Waiting / Results Screens ────────────────────────────── */
function _injectExamScreenStyles() {
  if (document.getElementById('exam-screen-styles')) return;
  const s = document.createElement('style');
  s.id = 'exam-screen-styles';
  s.textContent = `
    @keyframes ex-float { 0%,100%{transform:translateY(0) rotate(-1deg)} 50%{transform:translateY(-16px) rotate(1deg)} }
    @keyframes ex-spin-slow { to{transform:rotate(360deg)} }
    @keyframes ex-pulse-ring {
      0%{transform:scale(1);opacity:.8} 70%{transform:scale(1.6);opacity:0} 100%{opacity:0}
    }
    @keyframes ex-slide-up { from{opacity:0;transform:translateY(32px)} to{opacity:1;transform:translateY(0)} }
    @keyframes ex-count { from{opacity:0;transform:scale(.5)} to{opacity:1;transform:scale(1)} }
    .ex-root {
      min-height:100vh; display:flex; align-items:center; justify-content:center;
      flex-direction:column; gap:28px; padding:32px 16px;
      background:linear-gradient(135deg,#f8fafc 0%,#ede9fe 50%,#e0f2fe 100%);
      text-align:center;
    }
    .ex-mascot { width:180px; height:180px; animation:ex-float 3.5s ease-in-out infinite;
      filter:drop-shadow(0 20px 32px #7c3aed33); }
    .ex-mascot img { width:100%; height:100%; object-fit:contain; }
    .ex-bubble {
      background:white; border:2px solid #e9d5ff; border-radius:16px;
      padding:10px 18px; font-family:'JetBrains Mono',monospace;
      font-size:13px; color:#4c1d95; max-width:320px;
      box-shadow:0 4px 20px #7c3aed18;
    }
    .ex-title {
      font-family:'Plus Jakarta Sans',sans-serif; font-weight:800;
      font-size:28px; color:#0f172a; line-height:1.2;
    }
    .ex-sub {
      font-family:'JetBrains Mono',monospace; font-size:12px;
      color:#64748b; margin-top:4px;
    }
    .ex-pulse-ring {
      width:16px; height:16px; border-radius:50%; background:#7c3aed;
      position:relative; display:inline-block; margin-right:8px;
    }
    .ex-pulse-ring::after {
      content:''; position:absolute; inset:-4px; border-radius:50%;
      background:#7c3aed; animation:ex-pulse-ring 1.5s ease-out infinite;
    }
    /* Results card */
    .ex-results-card {
      background:white; border-radius:24px;
      border:1.5px solid #e2e8f0;
      box-shadow:0 20px 60px #7c3aed12;
      padding:28px 24px; width:100%; max-width:520px;
      animation:ex-slide-up .5s cubic-bezier(.4,0,.2,1) both;
    }
    .ex-score-big {
      font-family:'Plus Jakarta Sans',sans-serif; font-weight:900;
      font-size:56px; line-height:1;
      background:linear-gradient(135deg,#7c3aed,#06b6d4);
      -webkit-background-clip:text; -webkit-text-fill-color:transparent;
      animation:ex-count .6s .3s cubic-bezier(.4,0,.2,1) both;
    }
    .ex-lb-row {
      display:flex; align-items:center; padding:8px 12px;
      border-radius:10px; gap:10px; font-family:'JetBrains Mono',monospace;
      font-size:12px; margin-bottom:4px;
    }
    .ex-lb-row.me { background:#f5f3ff; border:1.5px solid #c4b5fd; }
    .ex-lb-rank { width:28px; font-weight:800; color:#7c3aed; }
    .ex-lb-name { flex:1; text-align:left; color:#0f172a; font-weight:600; }
    .ex-lb-score { color:#10b981; font-weight:700; }
    /* DQ screen */
    .ex-dq-card {
      background:white; border-radius:24px;
      border:1.5px solid #fecdd3;
      box-shadow:0 20px 60px #ff3b5c18;
      padding:28px 24px; width:100%; max-width:420px;
    }
    /* Spinner */
    .ex-spinner {
      width:48px; height:48px; border-radius:50%;
      border:4px solid #e9d5ff; border-top-color:#7c3aed;
      animation:ex-spin-slow .9s linear infinite;
      margin:0 auto;
    }
  `;
  document.head.appendChild(s);
}

function showWaitingApproval() {
  _injectExamScreenStyles();
  const sprites = window.MASCOT_SPRITES || {};
  const mascotSrc = sprites.worried || sprites.idle || '';
  const app = $('#app');
  app.innerHTML = `
    <div class="ex-root">
      <div class="ex-mascot">${mascotSrc ? `<img src="${mascotSrc}" alt="Mascot">` : animEmoji('🦅', 'text-5xl')}</div>
      <div class="ex-bubble">Hang tight! The admin is reviewing your registration ${animEmoji('🔍')}</div>
      <div class="ex-title">Waiting for Approval</div>
      <div class="ex-sub">// Your account is pending admin review</div>
      <div style="display:flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:12px;color:#7c3aed">
        <span class="ex-pulse-ring"></span> Checking status automatically…
      </div>
      <div class="ex-spinner"></div>
      <button onclick="doLogout()" style="margin-top:12px;padding:6px 14px;border-radius:8px;background:white;border:1px solid #cbd5e1;color:#64748b;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;cursor:pointer">← Exit to Login</button>
    </div>
  `;
  // Poll every 4s for approval status
  clearInterval(_examPollInterval);
  _examPollInterval = setInterval(async () => {
    try {
      const { user: me } = await Api.get('/api/session');
      if (!me) return;
      if (me.disqualified) { clearInterval(_examPollInterval); showDisqualifiedScreen(); return; }
      if (me.approved) {
        clearInterval(_examPollInterval);
        currentUser = me;
        toast('Approved! 🎉', 'Admin approved your account. Welcome to the exam!', 'success');
        Sound.play('login');
        if (DeviceGuard.isRestricted()) {
          showMobileRestrictedScreen();
        } else {
          initApp(false);
        }
      }
    } catch {}
  }, 4000);
}

let _dqPollInterval = null;
function showDisqualifiedScreen() {
  _injectExamScreenStyles();
  clearInterval(_examPollInterval);
  clearInterval(_dqPollInterval);
  try { AntiCheat.stop(); } catch {}

  const sprites = window.MASCOT_SPRITES || {};
  const mascotSrc = sprites.annoyed || sprites.worried || sprites.sad || sprites.idle || '';
  const app = $('#app') || document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <div class="ex-root">
      <div class="ex-mascot" style="animation:none;filter:drop-shadow(0 20px 32px #ff3b5c33)">
        ${mascotSrc ? `<img src="${mascotSrc}" alt="Mascot">` : animEmoji('🦅', 'text-5xl')}
      </div>
      <div class="ex-dq-card">
        <div style="font-size:48px;margin-bottom:12px">${animEmoji('🚫', 'text-5xl')}</div>
        <div class="ex-title" style="font-size:22px;color:#be123c">Disqualified</div>
        <div class="ex-sub" style="margin-top:8px">You have been removed from this contest by the admin.<br>Contact the organizers if you believe this is an error.</div>
        <div style="margin-top:18px;display:flex;flex-direction:column;align-items:center;gap:12px">
          <div style="display:flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:12px;color:#64748b">
            <span class="ex-pulse-ring"></span> Waiting for admin review…
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-sm btn-secondary" onclick="checkReinstatement()">🔄 Check Status</button>
            <button class="btn btn-sm" onclick="doLogout()" style="border:1px solid #cbd5e1;background:#fff;color:#64748b">Exit to Login</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Auto-poll: check every 3s if admin has reinstated or reset the user
  _dqPollInterval = setInterval(async () => {
    try {
      const res = await Api.get('/api/session');
      const me = res?.user || res;
      if (me && !me.disqualified) {
        clearInterval(_dqPollInterval);
        currentUser = me;
        try { AntiCheat.resetViolations(); } catch {}
        toast('Reinstated! 🎉', 'You have been reinstated by the admin. Re-entering contest...', 'success', 4000);
        setTimeout(() => {
          loginUser(me);
        }, 800);
      }
    } catch {}
  }, 3000);
}

window.checkReinstatement = async () => {
  try {
    const res = await Api.get('/api/session');
    const me = res?.user || res;
    if (me && !me.disqualified) {
      clearInterval(_dqPollInterval);
      currentUser = me;
      try { AntiCheat.resetViolations(); } catch {}
      toast('Reinstated! 🎉', 'Your account has been reinstated by the admin!', 'success');
      loginUser(me);
    } else {
      toast('Status: Disqualified', 'Your account is currently marked as disqualified.', 'warning');
    }
  } catch (err) {
    toast('Error', 'Could not check status: ' + (err.message || 'Session expired'), 'error');
  }
};

function showExamWaiting() {
  _injectExamScreenStyles();
  const sprites = window.MASCOT_SPRITES || {};
  const mascotSrc = sprites.idle || '';
  const app = $('#app') || document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <div class="ex-root" id="exam-waiting-root">
      <div class="ex-mascot"><img id="ew-mascot-img" src="${mascotSrc}" alt="Mascot"></div>
      <div class="ex-bubble" id="ew-bubble">The exam hasn't started yet. Standby, Agent. ${animEmoji('⏳')}</div>
      <div class="ex-title">Exam Not Started</div>
      <div class="ex-sub">// Waiting for admin to begin the contest</div>
      <div style="display:flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:12px;color:#7c3aed">
        <span class="ex-pulse-ring"></span> Will auto-start when admin begins…
      </div>
      <div class="ex-spinner"></div>
      <button onclick="doLogout()" style="margin-top:12px;padding:6px 14px;border-radius:8px;background:white;border:1px solid #cbd5e1;color:#64748b;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;cursor:pointer">← Exit to Login</button>
    </div>
  `;
  // Poll until exam starts (sync status from API)
  clearInterval(_examPollInterval);
  _examPollInterval = setInterval(async () => {
    await syncExamStatus();
    const status = _examStatusCache;
    if (status === 'running') {
      clearInterval(_examPollInterval);
      toast('Exam Started! 🚀', 'The contest is now live. Good luck, Agent!', 'success');
      Sound.play('round');
      if (DeviceGuard.isRestricted()) {
        showMobileRestrictedScreen();
      } else {
        initApp(false);
      }
    }
    // Also check DQ
    try {
      const { user: me } = await Api.get('/api/session');
      if (me?.disqualified) { clearInterval(_examPollInterval); showDisqualifiedScreen(); }
    } catch {}
  }, 3000);
}

async function showExamResults() {
  _injectExamScreenStyles();
  clearInterval(_examPollInterval);
  try { AntiCheat.stop(); } catch {}
  await syncLeaderboard();

  const sprites = window.MASCOT_SPRITES || {};
  const mascotSrc = sprites.hype || sprites.happy || 'mascot.png';
  const app = $('#app') || document.getElementById('app');
  if (!app) return;

  const lb = buildLeaderboard();
  const me = lb.find(u => u.id === currentUser?.id || u.username === currentUser?.username) || currentUser;
  const myRank = lb.findIndex(u => u.id === me?.id || u.username === me?.username) + 1;

  Sound.play('victory');

  app.innerHTML = `
    <div class="min-h-screen bg-surface esports-grid-pattern pb-20 font-telemetry">
      
      <!-- Top Exam Concluded Banner -->
      <div class="exam-over-hero py-8 sm:py-10 px-4 sm:px-6 relative overflow-hidden">
        <div class="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6 relative z-10">
          
          <!-- Mascot & Title Info -->
          <div class="flex flex-col sm:flex-row items-center gap-5 text-center sm:text-left">
            <div class="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl bg-white/95 p-2 shadow-lg border border-purple-200 shrink-0 flex items-center justify-center">
              <img src="${mascotSrc}" alt="Mascot" class="w-full h-full object-contain">
            </div>
            <div>
              <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-100 text-amber-900 border border-amber-300">
                <span class="w-2 h-2 rounded-full bg-amber-600 animate-pulse"></span>
                CONTEST PROTOCOL CONCLUDED
              </span>
              <h1 class="font-headline-lg text-2xl sm:text-3xl font-black text-slate-900 mt-1">
                OPERATION 0xRAVEN // MISSION DEBRIEF
              </h1>
              <p class="text-xs font-mono text-slate-700 mt-1 max-w-xl">
                The examination window has officially closed. All cryptographic hashes and point audits are permanently verified. Review your final report and the complete tournament standings below.
              </p>
            </div>
          </div>

          <!-- Quick Actions & Score Badge -->
          <div class="flex flex-col sm:flex-row items-center gap-3 shrink-0">
            <div class="bg-white/95 border border-purple-200 px-5 py-3 rounded-xl shadow-xs text-center font-mono">
              <div class="text-[10px] text-slate-500 font-bold uppercase">YOUR FINAL SCORE</div>
              <div class="text-2xl font-black text-gamer-purple">${me?.score || 0} <span class="text-xs">PTS</span></div>
              <div class="text-[11px] font-bold text-slate-700 mt-0.5">RANK #${myRank > 0 ? myRank : '-'} OF ${lb.length}</div>
            </div>
            <button onclick="doLogout()" class="px-4 py-2.5 bg-white hover:bg-slate-100 text-rose-600 border border-rose-200 rounded-xl text-xs font-bold font-mono transition-all shadow-xs cursor-pointer flex items-center gap-1.5">
              <span class="material-symbols-outlined text-sm">logout</span>
              <span>EXIT PLATFORM</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Main Leaderboard & Standings Container -->
      <div class="p-4 sm:p-6 lg:p-8">
        ${buildLeaderboardHTML({ lb, me, isExamOver: true })}
      </div>
    </div>
  `;
}

/* ── Participant Exam Polling (runs while exam is live) ─────── */
function _startParticipantExamPoll() {
  clearInterval(_examPollInterval);
  _examPollInterval = setInterval(async () => {
    try {
      const res = await Api.get('/api/session');
      const me = res?.user || res;
      if (me) {
        if (currentUser) {
          const currentSolved = currentUser.solvedChallenges || [];
          const serverSolved = me.solvedChallenges || [];
          me.solvedChallenges = Array.from(new Set([...serverSolved, ...currentSolved]));
          if (currentUser.skippedChallenges) {
            me.skippedChallenges = Array.from(new Set([...(me.skippedChallenges || []), ...currentUser.skippedChallenges]));
          }
          if (currentUser.skipsUsed !== undefined) {
            me.skipsUsed = Math.max(me.skipsUsed || 0, currentUser.skipsUsed || 0);
          }
          if (currentUser.revealedHints) {
            me.revealedHints = Array.from(new Set([...(me.revealedHints || []), ...currentUser.revealedHints]));
          }
          if (currentUser.unlockedHints) {
            me.unlockedHints = Array.from(new Set([...(me.unlockedHints || []), ...currentUser.unlockedHints]));
          }
          // Prevent race condition: never clobber score while local in-flight operations are processing
          const hasInFlight = (window._inFlightSubmissions && window._inFlightSubmissions.size > 0) ||
                              (window._inFlightSkips && window._inFlightSkips.size > 0) ||
                              (window._inFlightHints && window._inFlightHints.size > 0);
          if (hasInFlight && typeof currentUser.score === 'number') {
            me.score = currentUser.score;
          }
        }
        currentUser = me;
        if (me.disqualified) {
          clearInterval(_examPollInterval);
          try { AntiCheat.stop(); } catch {}
          showDisqualifiedScreen();
          return;
        }
      }
    } catch {}

    const status = Store.get('examStatus', 'waiting');
    if (status === 'stopped') { clearInterval(_examPollInterval); showExamResults(); return; }
  }, 3000);
}


/* ── Device Restriction Screen (Mobile & Tablet Exam Guard) ─ */
let _liveDeviceCheckAttached = false;
function showMobileRestrictedScreen() {
  _injectExamScreenStyles();
  clearInterval(_examPollInterval);
  const sprites = window.MASCOT_SPRITES || {};
  const mascotSrc = sprites.worried || sprites.thinking || sprites.idle || '';
  const app = $('#app') || document.getElementById('app');
  if (!app) return;

  const info = DeviceGuard.check();
  const userName = currentUser ? (currentUser.name || currentUser.username) : 'Operative';
  const userTeam = currentUser ? (currentUser.team || currentUser.username) : 'Participant';
  const curWidth = window.innerWidth;

  app.innerHTML = `
    <div class="device-restricted-root">
      <div class="device-restricted-card">
        <div class="dr-header">
          <span class="dr-badge-danger">
            <span class="dr-pulse-dot"></span>
            SECURITY 0x403 // EXAM RESTRICTED
          </span>
          <div class="dr-device-tag">${animEmoji('📱')} ${escapeHtml(info.label.toUpperCase())} DETECTED</div>
        </div>

        <div class="dr-mascot-row flex flex-col sm:flex-row items-center sm:items-start text-center sm:text-left gap-3">
          <div class="ex-mascot" style="width:72px;height:72px;flex-shrink:0;animation:none;filter:drop-shadow(0 8px 16px rgba(225,29,72,0.25));">
            ${mascotSrc ? `<img src="${mascotSrc}" alt="Mascot">` : `<div style="font-size:36px;">${animEmoji('🦅', 'text-4xl')}</div>`}
          </div>
          <div class="min-w-0">
            <div class="dr-mascot-title text-lg sm:text-xl font-extrabold text-white">Laptop Required for Exam</div>
            <div class="dr-mascot-sub text-xs text-slate-300 leading-snug">Mobile phones and tablets ("tabs") cannot open the test. A laptop or desktop is required to launch this CTF exam.</div>
          </div>
        </div>

        <!-- Authenticated Operative Card -->
        <div class="dr-user-box">
          <div class="dr-user-avatar">${animEmoji('🦅')}</div>
          <div class="dr-user-meta min-w-0">
            <div class="dr-user-name truncate">${escapeHtml(userName)}</div>
            <div class="dr-user-team text-[11px] truncate">Team: ${escapeHtml(userTeam)} &nbsp;·&nbsp; <span class="dr-status-pill">✓ Logged In</span></div>
          </div>
          <button class="dr-logout-link" onclick="doLogout()" title="Log out or switch account">Log Out</button>
        </div>

        <!-- System Diagnostics Checklist -->
        <div class="dr-diagnostics-box">
          <div class="dr-diag-title">DEVICE COMPLIANCE AUDIT</div>
          
          <div class="dr-diag-item failed">
            <div class="dr-diag-icon">✕</div>
            <div class="dr-diag-content min-w-0">
              <div class="dr-diag-name">Current Device</div>
              <div class="dr-diag-val break-words">${escapeHtml(info.label)} — Blocked for exam</div>
            </div>
          </div>

          <div class="dr-diag-item failed">
            <div class="dr-diag-icon">✕</div>
            <div class="dr-diag-content min-w-0">
              <div class="dr-diag-name">Screen Display Width</div>
              <div class="dr-diag-val break-words">${curWidth}px (Minimum required: 1024px width)</div>
            </div>
          </div>

          <div class="dr-diag-item warning">
            <div class="dr-diag-icon">!</div>
            <div class="dr-diag-content min-w-0">
              <div class="dr-diag-name">Required Hardware</div>
              <div class="dr-diag-val break-words">Laptop / PC with keyboard &amp; trackpad</div>
            </div>
          </div>
        </div>

        <!-- Explanatory note -->
        <div class="dr-explanation text-xs leading-relaxed break-words">
          <strong class="text-purple-200">Why Laptop Only?</strong> The exam environment utilizes live terminal forensics, network devtools, and code review editors designed exclusively for desktop monitors.
        </div>

        <!-- Action buttons -->
        <div class="dr-actions">
          <button class="dr-btn-primary" onclick="window.checkDeviceAgain()">
            <span class="material-symbols-outlined" style="font-size:18px">refresh</span>
            Re-check Device
          </button>
          <button class="dr-btn-secondary" onclick="window.copyExamLink()">
            <span class="material-symbols-outlined" style="font-size:18px">content_copy</span>
            Copy Exam Link
          </button>
        </div>

        <div id="dr-feedback" class="dr-feedback-msg"></div>

        <div class="dr-footer">
          Your registration is saved. Open this URL on your laptop and log in to start immediately!
        </div>
      </div>
    </div>
  `;

  // Attach live auto-detector in case user maximizes window or plugs into a monitor
  if (!_liveDeviceCheckAttached) {
    _liveDeviceCheckAttached = true;
    window.addEventListener('resize', () => {
      if (document.querySelector('.device-restricted-root')) {
        const updated = DeviceGuard.check();
        if (!updated.isRestricted && currentUser) {
          toast('Laptop Detected! 💻', 'Display requirement satisfied. Opening exam...', 'success');
          Sound.play('login');
          initApp(false);
        }
      }
    });
  }
}

window.checkDeviceAgain = () => {
  Sound.play('click');
  const info = DeviceGuard.check();
  const feedback = document.getElementById('dr-feedback');
  if (!info.isRestricted) {
    if (feedback) {
      feedback.style.color = '#10b981';
      feedback.textContent = '✓ Laptop verified! Opening exam environment...';
    }
    toast('Laptop Verified! 💻', 'Opening exam environment...', 'success');
    setTimeout(() => {
      if (currentUser) {
        initApp(currentUser.role === 'admin');
      } else {
        showAuthScreen();
      }
    }, 500);
  } else {
    if (feedback) {
      feedback.style.color = '#fb7185';
      feedback.textContent = `❌ Still detected: ${info.label} (${window.innerWidth}px). Please open on a laptop or desktop computer.`;
    }
    Sound.play('wrong');
    const card = document.querySelector('.device-restricted-card');
    if (card) {
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
    }
  }
};

window.copyExamLink = () => {
  Sound.play('click');
  const url = window.location.href;
  const feedback = document.getElementById('dr-feedback');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      if (feedback) {
        feedback.style.color = '#a78bfa';
        feedback.textContent = '📋 Exam link copied! Send it to your laptop.';
      }
      toast('Link Copied!', 'Send this URL to your laptop to start the exam.', 'success');
    }).catch(() => {
      prompt('Copy this exam link to open on your laptop:', url);
    });
  } else {
    prompt('Copy this exam link to open on your laptop:', url);
  }
};

let _liveGuardInitialized = false;
function _initLiveDeviceGuard() {
  if (_liveGuardInitialized) return;
  _liveGuardInitialized = true;

  const handleResize = () => {
    // Only guard if participant is actively in the app shell
    if (!currentUser || currentUser.role === 'admin') return;
    const isAppShellActive = !!document.getElementById('top-mission-hud');
    if (!isAppShellActive) return;

    const info = DeviceGuard.check();
    let overlay = document.getElementById('exam-device-guard-overlay');

    if (info.isRestricted) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'exam-device-guard-overlay';
        overlay.className = 'exam-device-guard-overlay';
        overlay.innerHTML = `
          <div class="exam-guard-modal">
            <div class="exam-guard-badge">${animEmoji('⚠️')} LAPTOP REQUIRED // SCREEN TOO SMALL</div>
            <div class="exam-guard-title">Display Window Too Small for Exam</div>
            <div class="exam-guard-msg">
              The CTF exam interface requires at least <strong>1024px</strong> width to display the forensic terminal, browser sandbox, and code review IDE.
            </div>
            <div class="exam-guard-stat">Current Width: <span id="exam-guard-width">${window.innerWidth}px</span> (Required: 1024px+)</div>
            <div class="exam-guard-help">Maximize your laptop browser window or return to desktop mode to continue.</div>
            <button onclick="doLogout()" class="exam-guard-exit-btn">← Exit to Login</button>
          </div>
        `;
        document.body.appendChild(overlay);
      } else {
        const wEl = document.getElementById('exam-guard-width');
        if (wEl) wEl.textContent = `${window.innerWidth}px`;
      }
    } else {
      if (overlay) {
        overlay.remove();
      }
    }
  };

  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', handleResize);
}


/* ── Exam Rules & Integrity Disclaimer Modal ───────────────── */
function showRulesDisclaimerModal(onAccept) {
  const existing = document.getElementById('rules-disclaimer-overlay');
  if (existing) existing.remove();

  const sprites = window.MASCOT_SPRITES || {};
  const mascotSrc = sprites.idle || sprites.thinking || sprites.worried || '';

  const overlay = document.createElement('div');
  overlay.id = 'rules-disclaimer-overlay';
  overlay.className = 'anticheat-disclaimer-overlay';
  overlay.innerHTML = `
    <div class="anticheat-disclaimer-card">
      <div class="disclaimer-header">
        <div class="disclaimer-badge-wrap">
          <span class="disclaimer-badge">
            <span class="anticheat-dot pulse-purple"></span>
            CODEVERSE // EXAM INTEGRITY POLICY
          </span>
        </div>
        <div class="disclaimer-mascot-row">
          <div class="disclaimer-mascot-wrap">
            ${mascotSrc ? `<img src="${mascotSrc}" alt="Mascot" class="disclaimer-mascot-img">` : '<div style="font-size:40px">🛡️</div>'}
          </div>
          <div class="disclaimer-title-wrap">
            <h2 class="disclaimer-title">Exam Instructions & Code of Conduct</h2>
            <p class="disclaimer-subtitle">
              Welcome, Agent. Review the mandatory competition rules below before proceeding.
            </p>
          </div>
        </div>
      </div>

      <div class="disclaimer-rules-list">
        <div class="disclaimer-rule-card">
          <div class="rule-icon-box fs">
            <span class="material-symbols-outlined">fullscreen</span>
          </div>
          <div class="rule-content">
            <div class="rule-title">1. Mandatory Fullscreen Mode</div>
            <div class="rule-desc">
              The exam interface runs strictly in fullscreen mode. Exiting fullscreen immediately halts your workspace until fullscreen is restored.
            </div>
          </div>
        </div>

        <div class="disclaimer-rule-card">
          <div class="rule-icon-box warn">
            <span class="material-symbols-outlined">tab</span>
          </div>
          <div class="rule-content">
            <div class="rule-title">2. Tab-Switching Limit — 3 Strikes Policy</div>
            <div class="rule-desc">
              Switching tabs, minimizing, or navigating away is tracked in real-time. You receive <strong>2 warnings</strong>; on the <strong>3rd violation, you are automatically disqualified</strong>.
            </div>
          </div>
        </div>

        <div class="disclaimer-rule-card">
          <div class="rule-icon-box flag">
            <span class="material-symbols-outlined">flag</span>
          </div>
          <div class="rule-content">
            <div class="rule-title">3. Flag Submissions & Fair Competition</div>
            <div class="rule-desc">
              All flag submissions are recorded with cryptographic timestamps. Sharing answers, collaborating with others, or attacking platform infrastructure is strictly prohibited.
            </div>
          </div>
        </div>

        <div class="disclaimer-rule-card">
          <div class="rule-icon-box sync">
            <span class="material-symbols-outlined">cloud_sync</span>
          </div>
          <div class="rule-content">
            <div class="rule-title">4. Real-Time Cloud Persistence</div>
            <div class="rule-desc">
              Your points, solved challenges, and unlocked hints are saved continuously. In the event of an unexpected disconnect, your progress remains intact.
            </div>
          </div>
        </div>
      </div>

      <div class="disclaimer-agreement">
        <label class="disclaimer-checkbox-label">
          <input type="checkbox" id="rules-agree-chk" checked>
          <span class="agreement-text">
            I have read, understood, and agree to abide by all the competition rules, anti-cheat protocols, and disqualification criteria.
          </span>
        </label>
      </div>

      <div class="disclaimer-actions">
        <button class="disclaimer-btn" id="rules-accept-btn">
          <span>Acknowledge Rules & Enter Exam</span>
          <span class="material-symbols-outlined">rocket_launch</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const chk = document.getElementById('rules-agree-chk');
  const btn = document.getElementById('rules-accept-btn');

  if (chk && btn) {
    chk.addEventListener('change', () => {
      btn.disabled = !chk.checked;
      btn.style.opacity = chk.checked ? '1' : '0.4';
      btn.style.cursor = chk.checked ? 'pointer' : 'not-allowed';
    });

    btn.addEventListener('click', async () => {
      if (!chk.checked) return;
      overlay.remove();
      if (typeof onAccept === 'function') onAccept();
      try {
        await AntiCheat.enterFullscreen();
      } catch {}
    });
  }
}

/* ── Anti-Cheat System: Fullscreen Enforcement + Tab-Switch Detection ── */
const AntiCheat = (() => {
  let _active = false;
  let _tabSwitchCount = 0;
  let _fsListenerAttached = false;
  let _visListenerAttached = false;
  let _processingViolation = false;

  // ── Fullscreen Helpers ──────────────────────────────────
  function _isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
  }

  function _canFullscreen() {
    return !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen || document.documentElement.mozRequestFullScreen || document.documentElement.msRequestFullscreen);
  }

  async function _requestFullscreen() {
    const el = document.documentElement;
    try {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      else if (el.mozRequestFullScreen) await el.mozRequestFullScreen();
      else if (el.msRequestFullscreen) await el.msRequestFullscreen();
    } catch (e) {
      console.warn('[AntiCheat] Fullscreen request failed:', e.message);
    }
  }

  // ── Fullscreen Overlay ──────────────────────────────────
  function _showFullscreenOverlay() {
    if (document.getElementById('anticheat-fs-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'anticheat-fs-overlay';
    overlay.className = 'anticheat-fs-overlay';
    const mascotSrc = window.MASCOT_SPRITES?.worried || window.MASCOT_SPRITES?.idle || '';
    overlay.innerHTML = `
      <div class="anticheat-fs-card">
        <div class="anticheat-fs-badge-wrap">
          <span class="anticheat-fs-badge">
            <span class="anticheat-dot pulse-purple"></span>
            EXAM SECURITY PROTOCOL ACTIVE
          </span>
        </div>
        
        <div class="anticheat-fs-mascot-wrap">
          <div class="anticheat-mascot-ring">
            ${mascotSrc ? `<img src="${mascotSrc}" alt="Mascot" class="anticheat-mascot-img fs-mascot-anim">` : '<div style="font-size:48px">🔒</div>'}
          </div>
        </div>

        <div class="anticheat-fs-content">
          <h2 class="anticheat-fs-title">Fullscreen Mode Required</h2>
          <p class="anticheat-fs-subtitle">
            To ensure fair competition and protect exam integrity, the CODEVERSE environment must remain in fullscreen mode throughout the test.
          </p>
        </div>

        <div class="anticheat-fs-checklist">
          <div class="anticheat-fs-check-item failed">
            <div class="check-icon">✕</div>
            <div class="check-text">
              <span class="check-label">Fullscreen Environment</span>
              <span class="check-status">Inactive — Action required</span>
            </div>
          </div>
          <div class="anticheat-fs-check-item success">
            <div class="check-icon">✓</div>
            <div class="check-text">
              <span class="check-label">Candidate Session</span>
              <span class="check-status">Authenticated & Verified</span>
            </div>
          </div>
          <div class="anticheat-fs-check-item success">
            <div class="check-icon">✓</div>
            <div class="check-text">
              <span class="check-label">Anti-Cheat Monitor</span>
              <span class="check-status">Armed & Active</span>
            </div>
          </div>
        </div>

        <button class="anticheat-fs-btn" onclick="AntiCheat.enterFullscreen()">
          <span class="material-symbols-outlined" style="font-size:22px">fullscreen</span>
          <span>Enter Fullscreen to Resume Exam</span>
        </button>

        <div class="anticheat-fs-warning-text">
          🛡️ Your answers and timer are securely preserved. Exiting fullscreen pauses exam interactions.
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  function _hideFullscreenOverlay() {
    const overlay = document.getElementById('anticheat-fs-overlay');
    if (overlay) overlay.remove();
  }

  // ── Fullscreen Change Handler ───────────────────────────
  function _onFullscreenChange() {
    if (!_active) return;
    if (_isFullscreen()) {
      _hideFullscreenOverlay();
    } else {
      // User exited fullscreen — block the exam
      _showFullscreenOverlay();
    }
  }

  // ── Tab-Switch Warning UI ───────────────────────────────
  function _showTabSwitchWarning(count) {
    // Remove any existing warning
    const existing = document.getElementById('anticheat-warn-overlay');
    if (existing) existing.remove();

    if (count >= 3) {
      // Disqualification — handled separately
      return;
    }

    const level = count === 1 ? '1' : '2';
    const isFinal = count === 2;
    const warningsLeft = 3 - count;
    const overlay = document.createElement('div');
    overlay.id = 'anticheat-warn-overlay';
    overlay.className = `anticheat-warn-overlay warning-level-${level}`;

    const sprites = window.MASCOT_SPRITES || {};
    // Level 1: worried mascot. Level 2: annoyed (angry emotion) mascot!
    const mascotSrc = count === 1 
      ? (sprites.worried || sprites.idle || '') 
      : (sprites.annoyed || sprites.worried || sprites.sad || sprites.idle || '');

    overlay.innerHTML = `
      <div class="anticheat-warn-card level-${level}">
        <div class="anticheat-warn-badge-wrap">
          <span class="anticheat-warn-badge level-${level}">
            <span class="anticheat-dot ${isFinal ? 'pulse-red' : 'pulse-amber'}"></span>
            ${count === 1 ? 'SECURITY ALERT // STRIKE 1 OF 3' : 'CRITICAL INTEGRITY VIOLATION // FINAL WARNING'}
          </span>
        </div>

        <div class="anticheat-warn-mascot-wrap">
          <div class="anticheat-mascot-ring ${isFinal ? 'ring-red' : 'ring-amber'}">
            ${mascotSrc ? `<img src="${mascotSrc}" alt="Mascot" class="anticheat-mascot-img warn-mascot-anim level-${level}">` : `<div style="font-size:56px">${count === 1 ? '⚠️' : '🚨'}</div>`}
          </div>
        </div>

        <div class="anticheat-warn-content">
          <h2 class="anticheat-warn-title level-${level}">
            ${count === 1 ? 'Tab Switch Detected' : 'Final Warning — Next Switch Disqualifies!'}
          </h2>
          <p class="anticheat-warn-msg">
            ${count === 1
              ? 'You navigated away from the exam tab. Tab switching is strictly monitored to prevent unauthorized tool access and maintain exam fairness.'
              : '<strong>Attention! This is your FINAL warning.</strong> If you leave this tab or switch applications <strong>one more time</strong>, you will be <span class="highlight-red">automatically and irreversibly disqualified</span>.'}
          </p>
        </div>

        <!-- Strike visual counter -->
        <div class="anticheat-strike-bar">
          <div class="anticheat-strike-track">
            <div class="anticheat-strike-fill level-${level}" style="width:${(count / 3) * 100}%"></div>
          </div>
          <div class="anticheat-strike-labels">
            <span class="anticheat-strike-item active">Strike 1 <span class="sub-label">(Warning)</span></span>
            <span class="anticheat-strike-item ${count >= 2 ? 'active critical' : ''}">Strike 2 <span class="sub-label">(Final)</span></span>
            <span class="anticheat-strike-item ${count >= 3 ? 'active dq' : ''}">Strike 3 <span class="sub-label">(Disqualified)</span></span>
          </div>
        </div>

        <div class="anticheat-warn-footer level-${level}">
          ${warningsLeft === 2 
            ? '<span class="icon">⚠️</span> <span class="text"><strong>2 chances remaining.</strong> Please stay focused on this window.</span>' 
            : '<span class="icon">🚨</span> <span class="text"><strong style="color:#fca5a5">0 warnings remaining!</strong> The very next tab switch will terminate your test.</span>'}
        </div>

        <button class="anticheat-warn-btn level-${level}" onclick="AntiCheat.dismissWarning()">
          <span>I Understand — Return to Exam</span>
          <span class="material-symbols-outlined" style="font-size:20px">arrow_forward</span>
        </button>
      </div>
    `;
    document.body.appendChild(overlay);

    // Play alert sound
    try { Sound.play('wrong'); } catch {}
  }

  function _dismissWarning() {
    const overlay = document.getElementById('anticheat-warn-overlay');
    if (overlay) overlay.remove();
    // Re-enter fullscreen after dismissing warning
    if (_canFullscreen() && !_isFullscreen()) {
      _showFullscreenOverlay();
    }
  }

  // ── Tab Visibility Handler ──────────────────────────────
  async function _onVisibilityChange() {
    if (!_active || _processingViolation) return;
    // Only trigger when the document becomes hidden (user left the tab)
    if (document.visibilityState !== 'hidden') return;
    // Only for participants, not admins
    if (!currentUser || currentUser.role === 'admin') return;
    // Only when exam is running
    const examStatus = Store.get('examStatus', 'waiting');
    if (examStatus !== 'running') return;

    _processingViolation = true;

    try {
      // Report to server
      const result = await Api.post('/api/anti-cheat/tab-switch');
      _tabSwitchCount = result.tabSwitches || (_tabSwitchCount + 1);

      if (result.disqualified || result.autoDisqualified || _tabSwitchCount >= 3) {
        // Auto-disqualified — show DQ screen
        clearInterval(_examPollInterval);
        currentUser.disqualified = true;
        showDisqualifiedScreen();
        toast('Disqualified 🚫', 'You have been automatically disqualified for switching tabs 3 times.', 'error', 10000);
        try { Sound.play('wrong'); } catch {}
        _active = false;
      } else {
        // Show warning
        _showTabSwitchWarning(_tabSwitchCount);
      }
    } catch (err) {
      // Even if server call fails, track locally
      _tabSwitchCount++;
      if (_tabSwitchCount >= 3) {
        // Try to disqualify via the direct API
        try { await Api.put(`/api/users/${currentUser.id}/disqualify`); } catch {}
        clearInterval(_examPollInterval);
        currentUser.disqualified = true;
        showDisqualifiedScreen();
        toast('Disqualified 🚫', 'You have been automatically disqualified for switching tabs 3 times.', 'error', 10000);
        _active = false;
      } else {
        _showTabSwitchWarning(_tabSwitchCount);
      }
    } finally {
      _processingViolation = false;
    }
  }

  // ── Public API ──────────────────────────────────────────
  async function start() {
    if (_active) return;
    // Only for participants
    if (!currentUser || currentUser.role === 'admin') return;

    _active = true;

    // Sync tab switch count from server (survives page refresh)
    try {
      const status = await Api.get('/api/anti-cheat/status');
      _tabSwitchCount = status.tabSwitches || 0;
      if (status.disqualified) {
        currentUser.disqualified = true;
        showDisqualifiedScreen();
        _active = false;
        return;
      }
    } catch {}

    // If already at 2 warnings, they're on thin ice — show a toast reminder
    if (_tabSwitchCount === 2) {
      toast('⚠️ Final Warning Active', 'You have 2 tab-switch violations. One more will disqualify you.', 'warning', 6000);
    } else if (_tabSwitchCount === 1) {
      toast('⚠️ Warning Active', 'You have 1 tab-switch violation. 2 more will disqualify you.', 'warning', 4000);
    }

    // Attach fullscreen change listener (once)
    if (!_fsListenerAttached) {
      _fsListenerAttached = true;
      document.addEventListener('fullscreenchange', _onFullscreenChange);
      document.addEventListener('webkitfullscreenchange', _onFullscreenChange);
      document.addEventListener('mozfullscreenchange', _onFullscreenChange);
      document.addEventListener('MSFullscreenChange', _onFullscreenChange);
    }

    // Attach visibility change listener (once)
    if (!_visListenerAttached) {
      _visListenerAttached = true;
      document.addEventListener('visibilitychange', _onVisibilityChange);
    }

    // Request fullscreen on start
    if (_canFullscreen()) {
      // Small delay to ensure DOM is ready after user gesture
      setTimeout(() => {
        if (!_isFullscreen()) {
          _showFullscreenOverlay();
        }
      }, 300);
    }
  }

  function stop() {
    _active = false;
    _hideFullscreenOverlay();
    const warnOverlay = document.getElementById('anticheat-warn-overlay');
    if (warnOverlay) warnOverlay.remove();
    // Exit fullscreen if active
    if (_isFullscreen()) {
      try {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
        else if (document.msExitFullscreen) document.msExitFullscreen();
      } catch {}
    }
  }

  async function enterFullscreen() {
    await _requestFullscreen();
    _hideFullscreenOverlay();
  }

  function dismissWarning() {
    _dismissWarning();
  }

  function getTabSwitchCount() {
    return _tabSwitchCount;
  }

  function isActive() {
    return _active;
  }

  function resetViolations() {
    _tabSwitchCount = 0;
    const warnOverlay = document.getElementById('anticheat-warn-overlay');
    if (warnOverlay) warnOverlay.remove();
  }

  return { start, stop, enterFullscreen, dismissWarning, getTabSwitchCount, isActive, resetViolations };
})();


/* ── Anti-Copying & Seeded Randomization Engine for Stage 3 ── */
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

window.cleanChallengeName = (name) => {
  if (!name) return '';
  return name.replace(/^Snippet\s+\d+\s*\/\/\s*/i, '').replace(/^Snippet\s+/i, '').trim();
};

window.getUserCodeReviewChallenges = (user = currentUser, count = 5) => {
  const allCode = challengesData?.challenges?.filter(c => c.round === 3) || [];
  if (!allCode.length) return [];

  // Seeded deterministic shuffle per user so each user gets 5 randomized questions from the 20
  const seedKey = user?.id ? 'code_order_' + user.id : 'code_order_default';
  const shuffled = seededShuffle(allCode, seedKey);
  const selected = shuffled.slice(0, count);

  // Present the 5 questions to the user strictly as CODE-01 to CODE-05
  return selected.map((c, idx) => {
    const virtualId = `CODE-0${idx + 1}`;
    const cleanName = window.cleanChallengeName(c.name);
    return {
      ...c,
      id: virtualId,
      originalId: c.id,
      name: cleanName,
      order: idx + 1,
      prerequisites: idx === 0 ? ['WEB-04'] : [`CODE-0${idx}`]
    };
  });
};

window.getUserChallenges = (user = currentUser) => {
  const all = challengesData?.challenges || [];
  const r1 = all.filter(c => c.round === 1);
  const r2 = all.filter(c => c.round === 2);
  const r3 = getUserCodeReviewChallenges(user, 5);
  return [...r1, ...r2, ...r3];
};

window.getChallengeById = (id, user = currentUser) => {
  if (!id) return null;
  if (user && window.getUserChallenges) {
    const userChals = window.getUserChallenges(user);
    const found = userChals.find(c => c.id === id || c.originalId === id);
    if (found) return found;
  }
  return challengesData?.challenges?.find(c => c.id === id) || null;
};

window.getUserShuffledOptions = (userId, challenge) => {
  const originalOptions = challenge?.options || [];
  if (!userId || !challenge) return originalOptions;
  const challengeKey = challenge.originalId || challenge.id;
  return seededShuffle(originalOptions, `mcq_opts_${userId}_${challengeKey}`);
};

window.isTargetSolved = (c, user = currentUser) => {
  if (!c) return false;
  const solved = user?.solvedChallenges || [];
  const id = typeof c === 'string' ? c : c.id;
  const originalId = typeof c === 'object' ? c.originalId : null;
  if (solved.includes(id) || (originalId && solved.includes(originalId))) return true;
  if (id && id.startsWith('CODE-') && user) {
    const userCode = getUserCodeReviewChallenges(user, 5);
    const chal = userCode.find(ch => ch.id === id || ch.originalId === id);
    if (chal && (solved.includes(chal.id) || (chal.originalId && solved.includes(chal.originalId)))) return true;
  }
  return false;
};

window.isTargetFailed = (c, user = currentUser) => {
  if (!c) return false;
  const failed = user?.failedChallenges || [];
  const id = typeof c === 'string' ? c : c.id;
  const originalId = typeof c === 'object' ? c.originalId : null;
  if (failed.includes(id) || (originalId && failed.includes(originalId))) return true;
  if (id && id.startsWith('CODE-') && user) {
    const userCode = getUserCodeReviewChallenges(user, 5);
    const chal = userCode.find(ch => ch.id === id || ch.originalId === id);
    if (chal && (failed.includes(chal.id) || (chal.originalId && failed.includes(chal.originalId)))) return true;
  }
  return false;
};

window.isTargetSkipped = (c, user = currentUser) => {
  if (!c) return false;
  const skipped = user?.skippedChallenges || [];
  const id = typeof c === 'string' ? c : c.id;
  const originalId = typeof c === 'object' ? c.originalId : null;
  if (skipped.includes(id) || (originalId && skipped.includes(originalId))) return true;
  if (id && id.startsWith('CODE-') && user) {
    const userCode = getUserCodeReviewChallenges(user, 5);
    const chal = userCode.find(ch => ch.id === id || ch.originalId === id);
    if (chal && (skipped.includes(chal.id) || (chal.originalId && skipped.includes(chal.originalId)))) return true;
  }
  return false;
};

function isTargetCleared(id, user = currentUser) {
  if (!id) return false;
  return isTargetSolved(id, user) || isTargetFailed(id, user) || isTargetSkipped(id, user);
}

function isChallengeUnlocked(challenge, user = currentUser) {
  if (!challenge || !challenge.enabled) return false;

  // Already cleared challenges are always unlocked/viewable
  if (isTargetCleared(challenge.id, user) || (challenge.originalId && isTargetCleared(challenge.originalId, user))) {
    return true;
  }

  if (challenge.round === 1) {
    const prereqs = challenge.prerequisites || [];
    return prereqs.length === 0 || prereqs.every(p => isTargetCleared(p, user));
  }

  if (challenge.round === 2) {
    const r1 = challengesData.challenges.filter(c => c.round === 1).map(c => c.id);
    if (!r1.every(id => isTargetCleared(id, user))) return false;
    const prereqs = challenge.prerequisites || [];
    return prereqs.length === 0 || prereqs.every(p => isTargetCleared(p, user));
  }

  if (challenge.round === 3) {
    // Round 3 requires all of Round 2 to be cleared
    const r2 = challengesData.challenges.filter(c => c.round === 2).map(c => c.id);
    if (!r2.every(id => isTargetCleared(id, user))) return false;

    // Get the user's personalized Stage 3 sequence (CODE-01 through CODE-05)
    const userCodeList = getUserCodeReviewChallenges(user, 5);
    const userIdx = userCodeList.findIndex(c => c.id === challenge.id || c.originalId === challenge.id);
    if (userIdx < 0) return false;
    if (userIdx === 0) return true; // CODE-01 is unlocked once Round 2 is cleared
    const prevChal = userCodeList[userIdx - 1];
    return isTargetCleared(prevChal.id, user);
  }

  return true;
}

window.getNextActiveChallenge = (user = currentUser) => {
  if (!user || !challengesData?.challenges?.length) return challengesData?.challenges?.[0];

  // Check Round 1
  const r1Chal = challengesData.challenges.filter(c => c.round === 1);
  const nextR1 = r1Chal.find(c => !isTargetCleared(c.id, user) && isChallengeUnlocked(c, user));
  if (nextR1) return nextR1;
  const unsolvedR1 = r1Chal.find(c => !isTargetCleared(c.id, user));
  if (unsolvedR1) return unsolvedR1;

  // Check Round 2
  const r2Chal = challengesData.challenges.filter(c => c.round === 2);
  const nextR2 = r2Chal.find(c => !isTargetCleared(c.id, user) && isChallengeUnlocked(c, user));
  if (nextR2) return nextR2;
  const unsolvedR2 = r2Chal.find(c => !isTargetCleared(c.id, user));
  if (unsolvedR2 && isChallengeUnlocked(unsolvedR2, user)) return unsolvedR2;

  // Check Round 3 in user's personalized order (CODE-01 to CODE-05)
  const r3UserList = getUserCodeReviewChallenges(user, 5);
  const nextR3 = r3UserList.find(c => !isTargetCleared(c.id, user) && isChallengeUnlocked(c, user));
  if (nextR3) return nextR3;

  return null;
};

/* ── App Init ─────────────────────────────────────────────── */
function initApp(isAdmin) {
  clearInterval(_examPollInterval);
  const app = $('#app');

  if (isAdmin) {
    app.innerHTML = buildAppShell(true);
    initMascot();
    initNavHandlers();
    renderAdminPanel();
    updateNavScore();
    updateMissionHud();
    return;
  }

  // Participant: check device restriction first
  if (DeviceGuard.isRestricted()) {
    showMobileRestrictedScreen();
    return;
  }

  // Participant: check exam gate
  const examStatus = Store.get('examStatus', 'waiting');
  if (examStatus === 'stopped') { showExamResults(); return; }
  if (examStatus === 'waiting') { showExamWaiting(); return; }

  // Exam is running — build the full UI
  app.innerHTML = buildAppShell(false);
  initMascot();
  initNavHandlers();
  _initLiveDeviceGuard();

  const solved = currentUser?.solvedChallenges || [];
  if (solved.length === 0) {
    showMissionBriefing();
  } else {
    const nextTarget = getNextActiveChallenge(currentUser);
    if (nextTarget) {
      renderChallenge(nextTarget.id);
    } else {
      renderChallenge('OSINT-01');
    }
  }
  updateNavScore();
  updateMissionHud();

  // Start background polling for DQ / exam-end
  _startParticipantExamPoll();

  // Start anti-cheat system (fullscreen enforcement + tab-switch detection)
  // Show rules disclaimer modal on first entry per session
  const acceptedKey = 'cv_rules_accepted_' + (currentUser?.id || 'guest');
  if (!sessionStorage.getItem(acceptedKey)) {
    showRulesDisclaimerModal(() => {
      sessionStorage.setItem(acceptedKey, 'true');
      AntiCheat.start();
    });
  } else {
    AntiCheat.start();
  }
}

function buildAppShell(isAdmin) {
  return `
    <header class="fixed top-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md border-b border-border-line shadow-xs select-none">
      <div class="h-12 w-full px-2.5 sm:px-4 flex items-center justify-between gap-2">
        
        <!-- Left: Logo & Project Title -->
        <div class="flex items-center gap-2 sm:gap-2.5 cursor-pointer shrink-0" onclick="showMissionBriefing()">
          <img alt="Codeverse Logo" class="h-7 sm:h-8 w-auto object-contain rounded border border-slate-200 shadow-xs" src="logo.jpeg"/>
          <div class="flex flex-col justify-center">
            <div class="flex items-center gap-1.5">
              <span class="font-headline-sm font-extrabold text-dark-title text-xs sm:text-sm tracking-tight">CASEFILE // 0xRAVEN</span>
              <span class="hidden xs:inline-flex items-center px-1.5 py-0.2 rounded text-[9px] font-mono bg-gamer-emerald/10 text-gamer-emerald font-bold border border-gamer-emerald/30">
                <span class="w-1.5 h-1.5 rounded-full bg-gamer-emerald animate-pulse mr-1"></span>ONLINE
              </span>
            </div>
            <span class="text-[9px] sm:text-[10px] font-mono text-dark-muted hidden md:inline leading-none">Investigation CTF</span>
          </div>
        </div>

        <!-- Center: Dynamic Mission Progress HUD (Desktop) -->
        <div id="top-mission-hud" class="hidden md:flex items-center gap-2.5 bg-slate-50 border border-slate-200 px-3 py-1 rounded-lg font-mono text-xs">
          <!-- Populated by updateMissionHud() -->
        </div>

        <!-- Right: Actions, Score, Navigation -->
        <div class="flex items-center gap-1 sm:gap-1.5 shrink-0 font-mono">
          <button onclick="showMissionBriefing()" class="hidden sm:flex items-center gap-1 px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-bold transition-all border border-slate-200 cursor-pointer" title="Review Story & Operation Briefing">
            <span class="material-symbols-outlined text-sm text-gamer-purple">movie</span>
            <span class="hidden md:inline">BRIEFING</span>
          </button>

          <button onclick="openIntelDrawer('steps')" class="flex items-center gap-1 px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-bold transition-all border border-slate-200 cursor-pointer" title="View all operational objectives & map">
            <span class="material-symbols-outlined text-sm text-gamer-cyan">view_timeline</span>
            <span>OBJECTIVES</span>
          </button>

          <button onclick="window.toggleCyberTerminal()" class="flex items-center gap-1.5 px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-purple-300 hover:text-purple-200 rounded-md text-xs font-bold transition-all border border-slate-700 shadow-xs cursor-pointer" title="Open Forensic Decoders &amp; Terminal (Ctrl+~)">
            <span class="material-symbols-outlined text-sm text-purple-400">home_repair_service</span>
            <span>DECODERS &amp; TOOLS</span>
          </button>

          <div class="flex items-center gap-1 bg-gamer-purple text-white px-2 py-1 rounded-md font-mono text-xs font-bold shadow-xs">
            ${animEmoji('⚡', 'text-xs')}
            <span id="nav-score-val">${currentUser.score || 0}</span>
            <span class="text-[9px] text-purple-200">PTS</span>
          </div>

          <div class="hidden xl:flex items-center gap-1.5 pl-1.5 pr-2.5 py-0.5 bg-slate-100 border border-slate-200 rounded-full text-xs">
            <div class="w-5 h-5 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-xs font-bold">${animEmoji('🦅')}</div>
            <span class="font-bold text-slate-800 truncate max-w-[90px] text-xs">${currentUser.username}</span>
          </div>

          <button class="sound-toggle p-1 rounded-md hover:bg-slate-100 text-slate-600 border border-slate-200 text-xs cursor-pointer flex items-center justify-center min-w-[28px] min-h-[28px]" onclick="toggleSound()" id="sound-toggle-btn" title="Toggle Sound">${animEmoji(Sound.isOn() ? '🔊' : '🔇')}</button>
          <button class="px-2.5 py-1 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 text-xs font-bold transition-all cursor-pointer flex items-center gap-1 shadow-xs" onclick="doLogout()" title="Exit Platform">
            <span class="material-symbols-outlined text-xs">logout</span>
            <span>EXIT</span>
          </button>
        </div>
      </div>

      <!-- Mobile Sub-Bar Mission Tracker (visible only on screens < md) -->
      <div id="mobile-mission-hud" class="md:hidden border-t border-slate-200 bg-slate-50/95 px-3 py-1 flex items-center justify-between text-[10px] font-mono">
        <!-- Populated by updateMissionHud() -->
      </div>
    </header>

    <!-- Main Clean Centered Content Area (Padding matches compact 48px header) -->
    <div id="main-content" class="pt-18 md:pt-12 min-h-screen bg-surface esports-grid-pattern"></div>
    <div id="toast-container"></div>

    <!-- Backdrop overlay for slide-over drawer on mobile/tablet -->
    <div id="intel-drawer-backdrop" onclick="closeIntelDrawer()" class="fixed inset-0 bg-slate-900/30 backdrop-blur-xs z-[89] hidden transition-opacity"></div>

    <!-- Slide-over Intel Drawer (12 steps, map, leaderboard, rules) -->
    <div id="intel-drawer" class="fixed inset-y-0 right-0 z-[90] w-full sm:w-[480px] bg-surface border-l border-border-line shadow-2xl transform translate-x-full transition-transform duration-300 ease-in-out flex flex-col font-sans">
      <!-- Dynamically rendered by renderDrawerTab() -->
    </div>

    <!-- Floating Interactive Mascot (Hidden by default; appears periodically after few minutes or when summoned) -->
    <div id="mascot-container" style="display:none;">
      <div class="mascot-bubble" id="mascot-bubble" style="display:none;">
        <span class="bubble-text" id="mascot-line"></span>
        <span class="bubble-caret"></span>
      </div>
      <div style="position:relative">
        <button class="mascot-toggle-btn" onclick="closeMascotSprite()" title="Dismiss Handler AI">✕</button>
        <div class="mascot-stage" onclick="speakCurrentHint()" title="Click for advice">
          <div class="mascot-rig" id="mascot-rig">
            <img class="mascot-sprite m-idle" id="mascot-sprite" alt="Assistant">
          </div>
        </div>
      </div>
    </div>
  `;
}

/* ── Dynamic Top Mission Progress HUD ────────────────────── */
function updateMissionHud() {
  if (!currentUser || !challengesData) return;
  const userChallenges = getUserChallenges(currentUser);
  const total = userChallenges.length;
  const solvedCount = userChallenges.filter(c => isTargetSolved(c, currentUser)).length;
  const processedCount = userChallenges.filter(c => isTargetCleared(c.id, currentUser)).length;
  const remaining = Math.max(0, total - processedCount);
  const pct = total > 0 ? Math.round((solvedCount / total) * 100) : 0;

  const skipsUsed = currentUser.skipsUsed || 0;
  const skipsLeft = Math.max(0, 3 - skipsUsed);

  // Active target
  const activeChal = currentChallenge || getNextActiveChallenge(currentUser) || userChallenges[0];
  const userIdx = userChallenges.findIndex(c => c.id === activeChal?.id || (c.originalId && c.originalId === activeChal?.id));
  const stepIdx = userIdx >= 0 ? userIdx + 1 : 1;

  // Desktop HUD
  const el = $('#top-mission-hud');
  if (el) {
    el.innerHTML = `
      <div class="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity" onclick="renderChallenge('${activeChal.id}')" title="Active Objective">
        <span class="w-2 h-2 rounded-full bg-gamer-cyan animate-ping"></span>
        <span class="text-slate-500 font-bold">TARGET ${stepIdx}/${total}:</span>
        <span class="font-extrabold text-slate-800">${activeChal.id}</span>
      </div>
      <div class="w-28 bg-slate-200 h-2 rounded-full overflow-hidden" title="${pct}% Completed">
        <div class="bg-gradient-to-r from-cyan-500 to-purple-600 h-full transition-all duration-500" style="width: ${pct}%"></div>
      </div>
      <div class="flex items-center gap-2 text-[11px]">
        <span class="text-gamer-purple font-bold">${pct}%</span>
        <span class="text-slate-300">•</span>
        <span class="text-amber-600 font-bold">${remaining > 0 ? `${remaining} REMAINING` : 'ALL CLEARED'}</span>
        <span class="text-slate-300">•</span>
        <span class="text-amber-700 font-extrabold flex items-center gap-1 bg-amber-50 px-2 py-0.5 rounded border border-amber-200" title="Tactical Skips (-30 PTS each)">
          <span class="material-symbols-outlined text-xs text-amber-600">fast_forward</span>
          ${skipsLeft}/3 SKIPS
        </span>
      </div>
    `;
  }

  // Mobile HUD
  const mobEl = $('#mobile-mission-hud');
  if (mobEl) {
    mobEl.innerHTML = `
      <div class="flex items-center gap-1.5 cursor-pointer" onclick="renderChallenge('${activeChal.id}')">
        <span class="w-2 h-2 rounded-full bg-gamer-cyan animate-ping"></span>
        <span class="text-slate-500 font-bold">TARGET ${stepIdx}/${total}:</span>
        <span class="font-bold text-slate-800 truncate max-w-[100px]">${activeChal.id}</span>
      </div>
      <div class="flex items-center gap-2 flex-1 max-w-[140px] mx-2">
        <div class="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
          <div class="bg-gradient-to-r from-cyan-500 to-purple-600 h-full" style="width: ${pct}%"></div>
        </div>
        <span class="text-gamer-purple font-bold text-[10px]">${pct}%</span>
      </div>
      <div class="flex items-center gap-1">
        <span class="text-[10px] font-bold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 shrink-0" title="Tactical Skips">
          ${skipsLeft}/3 SKIPS
        </span>
        <button onclick="openIntelDrawer('steps')" class="text-[10px] font-bold text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-200 shrink-0">
          ${remaining} LEFT
        </button>
      </div>
    `;
  }
}

/* ── Slide-over Intel Drawer (All Steps, Standings, Rules) ── */
window.openIntelDrawer = (tab = 'steps') => {
  const drawer = $('#intel-drawer');
  const backdrop = $('#intel-drawer-backdrop');
  if (!drawer) return;
  drawer.classList.remove('translate-x-full');
  if (backdrop) backdrop.classList.remove('hidden');
  renderDrawerTab(tab);
};

window.closeIntelDrawer = () => {
  const drawer = $('#intel-drawer');
  const backdrop = $('#intel-drawer-backdrop');
  if (drawer) drawer.classList.add('translate-x-full');
  if (backdrop) backdrop.classList.add('hidden');
};

window.renderDrawerTab = (tab = 'steps') => {
  const drawer = $('#intel-drawer');
  if (!drawer) return;

  const userChallenges = window.getUserChallenges ? window.getUserChallenges(currentUser) : (challengesData?.challenges || []);
  const total = userChallenges.length;
  const solvedCount = userChallenges.filter(c => isTargetSolved(c, currentUser)).length;
  const processedCount = userChallenges.filter(c => isTargetCleared(c.id, currentUser)).length;
  const remaining = Math.max(0, total - processedCount);
  const pct = total > 0 ? Math.round((solvedCount / total) * 100) : 0;
  const nextTarget = getNextActiveChallenge(currentUser);

  drawer.innerHTML = `
    <!-- Drawer Header -->
    <div class="p-4 border-b border-border-line flex items-center justify-between bg-surface-muted text-slate-800 select-none">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined text-purple-600 text-lg">folder_shared</span>
        <span class="font-mono font-bold text-sm">OPERATION DOSSIER & MAP</span>
      </div>
      <button onclick="closeIntelDrawer()" class="p-1 hover:bg-slate-300 rounded text-slate-500 hover:text-slate-800 transition-colors cursor-pointer" title="Close Drawer [ESC]">
        <span class="material-symbols-outlined text-lg">close</span>
      </button>
    </div>

    <!-- Drawer Tabs -->
    <div class="grid grid-cols-3 border-b border-border-line bg-surface-muted text-xs font-mono font-bold select-none">
      <button onclick="renderDrawerTab('steps')" class="py-2.5 text-center border-b-2 cursor-pointer ${tab === 'steps' ? 'border-purple-600 text-purple-700 bg-surface' : 'border-transparent text-slate-500 hover:text-slate-800'}">
        TARGET MATRIX (${solvedCount}/${total})
      </button>
      <button onclick="renderDrawerTab('standings')" class="py-2.5 text-center border-b-2 cursor-pointer ${tab === 'standings' ? 'border-purple-600 text-purple-700 bg-surface' : 'border-transparent text-slate-500 hover:text-slate-800'}">
        STANDINGS
      </button>
      <button onclick="renderDrawerTab('rules')" class="py-2.5 text-center border-b-2 cursor-pointer ${tab === 'rules' ? 'border-purple-600 text-purple-700 bg-surface' : 'border-transparent text-slate-500 hover:text-slate-800'}">
        RULES
      </button>
    </div>

    <!-- Drawer Body -->
    <div class="flex-1 overflow-y-auto p-4 space-y-4 font-mono text-xs">
      ${tab === 'steps' ? `
        <!-- Summary pill -->
        <div class="p-3.5 bg-purple-50 border border-purple-200 rounded-xl space-y-1.5">
          <div class="flex justify-between font-bold text-purple-900">
            <span>INVESTIGATION PROGRESS</span>
            <span>${pct}%</span>
          </div>
          <div class="w-full bg-purple-200 h-2 rounded-full overflow-hidden">
            <div class="bg-gradient-to-r from-cyan-500 to-purple-600 h-full" style="width: ${pct}%"></div>
          </div>
          <div class="flex justify-between text-[11px] text-purple-700">
            <span>${solvedCount} Solved</span>
            <span>${remaining} Remaining</span>
          </div>
        </div>

        <!-- 3 Rounds list -->
        ${[1, 2, 3].map(roundNum => {
          const roundName = roundNum === 1 ? 'STAGE 1: OSINT & CRYPTO' : roundNum === 2 ? 'STAGE 2: WEB CTF' : 'STAGE 3: CODE REVIEW (ANTI-CHEAT RANDOMIZED)';
          const roundChallenges = userChallenges.filter(c => c.round === roundNum);
          const roundSolvedCount = roundChallenges.filter(c => isTargetSolved(c, currentUser)).length;
          const roundProcessedCount = roundChallenges.filter(c => isTargetCleared(c.id, currentUser)).length;
          const isRoundUnlocked = roundNum === 1 || (roundNum === 2 && userChallenges.filter(c => c.round === 1 && isTargetCleared(c.id, currentUser)).length === 4) || (roundNum === 3 && userChallenges.filter(c => c.round === 2 && isTargetCleared(c.id, currentUser)).length === 4);

          return `
            <div class="space-y-2">
              <div class="flex items-center justify-between text-[11px] font-bold text-slate-500 border-b border-slate-100 pb-1">
                <span>${roundName}</span>
                <span class="${roundProcessedCount === roundChallenges.length ? 'text-emerald-600' : isRoundUnlocked ? 'text-cyan-600' : 'text-slate-400'}">
                  ${roundSolvedCount}/${roundChallenges.length} SOLVED ${roundProcessedCount > roundSolvedCount ? `(${roundProcessedCount}/${roundChallenges.length} PROCESSED)` : ''}
                </span>
              </div>
              <div class="space-y-1.5">
                ${roundChallenges.map(c => {
                  const isSol = isTargetSolved(c, currentUser);
                  const isFail = isTargetFailed(c, currentUser);
                  const isSkip = isTargetSkipped(c, currentUser);
                  const isUnl = isChallengeUnlocked(c, currentUser) || isTargetCleared(c.id, currentUser);
                  const isAct = nextTarget && (nextTarget.id === c.id || (c.originalId && nextTarget.originalId === c.originalId) || nextTarget.id === c.originalId);
                  return `
                    <div onclick="${isUnl ? `closeIntelDrawer(); renderChallenge('${c.id}')` : ''}"
                      class="p-2.5 rounded-lg border transition-all flex items-center justify-between ${
                        isSol ? 'bg-emerald-50/60 border-emerald-200 cursor-pointer hover:bg-emerald-50' :
                        isSkip ? 'bg-amber-50/70 border-amber-200 cursor-pointer hover:bg-amber-50' :
                        isFail ? 'bg-rose-50/60 border-rose-200 cursor-pointer hover:bg-rose-50' :
                        isAct ? 'bg-purple-50 border-2 border-purple-500 shadow-sm cursor-pointer hover:bg-purple-100/70' :
                        'bg-slate-50 border-slate-200 opacity-60 cursor-not-allowed'
                      }">
                      <div class="flex items-center gap-2.5">
                        <span class="text-sm">
                          ${isSol ? '✓' : isSkip ? '⏩' : isFail ? '✗' : isAct ? animEmoji('⚡') : animEmoji('🔒')}
                        </span>
                        <div>
                          <div class="font-bold text-slate-800 ${isSol || isSkip || isFail ? 'line-through text-slate-500' : ''}">
                            ${c.id}: ${cleanChallengeName(c.name)}
                          </div>
                          <div class="text-[10px] text-slate-400">${c.difficulty.toUpperCase()} &bull; +${c.points} PTS</div>
                        </div>
                      </div>
                      ${isAct ? `
                        <span class="px-2 py-1 bg-purple-600 text-white rounded text-[10px] font-bold shadow-xs">
                          ACTIVE TARGET
                        </span>
                      ` : isSol ? `
                        <span class="text-emerald-600 font-bold text-[11px]">
                          +${c.points} PTS
                        </span>
                      ` : isSkip ? `
                        <span class="text-amber-700 font-bold text-[11px]">
                          -30 PTS (SKIPPED)
                        </span>
                      ` : isFail ? `
                        <span class="text-rose-600 font-bold text-[11px]">
                          0 PTS (MISSED)
                        </span>
                      ` : `
                        <span class="text-slate-400 text-[10px]">
                          LOCKED
                        </span>
                      `}
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          `;
        }).join('')}
      ` : tab === 'standings' ? `
        <div class="space-y-2" id="drawer-standings-list">
          <div class="flex items-center justify-between text-xs text-slate-500 mb-2 font-mono">
            <span>LIVE RANKINGS // AUDIT TELEMETRY</span>
            <button onclick="closeIntelDrawer(); navigate('leaderboard')" class="text-gamer-purple font-bold hover:underline flex items-center gap-1 cursor-pointer">
              <span>FULL LEDGER</span>
              <span class="material-symbols-outlined text-xs">open_in_new</span>
            </button>
          </div>
          ${buildLeaderboard()
            .map((u, i) => {
              const isMe = currentUser && (u.id === currentUser.id || u.username === currentUser.username);
              return `
                <div class="p-2.5 rounded-lg border ${isMe ? 'border-gamer-purple bg-purple-50/70' : 'border-border-line bg-white'} flex items-center justify-between">
                  <div class="flex items-center gap-2.5 min-w-0">
                    <span class="w-6 h-6 rounded-full ${i === 0 ? 'bg-amber-100 text-slate-900 font-bold' : i === 1 ? 'bg-cyan-100 text-slate-900 font-bold' : i === 2 ? 'bg-purple-100 text-purple-900 font-bold' : 'bg-slate-100 text-slate-600'} flex items-center justify-center text-[11px] font-bold shrink-0">
                      ${i === 0 ? animEmoji('🥇') : i === 1 ? animEmoji('🥈') : i === 2 ? animEmoji('🥉') : `#${i+1}`}
                    </span>
                    <div class="min-w-0">
                      <div class="font-bold text-slate-800 text-xs truncate flex items-center gap-1">
                        <span>${escapeHtml(u.team || u.username)}</span>
                        ${isMe ? '<span class="px-1 py-0.2 rounded text-[8px] bg-gamer-purple text-white font-bold">YOU</span>' : ''}
                      </div>
                      <div class="text-[10px] text-slate-400 font-mono truncate">@${escapeHtml(u.username)} &bull; ${u.solved} solved</div>
                    </div>
                  </div>
                  <div class="font-bold font-mono text-gamer-purple text-xs shrink-0">${u.score || 0} PTS</div>
                </div>
              `;
            }).join('')}
          <button onclick="closeIntelDrawer(); navigate('leaderboard')" class="w-full mt-3 py-2 bg-purple-50 hover:bg-purple-100 text-gamer-purple border border-purple-200 rounded-lg text-xs font-mono font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer">
            <span class="material-symbols-outlined text-sm">leaderboard</span>
            <span>VIEW COMPLETE TOURNAMENT LEDGER</span>
          </button>
        </div>
      ` : `
        <div class="space-y-3 text-xs font-sans text-slate-600 leading-relaxed">
          <div class="font-mono font-bold text-slate-800 text-xs">CONTEST RULES OF ENGAGEMENT:</div>
          <ul class="list-disc pl-4 space-y-2">
            <li>Do NOT attack the contest infrastructure or scoring platform.</li>
            <li>No flag sharing between competing teams.</li>
            <li>Hints permanently deduct points from your final score &mdash; choose wisely.</li>
            <li>Answers are simple plain text (e.g. <code class="bg-slate-100 px-1 py-0.5 rounded text-purple-600 font-mono">NOTHING_IS_HIDDEN</code>). Flexible format!</li>
            <li>One continuous story links all three stages: OSINT &rarr; Web CTF &rarr; Code Review.</li>
          </ul>
          <button onclick="showMissionBriefing(); closeIntelDrawer();" class="w-full mt-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-mono font-bold text-xs flex items-center justify-center gap-2 cursor-pointer shadow-xs">
            <span class="material-symbols-outlined text-sm">movie</span>
            REPLAY MISSION BRIEFING
          </button>
        </div>
      `}
    </div>
  `;
};

/* ── Operation Briefing (Post-Login Story Presentation) ───── */
window.showMissionBriefing = () => {
  window.scrollTo({ top: 0, behavior: 'instant' });
  const main = $('#main-content');
  if (!main) return;
  PageTransition.wipe(() => _doShowMissionBriefing());
};
function _doShowMissionBriefing() {
  const main = $('#main-content');
  if (!main) return;

  Sound.play('boot');
  const spriteSrc = window.MASCOT_SPRITES?.idle || 'mascot.png';

  main.innerHTML = `
    <div class="min-h-[calc(100vh-64px)] flex flex-col items-center justify-center p-3 sm:p-6 lg:p-8 bg-surface text-slate-800 relative esports-grid-pattern py-6">
      <!-- Soft ambient accents -->
      <div class="absolute -top-40 -right-40 w-96 h-96 bg-purple-200/40 rounded-full blur-3xl pointer-events-none"></div>
      <div class="absolute -bottom-40 -left-40 w-96 h-96 bg-cyan-200/40 rounded-full blur-3xl pointer-events-none"></div>

      <div class="max-w-3xl w-full relative z-10 space-y-6">
        
        <!-- Header status -->
        <div class="flex items-center justify-between border-b border-slate-200 pb-3 font-mono">
          <div class="flex items-center gap-2.5">
            <span class="inline-flex items-center px-2.5 py-1 rounded text-xs font-bold bg-cyan-50 text-cyan-700 border border-cyan-200">
              <span class="w-2 h-2 rounded-full bg-cyan-500 animate-ping mr-1.5"></span>PRIORITY INCIDENT
            </span>
            <span class="text-xs text-slate-500">OPERATION 0xRAVEN // DISPATCH #2026-09</span>
          </div>
          <button onclick="renderChallenge('OSINT-01')" class="text-xs text-purple-600 hover:text-purple-800 font-bold transition-colors cursor-pointer">
            SKIP &bull; LAUNCH FIRST CLUE &rarr;
          </button>
        </div>

        <!-- Mascot Spotlight Briefing Card (100% Light Theme) -->
        <div class="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 lg:p-8 shadow-xl space-y-5 sm:space-y-6 max-h-[90vh] overflow-y-auto">
          <div class="flex flex-col sm:flex-row items-center sm:items-start gap-6">
            
            <!-- Mascot Rig Box -->
            <div class="shrink-0 relative">
              <div class="w-28 h-28 rounded-2xl bg-purple-50 border-2 border-purple-200 flex items-center justify-center p-2 shadow-sm relative">
                <img id="briefing-mascot-img" src="${spriteSrc}" alt="Tactical Assistant" class="w-full h-full object-contain animate-bounce" style="animation-duration: 3s;">
                <div class="absolute -bottom-2 -right-2 bg-purple-600 text-[10px] font-mono font-bold px-2 py-0.5 rounded-full text-white shadow-xs">
                  HANDLER AI
                </div>
              </div>
            </div>

            <!-- Problem Statement & Mission Context -->
            <div class="flex-1 space-y-2.5 text-center sm:text-left">
              <div class="inline-block bg-purple-100 text-purple-800 border border-purple-200 rounded px-2.5 py-0.5 text-xs font-mono font-bold">
                TACTICAL BRIEFING // CYBER OPERATIONS DISPATCH
              </div>
              <h1 class="text-2xl lg:text-3xl font-extrabold text-slate-900 tracking-tight">
                Senior Defense Architect 0xRAVEN Has Activated Kill-Switch.
              </h1>
              <p class="text-slate-600 text-sm leading-relaxed font-sans">
                At 03:47 UTC, rogue architect 0xRAVEN executed an evasive blackout protocol and severed all network links. Real-time SIGINT telemetry intercepted encrypted burst transmissions across darknet nodes. He left behind a deliberate, three-stage operational proving ground &mdash; <em class="text-slate-800 font-medium">cryptographic relays, an unscrubbed corporate web staging application, and classified source repositories.</em> Reconstruct the exfiltration trail and neutralize the threat vector.
              </p>
            </div>
          </div>

          <!-- 3 Stages Breakdown -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1 font-sans">
            <div class="bg-purple-50/70 border-2 border-purple-300 rounded-xl p-4 space-y-1.5 relative overflow-hidden">
              <div class="text-xs font-mono font-bold text-purple-800 flex items-center gap-1.5">
                <span class="text-base">01.</span> SIGINT & OSINT
              </div>
              <p class="text-[12px] text-purple-950 leading-snug">
                Intercept darknet telemetry, demodulate hex preambles, and excavate orphaned git commits.
              </p>
              <div class="text-[10px] font-mono text-purple-700 font-bold pt-1">ACTIVE SECTOR</div>
            </div>

            <div class="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-1.5">
              <div class="text-xs font-mono font-bold text-slate-600 flex items-center gap-1.5">
                <span class="text-base">02.</span> OFFENSIVE WEB CTF
              </div>
              <p class="text-[12px] text-slate-500 leading-snug">
                Infiltrate target at oxraventest.com. Exploit IDOR dossiers, execute SQLi, and hijack admin sessions.
              </p>
              <div class="text-[10px] font-mono text-slate-400 font-bold pt-1">LOCKED (CLEAR SECTOR 1)</div>
            </div>

            <div class="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-1.5">
              <div class="text-xs font-mono font-bold text-slate-600 flex items-center gap-1.5">
                <span class="text-base">03.</span> SAST CODE AUDIT
              </div>
              <p class="text-[12px] text-slate-500 leading-snug">
                Conduct static security audits across backend microservices to uncover architectural vulnerabilities.
              </p>
              <div class="text-[10px] font-mono text-slate-400 font-bold pt-1">FINAL SECTOR</div>
            </div>
          </div>

          <!-- Immediate First Objective Callout -->
          <div class="bg-purple-50/50 border-l-4 border-purple-600 p-4 rounded-r-xl space-y-1.5">
            <div class="text-xs font-mono font-bold text-purple-900 uppercase tracking-wide flex items-center gap-2">
              <span class="material-symbols-outlined text-sm text-purple-600">flag</span>
              Immediate Directive: OSINT-01 (Intercept Zero // Darknet Signal Beacon)
            </div>
            <p class="text-xs text-slate-600 leading-relaxed font-sans">
              Listening posts intercepted raw byte stream: <code class="text-purple-700 bg-white border border-purple-200 px-1.5 py-0.5 rounded font-mono font-bold">4E 6F 74 68 69 6E 67 20 69 73 20 68 69 64 64 65 6E</code>. Demodulate and decode the hexadecimal stream to reconstruct 0xRAVEN's operational doctrine.
            </p>
          </div>

          <!-- Action Launch Button -->
          <div class="flex flex-col sm:flex-row items-center justify-between gap-4 pt-1 font-mono">
            <div class="text-xs text-slate-500 flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span>13 Operational Objectives &bull; Target 01 Ready</span>
            </div>
            <button onclick="renderChallenge('OSINT-01')" class="w-full sm:w-auto px-8 py-3.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md shadow-purple-500/20 hover:shadow-purple-500/40 transition-all flex items-center justify-center gap-2 cursor-pointer transform hover:-translate-y-0.5">
              <span>COMMENCE INVESTIGATION // LAUNCH OSINT-01</span>
              <span class="material-symbols-outlined text-sm">arrow_forward</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  updateMissionHud();
};

/* ── Solve Success Debrief Modal (Mascot Celebrates & Advances) ── */
window.showSolveSuccessDebrief = (challenge) => {
  const userChallenges = getUserChallenges(currentUser);
  const total = userChallenges.length;
  const solvedCount = userChallenges.filter(c => isTargetSolved(c, currentUser)).length;
  const remaining = Math.max(0, total - solvedCount);
  const pct = total > 0 ? Math.round((solvedCount / total) * 100) : 0;

  // Find next unlocked challenge
  const nextChal = getNextActiveChallenge(currentUser);

  // Check if round completed
  const isRound1Complete = challenge.id === 'OSINT-04';
  const isRound2Complete = challenge.id === 'WEB-04';
  const userCodeList = getUserCodeReviewChallenges(currentUser, 5);
  const isAllComplete = remaining === 0 || (challenge.round === 3 && userCodeList.every(c => isTargetCleared(c.id, currentUser)));

  // Mascot sprite
  const spriteSrc = window.MASCOT_SPRITES?.hype || window.MASCOT_SPRITES?.happy || 'mascot.png';

  let title = 'OBJECTIVE CAPTURED!';
  let badgeText = `+${challenge.points} PTS ACQUIRED`;
  let stageClearMsg = '';

  if (isAllComplete) {
    title = '🏆 INVESTIGATION COMPLETE // 0xRAVEN FOUND!';
    badgeText = 'FINAL OBJECTIVE SOLVED!';
    stageClearMsg = `
      <div class="p-4 rounded-xl bg-purple-50 border border-purple-200 text-purple-900 text-xs font-mono space-y-1">
        <div class="font-bold text-sm text-purple-950">CASE FILE CLOSED: 0xRAVEN TRACED</div>
        <p class="text-purple-800">You have successfully decoded his cryptographic footprints, exploited his vulnerable web systems, and audited his hidden source code. Operation 0xRAVEN is a complete success!</p>
      </div>
    `;
  } else if (isRound1Complete) {
    title = '🎉 STAGE 1 CLEARED // WEB CTF UNLOCKED!';
    stageClearMsg = `
      <div class="p-4 rounded-xl bg-cyan-50 border border-cyan-200 text-cyan-900 text-xs font-mono space-y-1">
        <div class="font-bold text-sm text-cyan-950">NEW SECTOR ACCESSIBLE: STAGE 2 (OFFENSIVE WEB CTF)</div>
        <p class="text-cyan-800">All cryptographic footprints resolved! Engage 0xRAVEN's live web application infrastructure at oxraventest.com.</p>
      </div>
    `;
  } else if (isRound2Complete) {
    title = '🎉 STAGE 2 CLEARED // CODE REVIEW UNLOCKED!';
    stageClearMsg = `
      <div class="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs font-mono space-y-1">
        <div class="font-bold text-sm text-emerald-950">FINAL SECTOR ACCESSIBLE: STAGE 3 (CODE REVIEW)</div>
        <p class="text-emerald-800">Admin authorization bypassed! The final clues are buried inside the Python and JavaScript source code repositories.</p>
      </div>
    `;
  }

  // Remove existing modal if any
  const existing = $('#debrief-modal-overlay');
  if (existing) existing.remove();

  // Hide floating mascot bubble while debrief modal is active
  const floatingBubble = $('#mascot-bubble');
  if (floatingBubble) floatingBubble.style.display = 'none';

  const modalHtml = `
    <div id="debrief-modal-overlay" class="fixed inset-0 z-[100] bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div class="w-full max-w-2xl bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 lg:p-8 shadow-2xl text-slate-800 space-y-5 sm:space-y-6 relative max-h-[92vh] overflow-y-auto">
        
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-slate-100 pb-3 relative z-10 font-mono">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span class="text-xs text-emerald-700 font-bold tracking-wide">${badgeText}</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-xs text-slate-400 font-bold">${challenge.id} // DEBRIEF</span>
            <button onclick="closeDebriefOnly()" class="text-slate-400 hover:text-slate-700 p-1 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer" title="Close debrief">
              <span class="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>

        <!-- Mascot & Speech -->
        <div class="flex flex-col sm:flex-row items-center sm:items-start gap-5 relative z-10">
          <div class="w-24 h-24 shrink-0 rounded-2xl bg-purple-50 border-2 border-purple-200 p-2 shadow-sm flex items-center justify-center">
            <img src="${spriteSrc}" alt="Mascot" class="w-full h-full object-contain animate-bounce" style="animation-duration: 2.5s;">
          </div>
          <div class="flex-1 space-y-2 text-center sm:text-left">
            <h2 class="text-xl lg:text-2xl font-extrabold text-slate-900">${title}</h2>
            <div class="bg-purple-50/80 border border-purple-200 rounded-xl p-3.5 text-xs font-mono text-purple-950 leading-relaxed">
              <span class="text-purple-700 font-bold block mb-1">&gt; 0xRAVEN INTEL UNLOCKED:</span>
              "${challenge.unlock_message || 'Excellent work agent. You cracked this clue!'}"
            </div>
          </div>
        </div>

        ${stageClearMsg}

        <!-- Progress Metrics Card -->
        <div class="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3 relative z-10 font-mono text-xs">
          <div class="flex items-center justify-between">
            <span class="text-slate-500">OPERATION PROGRESS</span>
            <span class="text-slate-900 font-bold">${solvedCount} of ${total} Cleared (${pct}%)</span>
          </div>
          <div class="w-full bg-slate-200 h-2.5 rounded-full overflow-hidden">
            <div class="bg-gradient-to-r from-cyan-500 via-purple-600 to-emerald-500 h-full transition-all duration-700" style="width: ${pct}%"></div>
          </div>
          <div class="flex items-center justify-between text-[11px] text-slate-500">
            <span>Score: <strong class="text-purple-700 font-bold">${currentUser.score} PTS</strong></span>
            <span class="text-amber-600 font-bold">${remaining > 0 ? `${remaining} Objectives Remaining` : 'All Objectives Completed!'}</span>
          </div>
        </div>

        <!-- Action / Next Clue -->
        <div class="flex flex-col sm:flex-row items-center justify-between gap-4 pt-1 relative z-10 font-mono">
          ${nextChal ? `
            <div class="text-xs text-slate-600">
              <span class="text-slate-400">NEXT VECTOR:</span> <strong class="text-purple-700 font-bold">${nextChal.id}</strong> &bull; ${nextChal.name}
            </div>
            <button onclick="closeDebriefAndLaunch('${nextChal.id}')" class="w-full sm:w-auto px-8 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md shadow-purple-500/20 transition-all flex items-center justify-center gap-2 cursor-pointer">
              <span>PROCEED TO NEXT CLUE [${nextChal.id}]</span>
              <span class="material-symbols-outlined text-sm">arrow_forward</span>
            </button>
          ` : `
            <div class="text-xs text-emerald-700 font-bold">ALL OBJECTIVES COMPLETED!</div>
            <button onclick="closeDebriefAndLaunch('leaderboard')" class="w-full sm:w-auto px-8 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer">
              <span>VIEW FINAL STANDINGS</span>
              <span class="material-symbols-outlined text-sm">trophy</span>
            </button>
          `}
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  // Keyboard shortcut: Enter proceeds to next, Escape closes
  const keyHandler = (e) => {
    if (e.key === 'Enter') {
      document.removeEventListener('keydown', keyHandler);
      closeDebriefAndLaunch(nextChal ? nextChal.id : 'leaderboard');
    } else if (e.key === 'Escape') {
      document.removeEventListener('keydown', keyHandler);
      closeDebriefOnly();
    }
  };
  document.addEventListener('keydown', keyHandler, { once: true });
};

window.closeDebriefOnly = () => {
  const modal = $('#debrief-modal-overlay');
  if (modal) modal.remove();
  const floatingBubble = $('#mascot-bubble');
  if (floatingBubble && mascotVisible) floatingBubble.style.display = 'block';
};

window.closeDebriefAndLaunch = (targetId) => {
  if (window._solveTransitionTimer) {
    clearTimeout(window._solveTransitionTimer);
    window._solveTransitionTimer = null;
  }
  const modal = $('#debrief-modal-overlay');
  if (modal) modal.remove();
  const floatingBubble = $('#mascot-bubble');
  if (floatingBubble && mascotVisible) floatingBubble.style.display = 'block';
  if (targetId === 'leaderboard') {
    openIntelDrawer('standings');
  } else {
    renderChallenge(targetId);
  }
};

/* ── Code Review Failure & Advance Modal (No Second Chances) ── */
window.showCodeFailDebrief = (challenge, answerText) => {
  const solved = currentUser.solvedChallenges || [];
  const failed = currentUser.failedChallenges || [];
  const skipped = currentUser.skippedChallenges || [];
  const processedCount = solved.length + failed.length + skipped.length;
  const remaining = total - processedCount;

  // Find next unlocked challenge
  const nextChal = getNextActiveChallenge(currentUser);

  // Remove existing modal if any
  const existing = $('#debrief-modal-overlay');
  if (existing) existing.remove();

  const floatingBubble = $('#mascot-bubble');
  if (floatingBubble) floatingBubble.style.display = 'none';

  const spriteSrc = window.MASCOT_SPRITES?.worried || window.MASCOT_SPRITES?.idle || 'mascot.png';

  const modalHtml = `
    <div id="debrief-modal-overlay" class="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div class="w-full max-w-2xl bg-white border-2 border-rose-200 rounded-2xl p-5 sm:p-6 lg:p-8 shadow-2xl text-slate-800 space-y-5 relative max-h-[92vh] overflow-y-auto">
        
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-rose-100 pb-3 relative z-10 font-mono">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping"></span>
            <span class="text-xs text-rose-700 font-bold tracking-wide">0 PTS // SINGLE ATTEMPT EXHAUSTED</span>
          </div>
          <span class="text-xs text-slate-400 font-bold">${challenge.id} // FINDING REJECTED</span>
        </div>

        <!-- Mascot & Speech -->
        <div class="flex flex-col sm:flex-row items-center sm:items-start gap-5 relative z-10">
          <div class="w-24 h-24 shrink-0 rounded-2xl bg-rose-50 border-2 border-rose-200 p-2 shadow-sm flex items-center justify-center">
            <img src="${spriteSrc}" alt="Mascot" class="w-full h-full object-contain">
          </div>
          <div class="flex-1 space-y-2 text-center sm:text-left">
            <h2 class="text-xl lg:text-2xl font-extrabold text-slate-900">TARGET MISSED // ADVANCING</h2>
            <div class="bg-rose-50/80 border border-rose-200 rounded-xl p-3.5 text-xs font-mono text-rose-950 leading-relaxed">
              <span class="text-rose-700 font-bold block mb-1">&gt; 0xRAVEN AUDIT LOG:</span>
              Your submitted finding was incorrect. Under single-attempt evaluation rules, no second chance is granted for this dossier. Progression moves forward.
            </div>
          </div>
        </div>

        <!-- Correct Vulnerability Post-Mortem -->
        <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs font-mono space-y-2">
          <div class="flex items-center justify-between text-[11px] font-bold text-slate-500 uppercase">
            <span>Audit Post-Mortem</span>
            <span class="text-emerald-700 font-bold">Vulnerability Breakdown</span>
          </div>
          <p class="text-xs font-sans font-medium text-slate-700 leading-relaxed pl-3 border-l-2 border-rose-400">
            ${escapeHtml(challenge.explanation)}
          </p>
        </div>

        <!-- Progress Metrics Card -->
        <div class="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2 relative z-10 font-mono text-xs">
          <div class="flex items-center justify-between text-[11px] text-slate-500">
            <span>Current Score: <strong class="text-purple-700 font-bold">${currentUser.score || 0} PTS</strong></span>
            <span class="text-slate-600 font-bold">${processedCount} of ${total} Targets Audited</span>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="flex flex-col sm:flex-row items-center justify-between gap-4 pt-1 relative z-10 font-mono">
          <button onclick="closeDebriefAndLaunch('dashboard')" class="w-full sm:w-auto px-4 py-2.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50 transition-all cursor-pointer">
            DOSSIER CATALOG
          </button>
          ${nextChal ? `
            <button onclick="closeDebriefAndLaunch('${nextChal.id}')" class="w-full sm:w-auto px-8 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer transform active:scale-95">
              <span>PROCEED TO NEXT TARGET [${nextChal.id}]</span>
              <span class="material-symbols-outlined text-sm">arrow_forward</span>
            </button>
          ` : `
            <button onclick="closeDebriefAndLaunch('leaderboard')" class="w-full sm:w-auto px-8 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer">
              <span>VIEW FINAL STANDINGS</span>
              <span class="material-symbols-outlined text-sm">trophy</span>
            </button>
          `}
        </div>

      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  Sound.play('notify');
};

/* ── Tactical Skip System (3 Skips Max, 30 PTS each) ───────────────── */
window.confirmSkipChallenge = (challengeId) => {
  const challenge = challengesData?.challenges?.find(c => c.id === challengeId);
  if (!challenge) return;

  const skipsUsed = currentUser.skipsUsed || 0;
  const remainingSkips = Math.max(0, 3 - skipsUsed);

  if (remainingSkips <= 0) {
    Sound.play('error');
    Mascot.react('worried', 'You have already exhausted all 3 tactical skips available.');
    toast('No Skips Remaining', 'All 3 skips have already been used for this operation.', 'warning', 3000);
    return;
  }

  const currentScore = currentUser.score || 0;
  if (currentScore < 30) {
    Sound.play('error');
    Mascot.react('worried', 'Skipping costs 30 PTS, but your current score is only ' + currentScore + ' PTS.');
    toast('Insufficient Points', `You need at least 30 PTS to skip this challenge (Current balance: ${currentScore} PTS).`, 'warning', 3500);
    return;
  }

  const existing = $('#skip-confirm-modal-overlay');
  if (existing) existing.remove();

  const modalHtml = `
    <div id="skip-confirm-modal-overlay" class="fixed inset-0 z-[110] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 font-sans">
      <div class="w-full max-w-md bg-white border-2 border-amber-300 rounded-2xl p-6 shadow-2xl space-y-4 text-slate-800 relative">
        <div class="flex items-center justify-between pb-3 border-b border-slate-100 font-mono">
          <div class="flex items-center gap-2 text-amber-700 font-bold text-xs uppercase tracking-wider">
            <span class="material-symbols-outlined text-base text-amber-500">fast_forward</span>
            <span>TACTICAL BYPASS // SKIP TARGET</span>
          </div>
          <span class="text-xs bg-amber-100 text-amber-900 font-bold px-2 py-0.5 rounded font-mono">${remainingSkips}/3 SKIPS LEFT</span>
        </div>

        <div class="space-y-2">
          <h3 class="font-extrabold text-base text-slate-900">Bypass "${challenge.name}"?</h3>
          <p class="text-xs text-slate-600 leading-relaxed">
            Skipping this target will immediately deduct <strong>30 points</strong> from your score and consume <strong>1 of your 3 tactical skips</strong>.
            The challenge will be marked as bypassed, and the next operational objective will unlock immediately.
          </p>
          <div class="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between text-xs font-mono">
            <span class="text-slate-600">Current Score: <strong>${currentScore} PTS</strong></span>
            <span class="text-amber-800 font-bold">New Score: <strong>${currentScore - 30} PTS</strong></span>
          </div>
        </div>

        <div class="pt-2 flex items-center justify-end gap-3 border-t border-slate-100 font-mono">
          <button onclick="document.getElementById('skip-confirm-modal-overlay')?.remove();" class="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50 transition-all cursor-pointer">
            CANCEL
          </button>
          <button onclick="executeSkipChallenge('${challenge.id}')" class="px-5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white text-xs font-bold shadow-md transition-all flex items-center gap-1.5 cursor-pointer transform active:scale-95">
            <span class="material-symbols-outlined text-sm">fast_forward</span>
            <span>CONFIRM SKIP (-30 PTS)</span>
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  Sound.play('notify');
};

window.executeSkipChallenge = (challengeId) => {
  const modal = $('#skip-confirm-modal-overlay');
  if (modal) modal.remove();

  window._inFlightSkips = window._inFlightSkips || new Set();
  if (window._inFlightSkips.has(challengeId)) return;

  const challenge = challengesData?.challenges?.find(c => c.id === challengeId);
  if (!challenge) return;

  if ((currentUser.skippedChallenges || []).includes(challengeId)) {
    toast('Already Bypassed', 'This challenge was already bypassed.', 'info', 2000);
    return;
  }
  if ((currentUser.solvedChallenges || []).includes(challengeId)) {
    toast('Already Solved', 'This challenge has already been solved.', 'info', 2000);
    return;
  }
  if ((currentUser.skipsUsed || 0) >= 3) {
    toast('No Skips Left', 'All 3 tactical skips have been used.', 'warning', 2500);
    return;
  }
  if ((currentUser.score || 0) < 30) {
    toast('Insufficient Score', 'You need at least 30 PTS to skip this challenge.', 'warning', 2500);
    return;
  }

  window._inFlightSkips.add(challengeId);

  // Deduct 30 points and record skip locally
  currentUser.score = Math.max(0, (currentUser.score || 0) - 30);
  currentUser.skipsUsed = (currentUser.skipsUsed || 0) + 1;
  if (!currentUser.skippedChallenges) currentUser.skippedChallenges = [];
  if (!currentUser.skippedChallenges.includes(challengeId)) {
    currentUser.skippedChallenges.push(challengeId);
  }

  if (!currentUser.submissions) currentUser.submissions = [];
  currentUser.submissions.push({
    challengeId,
    value: 'SKIPPED_BY_USER',
    timestamp: new Date().toISOString(),
    correct: false
  });

  saveUser();
  updateNavScore();
  updateMissionHud();

  // Atomically persist skip to server
  Api.post('/api/skip', { challengeId }).then(res => {
    if (res && typeof res.score === 'number') {
      currentUser.score = res.score;
      if (res.skipsUsed !== undefined) currentUser.skipsUsed = res.skipsUsed;
      if (Array.isArray(res.skippedChallenges)) currentUser.skippedChallenges = res.skippedChallenges;
      saveUser();
      updateNavScore();
      updateMissionHud();
    }
  }).catch(() => {}).finally(() => {
    window._inFlightSkips.delete(challengeId);
  });

  Sound.play('notify');
  const remainingSkips = Math.max(0, 3 - currentUser.skipsUsed);
  Mascot.react('worried', `Target bypassed (-30 PTS). ${remainingSkips} skip${remainingSkips === 1 ? '' : 's'} remaining.`);
  toast('Target Bypassed', `-30 PTS deducted. ${remainingSkips} skip(s) remaining. Advancing to next target...`, 'info', 3500);

  // Find next unlocked challenge
  const nextChal = getNextActiveChallenge(currentUser);

  setTimeout(() => {
    if (nextChal) {
      renderChallenge(nextChal.id);
    } else {
      showSolveSuccessDebrief(challenge);
    }
  }, 400);
};

window.speakCurrentHint = () => {
  if (!mascotVisible) {
    showMascotSprite('hype');
    return;
  }
  if (currentChallenge) {
    Mascot.setEmotion('hype', `Intel on ${currentChallenge.id}: ${currentChallenge.mascot_hint || 'Carefully inspect the evidence artifacts!'}`);
  } else {
    Mascot.setEmotion('idle', 'Follow 0xRAVEN’s trail step by step. Every clue connects to the next!');
  }
};

function initMascot() {
  const sprite = $('#mascot-sprite');
  if (window.MASCOT_SPRITES) {
    if (sprite && window.MASCOT_SPRITES.idle) {
      sprite.src = window.MASCOT_SPRITES.idle;
    }
  } else {
    loadMascotSprites();
  }
  Mascot.initCursorFollow();
  Mascot.setVisible(false);
  scheduleMascotCheckIn(MASCOT_CHECKIN_DELAY_MS);
}

function loadMascotSprites() {
  if (window.MASCOT_SPRITES) return;
  fetch('mascot/dist/script.js')
    .then(r => r.text())
    .then(code => {
      const match = code.match(/const SPRITES\s*=\s*(\{[\s\S]*?\n\};)/);
      if (match) {
        try {
          const sprites = new Function('return ' + match[1])();
          window.MASCOT_SPRITES = sprites;
          const sprite = $('#mascot-sprite');
          if (sprite && sprites.idle) sprite.src = sprites.idle;
        } catch (e) {
          console.warn('Could not parse mascot sprites:', e);
        }
      }
    })
    .catch(() => {});
}

let mascotVisible = false;
let mascotTimer = null;
const MASCOT_CHECKIN_DELAY_MS = 120000; // 2 minutes check-in

window.showMascotSprite = (emotion = 'idle', customText = null) => {
  const container = $('#mascot-container');
  if (!container) return;
  mascotVisible = true;
  Mascot.setVisible(true);
  container.classList.add('visible');
  container.style.display = 'flex';
  if (emotion !== 'sad') Sound.play('notify');
  
  const text = customText || (currentChallenge ? (currentChallenge.mascot_hint || 'Agent, need intel on this clue? Click me for advice!') : 'Follow 0xRAVEN\'s trail step by step.');
  Mascot.setEmotion(emotion, text);

  // Auto-hide the speech bubble after 12s if inactive
  setTimeout(() => {
    const bubble = $('#mascot-bubble');
    if (bubble && mascotVisible) bubble.style.display = 'none';
  }, 12000);
};

window.closeMascotSprite = () => {
  const container = $('#mascot-container');
  const bubble = $('#mascot-bubble');
  if (bubble) bubble.style.display = 'none';
  if (container) {
    container.classList.remove('visible');
    container.style.display = 'none';
  }
  mascotVisible = false;
  Mascot.setVisible(false);
  Mascot.hide();
  toast('Handler AI', 'Mascot closed. Standing by in background.', 'info', 2000);

  // Schedule next gentle check-in after 3 minutes
  scheduleMascotCheckIn(180000);
};

window.toggleMascot = () => {
  if (mascotVisible) {
    closeMascotSprite();
  } else {
    showMascotSprite('idle');
  }
};

window.scheduleMascotCheckIn = (delayMs = MASCOT_CHECKIN_DELAY_MS) => {
  clearTimeout(mascotTimer);
  mascotTimer = setTimeout(() => {
    // Only appear if user is logged in, currently on an active challenge, and not already visible
    if (currentUser && currentChallenge && !mascotVisible) {
      const solved = currentUser.solvedChallenges || [];
      if (!solved.includes(currentChallenge.id)) {
        showMascotSprite('idle', `Need a hint on ${currentChallenge.id}? ${currentChallenge.mascot_hint || 'Click me for advice!'}`);
      }
    }
  }, delayMs);
};

window.toggleSound = () => {
  const isOn = Sound.toggle();
  const btn = $('#sound-toggle-btn');
  if (btn) { btn.innerHTML = isOn ? animEmoji('🔊') : animEmoji('🔇'); btn.classList.toggle('muted', !isOn); }
  toast('Sound', isOn ? 'Sound enabled' : 'Sound disabled', 'info', 2000);
};

window.doLogout = () => {
  if (typeof stopAdminRealtimePoller === 'function') stopAdminRealtimePoller();
  clearInterval(_examPollInterval);
  _examPollInterval = null;
  if (typeof window.closeSimulatedChromeWindow === 'function') window.closeSimulatedChromeWindow();
  if (typeof window.closeModal === 'function') window.closeModal();
  if (typeof window.closeIntelDrawer === 'function') window.closeIntelDrawer();
  if (typeof clearBriefingTimers === 'function') clearBriefingTimers();

  // Stop anti-cheat system (removes overlays, exits fullscreen)
  AntiCheat.stop();
  const discOverlay = document.getElementById('rules-disclaimer-overlay');
  if (discOverlay) discOverlay.remove();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('cv_rules_accepted_')) sessionStorage.removeItem(k);
    }
  } catch {}
  currentUser = null;
  // Invalidate session on the server (removes token from Redis)
  Api.post('/api/auth/logout').catch(() => {});
  Api.setToken(null);

  
  const main = $('#main-content');
  if (main) {
    main.style.padding = '';
    main.style.maxWidth = '';
  }
  
  const overlay = document.getElementById('exam-device-guard-overlay');
  if (overlay) overlay.remove();
  
  showAuthScreen();
};

function updateNavScore() {
  const scoreVal = $('#nav-score-val');
  if (scoreVal && currentUser) scoreVal.textContent = currentUser.score || 0;
}

function initNavHandlers() {}


/* ── Navigation ──────────────────────────────────────────── */
window.navigate = (view, param) => {
  if (view !== 'admin' && typeof stopAdminRealtimePoller === 'function') {
    stopAdminRealtimePoller();
  }
  if (typeof window.closeSimulatedChromeWindow === 'function') window.closeSimulatedChromeWindow();
  window.scrollTo({ top: 0, behavior: 'instant' });
  Sound.play('click');
  document.querySelectorAll('header nav button').forEach(b => {
    b.className = 'px-3.5 py-1.5 rounded-md text-dark-muted hover:text-dark-title hover:bg-white transition-all';
  });
  const activeBtn = $(`#nav-${view}`);
  if (activeBtn) {
    activeBtn.className = 'px-3.5 py-1.5 rounded-md text-dark-title bg-white shadow-xs font-bold border border-border-line';
  }

  const main = $('#main-content');
  const doNav = () => {
    if (view === 'dashboard')        renderDashboard();
    else if (view === 'challenges')  renderDashboard(param);
    else if (view === 'challenge')   renderChallenge(param);
    else if (view === 'leaderboard') renderLeaderboard();
    else if (view === 'rules')       renderRules();
    else if (view === 'admin')       renderAdminPanel();
  };
  PageTransition.wipe(doNav);
};


/* ── Dashboard & Investigation Progression Map ─────────────── */
let activeDashboardFilter = 'all';

window.filterDashboardChallenges = (cat) => {
  activeDashboardFilter = cat;
  document.querySelectorAll('#challenge-filter-group button').forEach(b => {
    b.className = b.dataset.filter === cat
      ? 'px-3 py-1.5 rounded-lg text-xs font-telemetry font-bold transition-all bg-gamer-purple text-white shadow-xs'
      : 'px-3 py-1.5 rounded-lg text-xs font-telemetry font-bold transition-all bg-white hover:bg-slate-50 text-dark-muted border border-border-line';
  });
  renderChallengeMosaic();
};

function renderChallengeMosaic() {
  const container = $('#challenge-list-container');
  if (!container) return;
  const challenges = challengesData.challenges;
  const solved = currentUser.solvedChallenges || [];
  const failed = currentUser.failedChallenges || [];
  const skipped = currentUser.skippedChallenges || [];
  
  let filtered = [];
  if (activeDashboardFilter === 'osint') {
    filtered = challenges.filter(c => c.round === 1);
  } else if (activeDashboardFilter === 'web') {
    filtered = challenges.filter(c => c.round === 2);
  } else if (activeDashboardFilter === 'code') {
    filtered = getUserCodeReviewChallenges(currentUser);
  } else {
    filtered = [
      ...challenges.filter(c => c.round === 1),
      ...challenges.filter(c => c.round === 2),
      ...getUserCodeReviewChallenges(currentUser)
    ];
  }

  // Find active focus challenge
  const nextUnsolved = getNextActiveChallenge(currentUser);

  container.innerHTML = filtered.map(c => {
    const isSolved = solved.includes(c.id);
    const isFailed = failed.includes(c.id);
    const isSkipped = skipped.includes(c.id);
    const isUnlocked = isChallengeUnlocked(c);
    const isActive = nextUnsolved && nextUnsolved.id === c.id;

    if (isSolved) {
      return `
        <div class="bg-white rounded-xl border border-slate-200 p-5 shadow-xs hover:border-emerald-300 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div class="space-y-1">
            <div class="flex items-center gap-2 text-[11px] font-telemetry">
              <span class="font-bold text-slate-800">${c.id} // R${c.round}</span>
              <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                <span class="material-symbols-outlined text-xs mr-0.5">check</span>SOLVED
              </span>
            </div>
            <div class="font-headline-sm font-bold text-slate-900 text-sm">${c.name}</div>
            <div class="text-xs font-telemetry text-slate-500 line-clamp-1">${c.description.replace(/[#*`]/g, '').trim()}</div>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span class="font-telemetry text-xs font-bold text-emerald-600">+${c.points} PTS</span>
            <button onclick="renderChallenge('${c.id}')" class="px-3 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 text-xs font-telemetry font-bold rounded-lg transition-all">
              [ REVIEW AUDIT TRAIL ]
            </button>
          </div>
        </div>
      `;
    }

    if (isSkipped) {
      return `
        <div class="bg-white rounded-xl border border-amber-200 p-5 shadow-xs hover:border-amber-300 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div class="space-y-1">
            <div class="flex items-center gap-2 text-[11px] font-telemetry">
              <span class="font-bold text-slate-800">${c.id} // R${c.round}</span>
              <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
                <span class="material-symbols-outlined text-xs mr-0.5">fast_forward</span>BYPASSED (-30 PTS)
              </span>
            </div>
            <div class="font-headline-sm font-bold text-slate-900 text-sm">${c.name}</div>
            <div class="text-xs font-telemetry text-slate-500 line-clamp-1">${c.description.replace(/[#*`]/g, '').trim()}</div>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span class="font-telemetry text-xs font-bold text-amber-700">-30 PTS DEDUCTED</span>
            <button onclick="renderChallenge('${c.id}')" class="px-3 py-1.5 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-800 text-xs font-telemetry font-bold rounded-lg transition-all cursor-pointer">
              [ VIEW ARCHIVED INTEL ]
            </button>
          </div>
        </div>
      `;
    }

    if (isFailed) {
      return `
        <div class="bg-white rounded-xl border border-rose-200 p-5 shadow-xs hover:border-rose-300 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div class="space-y-1">
            <div class="flex items-center gap-2 text-[11px] font-telemetry">
              <span class="font-bold text-slate-800">${c.id} // R${c.round}</span>
              <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
                <span class="material-symbols-outlined text-xs mr-0.5">cancel</span>MISSED (0 PTS)
              </span>
            </div>
            <div class="font-headline-sm font-bold text-slate-900 text-sm">${c.name}</div>
            <div class="text-xs font-telemetry text-slate-500 line-clamp-1">${c.description.replace(/[#*`]/g, '').trim()}</div>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span class="font-telemetry text-xs font-bold text-rose-600">0 / +${c.points} PTS</span>
            <button onclick="renderChallenge('${c.id}')" class="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 text-xs font-telemetry font-bold rounded-lg transition-all">
              [ VIEW POST-MORTEM ]
            </button>
          </div>
        </div>
      `;
    }

    if (!isUnlocked) {
      return `
        <div class="bg-slate-50 rounded-xl border border-dashed border-slate-300 p-5 opacity-70 flex flex-col sm:flex-row sm:items-center justify-between gap-4 select-none">
          <div class="space-y-1">
            <div class="flex items-center gap-2 text-[11px] font-telemetry text-slate-500">
              <span>${c.id} // R${c.round}</span>
              <span class="inline-flex items-center gap-1 text-[10px] font-bold bg-slate-200/60 px-2 py-0.5 rounded text-slate-600">
                <span class="material-symbols-outlined text-xs text-rose-500">lock</span>LOCKED
              </span>
            </div>
            <div class="font-headline-sm font-bold text-slate-700 text-sm">${c.name}</div>
            <div class="text-[11px] font-telemetry text-rose-500 font-semibold">PREREQUISITE UNMET // COMPLETE PREVIOUS VECTORS</div>
          </div>
          <div class="shrink-0 font-telemetry text-xs font-bold text-slate-400">${c.points} PTS</div>
        </div>
      `;
    }

    // Active or Unlocked
    return `
      <div class="bg-white rounded-xl ${isActive ? 'border-2 border-gamer-purple shadow-md' : 'border border-slate-200 shadow-xs'} p-5 relative transition-all">
        <div class="flex items-center justify-between gap-2 mb-2">
          <div class="flex items-center gap-2 text-[11px] font-telemetry">
            <span class="font-bold ${isActive ? 'text-gamer-purple' : 'text-slate-800'}">${c.id} // R${c.round}</span>
            <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200 uppercase">${c.difficulty}</span>
            ${isActive ? `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 animate-pulse">ACTIVE OBJECTIVE</span>` : ''}
          </div>
          <span class="font-telemetry text-xs font-bold text-gamer-purple">+${c.points} PTS</span>
        </div>
        <div class="font-headline-sm font-bold text-slate-900 text-base mb-1">${c.name}</div>
        <div class="text-xs font-telemetry text-slate-600 mb-4 line-clamp-2 leading-relaxed">${c.description.replace(/[#*`]/g, '').trim()}</div>
        
        <div class="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100">
          <button onclick="renderChallenge('${c.id}')" class="px-4 py-2 bg-gradient-to-r from-gamer-purple to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white text-xs font-telemetry font-bold rounded-lg shadow-sm transition-all flex items-center gap-1.5">
            <span class="material-symbols-outlined text-xs">rocket_launch</span>
            [ LAUNCH INVESTIGATION ]
          </button>
          <div class="flex items-center gap-2">
            <input type="text" id="inline-flag-${c.id}" class="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-telemetry text-slate-900 outline-none focus:border-gamer-purple w-48" placeholder="Enter plain text answer...">
            <button onclick="submitFlag('${c.id}', 'inline-flag-${c.id}')" class="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white shadow-xs text-xs font-telemetry font-bold rounded-lg transition-all">
              VERIFY
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderDashboard(filterParam) {
  const main = $('#main-content');
  const rounds = contestData.rounds;
  const challenges = window.getUserChallenges ? window.getUserChallenges(currentUser) : challengesData.challenges;
  const solved = currentUser.solvedChallenges || [];
  const totalPts = challenges.reduce((s, c) => s + c.points, 0);
  const earnedPts = challenges.filter(c => isTargetSolved(currentUser, c)).reduce((s, c) => s + c.points, 0);
  const pct = totalPts > 0 ? Math.round(earnedPts / totalPts * 100) : 0;
  
  if (filterParam) {
    if (filterParam === '1') activeDashboardFilter = 'osint';
    else if (filterParam === '2') activeDashboardFilter = 'web';
    else if (filterParam === '3') activeDashboardFilter = 'code';
  }

  // Active Next Challenge
  const nextTarget = getNextActiveChallenge(currentUser);

  // Round solve counts and totals based on user's active challenges (13 total: 4 OSINT, 4 WEB, 5 CODE)
  const r1Solved = challenges.filter(c => c.round === 1 && isTargetSolved(currentUser, c)).length;
  const r2Solved = challenges.filter(c => c.round === 2 && isTargetSolved(currentUser, c)).length;
  const r3Solved = challenges.filter(c => c.round === 3 && isTargetSolved(currentUser, c)).length;
  const r1Total = challenges.filter(c => c.round === 1).length;
  const r2Total = challenges.filter(c => c.round === 2).length;
  const r3Total = challenges.filter(c => c.round === 3).length;

  main.innerHTML = `
    <div class="w-full bg-surface pb-16 esports-grid-pattern min-h-screen">
      <!-- Master Mission HUD Banner -->
      <div class="w-full bg-white border-b border-border-line px-6 py-5 shadow-xs relative overflow-hidden">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative z-10">
          <!-- Left Info Block -->
          <div class="space-y-1 max-w-2xl">
            <div class="flex items-center gap-2 text-xs font-telemetry text-dark-muted">
              <span class="font-bold text-dark-title">CASEFILE #001</span>
              <span>//</span>
              <span class="text-gamer-purple font-bold">ACTIVE INVESTIGATION</span>
              <span>//</span>
              <span class="inline-flex items-center gap-1 bg-slate-100 text-slate-700 px-2 py-0.5 rounded text-[10px] font-bold">
                <span class="w-1.5 h-1.5 rounded-full bg-gamer-emerald"></span>NODE: 104.28.18.2
              </span>
            </div>
            <div class="font-headline-lg text-2xl lg:text-3xl font-extrabold text-dark-title tracking-tight flex items-center gap-3">
              THE VANISHING DEVELOPER
              <span class="text-xs font-telemetry bg-amber-500 text-white font-bold px-2 py-0.5 rounded shadow-xs">TIER 1 MAJOR</span>
            </div>
            <p class="text-xs font-telemetry text-dark-body leading-relaxed">
              Target: <span class="font-bold text-dark-title">V. Raven</span>, lead cryptographic architect at Aethelis Labs. Missing since 03.14 02:00 UTC. Suspected identity leak & cryptographic backdoors planted across microservices.
            </p>
          </div>

          <!-- Telemetry HUD Metrics Deck -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 font-telemetry text-center">
            <div class="bg-slate-50 border border-border-line rounded-lg p-3">
              <div class="text-[10px] text-dark-muted font-bold uppercase">TEAM CODE</div>
              <div class="text-sm font-bold text-dark-title truncate">${currentUser.team || currentUser.username}</div>
            </div>
            <div class="bg-slate-50 border border-border-line rounded-lg p-3">
              <div class="text-[10px] text-dark-muted font-bold uppercase">TRUE SCORE</div>
              <div class="text-sm font-bold text-gamer-purple">${currentUser.score || 0} <span class="text-[10px]">PTS</span></div>
            </div>
            <div class="bg-slate-50 border border-border-line rounded-lg p-3">
              <div class="text-[10px] text-dark-muted font-bold uppercase">STANDING</div>
              <div class="text-sm font-bold text-gamer-amber">#${getTeamRank()} <span class="text-[10px]">/ 142</span></div>
            </div>
            <div class="bg-slate-50 border border-border-line rounded-lg p-3">
              <div class="text-[10px] text-dark-muted font-bold uppercase">CLEAR RATE</div>
              <div class="text-sm font-bold text-gamer-emerald">${pct}% <span class="text-[10px]">NET</span></div>
            </div>
          </div>
        </div>

        <!-- Priority Target Callout -->
        <div class="mt-4 p-3 bg-gradient-to-r from-purple-50 via-indigo-50 to-cyan-50 border border-purple-200 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <div class="p-2 rounded-lg bg-gamer-purple text-white shadow-xs">
              <span class="material-symbols-outlined text-base animate-pulse">radar</span>
            </div>
            <div class="font-telemetry text-xs">
              <div class="font-bold text-gamer-purple">PRIORITY OBJECTIVE DETECTED // ROUND ${nextTarget.round} SECTOR ${nextTarget.type.toUpperCase()}</div>
              <div class="text-slate-700">Target endpoint for <span class="font-bold text-slate-900">${nextTarget.id}: ${nextTarget.name}</span>. Ready for penetration.</div>
            </div>
          </div>
          <button onclick="renderChallenge('${nextTarget.id}')" class="px-4 py-2 bg-gamer-purple hover:bg-purple-700 text-white rounded-lg text-xs font-telemetry font-bold shadow-sm transition-all whitespace-nowrap">
            [ RESUME ACTIVE INVESTIGATION → ]
          </button>
        </div>
      </div>

      <!-- Main Container -->
      <div class="px-6 py-6 space-y-6">
        <!-- Visual Stage Progression Tracker (Gamified Progress Cards) -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <!-- Stage 1 -->
          <div onclick="filterDashboardChallenges('osint')" class="bg-white rounded-xl border border-border-line p-4 shadow-xs hover:border-gamer-cyan transition-all cursor-pointer hud-card">
            <div class="flex items-center justify-between text-xs font-telemetry mb-2">
              <span class="font-bold text-dark-muted">ROUND 01: OSINT</span>
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${r1Solved === r1Total ? 'bg-emerald-50 text-emerald-600' : 'bg-cyan-50 text-cyan-700'}">${r1Solved === r1Total ? 'CLEARED' : 'IN PROGRESS'}</span>
            </div>
            <div class="font-headline-sm font-bold text-dark-title text-sm mb-1">Cryptic Investigation</div>
            <div class="flex items-center justify-between text-xs font-telemetry text-dark-muted">
              <span>SOLVED: ${r1Solved} / ${r1Total}</span>
              <span class="font-bold text-slate-900">${challenges.filter(c => c.round === 1).reduce((s, c) => s + c.points, 0)} PTS</span>
            </div>
          </div>

          <!-- Stage 2 -->
          <div onclick="filterDashboardChallenges('web')" class="bg-white rounded-xl border border-border-line p-4 shadow-xs hover:border-gamer-purple transition-all cursor-pointer hud-card">
            <div class="flex items-center justify-between text-xs font-telemetry mb-2">
              <span class="font-bold text-dark-muted">ROUND 02: WEB CTF</span>
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${r2Solved === r2Total ? 'bg-emerald-50 text-emerald-600' : r1Solved === r1Total ? 'bg-purple-50 text-purple-700' : 'bg-slate-100 text-slate-500'}">${r2Solved === r2Total ? 'CLEARED' : r1Solved === r1Total ? 'IN PROGRESS' : 'LOCKED'}</span>
            </div>
            <div class="font-headline-sm font-bold text-dark-title text-sm mb-1">Web Application CTF</div>
            <div class="flex items-center justify-between text-xs font-telemetry text-dark-muted">
              <span>SOLVED: ${r2Solved} / ${r2Total}</span>
              <span class="font-bold text-slate-900">${challenges.filter(c => c.round === 2).reduce((s, c) => s + c.points, 0)} PTS</span>
            </div>
          </div>

          <!-- Stage 3 -->
          <div onclick="filterDashboardChallenges('code')" class="bg-white rounded-xl border border-border-line p-4 shadow-xs hover:border-gamer-purple transition-all cursor-pointer hud-card">
            <div class="flex items-center justify-between text-xs font-telemetry mb-2">
              <span class="font-bold text-dark-muted">ROUND 03: CODE</span>
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${r3Solved === r3Total ? 'bg-emerald-50 text-emerald-600' : r2Solved === r2Total ? 'bg-purple-50 text-purple-700' : 'bg-slate-100 text-slate-500'}">${r3Solved === r3Total ? 'CLEARED' : r2Solved === r2Total ? 'IN PROGRESS' : 'LOCKED'}</span>
            </div>
            <div class="font-headline-sm font-bold text-dark-title text-sm mb-1">Source Code Audit IDE</div>
            <div class="flex items-center justify-between text-xs font-telemetry text-dark-muted">
              <span>SOLVED: ${r3Solved} / ${r3Total}</span>
              <span class="font-bold text-slate-900">${challenges.filter(c => c.round === 3).reduce((s, c) => s + c.points, 0)} PTS</span>
            </div>
          </div>

          <!-- Final -->
          <div class="bg-white rounded-xl border border-border-line p-4 shadow-xs opacity-80 hud-card">
            <div class="flex items-center justify-between text-xs font-telemetry mb-2">
              <span class="font-bold text-dark-muted">FINAL OBJECTIVE</span>
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${r3Solved === r3Total ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}">${r3Solved === r3Total ? 'RECONSTRUCTED' : 'AIR GAPPED'}</span>
            </div>
            <div class="font-headline-sm font-bold text-dark-title text-sm mb-1">0xRAVEN Gateway</div>
            <div class="flex items-center justify-between text-xs font-telemetry text-dark-muted">
              <span>IDENTITY TRACED</span>
              <span class="font-bold text-gamer-emerald">FINAL FLAG</span>
            </div>
          </div>
        </div>

        <!-- Investigation Dependency & Progression Graph -->
        <div class="bg-white rounded-xl border border-border-line p-5 shadow-sm">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 bg-slate-50 p-3 rounded-lg border border-border-line">
            <div class="flex items-center gap-3">
              <div class="p-1.5 rounded bg-gamer-cyan text-white">
                <span class="material-symbols-outlined text-lg">account_tree</span>
              </div>
              <div>
                <div class="font-label-caps text-xs font-bold text-dark-title uppercase tracking-wider">TACTICAL INVESTIGATION MAP // DEPENDENCY TREE</div>
                <div class="font-telemetry text-[11px] text-dark-muted font-semibold">CRYPTOGRAPHIC PREREQUISITES & DECRYPT PATHWAYS</div>
              </div>
            </div>
            <div class="flex items-center gap-4 font-telemetry text-xs text-dark-muted">
              <div class="flex items-center gap-1.5 font-bold"><span class="w-3 h-3 rounded bg-emerald-500"></span>COMPLETED</div>
              <div class="flex items-center gap-1.5 font-bold"><span class="w-3 h-3 rounded bg-gamer-purple"></span>ACTIVE TARGET</div>
              <div class="flex items-center gap-1.5 font-bold"><span class="w-3 h-3 rounded bg-slate-300"></span>LOCKED</div>
            </div>
          </div>

          <!-- Topology Diagram Canvas -->
          <div class="relative w-full overflow-x-auto bg-gradient-to-b from-slate-50 to-slate-100/50 p-5 rounded-lg border border-slate-200">
            <div class="space-y-3 min-w-[760px]">
              <!-- Stage 1: OSINT -->
              <div class="flex items-center gap-2">
                <div class="w-32 shrink-0 font-telemetry text-[11px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full bg-cyan-500"></span> STAGE 1 (OSINT)
                </div>
                <div class="flex items-center gap-2 flex-1">
                  ${['OSINT-01', 'OSINT-02', 'OSINT-03', 'OSINT-04'].map((id, idx) => {
                    const ch = challenges.find(c => c.id === id);
                    const isSol = solved.includes(id);
                    const isAct = nextTarget && nextTarget.id === id;
                    return `
                      <div onclick="renderChallenge('${id}')" class="flex-1 min-w-[110px] rounded-lg p-2.5 ${isSol ? 'bg-white border-2 border-emerald-400' : isAct ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md ring-2 ring-purple-300' : 'bg-slate-100 border border-dashed border-slate-300'} cursor-pointer transition-all">
                        <div class="flex items-center justify-between font-telemetry text-[11px] font-bold mb-1 ${isSol ? 'text-emerald-700' : isAct ? 'text-white' : 'text-slate-500'}">
                          <span>${id}</span>
                          <span class="material-symbols-outlined text-xs">${isSol ? 'check' : isAct ? 'crisis_alert' : 'lock'}</span>
                        </div>
                        <div class="font-label-caps text-xs font-bold truncate ${isAct ? 'text-white' : 'text-slate-900'}">${ch?.name || id}</div>
                        <div class="font-telemetry text-[10px] mt-1 ${isSol ? 'text-emerald-700' : isAct ? 'text-purple-200' : 'text-slate-400'}">+${ch?.points} PTS</div>
                      </div>
                      ${idx < 3 ? `<span class="text-slate-300 font-bold">→</span>` : ''}
                    `;
                  }).join('')}
                </div>
              </div>

              <!-- Stage 2: WEB CTF -->
              <div class="flex items-center gap-2">
                <div class="w-32 shrink-0 font-telemetry text-[11px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full bg-indigo-500"></span> STAGE 2 (WEB)
                </div>
                <div class="flex items-center gap-2 flex-1">
                  ${['WEB-01', 'WEB-02', 'WEB-03', 'WEB-04'].map((id, idx) => {
                    const ch = challenges.find(c => c.id === id);
                    const isSol = solved.includes(id);
                    const isAct = nextTarget && nextTarget.id === id;
                    return `
                      <div onclick="renderChallenge('${id}')" class="flex-1 min-w-[110px] rounded-lg p-2.5 ${isSol ? 'bg-white border-2 border-emerald-400' : isAct ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md ring-2 ring-purple-300' : 'bg-slate-100 border border-dashed border-slate-300'} cursor-pointer transition-all">
                        <div class="flex items-center justify-between font-telemetry text-[11px] font-bold mb-1 ${isSol ? 'text-emerald-700' : isAct ? 'text-white' : 'text-slate-500'}">
                          <span>${id}</span>
                          <span class="material-symbols-outlined text-xs">${isSol ? 'check' : isAct ? 'crisis_alert' : 'lock'}</span>
                        </div>
                        <div class="font-label-caps text-xs font-bold truncate ${isAct ? 'text-white' : 'text-slate-900'}">${ch?.name || id}</div>
                        <div class="font-telemetry text-[10px] mt-1 ${isSol ? 'text-emerald-700' : isAct ? 'text-purple-200' : 'text-slate-400'}">+${ch?.points} PTS</div>
                      </div>
                      ${idx < 3 ? `<span class="text-slate-300 font-bold">→</span>` : ''}
                    `;
                  }).join('')}
                </div>
              </div>

              <!-- Stage 3: CODE REVIEW -->
              <div class="flex items-center gap-2">
                <div class="w-32 shrink-0 font-telemetry text-[11px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full bg-purple-500"></span> STAGE 3 (CODE)
                </div>
                <div class="flex items-center gap-2 flex-1">
                  ${challenges.filter(c => c.round === 3).map((ch, idx, arr) => {
                    const id = ch.id;
                    const isSol = solved.includes(id);
                    const isFail = (currentUser.failedChallenges || []).includes(id);
                    const isAct = nextTarget && nextTarget.id === id;
                    return `
                      <div onclick="renderChallenge('${id}')" class="flex-1 min-w-[95px] rounded-lg p-2.5 ${isSol ? 'bg-white border-2 border-emerald-400' : isFail ? 'bg-white border-2 border-rose-400' : isAct ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md ring-2 ring-purple-300' : 'bg-slate-100 border border-dashed border-slate-300'} cursor-pointer transition-all">
                        <div class="flex items-center justify-between font-telemetry text-[11px] font-bold mb-1 ${isSol ? 'text-emerald-700' : isFail ? 'text-rose-600' : isAct ? 'text-white' : 'text-slate-500'}">
                          <span>${id}</span>
                          <span class="material-symbols-outlined text-xs">${isSol ? 'check' : isFail ? 'cancel' : isAct ? 'crisis_alert' : 'lock'}</span>
                        </div>
                        <div class="font-label-caps text-xs font-bold truncate ${isAct ? 'text-white' : 'text-slate-900'}">${ch?.name || id}</div>
                        <div class="font-telemetry text-[10px] mt-1 ${isSol ? 'text-emerald-700' : isFail ? 'text-rose-600 font-bold' : isAct ? 'text-purple-200' : 'text-slate-400'}">${isFail ? 'MISSED (0 PTS)' : `+${ch?.points} PTS`}</div>
                      </div>
                      ${idx < arr.length - 1 ? `<span class="text-slate-300 font-bold">→</span>` : ''}
                    `;
                  }).join('')}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Active Workbench Split: Challenges Grid (Left 66%) + Intel Stream (Right 34%) -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <!-- Left Column -->
          <div class="lg:col-span-8 space-y-4">
            <div class="flex items-center justify-between gap-3 bg-white p-3 rounded-xl border border-border-line">
              <div class="flex items-center gap-1.5 overflow-x-auto" id="challenge-filter-group">
                <button data-filter="all" onclick="filterDashboardChallenges('all')" class="px-3 py-1.5 rounded-lg text-xs font-telemetry font-bold transition-all bg-gamer-purple text-white shadow-xs">ALL (${challenges.length})</button>
                <button data-filter="osint" onclick="filterDashboardChallenges('osint')" class="px-3 py-1.5 rounded-lg text-xs font-telemetry font-bold transition-all bg-white hover:bg-slate-50 text-dark-muted border border-border-line">OSINT (${r1Total})</button>
                <button data-filter="web" onclick="filterDashboardChallenges('web')" class="px-3 py-1.5 rounded-lg text-xs font-telemetry font-bold transition-all bg-white hover:bg-slate-50 text-dark-muted border border-border-line">WEB CTF (${r2Total})</button>
                <button data-filter="code" onclick="filterDashboardChallenges('code')" class="px-3 py-1.5 rounded-lg text-xs font-telemetry font-bold transition-all bg-white hover:bg-slate-50 text-dark-muted border border-border-line">CODE REVIEW (${r3Total})</button>
              </div>
              <span class="text-xs font-telemetry text-dark-muted hidden sm:inline">SECTOR FILTERS</span>
            </div>

            <div class="space-y-4" id="challenge-list-container"></div>
          </div>

          <!-- Right Column -->
          <div class="lg:col-span-4 space-y-5">
            <!-- Intel Feed -->
            <div class="bg-white rounded-xl border border-border-line p-4 shadow-xs">
              <div class="flex items-center justify-between pb-3 border-b border-border-line mb-3">
                <div class="flex items-center gap-2">
                  <span class="material-symbols-outlined text-gamer-cyan text-sm">stream</span>
                  <span class="font-headline-sm font-bold text-dark-title text-xs">INTEL FEED // LIVE AUDIT</span>
                </div>
                <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-telemetry bg-emerald-50 text-emerald-700 font-bold border border-emerald-200">ACTIVE</span>
              </div>
              <div class="space-y-3 font-telemetry text-xs">
                <div class="p-2 rounded bg-slate-50 border border-slate-100">
                  <div class="flex justify-between text-[10px] text-slate-400"><span>JUST NOW</span><span class="text-emerald-600 font-bold">+25 PTS</span></div>
                  <div class="text-slate-800 font-semibold mt-0.5">Operative entered Operation 0xRAVEN session.</div>
                </div>
                <div class="p-2 rounded bg-slate-50 border border-slate-100">
                  <div class="flex justify-between text-[10px] text-slate-400"><span>12M AGO</span><span class="text-gamer-purple font-bold">DISCOVERY</span></div>
                  <div class="text-slate-800 font-semibold mt-0.5">Arena target online: <span class="text-gamer-cyan">target_app.html</span></div>
                </div>
                <div class="p-2 rounded bg-slate-50 border border-slate-100">
                  <div class="flex justify-between text-[10px] text-slate-400"><span>34M AGO</span><span class="text-gamer-cyan font-bold">TELEMETRY</span></div>
                  <div class="text-slate-800 font-semibold mt-0.5">Encrypted PGP broadcast logged from 0xRAVEN.</div>
                </div>
              </div>
            </div>

            <!-- Person of Interest Dossier Card -->
            <div class="bg-white rounded-xl border border-border-line p-4 shadow-xs relative hud-card">
              <div class="flex items-center justify-between pb-3 border-b border-border-line mb-3">
                <div class="flex items-center gap-2">
                  <span class="material-symbols-outlined text-gamer-purple text-sm">badge</span>
                  <span class="font-headline-sm font-bold text-dark-title text-xs">PERSON OF INTEREST // 0xRAVEN</span>
                </div>
                <span class="px-1.5 py-0.5 rounded text-[10px] font-telemetry bg-purple-50 text-purple-700 font-bold border border-purple-200">PRIORITY ALPHA</span>
              </div>
              <div class="flex items-center gap-3 mb-3">
                <img src="assets/raven_avatar.png" alt="0xRAVEN" class="w-14 h-14 rounded-lg object-cover border-2 border-gamer-purple shadow-sm" onerror="this.src='logo.jpeg'">
                <div>
                  <div class="font-headline-sm font-bold text-sm text-dark-title">Vanya Reyken</div>
                  <div class="text-[11px] font-telemetry text-gamer-purple font-semibold">0xRAVEN · LEAD ARCHITECT</div>
                  <div class="text-[10px] font-telemetry text-slate-400">LAST SEEN: 3 DAYS AGO</div>
                </div>
              </div>
              <div class="space-y-1.5 font-telemetry text-[11px] border-t border-slate-100 pt-3 text-slate-700">
                <div class="flex justify-between"><span class="text-slate-400">KNOWN ALIASES:</span><span class="font-bold text-slate-900">nullbyte_47, r4ven_sec</span></div>
                <div class="flex justify-between"><span class="text-slate-400">REPO COMMITS:</span><span class="font-bold text-slate-900">1,496 across 34 repos</span></div>
                <div class="flex justify-between"><span class="text-slate-400">ENCRYPTION:</span><span class="font-bold text-gamer-purple">OpenPGP 4096 / Ed25519</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  renderChallengeMosaic();

  const completedRound = getCompletedRound();
  if (completedRound > 0 && completedRound < 3) {
    Mascot.react('smug', `Round ${completedRound} complete. 0xRAVEN's trail goes deeper.`);
  } else if (solved.length === 0) {
    Mascot.react('idle', 'Start with OSINT-01. Decode the hex message.');
  } else {
    Mascot.react('idle', `${solved.length} challenges solved. Keep going.`);
  }
}

function getCurrentRound() {
  const r1 = challengesData.challenges.filter(c => c.round === 1).map(c => c.id);
  const r2 = challengesData.challenges.filter(c => c.round === 2).map(c => c.id);
  if (!r1.every(id => isTargetCleared(id))) return 1;
  if (!r2.every(id => isTargetCleared(id))) return 2;
  return 3;
}

function getCompletedRound() {
  const r1 = challengesData.challenges.filter(c => c.round === 1).map(c => c.id);
  const r2 = challengesData.challenges.filter(c => c.round === 2).map(c => c.id);
  const r3 = getUserCodeReviewChallenges(currentUser, 5).map(c => c.id);
  let count = 0;
  if (r1.every(id => isTargetCleared(id))) count = 1;
  if (count === 1 && r2.every(id => isTargetCleared(id))) count = 2;
  if (count === 2 && r3.length > 0 && r3.every(id => isTargetCleared(id))) count = 3;
  return count;
}

function getTeamRank() {
  const users = Store.get('users', getDefaultUsers());
  const sorted = users.filter(u => u.role !== 'admin').sort((a, b) => (b.score || 0) - (a.score || 0));
  const idx = sorted.findIndex(u => u.id === currentUser.id);
  return idx >= 0 ? idx + 1 : 1;
}

let _activeBaffleInstances = [];

window.triggerQuestionGlitchReveal = (selector = '#main-content .text__glitch', baseDuration = 350) => {
  if (typeof window.baffle !== 'function') return;
  requestAnimationFrame(() => {
    try {
      if (_activeBaffleInstances && _activeBaffleInstances.length) {
        _activeBaffleInstances.forEach(b => {
          try { b.stop(); } catch {}
        });
      }
      _activeBaffleInstances = [];

      const els = Array.from(document.querySelectorAll(selector));
      if (!els.length) return;

      // Detect active page-revealing scan line and its movement direction
      const wipeLine = document.getElementById('pt-wipe-line');
      const dir = wipeLine?.dataset?.dir || 'down';
      const vpHeight = window.innerHeight || 800;
      const vpWidth = window.innerWidth || 1200;

      els.forEach(el => {
        const b = window.baffle(el);
        b.set({
          characters: "█▓█ ▒░/▒░ █░▒▓/ █▒▒ ▓▒▓/█ ░█▒/ ▒▓░ █<░▒ ▓/░>",
          speed: 35
        });
        b.start();

        // Calculate progress along the wipe trajectory so each text reveals exactly as the line sweeps over it
        let progress = 0;
        const rect = el.getBoundingClientRect();
        if (dir === 'down') {
          progress = Math.min(1, Math.max(0, rect.top / vpHeight));
        } else if (dir === 'up') {
          progress = Math.min(1, Math.max(0, (vpHeight - rect.bottom) / vpHeight));
        } else if (dir === 'right') {
          progress = Math.min(1, Math.max(0, rect.left / vpWidth));
        } else if (dir === 'left') {
          progress = Math.min(1, Math.max(0, (vpWidth - rect.right) / vpWidth));
        }

        // The page revealing scan line runs for 680ms; calculate precise line arrival time for this element
        const lineArrivalDelay = el.offsetParent === null ? 0 : Math.round(progress * 520);

        b.reveal(baseDuration, lineArrivalDelay);
        _activeBaffleInstances.push(b);
      });
    } catch (err) {
      console.warn('[Baffle] Glitch reveal failed:', err);
    }
  });
};

window.renderChallenge = (id) => {
  if (window._solveTransitionTimer) {
    clearTimeout(window._solveTransitionTimer);
    window._solveTransitionTimer = null;
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  const challenge = getChallengeById(id, currentUser);
  if (!challenge) { showMissionBriefing(); return; }
  const main = $('#main-content');
  PageTransition.wipe(() => _doRenderChallenge(id));
};

function _doRenderChallenge(id) {
  const challenge = getChallengeById(id, currentUser);
  if (!challenge) { showMissionBriefing(); return; }
  currentChallenge = challenge;
  updateMissionHud();
  currentChallenge = challenge;
  const solved = currentUser.solvedChallenges || [];
  const failed = currentUser.failedChallenges || [];
  const skipped = currentUser.skippedChallenges || [];
  const isSolved = solved.includes(challenge.id);
  const isFailed = failed.includes(challenge.id);
  const isSkipped = skipped.includes(challenge.id);

  // Track which challenge the user is currently viewing (for admin monitor)
  if (currentUser?.id) {
    const users = Store.get('users', getDefaultUsers());
    const me = users.find(u => u.id === currentUser.id);
    if (me) { me.currentChallenge = challenge.id; Store.set('users', users); }
  }

  if (challenge.round === 1) {
    renderOsintChallenge(challenge, isSolved, isSkipped);
  } else if (challenge.round === 2) {
    renderWebCtfChallenge(challenge, isSolved, isSkipped);
  } else {
    renderCodeReviewChallenge(challenge, isSolved, isFailed, isSkipped);
  }

  // Mascot briefing
  briefChallengeToUser(challenge, isSolved);

  // Text revealing animation for question changing synchronized with page revealing line animation
  triggerQuestionGlitchReveal('#main-content .text__glitch', 350);
};


/* ── Round 1: OSINT Evidence Dossier ────────────────────────── */
window.switchEvidenceTab = (tabId) => {
  document.querySelectorAll('.evidence-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('#evidence-tabs button').forEach(b => {
    b.className = b.id === 'tab-btn-' + tabId
      ? 'px-3 py-2 bg-gamer-cyan text-white text-xs font-telemetry font-bold rounded shadow-xs'
      : 'px-3 py-2 bg-slate-50 hover:bg-white text-slate-600 border border-slate-200 text-xs font-telemetry font-bold rounded';
  });
  const target = $('#tab-' + tabId);
  if (target) target.classList.remove('hidden');
};

window.copyHexBytes = (str) => {
  navigator.clipboard.writeText(str || '4E 6F 74 68 69 6E 67 20 69 73 20 68 69 64 64 65 6E');
  toast('Hex Copied', 'Hexadecimal sequence copied to clipboard', 'info', 2000);
};

function formatInterceptedPayloadStream(rawText, challengeId = 'OSINT-01') {
  if (!rawText) return '';

  const toolMap = {
    'OSINT-01': { id: 'hex', name: 'HEX DECODER' },
    'OSINT-02': { id: 'base64', name: 'BASE64 DECODER' },
    'OSINT-03': { id: 'rot13', name: 'ROT13 CIPHER' },
    'OSINT-04': { id: 'morse', name: 'MORSE DECODER' }
  };
  const toolInfo = toolMap[challengeId] || { id: 'terminal', name: 'FORENSIC TOOLKIT' };

  // Match code blocks: ```...```
  const match = rawText.match(/```(?:\w+)?\n?([\s\S]*?)```/);
  if (match) {
    const code = match[1].trim();
    const parts = rawText.split(match[0]);
    const before = parts[0].trim();
    const after = parts[1] ? parts[1].trim() : '';

    return `
      <div class="space-y-3 font-sans">
        ${before ? `<div class="text-slate-200 text-xs sm:text-[13px] leading-relaxed break-words whitespace-pre-line">${escapeHtml(before)}</div>` : ''}
        
        <div class="bg-[#070b14] border border-purple-800/80 rounded-xl p-3.5 shadow-inner">
          <div class="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400 font-mono font-bold pb-2 mb-2.5 border-b border-slate-800/80">
            <span class="flex items-center gap-1.5 text-purple-400">
              <span class="material-symbols-outlined text-xs">data_object</span>
              <span>INTERCEPTED STREAM DATA // OCTETS</span>
            </span>
            <div class="flex items-center gap-1.5 shrink-0">
              <button onclick="navigator.clipboard.writeText('${escapeHtml(code).replace(/'/g, "\\'")}'); if (window.toast) toast('Copied', 'Payload copied to clipboard', 'success');" class="px-2.5 py-1 bg-purple-900/60 hover:bg-purple-700 text-purple-200 hover:text-white rounded text-[10px] font-bold transition-colors border border-purple-700 cursor-pointer flex items-center gap-1 shadow-2xs">
                <span class="material-symbols-outlined text-xs">content_copy</span>
                <span>COPY PAYLOAD</span>
              </button>
              <button onclick="window.openCyberTerminalWithTool('${toolInfo.id}')" class="px-2.5 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded text-[10px] font-bold transition-colors shadow-xs cursor-pointer flex items-center gap-1">
                <span class="material-symbols-outlined text-xs">terminal</span>
                <span>${toolInfo.name}</span>
              </button>
            </div>
          </div>
          <div class="text-purple-200 font-mono text-xs sm:text-sm font-bold tracking-wider break-all whitespace-pre-wrap select-all bg-[#0b0f19] p-3 rounded-lg border border-slate-800">
            ${escapeHtml(code)}
          </div>
        </div>

        ${after ? `<div class="text-slate-200 text-xs sm:text-[13px] leading-relaxed break-words whitespace-pre-line">${escapeHtml(after)}</div>` : ''}
      </div>
    `;
  }

  // Fallback if no code block
  return `
    <div class="text-slate-200 font-sans text-xs sm:text-[13px] leading-relaxed break-words whitespace-pre-line select-text">
      ${escapeHtml(rawText)}
    </div>
  `;
}

function renderOsintChallenge(challenge, isSolved, isSkipped = false) {
  const main = $('#main-content');
  const nextChal = getNextActiveChallenge(currentUser);
  const userFlag = getUserChallengeFlag(challenge.id, currentUser);
  const flagBytes = Array.from(userFlag).map(c => c.charCodeAt(0));
  const hexStr = flagBytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

  const hexLines = [];
  for (let i = 0; i < flagBytes.length; i += 16) {
    const chunk = flagBytes.slice(i, i + 16);
    const offset = i.toString(16).toUpperCase().padStart(8, '0');
    const hexPart = chunk.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ').padEnd(48, ' ');
    const asciiPart = chunk.map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
    hexLines.push(`<div>${offset}  ${hexPart}  |${asciiPart}|</div>`);
  }
  const hexDumpHtml = hexLines.join('\n');

  main.innerHTML = `
    <div class="w-full bg-surface esports-grid-pattern min-h-screen pb-16">
      <!-- Top Case Header Panel -->
      <div class="bg-white border-b border-border-line px-6 py-5 shadow-xs relative">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div class="space-y-1">
            <div class="flex items-center gap-2 text-xs font-telemetry text-dark-muted">
              <button onclick="navigate('dashboard')" class="text-gamer-purple font-bold hover:underline flex items-center gap-1">
                <span class="material-symbols-outlined text-xs">arrow_back</span>
                DOSSIER CATALOG
              </button>
              <span>//</span>
              <span class="font-bold text-dark-title text__glitch">CASE FILE #00${challenge.order} // EVIDENCE DOSSIER</span>
              <span>//</span>
              <span class="text-gamer-cyan font-semibold text__glitch">INCIDENT REF: DOC-2026-00${challenge.order}</span>
            </div>
            <div class="font-headline-lg text-2xl lg:text-3xl font-extrabold text-dark-title tracking-tight flex items-center flex-wrap gap-3">
              <h3 class="text__glitch font-headline-lg text-2xl lg:text-3xl font-extrabold text-dark-title tracking-tight m-0 p-0">${challenge.id}: ${challenge.name.toUpperCase()}</h3>
              <span class="text-xs font-telemetry bg-gamer-cyan text-white font-bold px-2.5 py-0.5 rounded shadow-xs uppercase">${challenge.difficulty}</span>
              ${isSolved ? '<span class="text-xs font-telemetry bg-gamer-emerald text-white font-bold px-2.5 py-0.5 rounded shadow-xs">SOLVED ✓</span>' : isSkipped ? '<span class="text-xs font-telemetry bg-amber-600 text-white font-bold px-2.5 py-0.5 rounded shadow-xs">BYPASSED (-30 PTS)</span>' : ''}
            </div>
            <p class="text-xs font-telemetry text-slate-600 leading-relaxed max-w-3xl text__glitch">
              Objective: ${challenge.description.replace(/[#*`]/g, '').trim()}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-xs font-telemetry shrink-0">
            ${(isSolved || isSkipped) && nextChal ? `
              <button onclick="renderChallenge('${nextChal.id}')" class="px-4 py-2 bg-gradient-to-r from-gamer-purple to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-telemetry font-bold text-xs rounded-lg shadow-sm transition-all flex items-center gap-1.5 cursor-pointer transform active:scale-95">
                <span class="material-symbols-outlined text-sm">arrow_forward</span>
                PROCEED TO NEXT TARGET [${nextChal.id}]
              </button>
            ` : ''}
            ${!isSolved && !isSkipped ? `
              <button onclick="confirmSkipChallenge('${challenge.id}')" class="px-3 py-2 bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-800 text-xs font-telemetry font-bold rounded-lg transition-all flex items-center gap-1.5 shadow-xs cursor-pointer active:scale-95" title="Skip this challenge by spending 30 points">
                <span class="material-symbols-outlined text-sm text-amber-600">fast_forward</span>
                <span>SKIP TARGET (-30 PTS) &bull; ${Math.max(0, 3 - (currentUser.skipsUsed || 0))}/3 LEFT</span>
              </button>
            ` : ''}
            <div class="bg-slate-50 border border-slate-200 px-3 py-2 rounded-lg text-center">
              <div class="text-[10px] text-slate-400 font-bold">BOUNTY VALUE</div>
              <div class="font-bold text-gamer-purple">+${challenge.points} PTS</div>
            </div>
            <div class="bg-slate-50 border border-slate-200 px-3 py-2 rounded-lg text-center">
              <div class="text-[10px] text-slate-400 font-bold">STATUS</div>
              <div class="font-bold ${isSolved ? 'text-gamer-emerald' : isSkipped ? 'text-amber-700' : 'text-amber-600'}">${isSolved ? 'CAPTURED' : isSkipped ? 'BYPASSED (-30 PTS)' : 'IN PROGRESS'}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Main 3-Pane Workspace -->
      <div class="max-w-6xl mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- Left & Center: Evidence Artifact Workbench (8 cols) -->
        <div class="lg:col-span-8 space-y-6">
          <div class="bg-white rounded-xl border border-border-line p-5 shadow-xs hud-card">
            <div class="flex items-center justify-between pb-3 border-b border-border-line">
              <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-gamer-cyan text-base">folder_open</span>
                <span class="font-headline-sm font-bold text-dark-title text-xs text__glitch">EVIDENCE WORKSPACE // 4 ARTIFACTS RECOVERED</span>
              </div>
              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-telemetry bg-emerald-50 text-emerald-700 font-bold border border-emerald-200">REALTIME</span>
            </div>

            <!-- Evidence Tabs Navigation -->
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4" id="evidence-tabs">
              <button id="tab-btn-metadata" onclick="switchEvidenceTab('metadata')" class="px-2 sm:px-3 py-2 bg-gamer-cyan text-white text-[11px] sm:text-xs font-mono font-bold rounded shadow-xs truncate"><span class="hidden sm:inline">EVIDENCE 01: </span>METADATA</button>
              <button id="tab-btn-hex" onclick="switchEvidenceTab('hex')" class="px-2 sm:px-3 py-2 bg-slate-50 hover:bg-white text-slate-600 border border-slate-200 text-[11px] sm:text-xs font-mono font-bold rounded truncate"><span class="hidden sm:inline">EVIDENCE 02: </span>HEX DUMP</button>
              <button id="tab-btn-communique" onclick="switchEvidenceTab('communique')" class="px-2 sm:px-3 py-2 bg-slate-50 hover:bg-white text-slate-600 border border-slate-200 text-[11px] sm:text-xs font-mono font-bold rounded truncate"><span class="hidden sm:inline">EVIDENCE 03: </span>COMMUNIQUE</button>
              <button id="tab-btn-attachment" onclick="switchEvidenceTab('attachment')" class="px-2 sm:px-3 py-2 bg-slate-50 hover:bg-white text-slate-600 border border-slate-200 text-[11px] sm:text-xs font-mono font-bold rounded truncate"><span class="hidden sm:inline">EVIDENCE 04: </span>ARCHIVE</button>
            </div>

            <!-- Tab Content -->
            <div class="mt-4">
              <!-- Tab 1: Metadata -->
              <div class="evidence-panel flex flex-col gap-3 font-telemetry text-xs" id="tab-metadata">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200 text-[11px] overflow-hidden break-words">
                  <div class="break-words"><span class="text-slate-400">RECORDED:</span> <span class="font-bold text-slate-800">2026-10-14 03:12:04 UTC</span></div>
                  <div class="break-words"><span class="text-slate-400">PGP KEY:</span> <span class="font-bold text-gamer-purple break-all">0x9E845DF1 [ED25519-GIT]</span></div>
                  <div class="break-words"><span class="text-slate-400">OPERATOR:</span> <span class="font-bold text-slate-800 break-all">0xRAVEN &lt;nullbyte_47@void-corp&gt;</span></div>
                  <div class="break-words"><span class="text-slate-400">FORENSIC ANOMALY:</span> <span class="font-bold text-rose-600 block sm:inline break-words">Dispersed commit signature detected</span></div>
                </div>
                <!-- Intercepted Payload Stream (High-Contrast Cyber Dark Terminal with Word-Wrap) -->
                <div class="bg-[#0b0f19] border border-slate-800 rounded-xl p-4 sm:p-5 shadow-lg space-y-3 font-mono text-xs">
                  <div class="flex items-center justify-between pb-2 mb-2 border-b border-slate-800/90">
                    <div class="flex items-center gap-2 text-emerald-400 font-bold font-mono text-xs tracking-wider">
                      <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                      <span class="material-symbols-outlined text-sm">terminal</span>
                      <span>// INTERCEPTED PAYLOAD STREAM</span>
                    </div>
                    <span class="text-[10px] font-mono font-bold bg-purple-950/80 text-purple-300 border border-purple-800 px-2.5 py-0.5 rounded-full">RAW TELEMETRY</span>
                  </div>
                  <div class="mt-1">
                    ${formatInterceptedPayloadStream(challenge.description, challenge.id)}
                  </div>
                </div>
              </div>

              <!-- Tab 2: Hex Dump -->
              <div class="evidence-panel hidden flex flex-col gap-3 font-telemetry text-xs" id="tab-hex">
                <div class="flex items-center justify-between">
                  <span class="text-slate-500 font-bold text-[11px]">BYTE OFFSET // HEX OCTETS // RAW STREAM</span>
                  <div class="flex items-center gap-2">
                    <button onclick="window.toggleCyberTerminal()" class="px-3 py-1 bg-slate-900 hover:bg-slate-800 text-emerald-400 text-xs font-mono font-bold rounded flex items-center gap-1 shadow-xs transition-all cursor-pointer" title="Open interactive cyber forensic terminal">
                      <span class="material-symbols-outlined text-xs">terminal</span>OPEN TERMINAL
                    </button>
                    <button onclick="copyHexBytes('${hexStr}')" class="px-3 py-1 bg-white hover:bg-cyan-50 border border-slate-300 hover:border-cyan-400 text-slate-700 text-xs font-bold rounded flex items-center gap-1 shadow-xs transition-all cursor-pointer">
                      <span class="material-symbols-outlined text-xs">content_copy</span>COPY HEX
                    </button>
                  </div>
                </div>
                <div class="bg-slate-100 border border-slate-300 text-slate-800 p-4 rounded-lg font-mono text-xs overflow-x-auto space-y-1">
                  ${hexDumpHtml}
                </div>
              </div>

              <!-- Tab 3: Communique -->
              <div class="evidence-panel hidden flex flex-col gap-3 font-telemetry text-xs" id="tab-communique">
                <div class="p-4 bg-purple-50 border border-purple-200 rounded-lg text-slate-800 space-y-2">
                  <div class="font-bold text-gamer-purple">// UNDERGROUND CYBERNETIC BROADCAST TRANSCRIPT</div>
                  <blockquote class="italic text-slate-700 border-l-2 border-gamer-purple pl-3 my-2">
                    "I left the door open. But you need to know where to look."
                  </blockquote>
                  <div class="text-[10px] text-slate-500">— Signed: 0xRAVEN (PGP FP: B49D F012 8A3C)</div>
                </div>
              </div>

              <!-- Tab 4: Attachment -->
              <div class="evidence-panel hidden flex flex-col gap-3 font-telemetry text-xs" id="tab-attachment">
                <div class="p-4 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <span class="material-symbols-outlined text-2xl text-slate-600">archive</span>
                    <div>
                      <div class="font-bold text-slate-800">evidence_vault_${challenge.id.toLowerCase()}.bin</div>
                      <div class="text-[10px] text-slate-500">SHA256: e8d4fc0198b50e2ddc9943efb3870526</div>
                    </div>
                  </div>
                  <button onclick="toast('Artifact Verified', 'Forensic hash verified in match database.', 'info', 2000)" class="px-3 py-1.5 bg-purple-600 text-white rounded text-xs font-bold hover:bg-purple-700">
                    VERIFY HASH
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Flag Submission Station -->
          <div class="bg-white rounded-xl border border-border-line p-5 shadow-xs hud-card">
            <div class="flex items-center justify-between pb-3 border-b border-border-line mb-4">
              <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-gamer-emerald text-base">flag</span>
                <span class="font-headline-sm font-bold text-dark-title text-xs text__glitch">ANSWER SUBMISSION STATION</span>
              </div>
              <span class="text-[11px] font-telemetry text-slate-400 text__glitch">SECRET ANSWER (PLAIN TEXT)</span>
            </div>

            <div class="space-y-3 font-telemetry">
              ${isSolved ? `
                <div class="p-4 bg-emerald-50 border-2 border-emerald-300 rounded-xl space-y-3">
                  <div class="flex items-center gap-2 text-emerald-800 font-bold text-xs font-telemetry">
                    <span class="material-symbols-outlined text-emerald-600 text-base">check_circle</span>
                    <span>OBJECTIVE CLEARED (+${challenge.points} PTS) &mdash; Cryptographic footprint captured!</span>
                  </div>
                  ${nextChal ? `
                    <button onclick="renderChallenge('${nextChal.id}')" class="w-full py-3 bg-gradient-to-r from-gamer-emerald to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-bold text-xs rounded-lg shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer font-telemetry transform active:scale-[0.98]">
                      <span>PROCEED TO NEXT TARGET [${nextChal.id}: ${nextChal.name}]</span>
                      <span class="material-symbols-outlined text-sm">arrow_forward</span>
                    </button>
                  ` : `
                    <button onclick="navigate('dashboard')" class="w-full py-3 bg-gamer-purple hover:bg-purple-700 text-white font-bold text-xs rounded-lg shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer font-telemetry">
                      <span>ALL OBJECTIVES COMPLETE &mdash; RETURN TO MISSION CONTROL</span>
                    </button>
                  `}
                </div>
              ` : isSkipped ? `
                <div class="p-4 bg-amber-50 border-2 border-amber-300 rounded-xl space-y-3">
                  <div class="flex items-center justify-between text-xs font-mono text-amber-800 font-bold">
                    <div class="flex items-center gap-2">
                      <span class="material-symbols-outlined text-sm text-amber-600">fast_forward</span>
                      <span>TARGET BYPASSED (-30 PTS) &mdash; Objective skipped using tactical bypass.</span>
                    </div>
                    <span class="text-[10px] bg-amber-200 text-amber-900 px-2 py-0.5 rounded font-extrabold">SKIPPED</span>
                  </div>
                  ${nextChal ? `
                    <button onclick="renderChallenge('${nextChal.id}')" class="w-full py-3 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700 text-white font-bold text-xs rounded-lg shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer font-telemetry transform active:scale-[0.98]">
                      <span>PROCEED TO NEXT TARGET [${nextChal.id}: ${nextChal.name}]</span>
                      <span class="material-symbols-outlined text-sm">arrow_forward</span>
                    </button>
                  ` : ''}
                </div>
              ` : `
                <div class="flex flex-col sm:flex-row items-stretch gap-2">
                  <div class="flex-1 flex items-center bg-slate-50 border-2 border-slate-200 rounded-lg px-3 focus-within:border-gamer-cyan focus-within:bg-white transition-all">
                    <span class="text-gamer-cyan font-bold mr-2 text-xs">&gt; submit-flag -k</span>
                    <input type="text" id="osint-flag-input" onkeydown="if(event.key==='Enter') submitFlag('${challenge.id}', 'osint-flag-input')" class="w-full bg-transparent py-2.5 text-xs text-slate-900 font-bold outline-none" placeholder="Type your plain text answer here...">
                  </div>
                  <button onclick="submitFlag('${challenge.id}', 'osint-flag-input')" class="px-6 py-2.5 bg-gamer-emerald hover:bg-emerald-600 text-white font-bold text-xs rounded-lg shadow-sm transition-all whitespace-nowrap cursor-pointer transform active:scale-[0.98]">
                    [ VERIFY & SUBMIT ANSWER ]
                  </button>
                </div>
              `}
              <div id="flag-feedback-status" class="text-xs pt-1"></div>
            </div>
          </div>
        </div>

        <!-- Right Column: Intel & Hint Decryptor (4 cols) -->
        <div class="lg:col-span-4 space-y-5">
          <!-- Hints Card -->
          <div class="bg-white rounded-xl border border-border-line p-4 shadow-xs">
            <div class="flex items-center justify-between pb-3 border-b border-border-line mb-3">
              <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-amber-500 text-sm">lightbulb</span>
                <span class="font-headline-sm font-bold text-dark-title text-xs">DECRYPTION HINTS</span>
              </div>
              <span class="text-[10px] font-telemetry text-rose-500 font-bold">PENALTY ACTIVE</span>
            </div>
            <div class="space-y-3 font-telemetry text-xs" id="hints-container-${challenge.id}">
              ${challenge.hints && challenge.hints.length > 0 ? challenge.hints.map((h, i) => {
                const unlocked = (currentUser.revealedHints || []).includes(h.id) || (currentUser.unlockedHints || []).includes(h.id);
                return `
                  <div class="p-3 rounded-lg ${unlocked ? 'bg-emerald-50 border border-emerald-300' : 'bg-slate-50 border border-slate-200'}" id="hint-box-${h.id}">
                    <div class="flex justify-between text-[11px] font-bold mb-1">
                      <span class="${unlocked ? 'text-emerald-700' : 'text-slate-700'}">HINT 0${i+1}</span>
                      <span class="${unlocked ? 'text-emerald-600 font-extrabold' : 'text-rose-500'}">${unlocked ? '✓ UNLOCKED' : '-' + h.cost + ' PTS'}</span>
                    </div>
                    ${unlocked ? `
                      <p class="text-slate-800 text-[11px] font-sans font-medium bg-white/90 p-2.5 rounded border border-emerald-200 mt-1 leading-relaxed whitespace-pre-line">${escapeHtml(h.text)}</p>
                    ` : `
                      <button onclick="revealHint('${challenge.id}', '${h.id}')" class="w-full mt-1.5 py-1.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-bold rounded text-[11px] transition-all cursor-pointer shadow-xs">
                        REVEAL HINT (-${h.cost} PTS)
                      </button>
                    `}
                  </div>
                `;
              }).join('') : '<div class="text-slate-400">No tactical hints available for this vector.</div>'}
            </div>
          </div>

          <!-- Subject Dossier Card -->
          <div class="bg-white rounded-xl border border-border-line p-4 shadow-xs hud-card">
            <div class="flex items-center justify-between pb-3 border-b border-border-line mb-3">
              <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-gamer-purple text-sm">fingerprint</span>
                <span class="font-headline-sm font-bold text-dark-title text-xs">SUBJECT DOSSIER // 0xRAVEN</span>
              </div>
              <span class="text-[10px] font-telemetry text-gamer-purple font-bold">TARGET DATA</span>
            </div>
            <img src="assets/raven_avatar.png" alt="0xRAVEN" class="w-full h-36 rounded-lg object-cover border border-slate-200 mb-3" onerror="this.src='logo.jpeg'">
            <div class="space-y-1.5 font-telemetry text-[11px] text-slate-700">
              <div class="flex justify-between"><span class="text-slate-400">PRIMARY AFFIL:</span> <span class="font-bold text-slate-900">Core Infrastructure</span></div>
              <div class="flex justify-between"><span class="text-slate-400">KNOWN ALIASES:</span> <span class="font-bold text-gamer-purple">v_archRaven, oxrvn_0x</span></div>
              <div class="flex justify-between"><span class="text-slate-400">COMMITS ACTIVE:</span> <span class="font-bold text-slate-900">14 OCT 2026</span></div>
              <div class="flex justify-between"><span class="text-slate-400">ENCRYPTION:</span> <span class="font-bold text-slate-900">OpenPGP 4096 / Ed25519</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}


/* ── Round 2: Web CTF Target Console ───────────────────────── */
function formatWebChallengeMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/^### (.*$)/gim, '<h4 class="font-headline-sm font-bold text-slate-800 text-xs mt-4 mb-2 flex items-center gap-1.5 text-gamer-purple"><span class="material-symbols-outlined text-xs">terminal</span><span class="text__glitch">$1</span></h4>')
    .replace(/^## (.*$)/gim, '<h3 class="font-headline-sm font-bold text-slate-900 text-sm mt-4 mb-2.5 text__glitch">$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-900 text__glitch">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em class="italic text-slate-700 text__glitch">$1</em>')
    .replace(/`([^`]+)`/g, (match, code) => {
      const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return `<code class="px-1.5 py-0.5 bg-slate-100 text-gamer-purple border border-slate-200 rounded font-mono text-[11px] font-bold text__glitch">${escaped}</code>`;
    })
    .replace(/^\s*-\s+(.*$)/gim, '<li class="ml-4 list-disc text-slate-700 leading-relaxed text-xs text__glitch">$1</li>')
    .replace(/^\s*(\d+)\.\s+(.*$)/gim, '<li class="ml-4 list-decimal text-slate-700 leading-relaxed text-xs font-medium"><span class="text-slate-900 font-bold">$1.</span> <span class="text__glitch">$2</span></li>')
    .replace(/\n\n/g, '<div class="h-2.5"></div>')
    .replace(/\n/g, '<br>');
}

function renderWebCtfChallenge(challenge, isSolved, isSkipped = false) {
  const main = $('#main-content');
  const nextChal = getNextActiveChallenge(currentUser);
  const targetUrl = challenge.endpoint || challenge.target_url || 'https://oxraventest.com/login';
  const method = challenge.http_method || (challenge.id === 'WEB-01' || challenge.id === 'WEB-04' ? 'POST' : 'GET');
  const isPost = method.toUpperCase().startsWith('POST');

  main.innerHTML = `
    <div class="w-full bg-surface esports-grid-pattern min-h-screen pb-16">
      <!-- Top Hero Header -->
      <div class="bg-white border-b border-border-line px-6 py-5 shadow-xs relative">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div class="space-y-1">
            <div class="flex items-center gap-2 text-xs font-telemetry text-dark-muted">
              <button onclick="navigate('dashboard')" class="text-gamer-purple font-bold hover:underline flex items-center gap-1">
                <span class="material-symbols-outlined text-xs">arrow_back</span>
                DOSSIER CATALOG
              </button>
              <span>//</span>
              <span class="font-bold text-dark-title text__glitch">ARENA // SECTOR 02 // WEB APPLICATION CTF</span>
              <span>//</span>
              <span class="text-gamer-cyan font-semibold text__glitch">TARGET: oxraventest.com</span>
            </div>
            <div class="font-headline-lg text-2xl lg:text-3xl font-extrabold text-dark-title tracking-tight flex items-center flex-wrap gap-3">
              <h3 class="text__glitch font-headline-lg text-2xl lg:text-3xl font-extrabold text-dark-title tracking-tight m-0 p-0">${challenge.id}: ${challenge.name.toUpperCase()}</h3>
              <span class="text-xs font-telemetry bg-gamer-purple text-white font-bold px-2.5 py-0.5 rounded shadow-xs uppercase">${challenge.difficulty}</span>
              ${isSolved ? '<span class="text-xs font-telemetry bg-gamer-emerald text-white font-bold px-2.5 py-0.5 rounded shadow-xs">SOLVED ✓</span>' : isSkipped ? '<span class="text-xs font-telemetry bg-amber-600 text-white font-bold px-2.5 py-0.5 rounded shadow-xs">BYPASSED (-30 PTS)</span>' : ''}
            </div>
          </div>
          <div class="flex items-center gap-3 font-telemetry text-xs shrink-0">
            ${(isSolved || isSkipped) && nextChal ? `
              <button onclick="renderChallenge('${nextChal.id}')" class="px-4 py-2 bg-gradient-to-r from-gamer-purple to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-telemetry font-bold text-xs rounded-lg shadow-sm transition-all flex items-center gap-1.5 cursor-pointer transform active:scale-95">
                <span class="material-symbols-outlined text-sm">arrow_forward</span>
                PROCEED TO NEXT TARGET [${nextChal.id}]
              </button>
            ` : ''}
            ${!isSolved && !isSkipped ? `
              <button onclick="confirmSkipChallenge('${challenge.id}')" class="px-3 py-2 bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-800 text-xs font-telemetry font-bold rounded-lg transition-all flex items-center gap-1.5 shadow-xs cursor-pointer active:scale-95" title="Skip this challenge by spending 30 points">
                <span class="material-symbols-outlined text-sm text-amber-600">fast_forward</span>
                <span>SKIP TARGET (-30 PTS) &bull; ${Math.max(0, 3 - (currentUser.skipsUsed || 0))}/3 LEFT</span>
              </button>
            ` : ''}
            <div class="bg-slate-50 border border-slate-200 px-4 py-2 rounded-lg text-center shadow-xs">
              <div class="text-[10px] text-slate-400 font-bold">REWARD VALUE</div>
              ${isSolved ? `<div class="font-bold text-gamer-emerald text-sm">+${challenge.points} PTS</div>` : isSkipped ? `<div class="font-bold text-amber-700 text-sm">-30 PTS DEDUCTED</div>` : `<div class="font-bold text-gamer-purple text-sm">+${challenge.points} PTS</div>`}
            </div>
          </div>
        </div>
      </div>

      <!-- 3-Column Operational Arena Console -->
      <div class="max-w-6xl mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- Left Pane: Target Endpoint Controller (4 cols) -->
        <div class="lg:col-span-4 space-y-5">
          <!-- Target Application Endpoint Card -->
          <div class="bg-white rounded-xl border border-border-line p-5 shadow-xs hud-card space-y-4">
            <div class="flex items-center justify-between pb-3 border-b border-border-line">
              <div class="flex items-center gap-2 text-xs font-telemetry font-bold text-slate-800">
                <span class="w-2.5 h-2.5 rounded-full bg-gamer-emerald animate-pulse"></span>
                <span class="text__glitch">TARGET STATUS: ONLINE</span>
              </div>
              <span class="font-telemetry text-[11px] text-slate-500 font-bold text__glitch">NODE: oxraventest.com</span>
            </div>

            <!-- Target Endpoint Box -->
            <div class="space-y-2 font-telemetry text-xs">
              <div class="flex items-center justify-between">
                <span class="text-[10px] text-slate-500 font-extrabold tracking-wider text__glitch">TARGET ENDPOINT</span>
                <span class="text-[10px] font-mono font-bold px-2 py-0.5 rounded ${isPost ? 'bg-purple-100 text-purple-700 border border-purple-200' : 'bg-emerald-100 text-emerald-700 border border-emerald-200'}">
                  ${method}
                </span>
              </div>
              <div class="flex items-center bg-slate-50 border border-slate-300 rounded-lg p-2.5 font-mono text-xs text-slate-900 justify-between shadow-inner">
                <span class="truncate font-bold text-gamer-purple text__glitch">${targetUrl}</span>
                <button onclick="navigator.clipboard.writeText('${targetUrl}'); toast('Copied', 'Target URL copied to clipboard', 'info', 1500);" class="text-slate-500 hover:text-slate-900 ml-2 p-1 hover:bg-slate-200 rounded transition-all" title="Copy endpoint URL">
                  <span class="material-symbols-outlined text-xs">content_copy</span>
                </button>
              </div>
            </div>

            <!-- Target Route & Scope -->
            <div class="p-3 bg-slate-50 border border-slate-200 rounded-lg font-mono text-[11px] space-y-1.5">
              <div class="flex justify-between items-center text-slate-600">
                <span class="text-slate-400 font-bold text__glitch">ROUTE:</span>
                <span class="font-bold text-slate-900 font-mono text__glitch">${challenge.target_route || '/' + targetUrl.split('oxraventest.com/')[1] || '/login'}</span>
              </div>
              ${challenge.target_parameter ? `
                <div class="flex justify-between items-center text-slate-600">
                  <span class="text-slate-400 font-bold">TARGET PARAMS:</span>
                  <span class="font-bold text-gamer-cyan truncate max-w-[170px]" title="${challenge.target_parameter}">${challenge.target_parameter}</span>
                </div>
              ` : ''}
              <div class="flex justify-between items-center text-slate-600">
                <span class="text-slate-400 font-bold">CONTAINER:</span>
                <span class="font-bold text-slate-700">ctf-node-00${challenge.order}</span>
              </div>
            </div>

            <button onclick="openSimulatedChromeWindow('${targetUrl}', '${challenge.name}')" class="w-full py-2.5 bg-gamer-cyan hover:bg-cyan-600 text-white font-bold text-xs rounded-lg shadow-sm transition-all flex items-center justify-center gap-2 text-center cursor-pointer transform active:scale-[0.98]">
              <span class="material-symbols-outlined text-sm">open_in_new</span>
              [ LAUNCH ENDPOINT IN SIMULATED BROWSER ]
            </button>

            <div class="p-3 bg-cyan-50/70 rounded-lg border border-cyan-200 text-[11px] font-telemetry text-cyan-900 space-y-1">
              <div class="font-bold flex items-center gap-1"><span class="material-symbols-outlined text-xs">info</span> BROWSER DEVTOOLS (F12)</div>
              <div class="leading-relaxed">Click <strong>Launch Endpoint</strong> to interact with the full URL omnibox, inspection tools, cookies, and network payloads.</div>
            </div>
          </div>

          <!-- Target Specifications Card -->
          <div class="bg-white rounded-xl border border-border-line p-5 shadow-xs space-y-3">
            <div class="flex items-center justify-between pb-3 border-b border-border-line">
              <span class="font-headline-sm font-bold text-dark-title text-xs">THREAT SPECIFICATIONS</span>
              <span class="text-[10px] font-telemetry bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded font-bold">ACTIVE POD</span>
            </div>
            <div class="space-y-2 font-mono text-xs text-slate-700">
              <div class="flex justify-between py-1 border-b border-slate-100">
                <span class="text-slate-400">HOSTNAME:</span>
                <span class="font-bold text-slate-800">oxraventest.com</span>
              </div>
              <div class="flex justify-between py-1 border-b border-slate-100">
                <span class="text-slate-400">PROTOCOL:</span>
                <span class="font-bold text-emerald-600">HTTPS (TLS 1.3)</span>
              </div>
              <div class="flex justify-between py-1 border-b border-slate-100">
                <span class="text-slate-400">CLASSIFICATION:</span>
                <span class="font-bold text-gamer-purple text-[11px] text-right truncate max-w-[190px]" title="${challenge.cwe || challenge.vulnerability}">${challenge.cwe || challenge.vulnerability}</span>
              </div>
              <div class="flex justify-between py-1">
                <span class="text-slate-400">DEVTOOLS RECON:</span>
                <span class="font-bold text-gamer-cyan">Inspect (F12) / Cookies</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Center Pane: Mission Dossier & Expected Answer Guide (5 cols) -->
        <div class="lg:col-span-5 space-y-5">
          <!-- Mission Briefing & Scope -->
          <div class="bg-white rounded-xl border border-border-line p-5 shadow-xs hud-card space-y-3">
            <div class="flex items-center justify-between pb-3 border-b border-border-line">
              <span class="font-headline-sm font-bold text-dark-title text-xs flex items-center gap-1.5">
                <span class="material-symbols-outlined text-sm text-gamer-purple">security</span>
                <span class="text__glitch">MISSION BRIEFING & PROBLEM DETAILS</span>
              </span>
              <span class="font-telemetry text-[10px] text-gamer-purple font-bold">SEC_PLAYBOOK_v2</span>
            </div>
            <div class="font-telemetry text-xs text-slate-700 space-y-2.5">
              ${formatWebChallengeMarkdown(challenge.description)}
            </div>
            <div class="mt-4 p-3 bg-rose-50 border border-rose-200 rounded-lg text-[11px] font-telemetry text-rose-700 space-y-1">
              <div class="font-bold text-rose-800 text__glitch">RULES OF ENGAGEMENT:</div>
              <div class="text__glitch">Target is restricted to simulated internal endpoints. Focus on endpoint parameter validation and access control logic.</div>
            </div>
          </div>

          <!-- Expected Verification Answer Guide Card -->
          <div class="bg-white rounded-xl border-2 border-gamer-emerald/30 p-5 shadow-xs space-y-3 bg-gradient-to-b from-white to-emerald-50/20">
            <div class="flex items-center justify-between pb-3 border-b border-emerald-200">
              <span class="font-headline-sm font-bold text-slate-900 text-xs flex items-center gap-1.5">
                <span class="material-symbols-outlined text-sm text-emerald-600">verified</span>
                <span class="text__glitch">EXPECTED ANSWER & EXTRACTION GUIDE</span>
              </span>
              <span class="font-mono text-[10px] bg-emerald-100 text-emerald-800 font-bold px-2 py-0.5 rounded text__glitch">TOKEN SCHEME</span>
            </div>
            
            <div class="space-y-3 text-xs font-telemetry">
              <div>
                <div class="text-[10px] text-slate-500 font-bold uppercase mb-1 text__glitch">Answer Format</div>
                <div class="p-2 bg-emerald-50 border border-emerald-200 rounded font-mono font-bold text-emerald-900 text-xs flex items-center justify-between">
                  <span class="text__glitch">${challenge.expected_answer_format || 'UPPERCASE_WITH_UNDERSCORES (Plain text token)'}</span>
                  <span class="material-symbols-outlined text-sm text-emerald-600">check</span>
                </div>
              </div>

              <div>
                <div class="text-[10px] text-slate-500 font-bold uppercase mb-1 text__glitch">Extraction Location & Procedure</div>
                <p class="leading-relaxed text-slate-700 bg-white p-3 rounded-lg border border-slate-200 font-medium text__glitch">
                  ${challenge.expected_answer_guide || 'Execute the attack vector in the simulated browser to reveal the secret verification answer token on the screen or in DevTools storage.'}
                </p>
              </div>

              <div class="text-[11px] text-slate-500 italic text__glitch">
                * Note: Do not wrap in flag{} syntax. Submit the raw captured token directly.
              </div>
            </div>
          </div>
        </div>

        <!-- Right Pane: Flag Submission Console (3 cols) -->
        <div class="lg:col-span-3 space-y-5">
          <div class="bg-white rounded-xl border border-border-line p-5 shadow-xs hud-card space-y-4">
            <div class="flex items-center justify-between pb-3 border-b border-border-line">
              <span class="font-headline-sm font-bold text-dark-title text-xs flex items-center gap-1.5">
                <span class="material-symbols-outlined text-sm text-gamer-purple">key</span>
                <span class="text__glitch">FLAG CONSOLE</span>
              </span>
              <span class="text-[10px] font-telemetry bg-gamer-purple/10 text-gamer-purple px-1.5 py-0.5 rounded font-bold">VERIFICATION</span>
            </div>

            <div class="space-y-3 font-telemetry text-xs">
              ${isSolved ? `
                <div class="p-4 bg-emerald-50 border-2 border-emerald-300 rounded-xl space-y-3">
                  <div class="flex items-center gap-2 text-emerald-800 font-bold text-xs font-telemetry">
                    <span class="material-symbols-outlined text-emerald-600 text-base">check_circle</span>
                    <span>OBJECTIVE CLEARED (+${challenge.points} PTS) &mdash; Flag token verified!</span>
                  </div>
                  ${nextChal ? `
                    <button onclick="renderChallenge('${nextChal.id}')" class="w-full py-3 bg-gradient-to-r from-gamer-purple to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold text-xs rounded-lg shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer font-telemetry transform active:scale-[0.98]">
                      <span>PROCEED TO NEXT TARGET [${nextChal.id}: ${nextChal.name}]</span>
                      <span class="material-symbols-outlined text-sm">arrow_forward</span>
                    </button>
                  ` : `
                    <button onclick="navigate('dashboard')" class="w-full py-3 bg-gamer-purple hover:bg-purple-700 text-white font-bold text-xs rounded-lg shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer font-telemetry">
                      <span>ALL OBJECTIVES COMPLETE &mdash; RETURN TO MISSION CONTROL</span>
                    </button>
                  `}
                </div>
              ` : isSkipped ? `
                <div class="p-4 bg-amber-50 border-2 border-amber-300 rounded-xl space-y-3">
                  <div class="flex items-center justify-between text-xs font-mono text-amber-800 font-bold">
                    <div class="flex items-center gap-2">
                      <span class="material-symbols-outlined text-sm text-amber-600">fast_forward</span>
                      <span>TARGET BYPASSED (-30 PTS) &mdash; Objective skipped.</span>
                    </div>
                    <span class="text-[10px] bg-amber-200 text-amber-900 px-2 py-0.5 rounded font-extrabold">SKIPPED</span>
                  </div>
                  ${nextChal ? `
                    <button onclick="renderChallenge('${nextChal.id}')" class="w-full py-3 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700 text-white font-bold text-xs rounded-lg shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer font-telemetry transform active:scale-[0.98]">
                      <span>PROCEED TO NEXT TARGET [${nextChal.id}: ${nextChal.name}]</span>
                      <span class="material-symbols-outlined text-sm">arrow_forward</span>
                    </button>
                  ` : ''}
                </div>
              ` : `
                <div>
                  <label class="block text-slate-700 font-bold mb-1 text-[11px]">TARGET ANSWER SCHEME</label>
                  <div class="p-2 bg-slate-50 border border-slate-200 rounded font-mono text-[11px] text-slate-700 font-bold truncate">
                    ${challenge.expected_answer_format ? challenge.expected_answer_format.split('(')[0].trim() : 'PLAIN TEXT STRING'}
                  </div>
                </div>

                <div>
                  <label class="block text-slate-700 font-bold mb-1 text-[11px]">SUBMISSION BUFFER</label>
                  <input type="text" id="web-flag-input" onkeydown="if(event.key==='Enter') submitFlag('${challenge.id}', 'web-flag-input')" class="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 font-bold outline-none focus:border-gamer-purple focus:bg-white text-xs font-mono" placeholder="Paste captured token here...">
                </div>

                <button onclick="submitFlag('${challenge.id}', 'web-flag-input')" class="w-full py-2.5 bg-purple-600 hover:bg-purple-700 text-white shadow-xs font-bold text-xs rounded-lg shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer transform active:scale-[0.98]">
                  <span class="material-symbols-outlined text-sm">key</span>
                  [ SUBMIT VERIFICATION ANSWER ]
                </button>
              `}

              <div id="flag-feedback-web" class="text-xs pt-1"></div>
            </div>
          </div>

          <!-- Hints Card -->
          <div class="bg-white rounded-xl border border-border-line p-4 shadow-xs">
            <div class="flex items-center justify-between pb-3 border-b border-border-line mb-3">
              <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-amber-500 text-sm">lightbulb</span>
                <span class="font-headline-sm font-bold text-dark-title text-xs">TACTICAL INTEL HINTS</span>
              </div>
              <span class="text-[10px] font-telemetry text-amber-600 font-bold">PENALTY ACTIVE</span>
            </div>
            <div class="space-y-2 font-telemetry text-xs" id="hints-container-${challenge.id}">
              ${challenge.hints && challenge.hints.length > 0 ? challenge.hints.map((h, i) => {
                const unlocked = (currentUser.revealedHints || []).includes(h.id) || (currentUser.unlockedHints || []).includes(h.id);
                return `
                  <div class="p-2.5 rounded-lg ${unlocked ? 'bg-emerald-50 border border-emerald-300' : 'bg-slate-50 border border-slate-200'}" id="hint-box-${h.id}">
                    <div class="flex justify-between text-[11px] font-bold">
                      <span class="${unlocked ? 'text-emerald-700' : 'text-slate-700'}">INTEL 0${i+1}</span>
                      <span class="${unlocked ? 'text-emerald-600 font-extrabold' : 'text-rose-500'}">${unlocked ? '✓ UNLOCKED' : '-' + h.cost + ' PTS'}</span>
                    </div>
                    ${unlocked ? `
                      <p class="text-slate-800 text-[11px] font-sans font-medium bg-white/90 p-2 rounded border border-emerald-200 mt-1 leading-relaxed whitespace-pre-line">${escapeHtml(h.text)}</p>
                    ` : `
                      <button onclick="revealHint('${challenge.id}', '${h.id}')" class="w-full mt-1 py-1.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-bold rounded text-[10px] transition-all cursor-pointer shadow-xs">
                        UNLOCK INTEL (-${h.cost} PTS)
                      </button>
                    `}
                  </div>
                `;
              }).join('') : '<div class="text-slate-400">No tactical intel available.</div>'}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}


/* ── Round 3: Code Review IDE & Findings ─────────────────────── */
let currentIdeFile = 'auth.py';

window.selectIdeFile = (name) => {
  currentIdeFile = name;
  document.querySelectorAll('.ide-file-item').forEach(b => {
    b.className = b.dataset.file === name
      ? 'ide-file-item w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono font-bold bg-gamer-purple text-white shadow-xs text-left'
      : 'ide-file-item w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono text-slate-700 hover:bg-slate-100 text-left';
  });
  renderIdeEditorContent();
};

/* ── Round 3: Beginner-Friendly Code Review Engine ─────────── */

function renderCodeSnippetLines(code, lang, challengeId) {
  if (!code) return '';
  const lines = code.split('\n');
  return lines.map((line, idx) => {
    const lineNum = idx + 1;
    let formatted = escapeHtml(line);
    // Lightweight keyword highlighting
    formatted = formatted
      .replace(/\b(def|class|return|if|else|elif|import|from|const|let|var|function)\b/g, '<span class="text-purple-400 font-bold">$1</span>')
      .replace(/(&quot;[^&]*&quot;|'[^']*'|`[^`]*`)/g, '<span class="text-emerald-300">$1</span>')
      .replace(/(\/\/[^\n]*|#[^\n]*)/g, '<span class="text-slate-500 italic">$1</span>')
      .replace(/\b(request|session|database|users|app|req|res)\b/g, '<span class="text-cyan-300 font-semibold">$1</span>')
      .replace(/\b(get|send|execute|query|args|route)\b/g, '<span class="text-amber-300 font-medium">$1</span>');

    const isClickable = challengeId === 'CODE-05';
    return `
      <div id="snippet-line-${challengeId}-${lineNum}" onclick="${isClickable ? `onSnippetLineClick('${challengeId}', ${lineNum})` : ''}" class="flex items-start hover:bg-slate-800/60 py-1 px-2 rounded -mx-2 transition-all ${isClickable ? 'cursor-pointer hover:ring-1 hover:ring-purple-400/50' : ''}">
        <span class="text-slate-600 select-none text-right pr-4 text-xs font-mono shrink-0 w-8">${lineNum}</span>
        <span class="text-slate-100 flex-1 whitespace-pre font-mono">${formatted || ' '}</span>
      </div>
    `;
  }).join('');
}

window.onSnippetLineClick = (challengeId, lineNum) => {
  const lineSelect = document.getElementById(`code-vuln-line-${challengeId}`);
  if (lineSelect) {
    lineSelect.value = String(lineNum);
    onVulnLineSelectChange(challengeId, lineNum);
  }
};

window.onVulnLineSelectChange = (challengeId, lineNum) => {
  document.querySelectorAll(`[id^="snippet-line-${challengeId}-"]`).forEach(el => {
    el.classList.remove('bg-purple-950/70', 'ring-1', 'ring-purple-400');
  });
  if (lineNum) {
    const target = document.getElementById(`snippet-line-${challengeId}-${lineNum}`);
    if (target) {
      target.classList.add('bg-purple-950/70', 'ring-1', 'ring-purple-400');
    }
  }
  Sound.play('click');
};

window.selectCodeMcqOption = (challengeId, optionIdx, optionValue) => {
  const container = document.getElementById(`code-mcq-options-${challengeId}`);
  if (!container) return;

  container.querySelectorAll('.code-mcq-card').forEach((card, idx) => {
    const radio = card.querySelector('input[type="radio"]');
    const dot = card.querySelector('.mcq-radio-dot');
    if (idx === optionIdx) {
      card.className = 'code-mcq-card cursor-pointer p-3.5 rounded-xl border-2 border-gamer-purple bg-purple-50/80 shadow-sm transition-all flex items-center justify-between';
      if (radio) radio.checked = true;
      if (dot) {
        dot.className = 'mcq-radio-dot w-5 h-5 rounded-full border-2 border-gamer-purple bg-gamer-purple flex items-center justify-center text-white text-xs font-bold';
        dot.innerHTML = '✓';
      }
    } else {
      card.className = 'code-mcq-card cursor-pointer p-3.5 rounded-xl border-2 border-slate-200 hover:border-slate-300 bg-slate-50/60 hover:bg-white transition-all flex items-center justify-between';
      if (radio) radio.checked = false;
      if (dot) {
        dot.className = 'mcq-radio-dot w-5 h-5 rounded-full border-2 border-slate-300 flex items-center justify-center text-transparent text-xs';
        dot.innerHTML = '';
      }
    }
  });

  Sound.play('click');
};

window.submitCodeMcqForm = (e, challengeId) => {
  if (e) e.preventDefault();
  const form = document.getElementById(`code-mcq-form-${challengeId}`);
  const selected = form ? form.querySelector('input[name="code_mcq_answer"]:checked') : null;
  if (!selected) {
    toast('Selection Required', 'Please select a vulnerability option before submitting.', 'warning', 2500);
    return;
  }
  submitCodeAnswer(challengeId, selected.value);
};

window.submitCodeAnalysisForm = (e, challengeId) => {
  if (e) e.preventDefault();
  const lineSelect = document.getElementById(`code-vuln-line-${challengeId}`);
  const typeSelect = document.getElementById(`code-vuln-type-${challengeId}`);

  if (lineSelect && typeSelect) {
    const lineVal = lineSelect.value.trim();
    const typeVal = typeSelect.value.trim();

    if (!lineVal) {
      toast('Line Selection Required', 'Please select which line contains the vulnerability.', 'warning', 2500);
      return;
    }
    if (!typeVal) {
      toast('Vulnerability Type Required', 'Please select the vulnerability type from the dropdown.', 'warning', 2500);
      return;
    }

    const validLines = ['5', '3', '4'];
    const isLineCorrect = validLines.includes(lineVal);
    const isTypeCorrect = typeVal === 'IDOR';
    if (isLineCorrect && isTypeCorrect) {
      submitCodeAnswer(challengeId, `LINE_${lineVal}_IDOR`);
    } else {
      // Single-chance evaluation: fail finding and advance
      const userSummary = `Line ${lineVal || 'None'} / ${typeVal || 'None'}`;
      submitCodeAnswer(challengeId, userSummary);
    }
    return;
  }

  const input = document.getElementById(`code-analysis-text-${challengeId}`);
  if (!input || !input.value.trim()) {
    toast('Input Required', 'Please complete the vulnerability inspection form.', 'warning', 2500);
    return;
  }
  submitCodeAnswer(challengeId, input.value.trim());
};

window.submitCodeAnswer = (challengeId, answerText) => {
  window._inFlightSubmissions = window._inFlightSubmissions || new Set();
  if (window._inFlightSubmissions.has(challengeId)) return;

  const challenge = getChallengeById(challengeId, currentUser);
  if (!challenge) return;

  if (!currentUser.solvedChallenges) currentUser.solvedChallenges = [];
  if (!currentUser.failedChallenges) currentUser.failedChallenges = [];
  if (!currentUser.skippedChallenges) currentUser.skippedChallenges = [];
  if (currentUser.solvedChallenges.includes(challengeId)) {
    toast('Already Solved', 'You have already resolved this code review finding.', 'info', 2000);
    return;
  }
  if (currentUser.failedChallenges.includes(challengeId)) {
    toast('Target Closed', 'Your single attempt for this finding has already been recorded (0 PTS).', 'info', 2500);
    return;
  }
  if (currentUser.skippedChallenges.includes(challengeId)) {
    toast('Target Bypassed', 'This challenge was bypassed (-30 PTS).', 'info', 2000);
    return;
  }

  window._inFlightSubmissions.add(challengeId);

  const norm = (s) => String(s || '').toUpperCase().replace(/^FLAG\{/i, '').replace(/\}$/, '').replace(/[^A-Z0-9]/g, '');
  const userNorm = norm(answerText);
  const flagNorm = norm(challenge.flag);

  let isCorrect = false;

  if (challenge.type === 'code_mcq') {
    const correctOptText = challenge.options ? challenge.options[challenge.correct_option] : '';
    if (userNorm === flagNorm || userNorm === norm(correctOptText)) {
      isCorrect = true;
    } else if (challenge.acceptable_answers && challenge.acceptable_answers.some(a => norm(a) === userNorm)) {
      isCorrect = true;
    }
  } else {
    // Free-form code analysis or Line + Dropdown validation
    const lower = String(answerText).toLowerCase();
    if (
      (lower.startsWith('line_') && lower.includes('idor')) ||
      (lower.includes('idor') && (lower.includes('line 5') || lower.includes('line 3') || lower.includes('line 4') || lower.includes('5') || lower.includes('get_user'))) ||
      lower.includes('bola') ||
      lower.includes('broken object') ||
      userNorm === flagNorm
    ) {
      isCorrect = true;
    }
  }

  if (isCorrect) {
    if (!currentUser.solvedChallenges.includes(challengeId)) {
      currentUser.solvedChallenges.push(challengeId);
      currentUser.score = (currentUser.score || 0) + (challenge.points || 0);
    }

    saveUser();
    updateNavScore();
    updateMissionHud();

    // Persist to server atomically
    Api.post('/api/submit', { challengeId, answer: answerText }).then(res => {
      if (res && typeof res.score === 'number') {
        currentUser.score = res.score;
        saveUser();
        updateNavScore();
        updateMissionHud();
      }
    }).catch(() => {}).finally(() => {
      window._inFlightSubmissions.delete(challengeId);
    });

    Sound.play('correct');
    Mascot.react('hype', 'Vulnerability confirmed! ' + (challenge.explanation ? challenge.explanation.slice(0, 50) + '...' : ''));
    toast('Finding Verified!', `+${challenge.points} PTS! ${challenge.unlock_message || 'Vulnerability identified.'}`, 'success', 3500);

    // Re-render challenge view to show explanation card
    renderCodeReviewChallenge(challenge, true, false, false);

    // Trigger debrief & next progression
    setTimeout(() => {
      showSolveSuccessDebrief(challenge);
    }, 450);
  } else {
    // Single-attempt evaluation: NO SECOND CHANCE! Lock challenge with 0 points and advance
    if (!currentUser.failedChallenges.includes(challengeId)) {
      currentUser.failedChallenges.push(challengeId);
    }
    if (!currentUser.attemptedAnswers) currentUser.attemptedAnswers = {};
    currentUser.attemptedAnswers[challengeId] = answerText;

    if (!currentUser.submissions) currentUser.submissions = [];
    currentUser.submissions.push({
      challengeId,
      value: answerText,
      timestamp: new Date().toISOString(),
      correct: false
    });

    saveUser();
    updateNavScore();
    updateMissionHud();

    // Record submission on server
    Api.post('/api/submit', { challengeId, answer: answerText }).catch(() => {}).finally(() => {
      window._inFlightSubmissions.delete(challengeId);
    });

    Sound.play('error');
    Mascot.react('worried', 'Target missed! 0 points awarded. Under single-attempt rules, advancing to next target...');
    toast('Target Missed!', 'Incorrect vulnerability finding. No second chance — advancing to next dossier...', 'error', 3500);

    // Re-render in failed locked state
    renderCodeReviewChallenge(challenge, false, true, false);

    // Trigger failure debrief modal and auto-advance
    setTimeout(() => {
      showCodeFailDebrief(challenge, answerText);
    }, 500);
  }
};

function renderCodeReviewChallenge(challenge, isSolved, isFailed = false, isSkipped = false) {
  const main = $('#main-content');
  if (!main) return;

  const isMcq = challenge.type === 'code_mcq';
  const ext = challenge.code_lang === 'javascript' ? 'js' : 'py';
  const langTitle = challenge.code_lang === 'javascript' ? 'JavaScript / Node.js' : 'Python 3 / Flask';

  const solved = currentUser.solvedChallenges || [];
  const failed = currentUser.failedChallenges || [];
  const skipped = currentUser.skippedChallenges || [];
  const nextChal = getNextActiveChallenge(currentUser);

  const userCodeList = getUserCodeReviewChallenges(currentUser, 5);
  const userCodeIdx = userCodeList.findIndex(c => c.id === challenge.id || c.originalId === challenge.id);
  const userStepNum = userCodeIdx >= 0 ? userCodeIdx + 1 : challenge.order;
  const totalCodeCount = userCodeList.length;

  const displayOptions = getUserShuffledOptions(currentUser.id, challenge);
  const correctOptText = challenge.options && typeof challenge.correct_option === 'number' ? challenge.options[challenge.correct_option] : '';
  const norm = (s) => String(s || '').toUpperCase().replace(/^FLAG\{/i, '').replace(/\}$/, '').replace(/[^A-Z0-9]/g, '');

  main.innerHTML = `
    <div class="w-full bg-surface esports-grid-pattern min-h-screen pb-16">
      <!-- Top Command Header -->
      <div class="bg-white border-b border-border-line px-6 py-4 shadow-xs">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div class="space-y-1">
            <div class="flex items-center gap-2 text-xs font-telemetry text-dark-muted">
              <button onclick="navigate('dashboard')" class="text-gamer-purple font-bold hover:underline flex items-center gap-1">
                <span class="material-symbols-outlined text-xs">arrow_back</span>
                DOSSIER CATALOG
              </button>
              <span>//</span>
              <span class="font-bold text-dark-title text__glitch">ROUND 03 // SECURE CODE REVIEW // VULNERABILITY AUDIT</span>
              <span>//</span>
              <span class="text-gamer-purple font-semibold text__glitch">STAGE 3: CODE REVIEW</span>
            </div>
            <div class="font-headline-lg text-2xl font-extrabold text-dark-title tracking-tight flex items-center flex-wrap gap-3">
              <h3 class="text__glitch font-headline-lg text-2xl font-extrabold text-dark-title tracking-tight m-0 p-0">${challenge.id}: ${cleanChallengeName(challenge.name).toUpperCase()}</h3>
              <span class="text-xs font-telemetry bg-gamer-purple text-white font-bold px-2 py-0.5 rounded shadow-xs uppercase">${challenge.difficulty}</span>
              ${isSolved ? '<span class="text-xs font-telemetry bg-gamer-emerald text-white font-bold px-2 py-0.5 rounded shadow-xs">SOLVED ✓</span>' : isFailed ? '<span class="text-xs font-telemetry bg-rose-600 text-white font-bold px-2 py-0.5 rounded shadow-xs">MISSED (0 PTS)</span>' : isSkipped ? '<span class="text-xs font-telemetry bg-amber-600 text-white font-bold px-2 py-0.5 rounded shadow-xs">BYPASSED (-30 PTS)</span>' : ''}
            </div>
          </div>
          <div class="flex items-center gap-3 font-telemetry text-xs shrink-0">
            ${!isSolved && !isFailed && !isSkipped ? `
              <button onclick="confirmSkipChallenge('${challenge.id}')" class="px-3 py-2 bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-800 text-xs font-telemetry font-bold rounded-lg transition-all flex items-center gap-1.5 shadow-xs cursor-pointer active:scale-95" title="Skip this challenge by spending 30 points">
                <span class="material-symbols-outlined text-sm text-amber-600">fast_forward</span>
                <span>SKIP TARGET (-30 PTS) &bull; ${Math.max(0, 3 - (currentUser.skipsUsed || 0))}/3 LEFT</span>
              </button>
            ` : ''}
            <div class="bg-slate-50 border border-slate-200 px-3 py-2 rounded-lg text-center shadow-xs">
              <div class="text-[10px] text-slate-400 font-bold">TOTAL BOUNTY</div>
              ${isSolved ? `<div class="font-bold text-gamer-emerald">+${challenge.points} PTS</div>` : isFailed ? `<div class="font-bold text-rose-600">0 / +${challenge.points} PTS</div>` : isSkipped ? `<div class="font-bold text-amber-700">-30 PTS DEDUCTED</div>` : `<div class="font-bold text-gamer-purple">+${challenge.points} PTS</div>`}
            </div>
          </div>
        </div>
      </div>

      <!-- Main Container: Focused Beginner-Friendly Code Review Layout -->
      <div class="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6 font-sans">
        
        <!-- Problem Statement Banner -->
        <div class="bg-white rounded-xl border border-border-line p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div class="space-y-1.5">
            <div class="flex items-center gap-2">
              <span class="material-symbols-outlined text-gamer-purple text-lg">terminal</span>
              <span class="font-headline-sm font-bold text-dark-title text-sm tracking-tight text__glitch">CODE REVIEW // VULNERABILITY INSPECTION</span>
              <span class="text-[10px] font-telemetry bg-purple-100 text-purple-700 px-2 py-0.5 rounded font-bold uppercase">Single Attempt Mode</span>
            </div>
            <p class="text-xs text-slate-600 max-w-2xl leading-relaxed text__glitch">
              A developer has written several microservices for a web application. The application works, but contains security flaws.
              Inspect the code below and identify the vulnerability. <strong>Note:</strong> Under single-attempt rules, once you submit an answer, it is locked in with no second chances.
            </p>
          </div>
          <div class="shrink-0 flex items-center gap-2 font-telemetry text-xs">
            <span class="px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200 font-bold text-slate-700 flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full ${isSolved ? 'bg-emerald-500' : isFailed ? 'bg-rose-500' : isSkipped ? 'bg-amber-500' : 'bg-purple-500 animate-pulse'}"></span>
              ${isSolved ? 'FINDING RESOLVED' : isFailed ? 'TARGET CLOSED (MISSED)' : isSkipped ? 'TARGET BYPASSED (-30 PTS)' : 'AUDIT IN PROGRESS'}
            </span>
          </div>
        </div>

        <!-- Code Snippet Card -->
        <div class="bg-[#0d1117] rounded-xl border border-slate-800 shadow-xl overflow-hidden font-mono">
          <!-- Terminal Titlebar -->
          <div class="bg-[#161b22] px-4 py-2.5 flex items-center justify-between border-b border-slate-800">
            <div class="flex items-center gap-2.5">
              <div class="flex items-center gap-1.5 pr-2">
                <span class="w-2.5 h-2.5 rounded-full bg-rose-500/80 inline-block"></span>
                <span class="w-2.5 h-2.5 rounded-full bg-amber-500/80 inline-block"></span>
                <span class="w-2.5 h-2.5 rounded-full bg-emerald-500/80 inline-block"></span>
              </div>
              <span class="text-xs text-slate-300 font-bold font-mono text__glitch">${challenge.id.toLowerCase()}_source.${ext}</span>
            </div>
            <span class="text-[10px] font-bold uppercase px-2.5 py-0.5 rounded bg-slate-800 text-cyan-300 border border-slate-700 font-mono tracking-wider">
              ${langTitle}
            </span>
          </div>

          <!-- Code Lines Canvas -->
          <div class="p-4 sm:p-5 overflow-x-auto text-xs sm:text-[13px] leading-relaxed select-text font-mono bg-[#090d16]">
            ${renderCodeSnippetLines(challenge.code_snippet, challenge.code_lang, challenge.id)}
          </div>

          <!-- Optional Runtime Context Alert -->
          ${challenge.code_context ? `
            <div class="px-4 py-3 bg-amber-950/40 border-t border-amber-800/40 text-amber-200 text-xs font-mono flex items-start sm:items-center gap-2">
              <span class="material-symbols-outlined text-amber-400 text-sm shrink-0">info</span>
              <span><strong>Runtime Context:</strong> ${escapeHtml(challenge.code_context)}</span>
            </div>
          ` : ''}
        </div>

        <!-- Question & Answer Console -->
        <div class="bg-white rounded-xl border border-border-line p-5 sm:p-6 shadow-xs space-y-4">
          <div class="flex items-center justify-between pb-3 border-b border-border-line">
            <div class="flex items-center gap-2">
              <span class="material-symbols-outlined text-gamer-purple text-lg">help</span>
              <span class="font-headline-sm font-bold text-dark-title text-sm text__glitch">Question ${userStepNum} of ${totalCodeCount} // ${escapeHtml(challenge.question || 'What is wrong with this code?')}</span>
            </div>
            <span class="text-xs font-telemetry font-bold ${isFailed ? 'text-rose-500' : isSkipped ? 'text-amber-500' : 'text-slate-400'}">${isFailed ? 'ATTEMPT EXHAUSTED' : isSkipped ? 'BYPASSED' : isMcq ? 'SELECT 1 OPTION' : 'INSPECTION DROPDOWNS'}</span>
          </div>

          ${isMcq ? `
            <!-- Multiple Choice Question UI -->
            ${isSolved ? `
              <!-- Solved State -->
              <div class="space-y-4">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  ${displayOptions.map((opt, i) => {
                    const isCorrect = norm(opt) === norm(correctOptText) || (challenge.acceptable_answers || []).some(a => norm(a) === norm(opt));
                    return `
                      <div class="p-3.5 rounded-xl border-2 font-mono text-xs font-bold flex items-center justify-between ${isCorrect ? 'bg-emerald-50 border-emerald-400 text-emerald-950 shadow-xs' : 'bg-slate-50 border-slate-200 text-slate-400 opacity-60'}">
                        <div class="flex items-center gap-2.5">
                          <span class="w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs ${isCorrect ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300'}">
                            ${isCorrect ? '✓' : ''}
                          </span>
                          <span>${escapeHtml(opt)}</span>
                        </div>
                        ${isCorrect ? '<span class="text-[10px] bg-emerald-200/80 text-emerald-900 px-2 py-0.5 rounded uppercase font-extrabold">CORRECT ANSWER</span>' : ''}
                      </div>
                    `;
                  }).join('')}
                </div>

                <!-- Deep Dive "Why?" Explanation -->
                <div class="p-4 rounded-xl bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-300 text-emerald-950 space-y-2 shadow-xs">
                  <div class="flex items-center gap-2 text-emerald-800 font-bold text-xs uppercase tracking-wider font-mono">
                    <span class="material-symbols-outlined text-base text-emerald-600">psychology</span>
                    <span>Why? Vulnerability Breakdown:</span>
                  </div>
                  <p class="text-xs font-sans font-medium text-slate-800 leading-relaxed pl-6 border-l-2 border-emerald-400">
                    ${escapeHtml(challenge.explanation)}
                  </p>
                </div>

                <!-- Advance Button -->
                <div class="pt-2 flex justify-end">
                  ${nextChal ? `
                    <button onclick="renderChallenge('${nextChal.id}')" class="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer transform active:scale-95">
                      <span>ADVANCE TO NEXT TARGET [${nextChal.id}]</span>
                      <span class="material-symbols-outlined text-sm">arrow_forward</span>
                    </button>
                  ` : `
                    <button onclick="navigate('dashboard')" class="px-6 py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer">
                      <span>RETURN TO DOSSIER CATALOG</span>
                      <span class="material-symbols-outlined text-sm">arrow_forward</span>
                    </button>
                  `}
                </div>
              </div>
            ` : isFailed ? `
              <!-- Failed State (No Second Chances) -->
              <div class="space-y-4">
                <div class="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-950 text-xs font-mono flex items-center justify-between">
                  <span class="flex items-center gap-1.5 font-bold">
                    <span class="material-symbols-outlined text-rose-600 text-base">cancel</span>
                    Single-attempt rule: Target closed (0 PTS awarded). Progression advanced.
                  </span>
                  <span class="text-[10px] bg-rose-200 text-rose-900 px-2 py-0.5 rounded font-extrabold uppercase">NO SECOND CHANCES</span>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  ${displayOptions.map((opt, i) => {
                    const isCorrect = norm(opt) === norm(correctOptText) || (challenge.acceptable_answers || []).some(a => norm(a) === norm(opt));
                    const userSelected = norm(currentUser.attemptedAnswers?.[challenge.id] || '') === norm(opt);
                    return `
                      <div class="p-3.5 rounded-xl border-2 font-mono text-xs font-bold flex items-center justify-between ${userSelected ? 'bg-rose-50 border-rose-400 text-rose-950 shadow-xs' : isCorrect ? 'bg-emerald-50 border-emerald-400 text-emerald-950 shadow-xs' : 'bg-slate-50 border-slate-200 text-slate-400 opacity-60'}">
                        <div class="flex items-center gap-2.5">
                          <span class="w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs ${userSelected ? 'border-rose-600 bg-rose-600 text-white font-bold' : isCorrect ? 'border-emerald-600 bg-emerald-600 text-white font-bold' : 'border-slate-300'}">
                            ${userSelected ? '✗' : isCorrect ? '✓' : ''}
                          </span>
                          <span>${escapeHtml(opt)}</span>
                        </div>
                        ${userSelected ? '<span class="text-[10px] bg-rose-200 text-rose-900 px-2 py-0.5 rounded uppercase font-extrabold">YOUR CHOICE (INCORRECT)</span>' : isCorrect ? '<span class="text-[10px] bg-emerald-200 text-emerald-900 px-2 py-0.5 rounded uppercase font-extrabold">CORRECT VULNERABILITY</span>' : ''}
                      </div>
                    `;
                  }).join('')}
                </div>

                <!-- Deep Dive "Why?" Explanation -->
                <div class="p-4 rounded-xl bg-slate-50 border border-slate-300 text-slate-900 space-y-2 shadow-xs">
                  <div class="flex items-center gap-2 text-slate-800 font-bold text-xs uppercase tracking-wider font-mono">
                    <span class="material-symbols-outlined text-base text-purple-600">psychology</span>
                    <span>Post-Mortem: Why this vulnerability is present:</span>
                  </div>
                  <p class="text-xs font-sans font-medium text-slate-800 leading-relaxed pl-6 border-l-2 border-purple-400">
                    ${escapeHtml(challenge.explanation)}
                  </p>
                </div>

                <!-- Advance Button -->
                <div class="pt-2 flex justify-end">
                  ${nextChal ? `
                    <button onclick="renderChallenge('${nextChal.id}')" class="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer transform active:scale-95">
                      <span>ADVANCE TO NEXT TARGET [${nextChal.id}]</span>
                      <span class="material-symbols-outlined text-sm">arrow_forward</span>
                    </button>
                  ` : `
                    <button onclick="navigate('dashboard')" class="px-6 py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer">
                      <span>RETURN TO DOSSIER CATALOG</span>
                      <span class="material-symbols-outlined text-sm">arrow_forward</span>
                    </button>
                  `}
                </div>
              </div>
            ` : isSkipped ? `
              <!-- Skipped State (Bypassed) -->
              <div class="space-y-4">
                <div class="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-950 text-xs font-mono flex items-center justify-between">
                  <span class="flex items-center gap-1.5 font-bold">
                    <span class="material-symbols-outlined text-amber-600 text-base">fast_forward</span>
                    Target bypassed (-30 PTS). Tactical skip spent.
                  </span>
                  <span class="text-[10px] bg-amber-200 text-amber-900 px-2 py-0.5 rounded font-extrabold uppercase">BYPASSED (-30 PTS)</span>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  ${displayOptions.map((opt, i) => {
                    const isCorrect = norm(opt) === norm(correctOptText) || (challenge.acceptable_answers || []).some(a => norm(a) === norm(opt));
                    return `
                      <div class="p-3.5 rounded-xl border-2 font-mono text-xs font-bold flex items-center justify-between ${isCorrect ? 'bg-emerald-50 border-emerald-400 text-emerald-950 shadow-xs' : 'bg-slate-50 border-slate-200 text-slate-400 opacity-60'}">
                        <div class="flex items-center gap-2.5">
                          <span class="w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs ${isCorrect ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300'}">
                            ${isCorrect ? '✓' : ''}
                          </span>
                          <span>${escapeHtml(opt)}</span>
                        </div>
                        ${isCorrect ? '<span class="text-[10px] bg-emerald-200/80 text-emerald-900 px-2 py-0.5 rounded uppercase font-extrabold">CORRECT ANSWER</span>' : ''}
                      </div>
                    `;
                  }).join('')}
                </div>

                <!-- Deep Dive "Why?" Explanation -->
                <div class="p-4 rounded-xl bg-slate-50 border border-slate-300 text-slate-900 space-y-2 shadow-xs">
                  <div class="flex items-center gap-2 text-slate-800 font-bold text-xs uppercase tracking-wider font-mono">
                    <span class="material-symbols-outlined text-base text-amber-600">psychology</span>
                    <span>Vulnerability Breakdown:</span>
                  </div>
                  <p class="text-xs font-sans font-medium text-slate-800 leading-relaxed pl-6 border-l-2 border-amber-400">
                    ${escapeHtml(challenge.explanation)}
                  </p>
                </div>

                <!-- Advance Button -->
                <div class="pt-2 flex justify-end">
                  ${nextChal ? `
                    <button onclick="renderChallenge('${nextChal.id}')" class="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer transform active:scale-95">
                      <span>ADVANCE TO NEXT TARGET [${nextChal.id}]</span>
                      <span class="material-symbols-outlined text-sm">arrow_forward</span>
                    </button>
                  ` : `
                    <button onclick="navigate('dashboard')" class="px-6 py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer">
                      <span>RETURN TO DOSSIER CATALOG</span>
                      <span class="material-symbols-outlined text-sm">arrow_forward</span>
                    </button>
                  `}
                </div>
              </div>
            ` : `
              <!-- Active Multiple Choice Form -->
              <form id="code-mcq-form-${challenge.id}" onsubmit="submitCodeMcqForm(event, '${challenge.id}')" class="space-y-4">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3" id="code-mcq-options-${challenge.id}">
                  ${displayOptions.map((opt, i) => `
                    <div onclick="selectCodeMcqOption('${challenge.id}', ${i}, '${escapeHtml(opt)}')" class="code-mcq-card cursor-pointer p-3.5 rounded-xl border-2 border-slate-200 hover:border-slate-300 bg-slate-50/60 hover:bg-white transition-all flex items-center justify-between">
                      <div class="flex items-center gap-3 font-mono text-xs font-bold text-slate-800">
                        <input type="radio" name="code_mcq_answer" value="${escapeHtml(opt)}" class="hidden">
                        <span class="mcq-radio-dot w-5 h-5 rounded-full border-2 border-slate-300 flex items-center justify-center text-transparent text-xs"></span>
                        <span class="text__glitch">${escapeHtml(opt)}</span>
                      </div>
                    </div>
                  `).join('')}
                </div>

                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
                  <div class="text-[11px] font-telemetry text-slate-500 text__glitch">
                    Select carefully. Under single-attempt rules, incorrect choices advance with 0 PTS.
                  </div>
                  <button type="submit" class="px-6 py-2.5 bg-gamer-purple hover:bg-purple-700 text-white font-bold text-xs rounded-xl shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer transform active:scale-95">
                    <span class="material-symbols-outlined text-sm">verified_user</span>
                    SUBMIT VULNERABILITY FINDING (+${challenge.points} PTS)
                  </button>
                </div>
              </form>
            `}
          ` : `
            <!-- Question 5: Dropdown-based Vulnerability Inspection UI -->
            ${isSolved ? `
              <!-- Solved State -->
              <div class="space-y-4">
                <div class="p-4 rounded-xl bg-emerald-50 border border-emerald-300 text-emerald-950 space-y-3 shadow-xs">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2 text-emerald-800 font-bold text-xs uppercase tracking-wider font-mono">
                      <span class="material-symbols-outlined text-base text-emerald-600">verified</span>
                      <span>Vulnerability Audit Verified! (+20 PTS)</span>
                    </div>
                    <span class="text-[10px] bg-emerald-200/80 text-emerald-900 px-2 py-0.5 rounded font-extrabold uppercase">SOLVED ✓</span>
                  </div>

                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <div class="p-3 bg-white rounded-lg border border-emerald-200">
                      <div class="text-[10px] text-slate-500 font-bold uppercase font-telemetry">Vulnerable Line</div>
                      <div class="font-mono text-xs font-bold text-emerald-900 mt-0.5">Line 5: return database.get_user(user_id)</div>
                    </div>
                    <div class="p-3 bg-white rounded-lg border border-emerald-200">
                      <div class="text-[10px] text-slate-500 font-bold uppercase font-telemetry">Vulnerability Type</div>
                      <div class="font-mono text-xs font-bold text-emerald-900 mt-0.5">Insecure Direct Object Reference (IDOR / BOLA)</div>
                    </div>
                  </div>

                  <!-- Deep Dive "Why?" Explanation -->
                  <div class="bg-white p-3.5 rounded-lg border border-emerald-200 mt-2">
                    <span class="text-[11px] font-bold text-emerald-800 uppercase block mb-1 font-mono flex items-center gap-1.5">
                      <span class="material-symbols-outlined text-sm text-emerald-600">psychology</span>
                      Why? Vulnerability Breakdown:
                    </span>
                    <p class="text-xs font-sans font-medium text-slate-800 leading-relaxed pl-5 border-l-2 border-emerald-400">
                      ${escapeHtml(challenge.explanation)}
                    </p>
                  </div>

                  <!-- Advance Button -->
                  <div class="pt-2 flex justify-end">
                    ${nextChal ? `
                      <button onclick="renderChallenge('${nextChal.id}')" class="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer transform active:scale-95">
                        <span>ADVANCE TO NEXT TARGET [${nextChal.id}]</span>
                        <span class="material-symbols-outlined text-sm">arrow_forward</span>
                      </button>
                    ` : `
                      <button onclick="navigate('dashboard')" class="px-6 py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer">
                        <span>RETURN TO DOSSIER CATALOG</span>
                        <span class="material-symbols-outlined text-sm">arrow_forward</span>
                      </button>
                    `}
                  </div>
                </div>
              </div>
            ` : isSkipped ? `
              <!-- Skipped State for Question 5 -->
              <div class="space-y-4">
                <div class="p-4 rounded-xl bg-amber-50 border border-amber-300 text-amber-950 space-y-3 shadow-xs">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2 text-amber-800 font-bold text-xs uppercase tracking-wider font-mono">
                      <span class="material-symbols-outlined text-base text-amber-600">fast_forward</span>
                      <span>Target Bypassed (-30 PTS) // Tactical Skip Used</span>
                    </div>
                    <span class="text-[10px] bg-amber-200 text-amber-900 px-2 py-0.5 rounded font-extrabold uppercase">SKIPPED (-30 PTS)</span>
                  </div>

                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <div class="p-3 bg-white rounded-lg border border-amber-200">
                      <div class="text-[10px] text-slate-500 font-bold uppercase font-telemetry">Vulnerable Line</div>
                      <div class="font-mono text-xs font-bold text-emerald-900 mt-0.5">Line 5: return database.get_user(user_id)</div>
                    </div>
                    <div class="p-3 bg-white rounded-lg border border-amber-200">
                      <div class="text-[10px] text-slate-500 font-bold uppercase font-telemetry">Vulnerability Type</div>
                      <div class="font-mono text-xs font-bold text-emerald-900 mt-0.5">Insecure Direct Object Reference (IDOR / BOLA)</div>
                    </div>
                  </div>

                  <!-- Deep Dive "Why?" Explanation -->
                  <div class="bg-white p-3.5 rounded-lg border border-slate-200 mt-2">
                    <span class="text-[11px] font-bold text-slate-800 uppercase block mb-1 font-mono flex items-center gap-1.5">
                      <span class="material-symbols-outlined text-sm text-purple-600">psychology</span>
                      Why? Vulnerability Breakdown:
                    </span>
                    <p class="text-xs font-sans font-medium text-slate-800 leading-relaxed pl-5 border-l-2 border-purple-400">
                      ${escapeHtml(challenge.explanation)}
                    </p>
                  </div>

                  <!-- Button -->
                  <div class="pt-2 flex justify-end">
                    ${nextChal ? `
                      <button onclick="renderChallenge('${nextChal.id}')" class="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer transform active:scale-95">
                        <span>ADVANCE TO NEXT TARGET [${nextChal.id}]</span>
                        <span class="material-symbols-outlined text-sm">arrow_forward</span>
                      </button>
                    ` : `
                      <button onclick="navigate('dashboard')" class="px-6 py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer">
                        <span>RETURN TO DOSSIER CATALOG</span>
                        <span class="material-symbols-outlined text-sm">arrow_forward</span>
                      </button>
                    `}
                  </div>
                </div>
              </div>
            ` : isFailed ? `
              <!-- Failed State (No Second Chances) -->
              <div class="space-y-4">
                <div class="p-4 rounded-xl bg-rose-50 border border-rose-300 text-rose-950 space-y-3 shadow-xs">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2 text-rose-800 font-bold text-xs uppercase tracking-wider font-mono">
                      <span class="material-symbols-outlined text-base text-rose-600">cancel</span>
                      <span>Finding Missed (0 PTS) // Single-Attempt Rule</span>
                    </div>
                    <span class="text-[10px] bg-rose-200 text-rose-900 px-2 py-0.5 rounded font-extrabold uppercase">ATTEMPT EXHAUSTED</span>
                  </div>

                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <div class="p-3 bg-white rounded-lg border border-rose-200">
                      <div class="text-[10px] text-slate-500 font-bold uppercase font-telemetry">Your Submitted Finding</div>
                      <div class="font-mono text-xs font-bold text-rose-700 mt-0.5">${escapeHtml(currentUser.attemptedAnswers?.[challenge.id] || 'Incorrect Selection')}</div>
                    </div>
                    <div class="p-3 bg-white rounded-lg border border-emerald-200">
                      <div class="text-[10px] text-slate-500 font-bold uppercase font-telemetry">Actual Vulnerable Line & Flaw</div>
                      <div class="font-mono text-xs font-bold text-emerald-900 mt-0.5">Line 5: return database.get_user(user_id) // IDOR</div>
                    </div>
                  </div>

                  <!-- Deep Dive "Why?" Explanation -->
                  <div class="bg-white p-3.5 rounded-lg border border-slate-200 mt-2">
                    <span class="text-[11px] font-bold text-slate-800 uppercase block mb-1 font-mono flex items-center gap-1.5">
                      <span class="material-symbols-outlined text-sm text-purple-600">psychology</span>
                      Why? Vulnerability Breakdown:
                    </span>
                    <p class="text-xs font-sans font-medium text-slate-800 leading-relaxed pl-5 border-l-2 border-purple-400">
                      ${escapeHtml(challenge.explanation)}
                    </p>
                  </div>

                  <!-- Button -->
                  <div class="pt-2 flex justify-end">
                    ${nextChal ? `
                      <button onclick="renderChallenge('${nextChal.id}')" class="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer transform active:scale-95">
                        <span>ADVANCE TO NEXT TARGET [${nextChal.id}]</span>
                        <span class="material-symbols-outlined text-sm">arrow_forward</span>
                      </button>
                    ` : `
                      <button onclick="navigate('dashboard')" class="px-6 py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer">
                        <span>RETURN TO DOSSIER CATALOG</span>
                        <span class="material-symbols-outlined text-sm">arrow_forward</span>
                      </button>
                    `}
                  </div>
                </div>
              </div>
            ` : `
              <!-- Active Dropdown Form -->
              <form id="code-analysis-form-${challenge.id}" onsubmit="submitCodeAnalysisForm(event, '${challenge.id}')" class="space-y-4 font-telemetry">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <!-- Dropdown 1: Vulnerable Line Number -->
                  <div>
                    <label for="code-vuln-line-${challenge.id}" class="block text-slate-700 font-bold text-xs mb-1.5 flex items-center gap-1.5">
                      <span class="material-symbols-outlined text-sm text-gamer-purple">format_list_numbered</span>
                      1. Which line contains the vulnerability?
                    </label>
                    <select id="code-vuln-line-${challenge.id}" onchange="onVulnLineSelectChange('${challenge.id}', this.value)" class="w-full p-2.5 bg-slate-50 border border-slate-200 focus:border-purple-500 focus:bg-white rounded-xl text-xs font-mono font-medium outline-none transition-all text-slate-800 cursor-pointer shadow-xs">
                      <option value="">-- Select Vulnerable Line --</option>
                      <option value="1">Line 1: @app.route("/account")</option>
                      <option value="2">Line 2: def account():</option>
                      <option value="3">Line 3: user_id = request.args.get("id")</option>
                      <option value="4">Line 4: if session.get("logged_in"):</option>
                      <option value="5">Line 5: return database.get_user(user_id)</option>
                      <option value="6">Line 6: return "Login required"</option>
                    </select>
                    <div class="text-[10px] text-slate-400 mt-1">Tip: Click directly on any code line above to select it.</div>
                  </div>

                  <!-- Dropdown 2: Vulnerability Type -->
                  <div>
                    <label for="code-vuln-type-${challenge.id}" class="block text-slate-700 font-bold text-xs mb-1.5 flex items-center gap-1.5">
                      <span class="material-symbols-outlined text-sm text-gamer-purple">security</span>
                      2. What kind of vulnerability is present?
                    </label>
                    <select id="code-vuln-type-${challenge.id}" class="w-full p-2.5 bg-slate-50 border border-slate-200 focus:border-purple-500 focus:bg-white rounded-xl text-xs font-mono font-medium outline-none transition-all text-slate-800 cursor-pointer shadow-xs">
                      <option value="">-- Select Vulnerability Type --</option>
                      <option value="IDOR">Insecure Direct Object Reference (IDOR / BOLA)</option>
                      <option value="SQL_INJECTION">SQL Injection</option>
                      <option value="XSS">Cross-Site Scripting (XSS)</option>
                      <option value="HARDCODED_SECRET">Hardcoded Password / Secret</option>
                      <option value="BROKEN_AUTH">Broken Authentication</option>
                      <option value="CSRF">Cross-Site Request Forgery (CSRF)</option>
                      <option value="COMMAND_INJECTION">Command Injection</option>
                    </select>
                    <div class="text-[10px] text-slate-400 mt-1">Choose the specific security vulnerability category.</div>
                  </div>
                </div>

                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-border-line">
                  <div class="text-[11px] text-slate-500">
                    Single-attempt rules active. Once submitted, your choice is final.
                  </div>
                  <button type="submit" class="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer transform active:scale-95">
                    <span class="material-symbols-outlined text-sm">verified_user</span>
                    VERIFY VULNERABILITY FINDING (+${challenge.points} PTS)
                  </button>
                </div>
              </form>
            `}
          `}
        </div>

        <!-- Hints / Tactical Intel Section -->
        <div class="bg-white rounded-xl border border-border-line p-5 shadow-xs hud-card space-y-3">
          <div class="flex items-center justify-between pb-3 border-b border-border-line">
            <div class="flex items-center gap-2">
              <span class="material-symbols-outlined text-amber-500 text-sm">lightbulb</span>
              <span class="font-headline-sm font-bold text-dark-title text-xs">TACTICAL INTEL & HINTS</span>
            </div>
            <span class="text-[10px] font-telemetry text-amber-600 font-bold">OPTIONAL INTEL</span>
          </div>
          <div class="space-y-2 font-telemetry text-xs" id="hints-container-${challenge.id}">
            ${challenge.hints && challenge.hints.length > 0 ? challenge.hints.map((h, i) => {
              const unlocked = (currentUser.revealedHints || []).includes(h.id) || (currentUser.unlockedHints || []).includes(h.id);
              return `
                <div class="p-2.5 rounded-lg ${unlocked ? 'bg-emerald-50 border border-emerald-300' : 'bg-slate-50 border border-slate-200'}" id="hint-box-${h.id}">
                  <div class="flex justify-between text-[11px] font-bold">
                    <span class="${unlocked ? 'text-emerald-700' : 'text-slate-700'}">TACTICAL INTEL 0${i+1}</span>
                    <span class="${unlocked ? 'text-emerald-600 font-extrabold' : 'text-rose-500'}">${unlocked ? '✓ UNLOCKED' : '-' + h.cost + ' PTS'}</span>
                  </div>
                  ${unlocked ? `
                    <p class="text-slate-800 text-[11px] font-sans font-medium bg-white/90 p-2 rounded border border-emerald-200 mt-1 leading-relaxed whitespace-pre-line">${escapeHtml(h.text)}</p>
                  ` : `
                    <button onclick="revealHint('${challenge.id}', '${h.id}')" class="w-full mt-1 py-1.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-bold rounded text-[10px] transition-all cursor-pointer shadow-xs">
                      UNLOCK INTEL (-${h.cost} PTS)
                    </button>
                  `}
                </div>
              `;
            }).join('') : '<div class="text-slate-400">No tactical intel available for this snippet.</div>'}
          </div>
        </div>

      </div>
    </div>
  `;
}


/* ── Mascot Briefing System ──────────────────────────────── */
let briefingTimers = [];

function clearBriefingTimers() {
  briefingTimers.forEach(t => clearTimeout(t));
  briefingTimers = [];
}

function briefChallengeToUser(challenge, isSolved) {
  // Clear any previous briefing
  clearBriefingTimers();

  if (isSolved) {
    // Already solved — smug review
    const script = [
      ['smug',  `"${challenge.name}" — already cracked this one.`,      0],
      ['happy', `You earned ${challenge.points} pts on this. Nice work.`, 2200],
      ['idle',  'Review the solution or check the next challenge.',        4400],
    ];
    runBriefingScript(script);
    return;
  }

  // Build briefing lines based on challenge type
  const typeEmotes = {
    crypto:      ['idle', 'worried', 'smug'],
    web:         ['idle', 'worried', 'smug'],
    code_review: ['idle', 'worried', 'smug'],
    final:       ['hype', 'hype',    'hype'],
  };
  const [e0, e1, e2] = typeEmotes[challenge.type] || ['idle', 'worried', 'idle'];

  // Extract the first plain-text sentence from the description (strip markdown)
  const plainDesc = challenge.description
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/#+\s*/g, '')
    .replace(/\n+/g, ' ')
    .trim();

  // Pull out the first 1–2 sentences for the briefing
  const sentences = plainDesc.match(/[^.!?]+[.!?]+/g) || [plainDesc];
  const openingSentence  = (sentences[0] || '').trim().slice(0, 120);
  const secondSentence   = (sentences[1] || '').trim().slice(0, 120);

  // Build the difficulty / points line
  const difficultyLine = `Difficulty: ${challenge.difficulty.toUpperCase()} — worth ${challenge.points} points.`;

  // Pick objective line by type
  const objectiveLines = {
    crypto:      'Demodulate signals intelligence and reconstruct the cryptographic token.',
    web:         'Breach the target perimeter and exfiltrate the verification token.',
    code_review: 'Conduct SAST analysis on codebase, catalog critical flaws, and submit the flag.',
    final:       'Analyze the operational manifesto and extract the master incident token.',
  };
  const objectiveLine = objectiveLines[challenge.type] || 'Analyze vector telemetry and isolate the verification token.';

  // Tactical clue (mascot_hint from data, or a fallback)
  const tacticLine = challenge.mascot_hint || 'Analyze the telemetry stream and correlate target artifacts.';

  const script = [
    [e0,     `OPERATIONAL BRIEFING: "${challenge.name}"`,        0   ],
    [e0,     openingSentence || challenge.name,                  2000],
    ...(secondSentence ? [[e1, secondSentence, 3800]] : []),
    [e1,     `Threat Classification: ${challenge.difficulty.toUpperCase()} // Value: ${challenge.points} PTS`, secondSentence ? 5600 : 3800],
    ['idle', objectiveLine,                                      secondSentence ? 7400 : 5600],
    [e2,     `Tactical Assessment: ${tacticLine}`,               secondSentence ? 9400 : 7600],
    ['idle', 'Maintain operational security. Standing by for token submission.', secondSentence ? 11400 : 9600],
  ];

  runBriefingScript(script);
}

function runBriefingScript(script) {
  clearBriefingTimers();
  script.forEach(([emotion, text, delay]) => {
    const t = setTimeout(() => {
      Mascot.setEmotion(emotion, text);
    }, delay);
    briefingTimers.push(t);
  });
}

function renderChallengeFiles(challenge) {
  if (!challenge.files || challenge.files.length === 0) return '';
  return `
    <div style="margin-bottom:20px">
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);letter-spacing:.15em;text-transform:uppercase;margin-bottom:10px">Source Files</div>
      <div class="code-files-container">
        ${challenge.files.map(f => `
          <div class="code-file-block">
            <div class="code-file-header">
              <span>${animEmoji('📄')}</span>
              <span class="code-file-name">${escapeHtml(f.name)}</span>
            </div>
            <div class="code-file-body">${escapeHtml(f.content)}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderVulnChecklist(challenge, isSolved) {
  if (!challenge.vulnerabilities || challenge.vulnerabilities.length === 0) return '';
  const submitted = Store.get('vuln_' + challenge.id + '_' + currentUser.id, []);
  return `
    <div style="margin-bottom:20px">
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);letter-spacing:.15em;text-transform:uppercase;margin-bottom:10px">Identify Vulnerabilities</div>
      <div class="vuln-checklist" id="vuln-list">
        ${challenge.vulnerabilities.map(v => {
          const isSelected = submitted.includes(v.id);
          return `
            <div class="vuln-item${isSelected ? ' selected' : ''}" id="vuln-${v.id}" onclick="toggleVuln('${challenge.id}','${v.id}',event)" data-id="${v.id}">
              <div class="vuln-checkbox">${isSelected ? '✓' : ''}</div>
              <div class="vuln-name">${v.name}</div>
              <div style="display:flex;align-items:center;gap:8px">
                <span class="vuln-severity ${v.severity}">${v.severity}</span>
                <span class="vuln-points">+${v.points}pts</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

window.toggleVuln = (challengeId, vulnId, e) => {
  e.stopPropagation();
  const item = $(`#vuln-${vulnId}`);
  if (!item) return;
  const selected = item.classList.toggle('selected');
  item.querySelector('.vuln-checkbox').textContent = selected ? '✓' : '';
  Sound.play('click');
  const stored = Store.get('vuln_' + challengeId + '_' + currentUser.id, []);
  if (selected && !stored.includes(vulnId)) stored.push(vulnId);
  else if (!selected) { const i = stored.indexOf(vulnId); if (i > -1) stored.splice(i, 1); }
  Store.set('vuln_' + challengeId + '_' + currentUser.id, stored);
};

function renderFlagSubmit(challenge, isSolved) {
  if (isSolved) {
    return `
      <div class="flag-submit-section">
        <div class="solved-overlay">
          <span class="solved-icon">${animEmoji('🎉')}</span>
          <div>
            <div class="solved-text">Challenge Solved!</div>
            <div class="solved-pts text-green">${challenge.points} pts earned</div>
          </div>
        </div>
        ${challenge.unlock_message ? `<div style="margin-top:12px;padding:12px;background:rgba(0,245,255,0.04);border:1px solid var(--border);border-radius:var(--radius-md);font-size:13px;color:var(--text-secondary);font-style:italic">"${challenge.unlock_message}"</div>` : ''}
      </div>
    `;
  }

  const isCode = challenge.type === 'code_review' && challenge.vulnerabilities?.length > 0;

  return `
    <div class="flag-submit-section">
      ${isCode ? `
        <div style="margin-bottom:16px;font-family:var(--font-mono);font-size:12px;color:var(--text-dim)">
          Select the vulnerabilities above, then submit your flag below.
        </div>
      ` : ''}
      <div class="flag-submit-label">Submit Answer</div>
      <div class="flag-input-wrap">
        <input type="text" class="flag-input" id="flag-input-${challenge.id}"
          placeholder="Enter plain text answer..."
          onkeydown="if(event.key==='Enter')submitFlag('${challenge.id}')"
          autocomplete="off" autocorrect="off" spellcheck="false">
        <button class="btn btn-green" id="submit-btn-${challenge.id}" onclick="submitFlag('${challenge.id}')">
          SUBMIT
        </button>
      </div>
      <div class="flag-feedback" id="flag-feedback-${challenge.id}"></div>
    </div>
  `;
}

function renderHints(challenge) {
  const revealed = currentUser.revealedHints || [];
  return challenge.hints.map(hint => {
    const isRevealed = revealed.includes(hint.id);
    return `
      <div class="hint-item">
        <button class="hint-reveal-btn${isRevealed ? ' revealed' : ''}"
          id="hint-btn-${hint.id}"
          onclick="${isRevealed ? '' : `revealHint('${challenge.id}','${hint.id}')`}">
          <span>${isRevealed ? `${animEmoji('💡')} Hint ` + hint.order + ' (revealed)' : `${animEmoji('💡')} Hint ` + hint.order}</span>
          ${!isRevealed ? `<span class="hint-cost">-${hint.cost} pts</span>` : ''}
        </button>
        <div class="hint-content${isRevealed ? ' visible' : ''}" id="hint-content-${hint.id}">
          ${isRevealed ? hint.text : ''}
        </div>
      </div>
    `;
  }).join('');
}

window.revealHint = (challengeId, hintId) => {
  const challenge = challengesData.challenges.find(c => c.id === challengeId);
  const hint = challenge?.hints.find(h => h.id === hintId);
  if (!hint) return;

  const already = (currentUser.revealedHints || []).includes(hintId) || (currentUser.unlockedHints || []).includes(hintId);
  if (already) {
    toast('Already Revealed', 'This tactical intel has already been unlocked.', 'info', 2000);
    return;
  }

  Sound.play('hint');
  Mascot.react('worried', `Revealing hint... that'll cost you ${hint.cost} points.`);

  // Confirm before revealing
  if (hint.cost > 0) {
    showModal('Reveal Tactical Hint?', `
      <p class="text-slate-700 mb-3 text-sm">Revealing this tactical hint will deduct <strong class="text-rose-600 font-mono font-bold">${hint.cost} points</strong> from your operative score.</p>
      <div class="p-3 bg-slate-100 rounded-lg border border-slate-200 flex items-center justify-between text-xs font-mono">
        <span class="text-slate-500 font-bold">CURRENT SCORE:</span>
        <span class="text-emerald-600 font-bold text-sm">${currentUser.score || 0} PTS</span>
      </div>
    `, [
      { label: `REVEAL (-${hint.cost} PTS)`, cls: 'bg-rose-600 hover:bg-rose-700 text-white', action: () => doRevealHint(challengeId, hintId, hint) },
      { label: 'CANCEL', cls: 'bg-slate-200 hover:bg-slate-300 text-slate-700', action: () => closeModal() }
    ]);
  } else {
    doRevealHint(challengeId, hintId, hint);
  }
};

function doRevealHint(challengeId, hintId, hint) {
  closeModal();
  window._inFlightHints = window._inFlightHints || new Set();
  if (window._inFlightHints.has(hintId)) return;

  if (!currentUser.revealedHints) currentUser.revealedHints = [];
  if (!currentUser.unlockedHints) currentUser.unlockedHints = [];
  if (currentUser.revealedHints.includes(hintId) || currentUser.unlockedHints.includes(hintId)) {
    return;
  }

  window._inFlightHints.add(hintId);
  currentUser.revealedHints.push(hintId);
  currentUser.unlockedHints.push(hintId);

  const cost = hint.cost || 0;
  currentUser.score = Math.max(0, (currentUser.score || 0) - cost);

  saveUser();
  updateNavScore();
  updateMissionHud();

  // Atomically persist hint reveal to server
  const challenge = challengesData.challenges.find(c => c.id === challengeId);
  const hintIndex = challenge?.hints ? challenge.hints.findIndex(h => h.id === hintId) : 0;
  Api.post('/api/hints/reveal', { challengeId, hintIndex: hintIndex >= 0 ? hintIndex : 0 }).then(res => {
    if (res && typeof res.score === 'number') {
      currentUser.score = res.score;
      saveUser();
      updateNavScore();
      updateMissionHud();
    }
  }).catch(() => {}).finally(() => {
    window._inFlightHints.delete(hintId);
  });

  // Re-render active challenge view to show unlocked hint immediately without resetting scrolls
  if (currentChallenge && currentChallenge.id === challengeId) {
    const solved = currentUser.solvedChallenges || [];
    const isSolved = solved.includes(currentChallenge.id);
    if (currentChallenge.round === 1) {
      renderOsintChallenge(currentChallenge, isSolved);
    } else if (currentChallenge.round === 2) {
      renderWebCtfChallenge(currentChallenge, isSolved);
    } else {
      renderCodeReviewChallenge(currentChallenge, isSolved);
    }
  }

  // Also support classic challenge view elements if present
  const btn = $(`#hint-btn-${hintId}`);
  const content = $(`#hint-content-${hintId}`);
  if (btn) { btn.classList.add('revealed'); btn.innerHTML = `<span>${animEmoji('💡')} Hint revealed</span>`; }
  if (content) { content.textContent = hint.text; content.classList.add('visible'); }

  Sound.play('unlock');
  Mascot.react('thinking', `Hint decrypted: "${hint.text.slice(0, 35)}..."`);
  toast('Hint Revealed', `-${hint.cost} points deducted. Tactical intel decrypted!`, 'warning', 3500);
}

/* ── Flag Submission ─────────────────────────────────────── */
window.submitFlag = (challengeId, customInputId) => {
  const challenge = challengesData.challenges.find(c => c.id === challengeId);
  if (!challenge) return;

  const input = (customInputId && $(`#${customInputId}`)) ||
                $(`#flag-input-${challengeId}`) ||
                $('#osint-flag-input') ||
                $('#web-flag-input') ||
                $('#code-flag-input');
  const feedback = $(`#flag-feedback-${challengeId}`) || $('#flag-feedback-status') || $('#flag-feedback-web') || { className: '', textContent: '', innerHTML: '' };
  const btn = $(`#submit-btn-${challengeId}`) || (input ? input.parentElement?.querySelector('button') : null) || { disabled: false, textContent: '' };
  if (!input || !feedback) return;

  const submitted = input.value.trim();
  if (!submitted) return;

  window._inFlightSubmissions = window._inFlightSubmissions || new Set();
  if (window._inFlightSubmissions.has(challengeId)) return;
  window._inFlightSubmissions.add(challengeId);

  const clearInFlight = () => window._inFlightSubmissions.delete(challengeId);

  // Already solved or bypassed
  if ((currentUser.solvedChallenges || []).includes(challengeId)) {
    clearInFlight();
    feedback.className = 'flag-feedback correct';
    feedback.textContent = '✓ This challenge has already been solved.';
    Sound.play('notify');
    return;
  }
  if ((currentUser.skippedChallenges || []).includes(challengeId)) {
    clearInFlight();
    feedback.className = 'flag-feedback info';
    feedback.textContent = '⏩ This challenge was bypassed (-30 PTS).';
    Sound.play('notify');
    return;
  }

  // Rate limiting
  const key = challengeId;
  const now = Date.now();
  if (!submissionRateLimits[key]) submissionRateLimits[key] = { count: 0, resetAt: now + 60000 };
  if (now > submissionRateLimits[key].resetAt) submissionRateLimits[key] = { count: 0, resetAt: now + 60000 };
  submissionRateLimits[key].count++;

  if (submissionRateLimits[key].count > 10) {
    clearInFlight();
    feedback.className = 'flag-feedback wrong';
    feedback.textContent = '⏱ Too many submissions. Please wait before trying again.';
    Sound.play('rate');
    Mascot.react('annoyed', 'Too many tries. Take a breath.');
    return;
  }

  // Record submission
  if (!currentUser.submissions) currentUser.submissions = [];
  currentUser.submissions.push({
    challengeId,
    value: submitted,
    timestamp: new Date().toISOString(),
    correct: false
  });

  // Validate answer (ultra-forgiving: strip FLAG{...} wrapper if typed, case-insensitive, flexible spaces/underscores)
  const cleanAns = (s) => {
    if (!s) return '';
    return s.toString().trim().toUpperCase()
      .replace(/^FLAG\{/i, '')
      .replace(/\}$/, '')
      .replace(/[\s\-_]+/g, '_')
      .replace(/^_+|_+$/g, '');
  };

  // Multi-format decoders to support authentic challenge encodings:
  // Base64, Hexadecimal (0x...), ROT13 Caesar cipher, and URL percent-encoding.
  const submissionCandidates = new Set();
  const rawTrimmed = submitted.trim();
  submissionCandidates.add(cleanAns(rawTrimmed));
  submissionCandidates.add(cleanAns(rawTrimmed).replace(/_/g, ''));

  // 1. URL / Percent decoding (e.g. WEB-05)
  if (rawTrimmed.includes('%')) {
    try {
      const uDec = decodeURIComponent(rawTrimmed);
      if (uDec && uDec !== rawTrimmed) {
        submissionCandidates.add(cleanAns(uDec));
        submissionCandidates.add(cleanAns(uDec).replace(/_/g, ''));
      }
    } catch (e) {}
  }

  // 2. Hexadecimal decoding (e.g. WEB-01, WEB-03: handles optional 0x prefix)
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
    } catch (e) {}
  }

  // 3. Base64 decoding (e.g. WEB-04)
  if (/^[A-Za-z0-9+/=_-]{8,}$/.test(rawTrimmed)) {
    try {
      const b64Dec = atob(rawTrimmed.replace(/-/g, '+').replace(/_/g, '/'));
      if (b64Dec && /^[\x20-\x7E]+$/.test(b64Dec)) {
        submissionCandidates.add(cleanAns(b64Dec));
        submissionCandidates.add(cleanAns(b64Dec).replace(/_/g, ''));
      }
    } catch (e) {}
  }

  // 4. ROT13 Caesar cipher decoding (e.g. WEB-02)
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
    } catch (e) {}
  }

  // 5. Morse code pulse decoding (e.g. OSINT-04: '-- --- .-. ... .   .. ...   .- .-.. .. ...- .')
  if (/^[.\-\s\/|_]{5,}$/.test(rawTrimmed)) {
    try {
      const morseDec = typeof window.decodeMorse === 'function' ? window.decodeMorse(rawTrimmed) : null;
      if (morseDec && morseDec !== rawTrimmed) {
        submissionCandidates.add(cleanAns(morseDec));
        submissionCandidates.add(cleanAns(morseDec).replace(/_/g, ''));
      }
    } catch (e) {}
  }

  const normalizedSubmit = cleanAns(submitted);
  const userExpectedFlag = cleanAns(getUserChallengeFlag(challenge.id, currentUser));
  const userExpectedFlagNoUnder = userExpectedFlag.replace(/_/g, '');
  const normalizedBaseFlag = cleanAns(challenge.flag);
  const normalizedBaseFlagNoUnder = normalizedBaseFlag.replace(/_/g, '');

  let isCorrect = submissionCandidates.has(userExpectedFlag) ||
                  submissionCandidates.has(userExpectedFlagNoUnder) ||
                  submissionCandidates.has(normalizedBaseFlag) ||
                  submissionCandidates.has(normalizedBaseFlagNoUnder);

  if (!isCorrect && challenge.acceptable_answers && Array.isArray(challenge.acceptable_answers)) {
    for (const ans of challenge.acceptable_answers) {
      const normAns = cleanAns(ans);
      if (submissionCandidates.has(normAns) || submissionCandidates.has(normAns.replace(/_/g, ''))) {
        isCorrect = true;
        break;
      }
    }
  }

  if (!isCorrect && challenge.options && challenge.correct_option !== undefined) {
    const optAns = cleanAns(challenge.options[challenge.correct_option]);
    if (submissionCandidates.has(optAns) || submissionCandidates.has(optAns.replace(/_/g, ''))) {
      isCorrect = true;
    }
  }

  if (!isCorrect && challenge.id === 'CODE-05') {
    const lower = rawTrimmed.toLowerCase();
    if (lower.includes('idor') || lower.includes('bola') || lower.includes('object') || lower.includes('broken access') || lower.includes('authorization')) {
      isCorrect = true;
    }
  }

  if (isCorrect) {
    // Award points
    if (!currentUser.solvedChallenges) currentUser.solvedChallenges = [];
    currentUser.solvedChallenges.push(challengeId);

    // Code review bonus points for selected vulnerabilities
    let bonusPoints = 0;
    if (challenge.type === 'code_review' && challenge.vulnerabilities?.length > 0) {
      const selected = Store.get('vuln_' + challengeId + '_' + currentUser.id, []);
      const expectedIds = challenge.vulnerabilities.map(v => v.id);
      bonusPoints = selected
        .filter(id => expectedIds.includes(id))
        .reduce((s, id) => {
          const v = challenge.vulnerabilities.find(v => v.id === id);
          return s + (v?.points || 0);
        }, 0);
    }

    const totalAwarded = challenge.points + bonusPoints;
    currentUser.score = (currentUser.score || 0) + totalAwarded;
    currentUser.submissions[currentUser.submissions.length - 1].correct = true;
    currentUser.lastSolve = new Date().toISOString();

    saveUser();
    // Also persist to server (SQLite + leaderboard cache bust)
    Api.post('/api/submit', { challengeId, answer: submitted, bonusPoints }).then(res => {
      if (res && typeof res.score === 'number') {
        currentUser.score = res.score;
        saveUser();
        updateNavScore();
        updateMissionHud();
      }
    }).catch(() => {}).finally(() => {
      clearInFlight();
    });
    updateNavScore();
    animateScoreIncrease(totalAwarded);


    Sound.play('correct');
    Mascot.react('hype', `ANSWER ACCEPTED! +${totalAwarded} points! Keep going.`);

    input.className = 'flag-input correct';
    feedback.className = 'flag-feedback correct';
    const nextTargetAfterSolve = getNextActiveChallenge(currentUser);
    const advanceBtnHtml = nextTargetAfterSolve ? `
      <div class="mt-2.5">
        <button onclick="renderChallenge('${nextTargetAfterSolve.id}')" class="w-full py-2.5 bg-gradient-to-r from-gamer-emerald to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-bold text-xs rounded-lg shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer font-telemetry">
          <span>PROCEED TO NEXT TARGET [${nextTargetAfterSolve.id}: ${nextTargetAfterSolve.name}]</span>
          <span class="material-symbols-outlined text-sm">arrow_forward</span>
        </button>
      </div>
    ` : '';
    feedback.innerHTML = `✓ Correct Answer! <strong>+${totalAwarded} points</strong> awarded.${bonusPoints > 0 ? ` (includes +${bonusPoints} code review bonus)` : ''}${advanceBtnHtml}`;

    btn.disabled = true;
    btn.textContent = 'SOLVED ✓';

    toast('Flag Captured!', `+${totalAwarded} points — "${challenge.name}" solved!`, 'success', 5000);
    updateMissionHud();

    // Trigger Mascot Debrief Modal celebrating solve & advancing
    setTimeout(() => showSolveSuccessDebrief(challenge), 450);

    // Check for round completion
    setTimeout(() => checkRoundCompletion(), 800);

    // Update submission station in-place to full solved state ONLY if still viewing this challenge
    window._solveTransitionTimer = setTimeout(() => {
      if (currentChallenge && currentChallenge.id === challenge.id) {
        const flagContainer = input.closest('.hud-card')?.querySelector('.font-telemetry.space-y-3') || input.closest('.space-y-3');
        if (flagContainer) {
          flagContainer.innerHTML = `
            <div class="p-4 bg-emerald-50 border-2 border-emerald-300 rounded-xl space-y-3">
              <div class="flex items-center gap-2 text-emerald-800 font-bold text-xs font-telemetry">
                <span class="material-symbols-outlined text-emerald-600 text-base">check_circle</span>
                <span>OBJECTIVE CLEARED (+${totalAwarded} PTS) &mdash; Answer accepted and points awarded!</span>
              </div>
              ${nextTargetAfterSolve ? `
                <button onclick="renderChallenge('${nextTargetAfterSolve.id}')" class="w-full py-3 bg-gradient-to-r from-gamer-emerald to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-bold text-xs rounded-lg shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer font-telemetry transform active:scale-[0.98]">
                  <span>PROCEED TO NEXT TARGET [${nextTargetAfterSolve.id}: ${nextTargetAfterSolve.name}]</span>
                  <span class="material-symbols-outlined text-sm">arrow_forward</span>
                </button>
              ` : `
                <button onclick="navigate('dashboard')" class="w-full py-3 bg-gamer-purple hover:bg-purple-700 text-white font-bold text-xs rounded-lg shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer font-telemetry">
                  <span>ALL OBJECTIVES COMPLETE &mdash; RETURN TO MISSION CONTROL</span>
                </button>
              `}
            </div>
          `;
        }
      }
    }, 600);

  } else {
    // 1. Anti-Cheat Check: Did the user submit another registered operative's unique flag?
    const allUsers = Store.get('users', []);
    const sharedUser = allUsers.find(u => {
      if (!u || u.id === currentUser.id) return false;
      const otherFlag = cleanAns(getUserChallengeFlag(challenge.id, u));
      const otherFlagNoUnder = otherFlag.replace(/_/g, '');
      return submissionCandidates.has(otherFlag) || submissionCandidates.has(otherFlagNoUnder);
    });

    if (sharedUser) {
      Sound.play('wrong');
      const otherName = sharedUser.username || sharedUser.name || 'another operative';
      Mascot.react('angry', `Flag sharing detected! Token belongs to operative "${otherName}". Every operative must solve independently.`);
      
      clearInFlight();
      input.className = 'flag-input wrong';
      feedback.className = feedback.id === 'flag-feedback-web' ? 'text-xs pt-2 text-rose-600 font-bold bg-rose-50 border border-rose-200 rounded p-2.5' : 'flag-feedback wrong';
      feedback.innerHTML = `✗ <strong>Shared / Mismatched Token Detected!</strong> This verification token belongs to operative <code>${escapeHtml(otherName)}</code>. Every operative must discover their own unique token in their own session!`;
      setTimeout(() => { input.className = 'flag-input'; }, 1500);
      return;
    }

    // 2. Incomplete pattern check: Did the user submit only the base flag without their personalized suffix on a live web target?
    const normalizedBaseFlagNoUnder = normalizedBaseFlag.replace(/_/g, '');
    const isBasePattern = submissionCandidates.has(normalizedBaseFlag) ||
                          submissionCandidates.has(normalizedBaseFlagNoUnder);

    if (isBasePattern && (challenge.round === 2 || challenge.id.startsWith('WEB-'))) {
      Sound.play('rate');
      Mascot.react('thinking', 'That is only the base pattern. Submit your full personalized token from your session.');

      clearInFlight();
      input.className = 'flag-input wrong';
      feedback.className = feedback.id === 'flag-feedback-web' ? 'text-xs pt-2 text-amber-700 font-bold bg-amber-50 border border-amber-200 rounded p-2.5' : 'flag-feedback wrong';
      feedback.innerHTML = `⚠️ <strong>Incomplete Verification Token!</strong> You submitted the base pattern. Each operative has a unique session-derived token (e.g. <code>${challenge.flag}_XXXXXX</code>). Submit your complete token captured from the target app.`;
      setTimeout(() => { input.className = 'flag-input'; }, 1500);
      return;
    }

    clearInFlight();
    Sound.play('wrong');
    showMascotSprite('sad', '✗ Not quite operative, that answer is incorrect. Review the clues carefully and try again!');

    input.className = 'flag-input wrong';
    feedback.className = feedback.id === 'flag-feedback-web' ? 'text-xs pt-2 text-rose-600 font-semibold' : 'flag-feedback wrong';
    feedback.textContent = '✗ Incorrect verification answer. Review the clues carefully and try again.';

    setTimeout(() => {
      input.className = 'flag-input';
    }, 1000);
  }
};

function animateScoreIncrease(amount) {
  const dashScore = $('#dash-score');
  const navScore = $('#nav-score-val');
  const target = currentUser.score;
  const start = target - amount;
  let current = start;
  const step = Math.max(1, Math.floor(amount / 30));
  const timer = setInterval(() => {
    current = Math.min(current + step, target);
    if (dashScore) dashScore.textContent = current;
    if (navScore) navScore.textContent = current;
    if (current >= target) clearInterval(timer);
  }, 30);
}

function checkRoundCompletion() {
  const solved = currentUser.solvedChallenges || [];
  const challenges = challengesData.challenges;

  for (const round of contestData.rounds) {
    const roundChallenges = challenges.filter(c => c.round === round.id);
    const allSolved = roundChallenges.every(c => solved.includes(c.id));
    const prevSolved = roundChallenges.slice(0, -1).every(c => {
      const prev = solved.filter(id => {
        const ch = challenges.find(c => c.id === id);
        return ch && ch.round === round.id;
      });
      return prev.length === roundChallenges.length - 1;
    });

    if (allSolved) {
      const nextRound = contestData.rounds.find(r => r.id === round.id + 1);
      if (nextRound) {
        Sound.play('round');
        Mascot.react('smug', `Round ${round.id} COMPLETE! ${nextRound.name} is now unlocked.`);
        toast('Round Complete!', `${round.name} finished! ${nextRound.name} is now unlocked.`, 'success', 6000);
      } else {
        // Final completion
        Sound.play('victory');
        Mascot.react('hype', `INVESTIGATION COMPLETE! You've found 0xRAVEN's trail! Incredible work.`);
        toast('🎉 Investigation Complete!', 'You have solved all challenges. The final flag has been found.', 'success', 8000);
        showVictoryModal();
      }
      break;
    }
  }
}

function showVictoryModal() {
  showModal('🎉 Investigation Complete!', `
    <div style="text-align:center;padding:20px 0">
      <div style="font-size:48px;margin-bottom:16px">${animEmoji('🏆', 'text-5xl')}</div>
      <div style="font-family:var(--font-mono);font-size:18px;color:var(--cyan);margin-bottom:8px">OPERATION 0xRAVEN</div>
      <div style="font-family:var(--font-mono);font-size:14px;color:var(--text-secondary);margin-bottom:24px">SOLVED</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.7;margin-bottom:16px">${contestData.contest.story.outro}</div>
      <div style="font-family:var(--font-mono);font-size:24px;color:var(--green)">Final Score: ${currentUser.score}</div>
    </div>
  `, [
    { label: 'View Leaderboard', cls: 'btn-primary', action: () => { closeModal(); navigate('leaderboard'); } },
    { label: 'Dashboard', cls: 'btn-secondary', action: () => { closeModal(); navigate('dashboard'); } }
  ]);
}

/* ── Leaderboard Telemetry & Engine ──────────────────────── */
function buildLeaderboard() {
  let sourceUsers = _cachedLeaderboard.length > 0 ? [..._cachedLeaderboard] : Store.get('users', getDefaultUsers());
  sourceUsers = sourceUsers.filter(u => u.role !== 'admin' && !u.disqualified);

  // Sync current user's live in-memory state
  if (currentUser) {
    const idx = sourceUsers.findIndex(u => u.id === currentUser.id || u.username === currentUser.username);
    const mySolved = currentUser.solvedChallenges || [];
    const mySolvedDetails = currentUser.solvedDetails || [];
    const myLastSolve = mySolvedDetails.length ? mySolvedDetails[mySolvedDetails.length - 1].solvedAt : currentUser.lastSolve;
    if (idx >= 0) {
      sourceUsers[idx] = {
        ...sourceUsers[idx],
        score: currentUser.score,
        solvedChallenges: mySolved,
        solvedDetails: mySolvedDetails,
        lastSolve: myLastSolve,
        skipsUsed: currentUser.skipsUsed || 0,
      };
    } else {
      sourceUsers.push({
        id: currentUser.id,
        username: currentUser.username,
        team: currentUser.team || currentUser.username,
        score: currentUser.score || 0,
        solvedChallenges: mySolved,
        solvedDetails: mySolvedDetails,
        lastSolve: myLastSolve,
        skipsUsed: currentUser.skipsUsed || 0,
      });
    }
  }

  const examStartTime = Store.get('examStartTime', null);

  return sourceUsers.map(u => {
    const userChallenges = window.getUserChallenges ? window.getUserChallenges(u) : (challengesData?.challenges || []);
    const timings = window.calculateContestantTimings ? window.calculateContestantTimings(u, userChallenges, examStartTime) : { totalCompletedTimeMs: 0 };
    const solvedDetails = u.solvedDetails || [];
    const lastSolve = u.lastSolve || (solvedDetails.length ? solvedDetails[solvedDetails.length - 1].solvedAt : null);
    const solvedList = u.solvedChallenges || [];
    const osintSolved = solvedList.filter(id => id.startsWith('OSINT')).length;
    const webSolved = solvedList.filter(id => id.startsWith('WEB')).length;
    const codeSolved = solvedList.filter(id => id.startsWith('CODE')).length;

    return {
      id: u.id,
      team: u.team || u.username,
      username: u.username,
      score: u.score || 0,
      solved: solvedList.length,
      totalSteps: userChallenges.length || 13,
      osintSolved,
      webSolved,
      codeSolved,
      skipsUsed: u.skipsUsed || 0,
      lastSolve: lastSolve,
      totalTimeMs: timings.totalCompletedTimeMs || 0,
    };
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.solved !== a.solved) return b.solved - a.solved;
    if (a.totalTimeMs && b.totalTimeMs && a.totalTimeMs !== b.totalTimeMs) return a.totalTimeMs - b.totalTimeMs;
    if (a.lastSolve && b.lastSolve) return new Date(a.lastSolve) - new Date(b.lastSolve);
    return 0;
  });
}

function buildLeaderboardHTML({ lb, me, isExamOver = false }) {
  const totalCompetitors = lb.length;
  const topScore = lb.length > 0 ? lb[0].score : 0;
  const avgScore = lb.length > 0 ? Math.round(lb.reduce((acc, u) => acc + (u.score || 0), 0) / lb.length) : 0;
  const myRank = me ? lb.findIndex(u => u.id === me.id || u.username === me.username) + 1 : 0;
  const myEntry = myRank > 0 ? lb[myRank - 1] : null;
  const pointsToAbove = myRank > 1 ? ((lb[myRank - 2].score || 0) - (myEntry?.score || 0)) + 1 : 0;
  const aboveUser = myRank > 1 ? lb[myRank - 2] : null;

  // Podium contestants
  const first = lb[0];
  const second = lb[1];
  const third = lb[2];

  const renderPodiumCard = (entry, rank, variant, medalEmoji, titleLabel) => {
    if (!entry) return '';
    const isMe = me && (entry.id === me.id || entry.username === me.username);
    const totalSteps = entry.totalSteps || 13;
    const pct = Math.round(((entry.solved || 0) / totalSteps) * 100);
    const osintPct = Math.min(100, Math.round(((entry.osintSolved || 0) / 4) * 100));
    const webPct = Math.min(100, Math.round(((entry.webSolved || 0) / 4) * 100));
    const codePct = Math.min(100, Math.round(((entry.codeSolved || 0) / 5) * 100));

    return `
      <div class="lb-podium-card lb-podium-${variant} p-5 flex flex-col justify-between ${rank === 1 ? 'md:order-2 md:-translate-y-3 z-20' : rank === 2 ? 'md:order-1 z-10' : 'md:order-3 z-10'}">
        <div>
          <!-- Header Tag -->
          <div class="flex items-center justify-between gap-2 pb-3 border-b border-border-line">
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-extrabold lb-podium-badge-${variant}">
              <span>${animEmoji(medalEmoji)}</span>
              <span>${titleLabel}</span>
            </span>
            <span class="text-[11px] font-mono font-bold text-slate-600">RANK #${rank}</span>
          </div>

          <!-- Operative Identity -->
          <div class="mt-4 flex items-center gap-3">
            <div class="w-11 h-11 rounded-xl bg-slate-100 border border-border-line flex items-center justify-center text-xl shrink-0 shadow-xs">
              ${rank === 1 ? animEmoji('👑') : rank === 2 ? animEmoji('🥈') : animEmoji('🥉')}
            </div>
            <div class="min-w-0">
              <div class="font-headline-sm font-extrabold text-dark-title text-base truncate flex items-center gap-1.5">
                <span>${escapeHtml(entry.team || entry.username)}</span>
                ${isMe ? '<span class="px-1.5 py-0.2 rounded text-[9px] bg-gamer-purple text-white font-bold font-mono">YOU</span>' : ''}
              </div>
              <div class="text-xs font-mono text-dark-muted truncate">@${escapeHtml(entry.username)}</div>
            </div>
          </div>

          <!-- Score Deck -->
          <div class="mt-4 p-3 bg-slate-50 border border-slate-200/80 rounded-xl">
            <div class="flex items-baseline justify-between">
              <span class="text-[10px] font-mono text-dark-muted font-bold tracking-wider uppercase">SCORE</span>
              <span class="font-mono text-lg font-black text-gamer-purple">${entry.score || 0} <span class="text-xs font-bold text-slate-600">PTS</span></span>
            </div>
            <!-- Clearance spectrum -->
            <div class="mt-2 space-y-1">
              <div class="flex items-center justify-between text-[11px] font-mono">
                <span class="text-slate-600">${entry.solved || 0}/${totalSteps} TARGETS CLEARED</span>
                <span class="font-bold text-emerald-600">${pct}%</span>
              </div>
              <div class="lb-clearance-bar">
                <div class="seg-osint" style="width: ${osintPct * 0.33}%" title="OSINT: ${entry.osintSolved || 0}/4"></div>
                <div class="seg-web" style="width: ${webPct * 0.33}%" title="Web CTF: ${entry.webSolved || 0}/4"></div>
                <div class="seg-code" style="width: ${codePct * 0.34}%" title="Code Review: ${entry.codeSolved || 0}/5"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- Card Footer -->
        <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] font-mono text-dark-muted">
          <span>${entry.skipsUsed ? `${entry.skipsUsed} skips used` : '0 skips used'}</span>
          <span class="truncate max-w-[130px]">${entry.lastSolve ? formatTime(entry.lastSolve) : 'No Telemetry'}</span>
        </div>
      </div>
    `;
  };

  return `
    <div class="max-w-6xl mx-auto space-y-6">
      
      <!-- Top Command Header -->
      <div class="bg-white rounded-2xl border border-border-line p-5 sm:p-6 shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-5 hud-card">
        <div class="space-y-1.5 max-w-2xl">
          <div class="flex items-center gap-2 text-xs font-mono text-dark-muted">
            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">
              <span class="w-2 h-2 rounded-full bg-gamer-purple animate-pulse"></span>
              ${isExamOver ? 'FINAL AUDIT LEDGER // LOCKED' : 'TOURNAMENT LIVE TELEMETRY'}
            </span>
            <span>//</span>
            <span>OPERATION 0xRAVEN</span>
          </div>
          <h1 class="font-headline-lg text-2xl sm:text-3xl font-extrabold text-dark-title tracking-tight flex items-center gap-2.5">
            ${animEmoji('🏆')} STANDINGS & AUDIT LEDGER
          </h1>
          <p class="text-xs font-mono text-slate-600 leading-relaxed">
            ${isExamOver ? 'The contest has officially concluded. Final points, tactical deductions, and solve audits are permanently verified below.' : 'Real-time verified score progression and adversarial compromise telemetry across all active squads.'}
          </p>
        </div>

        <!-- Telemetry Stats & Refresh -->
        <div class="flex flex-wrap items-center gap-3 shrink-0">
          <div class="grid grid-cols-3 gap-2 font-mono text-center">
            <div class="bg-surface border border-border-line px-3 py-2 rounded-lg">
              <div class="text-[9px] text-dark-muted font-bold uppercase">SQUADS</div>
              <div class="text-sm font-black text-dark-title">${totalCompetitors}</div>
            </div>
            <div class="bg-surface border border-border-line px-3 py-2 rounded-lg">
              <div class="text-[9px] text-dark-muted font-bold uppercase">TOP SCORE</div>
              <div class="text-sm font-black text-gamer-purple">${topScore} <span class="text-[9px]">PTS</span></div>
            </div>
            <div class="bg-surface border border-border-line px-3 py-2 rounded-lg">
              <div class="text-[9px] text-dark-muted font-bold uppercase">FIELD AVG</div>
              <div class="text-sm font-black text-gamer-cyan">${avgScore} <span class="text-[9px]">PTS</span></div>
            </div>
          </div>

          <button onclick="window.refreshLeaderboardView()" class="px-4 py-2.5 bg-surface-muted hover:bg-slate-200 border border-border-line text-slate-800 rounded-lg text-xs font-mono font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer active:scale-95" title="Refresh match telemetry">
            <span class="material-symbols-outlined text-sm text-gamer-purple">refresh</span>
            <span>REFRESH</span>
          </button>
        </div>
      </div>

      <!-- Top-3 Champions Podium Deck -->
      ${lb.length >= 2 ? `
        <div class="lb-podium-grid">
          ${renderPodiumCard(second, 2, 'silver', '🥈', 'RUNNER UP')}
          ${renderPodiumCard(first, 1, 'gold', '👑', 'TOURNAMENT CHAMPION')}
          ${renderPodiumCard(third, 3, 'bronze', '🥉', 'THIRD PLACE')}
        </div>
      ` : ''}

      <!-- Operative Personal Standing Telemetry Card (if logged in) -->
      ${myEntry ? `
        <div class="lb-you-card p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div class="flex items-center gap-3.5">
            <div class="w-12 h-12 rounded-xl bg-gamer-purple text-white flex items-center justify-center font-mono font-black text-base shadow-sm shrink-0">
              #${myRank}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <span class="font-headline-sm font-black text-dark-title text-sm">${escapeHtml(myEntry.team || myEntry.username)}</span>
                <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-gamer-purple text-white shadow-2xs">YOUR SQUAD</span>
              </div>
              <div class="text-xs font-mono text-slate-600 mt-0.5">
                ${myRank === 1 ? '🥇 Defending #1 tournament position! Full operational dominance.' : `⚡ ${pointsToAbove} PTS behind #${myRank - 1} (${escapeHtml(aboveUser?.team || aboveUser?.username)}).`}
              </div>
            </div>
          </div>

          <div class="flex items-center gap-4 sm:gap-6 font-mono self-start sm:self-center">
            <div class="text-right">
              <div class="text-[10px] text-slate-500 font-bold uppercase">SCORE</div>
              <div class="text-base font-black text-gamer-purple">${myEntry.score || 0} PTS</div>
            </div>
            <div class="h-8 w-px bg-purple-200"></div>
            <div class="text-right">
              <div class="text-[10px] text-slate-500 font-bold uppercase">CLEARANCE</div>
              <div class="text-sm font-bold text-emerald-600">${myEntry.solved || 0}/${myEntry.totalSteps || 13}</div>
            </div>
            <div class="h-8 w-px bg-purple-200"></div>
            <div class="text-right">
              <div class="text-[10px] text-slate-500 font-bold uppercase">SKIPS</div>
              <div class="text-sm font-bold text-amber-700">${myEntry.skipsUsed || 0}/3</div>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- Interactive Search, Filter, and Standings Table Card -->
      <div class="bg-white rounded-2xl border border-border-line shadow-xs overflow-hidden hud-card">
        
        <!-- Table Control Bar -->
        <div class="p-4 border-b border-border-line bg-surface flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <!-- Search input -->
          <div class="relative w-full sm:w-80">
            <span class="material-symbols-outlined absolute left-3 top-2.5 text-slate-400 text-sm">search</span>
            <input 
              type="text" 
              id="lb-search-input" 
              oninput="window.filterLeaderboardTable()" 
              placeholder="Search operative or squad handle..." 
              class="w-full pl-9 pr-3.5 py-1.5 bg-white border border-border-line rounded-lg text-xs font-mono text-dark-title outline-none focus:border-gamer-purple focus:ring-1 focus:ring-purple-400/20 transition-all"
            />
          </div>

          <!-- Filter chips -->
          <div class="flex items-center gap-1.5 font-mono text-xs overflow-x-auto pb-1 sm:pb-0" id="lb-filter-chips">
            <button onclick="window.setLeaderboardFilter('all')" data-filter="all" class="lb-chip px-3 py-1.5 rounded-lg font-bold transition-all bg-gamer-purple text-white shadow-2xs">
              ALL (${totalCompetitors})
            </button>
            <button onclick="window.setLeaderboardFilter('top10')" data-filter="top10" class="lb-chip px-3 py-1.5 rounded-lg font-bold transition-all bg-white hover:bg-slate-100 text-slate-600 border border-border-line">
              TOP 10
            </button>
            ${myEntry ? `
              <button onclick="window.setLeaderboardFilter('me')" data-filter="me" class="lb-chip px-3 py-1.5 rounded-lg font-bold transition-all bg-white hover:bg-slate-100 text-slate-600 border border-border-line">
                MY SQUAD
              </button>
            ` : ''}
            <button onclick="window.setLeaderboardFilter('cleared')" data-filter="cleared" class="lb-chip px-3 py-1.5 rounded-lg font-bold transition-all bg-white hover:bg-slate-100 text-slate-600 border border-border-line">
              CLEARED
            </button>
          </div>
        </div>

        <!-- Standings Table -->
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs" id="lb-table">
            <thead class="bg-surface-muted border-b border-border-line text-slate-600 font-mono font-bold text-[11px] uppercase tracking-wider select-none">
              <tr>
                <th class="py-3.5 px-4 w-20">RANK</th>
                <th class="py-3.5 px-4">OPERATIVE / SQUAD</th>
                <th class="py-3.5 px-4">SCORE</th>
                <th class="py-3.5 px-4">CLEARANCE PROGRESS</th>
                <th class="py-3.5 px-4">SKIPS</th>
                <th class="py-3.5 px-4 text-right">LAST AUDIT TELEMETRY</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 font-mono text-xs" id="lb-table-body">
              ${lb.map((entry, i) => {
                const isMe = me && (entry.id === me.id || entry.username === me.username);
                const rankNum = i + 1;
                const totalSteps = entry.totalSteps || 13;
                const pct = Math.round(((entry.solved || 0) / totalSteps) * 100);
                const osintPct = Math.min(100, Math.round(((entry.osintSolved || 0) / 4) * 100));
                const webPct = Math.min(100, Math.round(((entry.webSolved || 0) / 4) * 100));
                const codePct = Math.min(100, Math.round(((entry.codeSolved || 0) / 5) * 100));

                return `
                  <tr class="lb-row ${isMe ? 'bg-purple-50/80 font-bold border-l-4 border-gamer-purple' : 'hover:bg-slate-50/80'} transition-all" data-team="${escapeHtml((entry.team || '').toLowerCase())}" data-username="${escapeHtml((entry.username || '').toLowerCase())}" data-rank="${rankNum}" data-solved="${entry.solved || 0}" data-me="${isMe ? 'true' : 'false'}">
                    
                    <!-- Rank -->
                    <td class="py-3.5 px-4 font-mono font-black">
                      ${rankNum === 1 ? '<span class="inline-flex items-center gap-1 text-amber-600 font-black">' + animEmoji('👑') + ' #1</span>' :
                        rankNum === 2 ? '<span class="inline-flex items-center gap-1 text-cyan-600 font-black">' + animEmoji('🥈') + ' #2</span>' :
                        rankNum === 3 ? '<span class="inline-flex items-center gap-1 text-purple-600 font-black">' + animEmoji('🥉') + ' #3</span>' :
                        '<span class="text-slate-500 font-bold">#' + rankNum + '</span>'}
                    </td>

                    <!-- Squad -->
                    <td class="py-3.5 px-4">
                      <div class="flex items-center gap-2.5">
                        <span class="w-7 h-7 rounded-lg ${isMe ? 'bg-purple-200 text-purple-800' : 'bg-slate-100 text-slate-700'} text-xs flex items-center justify-center font-bold shrink-0 border border-slate-200">
                          ${rankNum === 1 ? animEmoji('🦅') : rankNum <= 3 ? animEmoji('⚡') : animEmoji('🛡️')}
                        </span>
                        <div class="min-w-0">
                          <div class="flex items-center gap-1.5 font-bold ${isMe ? 'text-gamer-purple' : 'text-dark-title'} truncate">
                            <span>${escapeHtml(entry.team || entry.username)}</span>
                            ${isMe ? '<span class="px-1.5 py-0.2 rounded text-[9px] bg-gamer-purple text-white font-bold">YOU</span>' : ''}
                          </div>
                          <div class="text-[10px] text-slate-400 truncate">@${escapeHtml(entry.username)}</div>
                        </div>
                      </div>
                    </td>

                    <!-- Score -->
                    <td class="py-3.5 px-4 font-black text-sm text-gamer-purple">
                      ${entry.score || 0} <span class="text-[10px] text-slate-600 font-bold">PTS</span>
                    </td>

                    <!-- Clearance Progress Bar -->
                    <td class="py-3.5 px-4">
                      <div class="space-y-1 max-w-[200px]">
                        <div class="flex items-center justify-between text-[10px]">
                          <span class="font-bold text-slate-700">${entry.solved || 0}/${totalSteps} SOLVED</span>
                          <span class="font-bold text-emerald-600">${pct}%</span>
                        </div>
                        <div class="lb-clearance-bar">
                          <div class="seg-osint" style="width: ${osintPct * 0.33}%" title="OSINT: ${entry.osintSolved || 0}/4"></div>
                          <div class="seg-web" style="width: ${webPct * 0.33}%" title="Web: ${entry.webSolved || 0}/4"></div>
                          <div class="seg-code" style="width: ${codePct * 0.34}%" title="Code: ${entry.codeSolved || 0}/5"></div>
                        </div>
                      </div>
                    </td>

                    <!-- Skips -->
                    <td class="py-3.5 px-4 text-[11px]">
                      ${entry.skipsUsed > 0 
                        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
                             <span class="material-symbols-outlined text-xs">fast_forward</span>${entry.skipsUsed}/3 (-${entry.skipsUsed * 30} PTS)
                           </span>` 
                        : '<span class="text-slate-400 text-[10px]">0 / 3</span>'}
                    </td>

                    <!-- Last Solve Timestamp -->
                    <td class="py-3.5 px-4 text-right text-slate-500 text-[11px]">
                      ${entry.lastSolve ? formatTime(entry.lastSolve) : '<span class="text-slate-400">NO TELEMETRY</span>'}
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
          <div id="lb-empty-msg" class="hidden p-8 text-center font-mono text-xs text-slate-400">
            No operative squads matched the current search query or filter.
          </div>
        </div>
      </div>
    </div>
  `;
}

let _currentLbFilter = 'all';

window.setLeaderboardFilter = (filter) => {
  _currentLbFilter = filter;
  document.querySelectorAll('#lb-filter-chips .lb-chip').forEach(btn => {
    if (btn.dataset.filter === filter) {
      btn.className = 'lb-chip px-3 py-1.5 rounded-lg font-bold transition-all bg-gamer-purple text-white shadow-2xs';
    } else {
      btn.className = 'lb-chip px-3 py-1.5 rounded-lg font-bold transition-all bg-white hover:bg-slate-100 text-slate-600 border border-border-line';
    }
  });
  window.filterLeaderboardTable();
};

window.filterLeaderboardTable = () => {
  const query = ($('#lb-search-input')?.value || '').trim().toLowerCase();
  const rows = document.querySelectorAll('#lb-table-body .lb-row');
  let visibleCount = 0;

  rows.forEach(row => {
    const team = row.dataset.team || '';
    const username = row.dataset.username || '';
    const rank = parseInt(row.dataset.rank, 10) || 999;
    const isMe = row.dataset.me === 'true';
    const solved = parseInt(row.dataset.solved, 10) || 0;

    let matchesFilter = true;
    if (_currentLbFilter === 'top10' && rank > 10) matchesFilter = false;
    if (_currentLbFilter === 'me' && !isMe) matchesFilter = false;
    if (_currentLbFilter === 'cleared' && solved < 13) matchesFilter = false;

    let matchesQuery = true;
    if (query && !team.includes(query) && !username.includes(query)) {
      matchesQuery = false;
    }

    if (matchesFilter && matchesQuery) {
      row.style.display = '';
      visibleCount++;
    } else {
      row.style.display = 'none';
    }
  });

  const emptyMsg = $('#lb-empty-msg');
  if (emptyMsg) {
    emptyMsg.classList.toggle('hidden', visibleCount > 0);
  }
};

window.refreshLeaderboardView = async () => {
  await syncLeaderboard();
  renderLeaderboard();
};

function renderLeaderboard() {
  const lb = buildLeaderboard();
  const main = $('#main-content');
  if (!main) return;

  main.innerHTML = `
    <div class="w-full bg-surface esports-grid-pattern min-h-screen pb-16 px-4 sm:px-6 lg:px-8 py-6 font-telemetry">
      ${buildLeaderboardHTML({ lb, me: currentUser, isExamOver: false })}
    </div>
  `;
}

/* ── Rules ───────────────────────────────────────────────── */
function renderRules() {
  const main = $('#main-content');
  const rules = contestData.rules || [];

  main.innerHTML = `
    <div class="w-full bg-surface esports-grid-pattern min-h-screen pb-16 px-6 py-6 font-telemetry">
      <div class="max-w-4xl mx-auto space-y-6">
        <div class="bg-white rounded-xl border border-border-line p-5 shadow-xs hud-card">
          <div class="flex items-center gap-2 text-xs text-dark-muted mb-1">
            <span>OPERATIONAL DIRECTIVES</span>
            <span>//</span>
            <span class="text-gamer-purple font-bold">RULES OF ENGAGEMENT</span>
          </div>
          <h1 class="font-headline-lg text-2xl font-extrabold text-dark-title tracking-tight">TOURNAMENT RULES & DEBRIEF</h1>
          <p class="text-xs text-slate-600 mt-1">Directives governing Operation 0xRAVEN. Strict compliance required for qualification.</p>
        </div>

        <div class="bg-white rounded-xl border border-border-line p-6 shadow-xs hud-card space-y-4 font-telemetry text-xs">
          <div class="font-bold text-slate-800 text-sm border-b border-border-line pb-2 flex items-center gap-2">
            <span class="material-symbols-outlined text-gamer-cyan text-base">policy</span>
            STANDARD COMPETITION DIRECTIVES
          </div>
          <div class="space-y-3">
            ${rules.map((r, i) => `
              <div class="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
                <span class="w-6 h-6 rounded-full bg-gamer-purple text-white text-[10px] font-bold flex items-center justify-center shrink-0">0${i+1}</span>
                <div class="text-slate-800 font-semibold leading-relaxed pt-0.5">${r}</div>
              </div>
            `).join('')}
          </div>

          <div class="mt-6 p-4 bg-purple-50 border border-purple-200 rounded-xl space-y-2 text-purple-900">
            <div class="font-bold flex items-center gap-2">
              <span class="material-symbols-outlined text-base text-gamer-purple">report</span>
              DISPUTE PROTOCOL &amp; FAIR PLAY
            </div>
            <div class="text-[11px] leading-relaxed">
              Every flag submission is cryptographically signed and logged with operative timestamp and IP hash. In the event of ties, earliest validated submission time on the match ledger takes precedence.
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}


window.openArtifactsModal = () => {
  const challenges = challengesData.challenges;
  const content = `
    <div class="font-telemetry text-xs space-y-4">
      <div class="p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-700">
        Review all discovered artifacts and evidence dossiers collected across Operation 0xRAVEN.
      </div>
      <div class="space-y-2 max-h-96 overflow-y-auto pr-1">
        ${challenges.map(c => `
          <div class="p-3 bg-white border border-slate-200 rounded-lg flex items-center justify-between hover:border-gamer-cyan transition-all">
            <div>
              <div class="flex items-center gap-2">
                <span class="font-bold text-slate-800">${c.id}</span>
                <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 uppercase">${c.type}</span>
              </div>
              <div class="font-bold text-dark-title mt-0.5">${c.name}</div>
            </div>
            <button onclick="closeModal(); renderChallenge('${c.id}')" class="px-3 py-1.5 bg-gamer-purple text-white text-xs font-bold rounded hover:bg-purple-700">
              INSPECT →
            </button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  showModal('EVIDENCE & ARTIFACT REPOSITORY', content);
};


/* ── Admin Realtime Poller & Dynamic Sync ────────────────── */
let _adminPollInterval = null;
let _lastAdminFingerprint = '';
let _lastKnownPendingUids = new Set();
let _lastKnownDqUids = new Set();
let _adminPollerInitialDone = false;
let _isPollingAdmin = false;

function _computeUsersFingerprint(users, examStatus) {
  const parts = [examStatus || 'waiting'];
  const sorted = [...(users || [])].sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  for (let i = 0; i < sorted.length; i++) {
    const u = sorted[i];
    parts.push(
      `${u.id}:${u.approved ? 1 : 0}:${u.disqualified ? 1 : 0}:${u.tabSwitches || 0}:${u.score || 0}:` +
      `${(u.solvedChallenges || []).length}:${(u.submissions || []).length}:${u.currentChallenge || ''}`
    );
  }
  return parts.join(';');
}

function updateAdminBadges() {
  const allUsers = Store.get('users', getDefaultUsers());
  const pendingCount = allUsers.filter(u => u.role !== 'admin' && !u.approved && !u.disqualified).length;
  const examStatus = Store.get('examStatus', 'waiting');

  // 1. Update Desktop Sidebar Approvals Badge
  const desktopApprovalsItem = document.getElementById('anav-approvals');
  if (desktopApprovalsItem) {
    let badgeEl = desktopApprovalsItem.querySelector('.nav-badge');
    if (pendingCount > 0) {
      if (!badgeEl) {
        const textSpan = desktopApprovalsItem.querySelector('span:nth-child(2)');
        if (textSpan) {
          textSpan.insertAdjacentHTML('beforeend', `<span class="nav-badge">${pendingCount}</span>`);
        }
      } else {
        badgeEl.textContent = pendingCount;
      }
    } else if (badgeEl) {
      badgeEl.remove();
    }
  }

  // 2. Update Mobile Tab Approvals Badge
  const mobileTabs = document.querySelectorAll('.admin-mobile-tab');
  mobileTabs.forEach(tab => {
    if (tab.getAttribute('onclick')?.includes("'approvals'")) {
      let badgeEl = tab.querySelector('.tab-badge');
      if (pendingCount > 0) {
        if (!badgeEl) {
          tab.insertAdjacentHTML('beforeend', `<span class="tab-badge">${pendingCount}</span>`);
        } else {
          badgeEl.textContent = pendingCount;
        }
      } else if (badgeEl) {
        badgeEl.remove();
      }
    }
  });

  // 3. Update Exam status pill in sidebar
  const statusPill = document.querySelector('.admin-sidebar .exam-status-pill');
  if (statusPill) {
    statusPill.className = `exam-status-pill ${examStatus}`;
    statusPill.innerHTML = `
      <span class="sdot"></span>
      ${examStatus === 'waiting' ? 'NOT STARTED' : examStatus === 'running' ? 'LIVE' : 'ENDED'}
    `;
  }
}

async function refreshAdminDataRealtime(forceRedraw = false) {
  if (_isPollingAdmin) return;
  _isPollingAdmin = true;
  try {
    const prevPendingUids = new Set(_lastKnownPendingUids);
    const prevDqUids = new Set(_lastKnownDqUids);

    await Promise.all([syncAllUsers(), syncExamStatus(), syncLeaderboard()]);
    const users = Store.get('users', getDefaultUsers());
    const examStatus = Store.get('examStatus', 'waiting');
    const fingerprint = _computeUsersFingerprint(users, examStatus);

    const currentPending = users.filter(u => u.role !== 'admin' && !u.approved && !u.disqualified);
    const currentDq = users.filter(u => u.role !== 'admin' && u.disqualified);

    // If poller already initialized, check for new pending approvals or disqualifications
    if (_adminPollerInitialDone) {
      for (const u of currentPending) {
        if (!prevPendingUids.has(u.id)) {
          toast('New Approval Request ⏳', `${escapeHtml(u.name || u.username)} requested access to the exam.`, 'info', 4000);
          Sound.play('unlock');
        }
      }
      for (const u of currentDq) {
        if (!prevDqUids.has(u.id)) {
          toast('Violation Alert 🚫', `${escapeHtml(u.username)} has been DISQUALIFIED (${u.tabSwitches || 3} tab violations).`, 'error', 5000);
          Sound.play('wrong');
        }
      }
    }

    _lastKnownPendingUids = new Set(currentPending.map(u => u.id));
    _lastKnownDqUids = new Set(currentDq.map(u => u.id));
    _adminPollerInitialDone = true;

    // Always keep navigation badges updated in realtime
    updateAdminBadges();

    // Check if view needs to be redrawn
    const hasChanged = fingerprint !== _lastAdminFingerprint;
    if (hasChanged || forceRedraw) {
      _lastAdminFingerprint = fingerprint;

      // Do not redraw content area if a modal or confirm dialog is currently open
      const modalOpen = !!document.getElementById('modal-backdrop') || !!document.querySelector('.modal-overlay') || !!document.querySelector('.modal-box');
      if (!modalOpen) {
        // If typing in search input on 'users' tab, preserve input focus & cursor
        const searchInput = document.getElementById('admin-user-search');
        let searchFocus = false;
        let selStart = 0;
        let selEnd = 0;
        let queryVal = '';
        if (searchInput && document.activeElement === searchInput) {
          searchFocus = true;
          selStart = searchInput.selectionStart;
          selEnd = searchInput.selectionEnd;
          queryVal = searchInput.value;
        }

        renderAdminView(adminView);

        if (searchFocus) {
          const newSearchInput = document.getElementById('admin-user-search');
          if (newSearchInput) {
            newSearchInput.value = queryVal;
            newSearchInput.focus();
            try {
              newSearchInput.setSelectionRange(selStart, selEnd);
            } catch {}
          }
        }
      }
    }
  } catch (err) {
    console.warn('[AdminPoller] sync error:', err);
  } finally {
    _isPollingAdmin = false;
  }
}

function startAdminRealtimePoller() {
  stopAdminRealtimePoller();
  _adminPollerInitialDone = false;
  const users = Store.get('users', []);
  const currentPending = users.filter(u => u.role !== 'admin' && !u.approved && !u.disqualified);
  const currentDq = users.filter(u => u.role !== 'admin' && u.disqualified);
  _lastKnownPendingUids = new Set(currentPending.map(u => u.id));
  _lastKnownDqUids = new Set(currentDq.map(u => u.id));
  _lastAdminFingerprint = _computeUsersFingerprint(users, Store.get('examStatus', 'waiting'));
  _adminPollerInitialDone = true;

  _adminPollInterval = setInterval(() => {
    if (currentUser?.role === 'admin') {
      refreshAdminDataRealtime();
    } else {
      stopAdminRealtimePoller();
    }
  }, 1500);
}

function stopAdminRealtimePoller() {
  if (_adminPollInterval) {
    clearInterval(_adminPollInterval);
    _adminPollInterval = null;
  }
}

/* ── Admin Panel ─────────────────────────────────────────── */
async function renderAdminPanel() {
  const main = $('#main-content');
  main.style.padding = '48px 0 0 0';
  main.style.maxWidth = 'none';

  // Sync fresh data from API before rendering
  await Promise.all([syncAllUsers(), syncExamStatus(), syncLeaderboard()]);
  startAdminRealtimePoller();

  const allUsers = Store.get('users', getDefaultUsers());
  const pendingCount = allUsers.filter(u => u.role !== 'admin' && !u.approved && !u.disqualified).length;
  const examStatus   = Store.get('examStatus', 'waiting');

  // Inject admin extra styles once
  if (!document.getElementById('admin-extra-styles')) {
    const s = document.createElement('style');
    s.id = 'admin-extra-styles';
    s.textContent = `
      /* Exam control bar */
      .exam-ctrl-bar {
        display:flex; align-items:center; gap:12px; flex-wrap:wrap;
        padding:14px 18px; background:#ffffff; border:1.5px solid #e2e8f0;
        border-radius:14px; margin-bottom:16px;
      }
      .exam-status-pill {
        display:inline-flex; align-items:center; gap:6px;
        padding:5px 12px; border-radius:20px;
        font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:700;
      }
      .exam-status-pill.waiting  { background:#f8fafc; color:#64748b; border:1.5px solid #e2e8f0; }
      .exam-status-pill.running  { background:#f0fdf4; color:#059669; border:1.5px solid #bbf7d0; transform:skewX(-14deg); border-radius:3px; }
      .exam-status-pill.stopped  { background:#fef2f2; color:#dc2626; border:1.5px solid #fecaca; transform:skewX(-14deg); border-radius:3px; }
      .exam-status-pill .sdot { width:8px;height:8px;border-radius:50%;background:currentColor; transform:skewX(14deg); }
      .exam-status-pill.running .sdot { animation:pulse 1.2s infinite; }
      /* Parallelogram Approval badges & status pills */
      .badge-pending   { background:#fffbeb; color:#92400e; border:1px solid #fde68a;
        font-family:'JetBrains Mono',monospace; font-size:10px; font-weight:700;
        padding:3px 10px; border-radius:3px; transform:skewX(-14deg); display:inline-flex; align-items:center; }
      .badge-approved  { background:#f0fdf4; color:#065f46; border:1px solid #bbf7d0;
        font-family:'JetBrains Mono',monospace; font-size:10px; font-weight:700;
        padding:3px 10px; border-radius:3px; transform:skewX(-14deg); display:inline-flex; align-items:center; }
      .badge-dq        { background:#fef2f2; color:#991b1b; border:1px solid #fecaca;
        font-family:'JetBrains Mono',monospace; font-size:10px; font-weight:700;
        padding:3px 10px; border-radius:3px; transform:skewX(-14deg); display:inline-flex; align-items:center; }
      .ac-badge-violations {
        display:inline-flex; align-items:center; justify-content:center;
        transform:skewX(-14deg); border-radius:3px; padding:3px 10px;
        font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:700; white-space:nowrap;
      }
      .ac-badge-violations.clean    { background:#f0fdf4; color:#16a34a; border:1px solid #bbf7d0; }
      .ac-badge-violations.warned   { background:#fffbeb; color:#d97706; border:1px solid #fde68a; }
      .ac-badge-violations.critical { background:#fef2f2; color:#dc2626; border:1px solid #fecaca; }
      .badge-pending > *, .badge-approved > *, .badge-dq > *, .ac-badge-violations > *, .badge-inner {
        display:inline-flex; align-items:center; gap:4px; transform:skewX(14deg);
      }
      /* Solved pills */
      .solved-pill-list { display:flex; flex-wrap:wrap; gap:4px; }
      .solved-pill {
        font-family:'JetBrains Mono',monospace; font-size:10px; font-weight:600;
        padding:2px 8px; border-radius:3px; background:#f0fdf4;
        color:#065f46; border:1px solid #bbf7d0; transform:skewX(-14deg); display:inline-flex;
      }
      .solved-pill > * { transform:skewX(14deg); display:inline-block; }
      /* Monitor table column widths */
      .monitor-table th, .monitor-table td { vertical-align:top; padding:10px 8px; }
      .monitor-table .col-user { min-width:120px; }
      .monitor-table .col-score{ min-width:60px; }
      .monitor-table .col-solved{ min-width:160px; }
      .monitor-table .col-current{ min-width:100px; }
      .monitor-table .col-last  { min-width:140px; }
      .monitor-table .col-actions{ min-width:120px; }
      /* nav badge */
      .nav-badge {
        display:inline-flex; align-items:center; justify-content:center;
        background:#ef4444; color:white; border-radius:999px;
        font-size:10px; font-weight:800; min-width:18px; height:18px;
        padding:0 4px; margin-left:6px;
      }
      /* Difficulty badges */
      .difficulty-badge {
        font-family:'JetBrains Mono',monospace; font-size:9px; font-weight:700;
        padding:2px 8px; border-radius:4px; text-transform:uppercase;
      }
      .difficulty-easy { background:#f0fdf4; color:#059669; }
      .difficulty-medium { background:#fffbeb; color:#d97706; }
      .difficulty-hard { background:#fef2f2; color:#dc2626; }
      /* User directory styles */
      .user-avatar-initials {
        display:inline-flex; align-items:center; justify-content:center;
        width:34px; height:34px; border-radius:50%;
        background:linear-gradient(135deg, #6366f1, #8b5cf6);
        color:#ffffff; font-weight:700; font-size:12px;
        font-family:'JetBrains Mono',monospace; flex-shrink:0;
      }
      .admin-search-input {
        padding:8px 14px; background:#ffffff; border:1.5px solid #e2e8f0;
        border-radius:10px; font-size:12px; font-family:var(--font-mono);
        color:#0f172a; min-width:260px; outline:none; transition:border-color .15s;
      }
      .admin-search-input:focus { border-color:#7c3aed; }
      .user-dir-cards { display:none; }
      @media (max-width: 900px) {
        .user-dir-cards { display:block; }
        .user-dir-table-desktop { display:none; }
      }
    `;
    document.head.appendChild(s);
  }

  const navItems = [
    { id: 'overview',    icon: '📊', label: 'Overview' },
    { id: 'users',       icon: '👥', label: 'Contestants' },
    { id: 'approvals',   icon: '🕐', label: 'Approvals', badge: pendingCount },
    { id: 'contestants', icon: '👁️', label: 'Live Monitor' },
    { id: 'challenges',  icon: '🎯', label: 'Challenges' },
    { id: 'submissions', icon: '📋', label: 'Submissions' },
    { id: 'leaderboard', icon: '🏆', label: 'Leaderboard' },
    { id: 'contest',     icon: '⚙️', label: 'Exam Control' },
  ];

  main.innerHTML = `
    <!-- Mobile Tab Navigation (shown < 900px) -->
    <div class="admin-mobile-nav">
      <div class="admin-mobile-nav-inner">
        ${navItems.map(item => `
          <button class="admin-mobile-tab${adminView === item.id ? ' active' : ''}" onclick="adminNav('${item.id}')">
            <span>${animEmoji(item.icon)}</span>
            <span>${item.label}</span>
            ${item.badge > 0 ? `<span class="tab-badge">${item.badge}</span>` : ''}
          </button>
        `).join('')}
      </div>
    </div>

    <div class="admin-grid">
      <!-- Desktop Sidebar -->
      <div class="admin-sidebar">
        <div class="admin-sidebar-title">Admin Panel</div>
        ${navItems.map(item => `
          <div class="admin-nav-item${adminView === item.id ? ' active' : ''}" id="anav-${item.id}" onclick="adminNav('${item.id}')">
            <span class="admin-nav-icon">${animEmoji(item.icon)}</span>
            <span>${item.label}${item.badge > 0 ? `<span class="nav-badge">${item.badge}</span>` : ''}</span>
          </div>
        `).join('')}

        <div style="margin-top:auto;padding:16px 20px;border-top:1px solid #334155">
          <div class="exam-status-pill ${examStatus}" style="justify-content:center;width:100%">
            <span class="sdot"></span>
            ${examStatus === 'waiting' ? 'NOT STARTED' : examStatus === 'running' ? 'LIVE' : 'ENDED'}
          </div>
        </div>
      </div>

      <!-- Content Area -->
      <div class="admin-content" id="admin-content-area">
        <!-- content rendered here -->
      </div>
    </div>
  `;

  renderAdminView(adminView);
}

window.adminNav = async (view) => {
  Sound.play('click');
  adminView = view;
  // Update desktop sidebar
  $$('.admin-nav-item').forEach(i => i.classList.remove('active'));
  $(`#anav-${view}`)?.classList.add('active');
  // Update mobile tabs
  $$('.admin-mobile-tab').forEach(t => t.classList.remove('active'));
  $$('.admin-mobile-tab').forEach(t => {
    if (t.getAttribute('onclick')?.includes(`'${view}'`)) t.classList.add('active');
  });

  // Fetch freshest data in background before transitioning view
  await Promise.all([syncAllUsers(), syncExamStatus(), syncLeaderboard()]);
  updateAdminBadges();
  _lastAdminFingerprint = _computeUsersFingerprint(Store.get('users', []), Store.get('examStatus', 'waiting'));

  const area = $('#admin-content-area');
  PageTransition.wipe(() => renderAdminView(view));
};

function renderAdminView(view) {
  const area = $('#admin-content-area');
  if (!area) return;
  const views = {
    overview: adminOverview,
    users: adminUsersDirectory,
    approvals: adminApprovals,
    contestants: adminContestants,
    challenges: adminChallenges,
    submissions: adminSubmissions,
    leaderboard: adminLeaderboard,
    contest: adminContest,
    // keep legacy 'teams' alias
    teams: adminContestants,
  };
  if (views[view]) area.innerHTML = withAnimEmojis(views[view]());
}

/* ── Contestant Directory (Registered Details) ───────────── */
let adminUserFilter = 'all';
let adminUserSearchQuery = '';

window.adminSetUserFilter = (f) => {
  Sound.play('click');
  adminUserFilter = f;
  const area = $('#admin-content-area');
  if (area) area.innerHTML = withAnimEmojis(adminUsersDirectory());
};

window.adminFilterUsers = () => {
  const query = $('#admin-user-search')?.value.toLowerCase() || '';
  adminUserSearchQuery = query;
  const area = $('#admin-content-area');
  if (area) area.innerHTML = withAnimEmojis(adminUsersDirectory());
  const input = $('#admin-user-search');
  if (input) {
    input.focus();
    input.value = query;
  }
};

window.adminExportUsersCSV = () => {
  Sound.play('click');
  const users = Store.get('users', getDefaultUsers()).filter(u => u.role !== 'admin');
  const headers = ['User ID', 'Full Name', 'Username', 'Phone', 'Email', 'Team', 'Status', 'Registered Date', 'Score', 'Solved Challenges', 'Tab Violations'];
  const rows = users.map(u => [
    `"${(u.id||'').replace(/"/g, '""')}"`,
    `"${(u.name||'').replace(/"/g, '""')}"`,
    `"${(u.username||'').replace(/"/g, '""')}"`,
    `"${(u.phone||'').replace(/"/g, '""')}"`,
    `"${(u.email||u.username + '@contestant.local').replace(/"/g, '""')}"`,
    `"${(u.team||'Individual').replace(/"/g, '""')}"`,
    `"${u.disqualified ? 'Disqualified' : !u.approved ? 'Pending' : 'Approved'}"`,
    `"${u.createdAt ? new Date(u.createdAt).toISOString() : ''}"`,
    u.score || 0,
    (u.solvedChallenges || []).length,
    u.tabSwitches || 0
  ]);

  const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `codeverse_contestants_${new Date().toISOString().slice(0,10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  toast('Exported ✓', `Downloaded CSV for ${users.length} contestants.`, 'success');
};

window.adminViewUserDetails = (uid) => {
  Sound.play('click');
  const users = Store.get('users', getDefaultUsers());
  const u = users.find(user => user.id === uid);
  if (!u) return toast('Error', 'Contestant not found.', 'error');

  const challenges = challengesData.challenges;
  const subs = u.submissions || [];
  const solved = u.solvedChallenges || [];
  const examStartTime = Store.get('examStartTime', null);
  const timing = calculateContestantTimings(u, getUserChallenges(u), examStartTime);

  const bodyHtml = `
    <div style="display:flex;flex-direction:column;gap:16px;max-height:75vh;overflow-y:auto;padding-right:4px">
      <!-- Profile Header -->
      <div style="display:flex;align-items:center;gap:14px;padding:16px;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px">
        <div class="user-avatar-initials" style="width:48px;height:48px;font-size:18px">
          ${((u.name || u.username || 'U').substring(0, 2)).toUpperCase()}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:18px;font-weight:800;color:#0f172a">${escapeHtml(u.name || u.username)}</div>
          <div style="font-family:var(--font-mono);font-size:12px;color:#64748b">@${escapeHtml(u.username)} &bull; <span style="color:#94a3b8">ID: ${escapeHtml(u.id)}</span></div>
        </div>
        <div>
          ${u.disqualified ? '<span class="badge-dq"><span class="badge-inner">🚫 Disqualified</span></span>' : !u.approved ? '<span class="badge-pending"><span class="badge-inner">⏳ Pending</span></span>' : '<span class="badge-approved"><span class="badge-inner">✓ Approved</span></span>'}
        </div>
      </div>

      <!-- Registration & Contact Details Grid -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px">
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:12px">
          <div style="font-family:var(--font-mono);font-size:10px;color:#94a3b8;text-transform:uppercase">Full Name</div>
          <div style="font-size:13px;font-weight:700;color:#0f172a;margin-top:2px">${escapeHtml(u.name || 'Not provided')}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:12px">
          <div style="font-family:var(--font-mono);font-size:10px;color:#94a3b8;text-transform:uppercase">Username / Handle</div>
          <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:#0284c7;margin-top:2px">@${escapeHtml(u.username)}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:12px">
          <div style="font-family:var(--font-mono);font-size:10px;color:#94a3b8;text-transform:uppercase">Phone Number</div>
          <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:#0f172a;margin-top:2px">${escapeHtml(u.phone || '—')}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:12px">
          <div style="font-family:var(--font-mono);font-size:10px;color:#94a3b8;text-transform:uppercase">Email Address</div>
          <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:#0f172a;margin-top:2px">${escapeHtml(u.email || (u.username + '@contestant.local'))}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:12px">
          <div style="font-family:var(--font-mono);font-size:10px;color:#94a3b8;text-transform:uppercase">Team / Track</div>
          <div style="font-size:13px;font-weight:700;color:#7c3aed;margin-top:2px">${escapeHtml(u.team || 'Individual')}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:12px">
          <div style="font-family:var(--font-mono);font-size:10px;color:#94a3b8;text-transform:uppercase">Registered At</div>
          <div style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:#334155;margin-top:2px">${u.createdAt ? formatTime(u.createdAt) + ' (' + new Date(u.createdAt).toLocaleDateString() + ')' : '—'}</div>
        </div>
      </div>

      <!-- Exam & Anti-Cheat Metrics -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:10px">
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:10px;text-align:center">
          <div style="font-family:var(--font-mono);font-size:10px;color:#065f46;text-transform:uppercase">Score</div>
          <div style="font-family:var(--font-mono);font-size:22px;font-weight:800;color:#059669">${u.score || 0}</div>
        </div>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:10px;text-align:center">
          <div style="font-family:var(--font-mono);font-size:10px;color:#1e40af;text-transform:uppercase">Solved</div>
          <div style="font-family:var(--font-mono);font-size:22px;font-weight:800;color:#0284c7">${solved.length} / 13</div>
        </div>
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px;text-align:center">
          <div style="font-family:var(--font-mono);font-size:10px;color:#92400e;text-transform:uppercase">Tab Violations</div>
          <div style="font-family:var(--font-mono);font-size:22px;font-weight:800;color:${(u.tabSwitches||0) >= 3 ? '#dc2626' : '#d97706'}">${u.tabSwitches || 0}</div>
        </div>
        <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:10px;padding:10px;text-align:center">
          <div style="font-family:var(--font-mono);font-size:10px;color:#6b21a8;text-transform:uppercase">Total Time</div>
          <div style="font-family:var(--font-mono);font-size:13px;font-weight:800;color:#7c3aed;margin-top:6px">${timing.completedSteps > 0 ? formatDuration(timing.totalCompletedTimeMs) : '—'}</div>
        </div>
      </div>

      <!-- Solved Challenges List -->
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:#475569;margin-bottom:6px">SOLVED CHALLENGES (${solved.length})</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${solved.length === 0 ? '<span style="font-size:12px;color:#94a3b8;font-style:italic">No challenges solved yet.</span>' :
            solved.map(id => {
              const ch = challenges.find(c => c.id === id);
              return `<span class="solved-pill" style="font-size:11px;padding:4px 8px">${id}: ${escapeHtml(ch?.name || id)}</span>`;
            }).join('')}
        </div>
      </div>

      <!-- Submissions Log Table -->
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:#475569;margin-bottom:6px">SUBMISSION LOG (${subs.length})</div>
        <div style="max-height:180px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px">
          <table class="admin-table" style="font-size:11px">
            <thead><tr><th>Time</th><th>Challenge</th><th>Attempted Value</th><th>Result</th></tr></thead>
            <tbody>
              ${subs.slice().reverse().map(s => `
                <tr>
                  <td class="mono">${formatTime(s.timestamp)}</td>
                  <td class="mono" style="font-weight:700">${escapeHtml(s.challengeId)}</td>
                  <td class="mono" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.value || '—')}</td>
                  <td><span class="enabled-badge ${s.correct ? 'yes' : 'no'}" style="font-size:8px">${s.correct ? 'CORRECT' : 'WRONG'}</span></td>
                </tr>
              `).join('')}
              ${subs.length === 0 ? '<tr><td colspan="4" style="text-align:center;color:#94a3b8">No submissions yet</td></tr>' : ''}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  showModal(`Contestant: ${u.name || u.username}`, bodyHtml, [
    { label: 'Close', cls: 'btn-secondary', action: closeModal },
    { label: '⏱️ Step Breakdown', cls: 'btn-primary', action: () => { closeModal(); adminViewStepTimes(u.id); } },
    ...(!u.approved && !u.disqualified ? [{ label: '✓ Approve', cls: 'btn-green', action: () => { closeModal(); adminApproveUser(u.id); } }] : []),
    ...(u.disqualified ? [{ label: '↩ Reinstate', cls: 'btn-secondary', action: () => { closeModal(); adminReinstate(u.id); } }] : [{ label: '🚫 Disqualify', cls: 'btn-danger', action: () => { closeModal(); adminDisqualifyUser(u.id); } }]),
    ...((u.tabSwitches || 0) > 0 ? [{ label: '🛡️ Reset Strikes', cls: 'btn-secondary', action: () => { closeModal(); adminResetViolations(u.id); } }] : []),
  ]);
};

function adminUsersDirectory() {
  const allUsers = Store.get('users', getDefaultUsers()).filter(u => u.role !== 'admin');

  const totalCount = allUsers.length;
  const approvedCount = allUsers.filter(u => u.approved && !u.disqualified).length;
  const pendingCount = allUsers.filter(u => !u.approved && !u.disqualified).length;
  const dqCount = allUsers.filter(u => u.disqualified).length;
  const violationCount = allUsers.filter(u => (u.tabSwitches || 0) > 0).length;

  let filtered = allUsers.filter(u => {
    if (adminUserFilter === 'approved' && (!u.approved || u.disqualified)) return false;
    if (adminUserFilter === 'pending' && (u.approved || u.disqualified)) return false;
    if (adminUserFilter === 'disqualified' && !u.disqualified) return false;
    if (adminUserFilter === 'violations' && !(u.tabSwitches > 0)) return false;

    if (adminUserSearchQuery) {
      const q = adminUserSearchQuery.toLowerCase();
      const matchName = (u.name || '').toLowerCase().includes(q);
      const matchUser = (u.username || '').toLowerCase().includes(q);
      const matchPhone = (u.phone || '').toLowerCase().includes(q);
      const matchEmail = (u.email || '').toLowerCase().includes(q);
      const matchTeam = (u.team || '').toLowerCase().includes(q);
      const matchId = (u.id || '').toLowerCase().includes(q);
      if (!matchName && !matchUser && !matchPhone && !matchEmail && !matchTeam && !matchId) return false;
    }
    return true;
  });

  const getInitials = (name, user) => {
    const n = (name || user || 'U').trim();
    const parts = n.split(' ');
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return n.substring(0, 2).toUpperCase();
  };

  const statusBadge = (u) => {
    if (u.disqualified) return `<span class="badge-dq"><span class="badge-inner">${animEmoji('🚫')} DISQUALIFIED</span></span>`;
    if (!u.approved)    return `<span class="badge-pending"><span class="badge-inner">${animEmoji('⏳')} PENDING</span></span>`;
    return '<span class="badge-approved"><span class="badge-inner">✓ APPROVED</span></span>';
  };

  return `
    <div class="admin-page-title" style="margin-bottom:8px">👥 Contestant Directory</div>
    <div style="font-family:var(--font-mono);font-size:12px;color:#64748b;margin-bottom:20px">
      Comprehensive registered contestant details, verified contact information, credential data, and exam progress.
    </div>

    <!-- Quick Stat Cards -->
    <div class="stats-grid" style="grid-template-columns:repeat(auto-fill, minmax(150px, 1fr));gap:12px;margin-bottom:20px">
      <div class="stat-card" style="padding:14px 16px;cursor:pointer" onclick="adminSetUserFilter('all')">
        <div class="stat-card-value cyan" style="font-size:24px">${totalCount}</div>
        <div class="stat-card-label" style="font-size:10px">Total Registered</div>
      </div>
      <div class="stat-card" style="padding:14px 16px;cursor:pointer" onclick="adminSetUserFilter('approved')">
        <div class="stat-card-value green" style="font-size:24px">${approvedCount}</div>
        <div class="stat-card-label" style="font-size:10px">Approved</div>
      </div>
      <div class="stat-card" style="padding:14px 16px;cursor:pointer" onclick="adminSetUserFilter('pending')">
        <div class="stat-card-value yellow" style="font-size:24px">${pendingCount}</div>
        <div class="stat-card-label" style="font-size:10px">Pending</div>
      </div>
      <div class="stat-card" style="padding:14px 16px;cursor:pointer" onclick="adminSetUserFilter('disqualified')">
        <div class="stat-card-value red" style="font-size:24px">${dqCount}</div>
        <div class="stat-card-label" style="font-size:10px">Disqualified</div>
      </div>
      <div class="stat-card" style="padding:14px 16px;cursor:pointer" onclick="adminSetUserFilter('violations')">
        <div class="stat-card-value red" style="font-size:24px">${violationCount}</div>
        <div class="stat-card-label" style="font-size:10px">With Violations</div>
      </div>
    </div>

    <!-- Search & Filter Controls Toolbar -->
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1">
        <div style="position:relative;display:inline-flex;align-items:center">
          <span style="position:absolute;left:12px;pointer-events:none;color:#94a3b8;font-size:14px;font-weight:700">⌕</span>
          <input
            type="text"
            id="admin-user-search"
            class="admin-search-input"
            style="padding-left:32px"
            placeholder="Search name, username, phone, email, team..."
            value="${escapeHtml(adminUserSearchQuery)}"
            oninput="adminFilterUsers()"
          >
        </div>
        <div class="admin-filter-tabs" style="margin-bottom:0">
          <button class="admin-filter-tab${adminUserFilter === 'all' ? ' active' : ''}" onclick="adminSetUserFilter('all')">All (${totalCount})</button>
          <button class="admin-filter-tab${adminUserFilter === 'approved' ? ' active' : ''}" onclick="adminSetUserFilter('approved')">✓ Approved (${approvedCount})</button>
          <button class="admin-filter-tab${adminUserFilter === 'pending' ? ' active' : ''}" onclick="adminSetUserFilter('pending')">⏳ Pending (${pendingCount})</button>
          <button class="admin-filter-tab${adminUserFilter === 'disqualified' ? ' active' : ''}" onclick="adminSetUserFilter('disqualified')">🚫 Disqualified (${dqCount})</button>
          <button class="admin-filter-tab${adminUserFilter === 'violations' ? ' active' : ''}" onclick="adminSetUserFilter('violations')">⚠️ Violations (${violationCount})</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <button class="btn btn-sm btn-secondary" onclick="adminExportUsersCSV()">📥 Export CSV</button>
        <button class="btn btn-sm btn-danger" onclick="adminClearAllUsers()" style="background:#dc2626;color:white;display:inline-flex;align-items:center;gap:4px">
          <span class="material-symbols-outlined" style="font-size:14px">delete_forever</span>
          <span>Clear All</span>
        </button>
      </div>
    </div>

    <!-- Desktop Table View (shown >= 900px) -->
    <div class="admin-table-wrap user-dir-table-desktop" style="overflow-x:auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Contestant</th>
            <th>Contact Details</th>
            <th>Team / Track</th>
            <th>Registered At</th>
            <th>Status</th>
            <th>Anti-Cheat</th>
            <th>Progress</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(u => `
            <tr style="${u.disqualified ? 'background:#fff1f2' : ''}">
              <td>
                <div style="display:flex;align-items:center;gap:10px">
                  <div class="user-avatar-initials">${getInitials(u.name, u.username)}</div>
                  <div>
                    <div class="bright" style="font-size:13px">${escapeHtml(u.name || u.username)}</div>
                    <div class="mono" style="font-size:11px;color:#64748b">@${escapeHtml(u.username)}</div>
                    <div class="mono" style="font-size:9px;color:#94a3b8">ID: ${escapeHtml(u.id)}</div>
                  </div>
                </div>
              </td>
              <td>
                <div style="font-size:12px;color:#334155;display:flex;align-items:center;gap:5px">
                  <span>📞</span>
                  <span class="mono">${escapeHtml(u.phone || '—')}</span>
                </div>
                <div style="font-size:11px;color:#64748b;display:flex;align-items:center;gap:5px;margin-top:2px">
                  <span>✉️</span>
                  <span class="mono">${escapeHtml(u.email || (u.username + '@contestant.local'))}</span>
                </div>
              </td>
              <td>
                <div class="mono" style="font-size:12px;font-weight:700;color:#7c3aed">${escapeHtml(u.team || 'Individual')}</div>
              </td>
              <td>
                <div class="mono" style="font-size:11px;color:#475569">${u.createdAt ? formatTime(u.createdAt) : '—'}</div>
                <div style="font-size:10px;color:#94a3b8">${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : ''}</div>
              </td>
              <td>
                ${statusBadge(u)}
              </td>
              <td>
                <span class="ac-badge-violations ${(u.tabSwitches||0) === 0 ? 'clean' : (u.tabSwitches||0) >= 3 ? 'critical' : 'warned'}">
                  <span class="badge-inner">${(u.tabSwitches||0) === 0 ? '✓ Clean' : `⚠ ${u.tabSwitches} violations`}</span>
                </span>
              </td>
              <td>
                <div class="mono" style="font-size:14px;font-weight:800;color:#059669">${u.score || 0} <span style="font-size:10px;color:#64748b">pts</span></div>
                <div class="mono" style="font-size:10px;color:#64748b">${(u.solvedChallenges || []).length} / 13 solved</div>
              </td>
              <td>
                <div class="action-btns">
                  <button class="btn btn-sm btn-primary" onclick="adminViewUserDetails('${u.id}')" title="View complete registered details">👁️ Details</button>
                  ${!u.approved && !u.disqualified ? `<button class="btn btn-sm btn-green" onclick="adminApproveUser('${u.id}')">✓ Approve</button>` : ''}
                  ${u.disqualified ? `<button class="btn btn-sm btn-secondary" onclick="adminReinstate('${u.id}')">↩ Reinstate</button>` : `<button class="btn btn-sm btn-danger" onclick="adminDisqualifyUser('${u.id}')">🚫 Disqualify</button>`}
                  <button class="btn btn-sm btn-secondary" onclick="adminResetUser('${u.id}')" title="Reset score and violations">🔄</button>
                  <button class="btn btn-sm btn-danger" onclick="adminRejectUser('${u.id}')" title="Delete contestant">🗑️</button>
                </div>
              </td>
            </tr>
          `).join('')}
          ${filtered.length === 0 ? '<tr><td colspan="8"><div class="empty-state"><div class="empty-state-title">No contestants match this search/filter</div></div></td></tr>' : ''}
        </tbody>
      </table>
    </div>

    <!-- Mobile Cards View (shown < 900px) -->
    <div class="user-dir-cards">
      ${filtered.length === 0 ? `<div class="empty-state"><div class="empty-state-title">No contestants match this search/filter</div></div>` :
      filtered.map(u => `
        <div class="admin-monitor-card" style="${u.disqualified ? 'background:#fff1f2;border-color:#fecaca' : ''}">
          <div class="admin-monitor-card-header">
            <div style="display:flex;align-items:center;gap:10px">
              <div class="user-avatar-initials">${getInitials(u.name, u.username)}</div>
              <div>
                <div class="admin-monitor-card-name">${escapeHtml(u.name || u.username)}</div>
                <div class="admin-monitor-card-handle">@${escapeHtml(u.username)} &bull; ID: ${escapeHtml(u.id)}</div>
              </div>
            </div>
            <div style="text-align:right">
              <div>${statusBadge(u)}</div>
              <div style="margin-top:4px">
                <span class="ac-badge-violations ${(u.tabSwitches||0) === 0 ? 'clean' : (u.tabSwitches||0) >= 3 ? 'critical' : 'warned'}">
                  <span class="badge-inner">${(u.tabSwitches||0) === 0 ? '✓ Clean' : `⚠ ${u.tabSwitches} violations`}</span>
                </span>
              </div>
            </div>
          </div>

          <div class="admin-monitor-card-grid">
            <div class="admin-monitor-card-stat">
              <div class="admin-monitor-card-stat-label">Phone</div>
              <div class="mono" style="font-size:12px;font-weight:700;color:#0f172a;margin-top:2px">${escapeHtml(u.phone || '—')}</div>
            </div>
            <div class="admin-monitor-card-stat">
              <div class="admin-monitor-card-stat-label">Email</div>
              <div class="mono" style="font-size:11px;color:#0f172a;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(u.email || (u.username + '@contestant.local'))}</div>
            </div>
            <div class="admin-monitor-card-stat">
              <div class="admin-monitor-card-stat-label">Score / Solved</div>
              <div class="mono" style="font-size:13px;font-weight:800;color:#059669;margin-top:2px">${u.score || 0} pts &bull; ${(u.solvedChallenges || []).length} solved</div>
            </div>
            <div class="admin-monitor-card-stat">
              <div class="admin-monitor-card-stat-label">Registered</div>
              <div class="mono" style="font-size:11px;color:#475569;margin-top:2px">${u.createdAt ? formatTime(u.createdAt) : '—'}</div>
            </div>
          </div>

          <div class="admin-monitor-card-actions">
            <button class="btn btn-sm btn-primary" onclick="adminViewUserDetails('${u.id}')">👁️ View Details</button>
            ${!u.approved && !u.disqualified ? `<button class="btn btn-sm btn-green" onclick="adminApproveUser('${u.id}')">✓ Approve</button>` : ''}
            ${u.disqualified ? `<button class="btn btn-sm btn-secondary" onclick="adminReinstate('${u.id}')">↩ Reinstate</button>` : `<button class="btn btn-sm btn-danger" onclick="adminDisqualifyUser('${u.id}')">🚫 Disqualify</button>`}
            <button class="btn btn-sm btn-secondary" onclick="adminResetUser('${u.id}')">🔄 Reset</button>
            <button class="btn btn-sm btn-danger" onclick="adminRejectUser('${u.id}')">🗑️ Delete</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}



function adminOverview() {
  const users = Store.get('users', getDefaultUsers()).filter(u => u.role !== 'admin');
  const approved = users.filter(u => u.approved && !u.disqualified).length;
  const pending  = users.filter(u => !u.approved && !u.disqualified).length;
  const dq       = users.filter(u => u.disqualified).length;
  const allSubmissions = users.flatMap(u => (u.submissions || []).map(s => ({ ...s, username: u.username, team: u.team })));
  const correctSubs = allSubmissions.filter(s => s.correct);
  const correct = correctSubs.length;
  const total = allSubmissions.length;
  const wrong = total - correct;
  const challenges = challengesData.challenges;

  const r1Challenges = challenges.filter(c => c.round === 1);
  const r2Challenges = challenges.filter(c => c.round === 2);
  const r3Challenges = challenges.filter(c => c.round === 3);

  const r1Solves = users.reduce((s, u) => s + (u.solvedChallenges || []).filter(id => r1Challenges.some(c => c.id === id)).length, 0);
  const r2Solves = users.reduce((s, u) => s + (u.solvedChallenges || []).filter(id => r2Challenges.some(c => c.id === id)).length, 0);
  const r3Solves = users.reduce((s, u) => s + (u.solvedChallenges || []).filter(id => r3Challenges.some(c => c.id === id)).length, 0);

  const totalPossibleR1 = r1Challenges.length * users.length || 1;
  const totalPossibleR2 = r2Challenges.length * users.length || 1;
  const totalPossibleR3 = 5 * users.length || 1;

  const r1Pct = Math.min(100, Math.round((r1Solves / totalPossibleR1) * 100));
  const r2Pct = Math.min(100, Math.round((r2Solves / totalPossibleR2) * 100));
  const r3Pct = Math.min(100, Math.round((r3Solves / totalPossibleR3) * 100));

  const examStatus = Store.get('examStatus', 'waiting');
  const examStartTime = Store.get('examStartTime', null);
  const userTimings = users.map(u => ({
    user: u,
    timing: calculateContestantTimings(u, getUserChallenges(u), examStartTime)
  }));
  const finishedUsers = userTimings
    .filter(t => t.timing.isAllCompleted)
    .sort((a, b) => a.timing.totalCompletedTimeMs - b.timing.totalCompletedTimeMs);
  const fastestAllSteps = finishedUsers.length > 0 ? finishedUsers[0] : null;

  const allCompletedSteps = userTimings.flatMap(t => t.timing.steps.filter(s => s.status === 'completed'));
  const overallAvgStepMs = allCompletedSteps.length > 0
    ? Math.round(allCompletedSteps.reduce((sum, s) => sum + (s.durationMs || 0), 0) / allCompletedSteps.length)
    : 0;

  // Recent activity: last 10 submissions across all users
  const recentSubs = allSubmissions.slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 10);

  return `
    <div class="admin-page-title">📊 Contest Overview</div>

    <div class="exam-ctrl-bar">
      <span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:#475569">Exam Status:</span>
      <span class="exam-status-pill ${examStatus}"><span class="sdot"></span>${examStatus === 'waiting' ? 'NOT STARTED' : examStatus === 'running' ? '● LIVE' : '■ ENDED'}</span>
      ${examStatus !== 'running' ? `<button class="btn btn-green btn-sm" onclick="adminStartExam()">▶ Start Exam</button>` : ''}
      ${examStatus === 'running'  ? `<button class="btn btn-danger btn-sm" onclick="adminStopExam()">■ End Exam</button>` : ''}
    </div>

    <!-- Interactive Drill-down Stat Cards -->
    <div class="stats-grid">
      <div class="stat-card stat-card--clickable" onclick="adminNav('users')" title="Click to view Contestant Directory">
        <div class="stat-card-value cyan">${users.length}</div>
        <div class="stat-card-label">Total Registered</div>
        <div class="stat-card-hint">View Directory →</div>
      </div>
      <div class="stat-card stat-card--clickable" onclick="adminDrillDown('approved')" title="Click to view approved contestants">
        <div class="stat-card-value green">${approved}</div>
        <div class="stat-card-label">Approved</div>
        <div class="stat-card-hint">Click to inspect →</div>
      </div>
      <div class="stat-card stat-card--clickable" onclick="adminDrillDown('pending')" title="Click to review pending approvals">
        <div class="stat-card-value yellow">${pending}</div>
        <div class="stat-card-label">Pending Approval</div>
        <div class="stat-card-hint">Click to review →</div>
      </div>
      <div class="stat-card stat-card--clickable" onclick="adminDrillDown('disqualified')" title="Click to view disqualified contestants">
        <div class="stat-card-value red">${dq}</div>
        <div class="stat-card-label">Disqualified</div>
        <div class="stat-card-hint">Click to manage →</div>
      </div>
      <div class="stat-card stat-card--clickable" onclick="adminDrillDown('correct')" title="Click to view all correct solves">
        <div class="stat-card-value green">${correct}</div>
        <div class="stat-card-label">Correct Solves</div>
        <div class="stat-card-hint">Click to inspect →</div>
      </div>
      <div class="stat-card stat-card--clickable" onclick="adminDrillDown('wrong')" title="Click to view all wrong attempts">
        <div class="stat-card-value red">${wrong}</div>
        <div class="stat-card-label">Wrong Attempts</div>
        <div class="stat-card-hint">Click to inspect →</div>
      </div>
      <div class="stat-card stat-card--clickable" onclick="adminDrillDown('osint')" title="Click to view OSINT round solves">
        <div class="stat-card-value cyan">${r1Solves}</div>
        <div class="stat-card-label">OSINT Solves</div>
        <div class="stat-card-hint">Click to inspect →</div>
      </div>
      <div class="stat-card stat-card--clickable" onclick="adminDrillDown('web')" title="Click to view Web round solves">
        <div class="stat-card-value green">${r2Solves}</div>
        <div class="stat-card-label">Web Solves</div>
        <div class="stat-card-hint">Click to inspect →</div>
      </div>
      <div class="stat-card stat-card--clickable" onclick="adminDrillDown('code')" title="Click to view Code round solves">
        <div class="stat-card-value purple">${r3Solves}</div>
        <div class="stat-card-label">Code Solves</div>
        <div class="stat-card-hint">Click to inspect →</div>
      </div>
      <div class="stat-card stat-card--clickable" onclick="adminDrillDown('fastest')" title="Click to view speed leaderboard">
        <div class="stat-card-value green" style="font-size:22px">${fastestAllSteps ? formatDuration(fastestAllSteps.timing.totalCompletedTimeMs) : (finishedUsers.length === 0 && users.length > 0 ? 'In Progress' : '—')}</div>
        <div class="stat-card-label">🏆 Fastest Finish${fastestAllSteps ? ` (@${escapeHtml(fastestAllSteps.user.username)})` : ''}</div>
        <div class="stat-card-hint">Click for speed board →</div>
      </div>
      <div class="stat-card stat-card--clickable" onclick="adminDrillDown('timing')" title="Click to view question solve time breakdown">
        <div class="stat-card-value cyan" style="font-size:22px">${overallAvgStepMs > 0 ? formatDuration(overallAvgStepMs) : '—'}</div>
        <div class="stat-card-label">⚡ Avg Question Solve Time</div>
        <div class="stat-card-hint">Click for analytics →</div>
      </div>
    </div>

    <!-- Round Solves Progress Widget -->
    <div class="admin-round-progress">
      <div style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:#0f172a;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between">
        <span>📈 Round Completion Progress</span>
        <span style="font-size:11px;color:#64748b;font-weight:500">Across ${users.length} registered contestant${users.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="admin-round-row">
        <div class="admin-round-label" style="color:#0284c7">🔍 OSINT</div>
        <div class="admin-round-bar-bg"><div class="admin-round-bar-fill osint" style="width:${r1Pct}%"></div></div>
        <div class="admin-round-pct">${r1Solves} solves (${r1Pct}%)</div>
      </div>
      <div class="admin-round-row">
        <div class="admin-round-label" style="color:#059669">🌐 WEB</div>
        <div class="admin-round-bar-bg"><div class="admin-round-bar-fill web" style="width:${r2Pct}%"></div></div>
        <div class="admin-round-pct">${r2Solves} solves (${r2Pct}%)</div>
      </div>
      <div class="admin-round-row">
        <div class="admin-round-label" style="color:#7c3aed">💻 CODE</div>
        <div class="admin-round-bar-bg"><div class="admin-round-bar-fill code" style="width:${r3Pct}%"></div></div>
        <div class="admin-round-pct">${r3Solves} solves (${r3Pct}%)</div>
      </div>
    </div>

    <!-- Top Performers Table -->
    <div class="admin-table-wrap" style="margin-bottom:24px">
      <div class="admin-table-header">
        <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:#0f172a">🏆 Top Performers</div>
        <button class="btn btn-sm btn-secondary" onclick="adminNav('leaderboard')">Full Leaderboard →</button>
      </div>
      <div style="overflow-x:auto">
        <table class="admin-table">
          <thead><tr><th>#</th><th>Team / Contestant</th><th>Score</th><th>Solved</th><th>⏱️ Total Time</th><th>Last Active</th><th>Actions</th></tr></thead>
          <tbody>
            ${buildLeaderboard().slice(0,6).map((e,i) => `
              <tr>
                <td class="mono">#${i+1}</td>
                <td class="bright">${escapeHtml(e.team)}</td>
                <td style="color:#059669;font-family:var(--font-mono);font-weight:800">${e.score}</td>
                <td>${e.solved}</td>
                <td class="mono" style="font-size:11px;color:#0284c7;font-weight:700">
                  ${e.totalTimeMs ? `<span class="duration-badge ${e.isAllCompleted ? 'fast' : 'medium'}" style="cursor:pointer" onclick="adminViewStepTimes('${e.id}')">${e.isAllCompleted ? '🏆 ' : '⏱️ '}${formatDuration(e.totalTimeMs)}</span>` : '—'}
                </td>
                <td class="mono" style="font-size:11px">${e.lastSolve ? formatTime(e.lastSolve) : '—'}</td>
                <td>
                  <button class="btn btn-sm btn-secondary" onclick="adminViewStepTimes('${e.id}')" style="font-size:10px;padding:2px 8px">⏱️ Steps</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Recent Activity Feed -->
    <div class="admin-activity-feed">
      <div class="admin-activity-header">
        <span>⚡ Live Submission Stream</span>
        <button class="btn btn-sm btn-secondary" style="margin-left:auto;font-size:10px;padding:2px 8px" onclick="adminNav('submissions')">View All Submissions →</button>
      </div>
      ${recentSubs.length === 0 ? `
        <div style="padding:24px;text-align:center;color:#64748b;font-size:12px;font-family:var(--font-mono)">
          No submissions recorded yet. Live activity will appear here as contestants submit flags.
        </div>
      ` : recentSubs.map(s => {
        return `
          <div class="admin-activity-item">
            <div class="admin-activity-dot ${s.correct ? 'correct' : 'wrong'}"></div>
            <div class="admin-activity-time">${formatTime(s.timestamp)}</div>
            <div class="admin-activity-user">@${escapeHtml(s.username)}</div>
            <div class="admin-activity-detail">
              <strong style="color:#0f172a">${escapeHtml(s.challengeId)}</strong>:
              <span style="font-family:var(--font-mono);font-size:11px;color:#64748b">"${escapeHtml((s.value||'').substring(0, 35))}"</span>
            </div>
            <div class="admin-activity-badge ${s.correct ? 'correct' : 'wrong'}">
              ${s.correct ? '✓ CORRECT' : '✗ WRONG'}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/* ── Admin Drill-down View ───────────────────────────────── */
window.adminDrillDown = (type) => {
  Sound.play('click');
  const area = $('#admin-content-area');
  if (!area) return;

  const users = Store.get('users', getDefaultUsers()).filter(u => u.role !== 'admin');
  const challenges = challengesData.challenges;
  const examStartTime = Store.get('examStartTime', null);
  const allSubmissions = users.flatMap(u => (u.submissions || []).map(s => ({ ...s, username: u.username, name: u.name, team: u.team })));
  allSubmissions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  let title = '';
  let icon = '📊';
  let desc = '';
  let count = 0;
  let headerActions = '';
  let tableHtml = '';

  if (type === 'registered') {
    icon = '👥';
    title = 'All Registered Contestants';
    desc = 'Comprehensive registry of all contestant accounts, contact details, registration time, and status.';
    count = users.length;
    tableHtml = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Name & Username</th>
            <th>Phone</th>
            <th>Registered At</th>
            <th>Status</th>
            <th>Score</th>
            <th>Violations</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${users.map(u => `
            <tr>
              <td>
                <div class="bright">${escapeHtml(u.name || u.username)}</div>
                <div class="mono" style="font-size:11px;color:#64748b">@${escapeHtml(u.username)}</div>
              </td>
              <td class="mono" style="font-size:11px">${escapeHtml(u.phone || '—')}</td>
              <td class="mono" style="font-size:11px">${u.createdAt ? formatTime(u.createdAt) : '—'}</td>
              <td>
                ${u.disqualified ? '<span class="badge-dq"><span class="badge-inner">🚫 Disqualified</span></span>' : !u.approved ? '<span class="badge-pending"><span class="badge-inner">⏳ Pending</span></span>' : '<span class="badge-approved"><span class="badge-inner">✓ Approved</span></span>'}
              </td>
              <td class="mono" style="font-weight:700;color:#059669">${u.score || 0}</td>
              <td>
                <span class="ac-badge-violations ${(u.tabSwitches||0) === 0 ? 'clean' : (u.tabSwitches||0) >= 3 ? 'critical' : 'warned'}">
                  <span class="badge-inner">${(u.tabSwitches||0) === 0 ? '✓ Clean' : `⚠ ${u.tabSwitches} violation${u.tabSwitches > 1 ? 's' : ''}`}</span>
                </span>
              </td>
              <td>
                <div class="action-btns">
                  <button class="btn btn-sm btn-secondary" onclick="adminViewStepTimes('${u.id}')">⏱️ Steps</button>
                  ${!u.approved && !u.disqualified ? `<button class="btn btn-sm btn-green" onclick="adminApproveUser('${u.id}')">✓ Approve</button>` : ''}
                  ${u.disqualified ? `<button class="btn btn-sm btn-secondary" onclick="adminReinstate('${u.id}')">↩ Reinstate</button>` : `<button class="btn btn-sm btn-danger" onclick="adminDisqualifyUser('${u.id}')">🚫 Disqualify</button>`}
                  <button class="btn btn-sm btn-secondary" onclick="adminResetUser('${u.id}')">🔄 Reset</button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } else if (type === 'approved') {
    const approvedUsers = users.filter(u => u.approved && !u.disqualified);
    icon = '✓';
    title = 'Approved Contestants';
    desc = 'Contestants currently eligible and permitted to take part in the exam.';
    count = approvedUsers.length;
    tableHtml = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Name & Username</th>
            <th>Phone</th>
            <th>Score</th>
            <th>Solved Challenges</th>
            <th>Violations</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${approvedUsers.map(u => `
            <tr>
              <td>
                <div class="bright">${escapeHtml(u.name || u.username)}</div>
                <div class="mono" style="font-size:11px;color:#64748b">@${escapeHtml(u.username)}</div>
              </td>
              <td class="mono" style="font-size:11px">${escapeHtml(u.phone || '—')}</td>
              <td class="mono" style="font-size:16px;font-weight:800;color:#059669">${u.score || 0}</td>
              <td>
                <div class="mono" style="font-size:12px;font-weight:700">${(u.solvedChallenges || []).length} solved</div>
                <div class="mono" style="font-size:10px;color:#64748b">${(u.solvedChallenges || []).join(', ') || 'None'}</div>
              </td>
              <td>
                <span class="ac-badge-violations ${(u.tabSwitches||0) === 0 ? 'clean' : (u.tabSwitches||0) >= 3 ? 'critical' : 'warned'}">
                  <span class="badge-inner">${(u.tabSwitches||0) === 0 ? '✓ Clean' : `⚠ ${u.tabSwitches}`}</span>
                </span>
              </td>
              <td>
                <div class="action-btns">
                  <button class="btn btn-sm btn-secondary" onclick="adminViewStepTimes('${u.id}')">⏱️ Steps</button>
                  <button class="btn btn-sm btn-danger" onclick="adminDisqualifyUser('${u.id}')">🚫 Disqualify</button>
                  <button class="btn btn-sm btn-secondary" onclick="adminResetUser('${u.id}')">🔄 Reset</button>
                </div>
              </td>
            </tr>
          `).join('')}
          ${approvedUsers.length === 0 ? '<tr><td colspan="6"><div class="empty-state"><div class="empty-state-title">No approved users yet</div></div></td></tr>' : ''}
        </tbody>
      </table>
    `;
  } else if (type === 'pending') {
    const pendingUsers = users.filter(u => !u.approved && !u.disqualified);
    icon = '⏳';
    title = 'Pending Contestant Approvals';
    desc = 'These users have registered and are waiting for admin verification before taking the exam.';
    count = pendingUsers.length;
    if (pendingUsers.length > 0) {
      headerActions = `<button class="btn btn-green btn-sm" onclick="adminApproveAll()">✓ Approve All (${pendingUsers.length})</button>`;
    }
    tableHtml = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Name & Username</th>
            <th>Phone</th>
            <th>Registered At</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${pendingUsers.map(u => `
            <tr>
              <td>
                <div class="bright">${escapeHtml(u.name || u.username)}</div>
                <div class="mono" style="font-size:11px;color:#64748b">@${escapeHtml(u.username)}</div>
              </td>
              <td class="mono" style="font-size:11px">${escapeHtml(u.phone || '—')}</td>
              <td class="mono" style="font-size:11px">${u.createdAt ? formatTime(u.createdAt) : '—'}</td>
              <td>
                <div class="action-btns">
                  <button class="btn btn-sm btn-green" onclick="adminApproveUser('${u.id}')">✓ Approve</button>
                  <button class="btn btn-sm btn-danger" onclick="adminRejectUser('${u.id}')">✗ Reject</button>
                </div>
              </td>
            </tr>
          `).join('')}
          ${pendingUsers.length === 0 ? '<tr><td colspan="4"><div class="empty-state"><div class="empty-state-title" style="color:#059669">✓ No pending approvals!</div><div class="empty-state-sub">All registered contestants have been approved.</div></div></td></tr>' : ''}
        </tbody>
      </table>
    `;
  } else if (type === 'disqualified') {
    const dqUsers = users.filter(u => u.disqualified);
    icon = '🚫';
    title = 'Disqualified Contestants';
    desc = 'Contestants locked out of the exam due to proctoring/tab-switch violations or manual admin action.';
    count = dqUsers.length;
    tableHtml = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Name & Username</th>
            <th>Phone</th>
            <th>Tab Switch Violations</th>
            <th>Score Before DQ</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${dqUsers.map(u => `
            <tr style="background:#fff1f2">
              <td>
                <div class="bright" style="color:#991b1b">${escapeHtml(u.name || u.username)}</div>
                <div class="mono" style="font-size:11px;color:#64748b">@${escapeHtml(u.username)}</div>
              </td>
              <td class="mono" style="font-size:11px">${escapeHtml(u.phone || '—')}</td>
              <td>
                <span class="ac-badge-violations critical">
                  <span class="badge-inner">⚠ ${u.tabSwitches || 3} violations (Limit exceeded)</span>
                </span>
              </td>
              <td class="mono" style="font-weight:700">${u.score || 0} pts</td>
              <td>
                <div class="action-btns">
                  <button class="btn btn-sm btn-secondary" onclick="adminReinstate('${u.id}')">↩ Reinstate Contestant</button>
                  <button class="btn btn-sm btn-secondary" onclick="adminResetViolations('${u.id}')">🛡️ Reset Strikes</button>
                </div>
              </td>
            </tr>
          `).join('')}
          ${dqUsers.length === 0 ? '<tr><td colspan="5"><div class="empty-state"><div class="empty-state-title" style="color:#059669">✓ No disqualified contestants</div><div class="empty-state-sub">No anti-cheat violations or manual disqualifications active.</div></div></td></tr>' : ''}
        </tbody>
      </table>
    `;
  } else if (type === 'wrong') {
    const wrongSubs = allSubmissions.filter(s => !s.correct);
    icon = '❌';
    title = 'Incorrect Attempts Log';
    desc = 'Every wrong flag submitted by contestants, showing exact attempted values and timestamps.';
    count = wrongSubs.length;
    tableHtml = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Contestant</th>
            <th>Challenge</th>
            <th>Attempted Value</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          ${wrongSubs.map(s => {
            const ch = challenges.find(c => c.id === s.challengeId);
            return `
              <tr>
                <td class="mono" style="font-size:11px">${formatTime(s.timestamp)}</td>
                <td class="bright">@${escapeHtml(s.username)}</td>
                <td>
                  <span class="mono" style="font-weight:700;color:#0284c7">${escapeHtml(s.challengeId)}</span>
                  ${ch ? `<span style="font-size:11px;color:#64748b"> (${escapeHtml(ch.name)})</span>` : ''}
                </td>
                <td class="mono" style="font-size:11px;color:#dc2626;background:#fef2f2;border-radius:4px;padding:4px 8px;max-width:280px;word-break:break-all">
                  ${escapeHtml(s.value || '—')}
                </td>
                <td><span class="enabled-badge no">WRONG</span></td>
              </tr>
            `;
          }).join('')}
          ${wrongSubs.length === 0 ? '<tr><td colspan="5"><div class="empty-state"><div class="empty-state-title">No wrong attempts recorded yet</div></div></td></tr>' : ''}
        </tbody>
      </table>
    `;
  } else if (type === 'correct') {
    const correctSubs = allSubmissions.filter(s => s.correct);
    icon = '✅';
    title = 'Correct Solves Log';
    desc = 'All successful flag submissions with challenge details, points, and solve times.';
    count = correctSubs.length;
    tableHtml = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Contestant</th>
            <th>Challenge</th>
            <th>Round</th>
            <th>Solved Flag</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          ${correctSubs.map(s => {
            const ch = challenges.find(c => c.id === s.challengeId);
            return `
              <tr>
                <td class="mono" style="font-size:11px">${formatTime(s.timestamp)}</td>
                <td class="bright">@${escapeHtml(s.username)}</td>
                <td>
                  <span class="mono" style="font-weight:700;color:#059669">${escapeHtml(s.challengeId)}</span>
                  ${ch ? `<span style="font-size:11px;color:#64748b"> (${escapeHtml(ch.name)})</span>` : ''}
                </td>
                <td>
                  <span class="mono" style="font-size:11px;font-weight:700;color:${ch?.round === 1 ? '#0284c7' : ch?.round === 2 ? '#059669' : '#7c3aed'}">
                    ${ch?.round === 1 ? 'OSINT' : ch?.round === 2 ? 'WEB' : 'CODE'}
                  </span>
                </td>
                <td class="mono" style="font-size:11px;color:#059669;background:#f0fdf4;border-radius:4px;padding:4px 8px;max-width:280px;word-break:break-all">
                  ${escapeHtml(s.value || '—')}
                </td>
                <td><span class="enabled-badge yes">CORRECT</span></td>
              </tr>
            `;
          }).join('')}
          ${correctSubs.length === 0 ? '<tr><td colspan="6"><div class="empty-state"><div class="empty-state-title">No correct solves yet</div></div></td></tr>' : ''}
        </tbody>
      </table>
    `;
  } else if (type === 'osint' || type === 'web' || type === 'code') {
    const roundNum = type === 'osint' ? 1 : type === 'web' ? 2 : 3;
    const roundName = type === 'osint' ? 'OSINT (Round 1)' : type === 'web' ? 'WEB (Round 2)' : 'CODE (Round 3)';
    const roundSubs = allSubmissions.filter(s => {
      const ch = challenges.find(c => c.id === s.challengeId);
      return ch && ch.round === roundNum && s.correct;
    });
    icon = type === 'osint' ? '🔍' : type === 'web' ? '🌐' : '💻';
    title = `${roundName} Solves`;
    desc = `All successful solves for challenges in ${roundName}.`;
    count = roundSubs.length;
    tableHtml = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Contestant</th>
            <th>Challenge</th>
            <th>Difficulty</th>
            <th>Points</th>
            <th>Solved Flag</th>
          </tr>
        </thead>
        <tbody>
          ${roundSubs.map(s => {
            const ch = challenges.find(c => c.id === s.challengeId);
            return `
              <tr>
                <td class="mono" style="font-size:11px">${formatTime(s.timestamp)}</td>
                <td class="bright">@${escapeHtml(s.username)}</td>
                <td class="mono" style="font-weight:700">${escapeHtml(s.challengeId)}: ${escapeHtml(ch?.name || '')}</td>
                <td><span class="difficulty-badge difficulty-${ch?.difficulty || 'easy'}">${ch?.difficulty || 'easy'}</span></td>
                <td class="mono" style="font-weight:700;color:#d97706">${ch?.points || 0}</td>
                <td class="mono" style="font-size:11px;color:#059669">${escapeHtml(s.value || '—')}</td>
              </tr>
            `;
          }).join('')}
          ${roundSubs.length === 0 ? `<tr><td colspan="6"><div class="empty-state"><div class="empty-state-title">No solves for ${roundName} yet</div></div></td></tr>` : ''}
        </tbody>
      </table>
    `;
  } else if (type === 'fastest' || type === 'timing') {
    icon = '⏱️';
    title = 'Contestant Solve Speed & Timings';
    desc = 'Breakdown of completion speed, individual question solve durations, and step analytics.';
    const userTimings = users.map(u => ({
      user: u,
      timing: calculateContestantTimings(u, getUserChallenges(u), examStartTime)
    })).sort((a, b) => {
      if (a.timing.isAllCompleted && !b.timing.isAllCompleted) return -1;
      if (!a.timing.isAllCompleted && b.timing.isAllCompleted) return 1;
      return a.timing.totalCompletedTimeMs - b.timing.totalCompletedTimeMs;
    });
    count = userTimings.length;
    tableHtml = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Contestant</th>
            <th>Progress</th>
            <th>⏱️ Total Completed Time</th>
            <th>⚡ Avg Time / Step</th>
            <th>Status</th>
            <th>Step Breakdown</th>
          </tr>
        </thead>
        <tbody>
          ${userTimings.map((t, i) => `
            <tr>
              <td class="mono">#${i+1}</td>
              <td>
                <div class="bright">${escapeHtml(t.user.name || t.user.username)}</div>
                <div class="mono" style="font-size:11px;color:#64748b">@${escapeHtml(t.user.username)}</div>
              </td>
              <td>
                <div class="mono" style="font-size:12px;font-weight:700">${t.timing.completedSteps} / ${t.timing.totalSteps} steps</div>
                <div style="font-size:10px;color:#64748b">${t.user.score || 0} points earned</div>
              </td>
              <td class="mono" style="font-size:13px;font-weight:700;color:#0284c7">
                ${t.timing.completedSteps > 0 ? (t.timing.isAllCompleted ? `🏆 ${formatDuration(t.timing.totalCompletedTimeMs)}` : `⏱️ ${formatDuration(t.timing.totalCompletedTimeMs)}`) : '—'}
              </td>
              <td class="mono" style="font-size:11px;font-weight:700;color:#059669">
                ${t.timing.avgTimePerStepMs > 0 ? formatDuration(t.timing.avgTimePerStepMs) : '—'}
              </td>
              <td>
                ${t.timing.isAllCompleted ? '<span class="badge-approved"><span class="badge-inner">✓ ALL STEPS DONE</span></span>' : t.timing.completedSteps > 0 ? '<span class="badge-pending"><span class="badge-inner">● IN PROGRESS</span></span>' : '<span style="font-family:var(--font-mono);font-size:11px;color:#94a3b8">Not started</span>'}
              </td>
              <td>
                <button class="btn btn-sm btn-primary" onclick="adminViewStepTimes('${t.user.id}')" style="font-size:10px;padding:3px 8px">⏱️ Step Breakdown</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  area.innerHTML = withAnimEmojis(`
    <div class="admin-drilldown-header">
      <button class="admin-back-btn" onclick="adminNav('overview')">
        <span>←</span>
        <span>Back to Overview</span>
      </button>
      <div style="flex:1;min-width:200px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-size:22px">${animEmoji(icon)}</span>
          <span class="admin-drilldown-title">${title}</span>
          <span class="admin-drilldown-count">${count} items</span>
        </div>
        <div style="font-family:var(--font-mono);font-size:11px;color:#64748b;margin-top:4px">${desc}</div>
      </div>
      ${headerActions}
    </div>

    <div class="admin-table-wrap" style="overflow-x:auto">
      ${tableHtml}
    </div>
  `);
};


/* \u2500\u2500 Approvals Tab \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
function adminApprovals() {
  const users = Store.get('users', getDefaultUsers()).filter(u => u.role !== 'admin');
  const pending  = users.filter(u => !u.approved && !u.disqualified);
  const approved = users.filter(u => u.approved && !u.disqualified);
  const dq       = users.filter(u => u.disqualified);

  const renderRow = (u, actions) => `
    <tr>
      <td class="bright">${escapeHtml(u.name || u.username)}</td>
      <td class="mono" style="font-size:11px">${escapeHtml(u.username)}</td>
      <td class="mono" style="font-size:11px">${escapeHtml(u.phone || '—')}</td>
      <td class="mono" style="font-size:11px">${u.createdAt ? formatTime(u.createdAt) : '—'}</td>
      <td><div class="action-btns">${actions}</div></td>
    </tr>`;

  return `
    <div class="admin-page-title">🕐 Contestant Approvals</div>

    ${pending.length === 0 ? `
      <div class="empty-state" style="margin-bottom:24px">
        <div class="empty-state-title" style="color:var(--green)">✓ No pending approvals</div>
        <div class="empty-state-sub">All registered contestants have been reviewed.</div>
      </div>` : `
      <div class="admin-table-wrap" style="margin-bottom:24px">
        <div class="admin-table-header" style="background:#fef3c7;border-color:#fcd34d">
          <div style="font-family:var(--font-mono);font-size:13px;color:#92400e">⏳ Pending Approval (${pending.length})</div>
          <button class="btn btn-green btn-sm" onclick="adminApproveAll()">✓ Approve All</button>
        </div>
        <table class="admin-table">
          <thead><tr><th>Name</th><th>Username</th><th>Phone</th><th>Registered</th><th>Actions</th></tr></thead>
          <tbody>
            ${pending.map(u => renderRow(u, `
              <button class="btn btn-sm btn-green" onclick="adminApproveUser('${u.id}')">✓ Approve</button>
              <button class="btn btn-sm btn-danger" onclick="adminRejectUser('${u.id}')">✗ Reject</button>
            `)).join('')}
          </tbody>
        </table>
      </div>`}

    ${approved.length > 0 ? `
      <div class="admin-table-wrap" style="margin-bottom:24px">
        <div class="admin-table-header">
          <div style="font-family:var(--font-mono);font-size:13px;color:var(--green)">✓ Approved (${approved.length})</div>
        </div>
        <table class="admin-table">
          <thead><tr><th>Name</th><th>Username</th><th>Phone</th><th>Registered</th><th>Actions</th></tr></thead>
          <tbody>
            ${approved.map(u => renderRow(u, `
              <button class="btn btn-sm btn-danger" onclick="adminDisqualifyUser('${u.id}')">🚫 Disqualify</button>
              <button class="btn btn-sm btn-secondary" onclick="adminResetUser('${u.id}')">🔄 Reset</button>
            `)).join('')}
          </tbody>
        </table>
      </div>` : ''}

    ${dq.length > 0 ? `
      <div class="admin-table-wrap">
        <div class="admin-table-header" style="background:#fff1f2;border-color:#fecdd3">
          <div style="font-family:var(--font-mono);font-size:13px;color:#be123c">🚫 Disqualified (${dq.length})</div>
        </div>
        <table class="admin-table">
          <thead><tr><th>Name</th><th>Username</th><th>Phone</th><th>Registered</th><th>Actions</th></tr></thead>
          <tbody>
            ${dq.map(u => renderRow(u, `
              <button class="btn btn-sm btn-secondary" onclick="adminReinstate('${u.id}')">↩ Reinstate</button>
            `)).join('')}
          </tbody>
        </table>
      </div>` : ''}
  `;
}

window.adminApproveUser = async (uid) => {
  try {
    const { user: u } = await Api.put(`/api/users/${uid}/approve`);
    toast('Approved ✓', `${u?.username || uid} can now enter the exam.`, 'success');
    Sound.play('unlock');
    await refreshAdminDataRealtime(true);
  } catch (err) { toast('Error', err.message, 'error'); }
};
window.adminApproveAll = async () => {
  const users = Store.get('users', getDefaultUsers());
  const pending = users.filter(u => u.role !== 'admin' && !u.disqualified && !u.approved);
  try {
    await Promise.all(pending.map(u => Api.put(`/api/users/${u.id}/approve`)));
    toast('All Approved ✓', 'All pending contestants have been approved.', 'success');
    Sound.play('unlock');
    await refreshAdminDataRealtime(true);
  } catch (err) { toast('Error', err.message, 'error'); }
};
window.adminRejectUser = (uid) => {
  showModal('Reject Contestant?', '<p style="color:var(--text-secondary)">This will permanently delete this user\'s registration.</p>', [
    { label: 'Reject & Delete', cls: 'btn-danger', action: async () => {
      try {
        await Api.del(`/api/users/${uid}`);
        closeModal();
        toast('Rejected', 'User registration removed.', 'warning');
        await refreshAdminDataRealtime(true);
      } catch (err) { toast('Error', err.message, 'error'); }
    }},
    { label: 'Cancel', cls: 'btn-secondary', action: closeModal }
  ]);
};
window.adminReinstate = async (uid) => {
  try {
    await Api.put(`/api/users/${uid}/restore`);
    toast('Reinstated', 'User has been reinstated and violations reset to 0.', 'success');
    await refreshAdminDataRealtime(true);
  } catch (err) { toast('Error', err.message, 'error'); }
};

window.adminResetViolations = async (uid) => {
  try {
    await Api.put(`/api/users/${uid}/reset-violations`);
    toast('Strikes Cleared', 'Tab-switch violations reset to 0 (3 chances restored).', 'success');
    await refreshAdminDataRealtime(true);
  } catch (err) { toast('Error', err.message, 'error'); }
};

/* \u2500\u2500 Live Contestant Monitor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
function adminContestants() {
  const allUsers = Store.get('users', getDefaultUsers()).filter(u => u.role !== 'admin');
  const challenges = challengesData.challenges;

  const statusBadge = (u) => {
    if (u.disqualified) return `<span class="badge-dq"><span class="badge-inner">${animEmoji('🚫')} DISQUALIFIED</span></span>`;
    if (!u.approved)    return `<span class="badge-pending"><span class="badge-inner">${animEmoji('⏳')} PENDING</span></span>`;
    return '<span class="badge-approved"><span class="badge-inner">✓ APPROVED</span></span>';
  };

  const lastSubmission = (u) => {
    const subs = u.submissions || [];
    if (!subs.length) return { challengeId: '—', value: '—', correct: null };
    return subs[subs.length - 1];
  };

  const currentChallenge = (u) => {
    // last submission's challenge, or currentChallenge field
    const sub = (u.submissions || []).slice().reverse().find(s => !s.correct);
    return u.currentChallenge || sub?.challengeId || '—';
  };

  return `
    <div class="admin-page-title">👁️ Live Contestant Monitor</div>
    <div style="margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <button class="btn btn-sm btn-secondary" onclick="adminNav('contestants')">🔄 Refresh</button>
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim)">Auto-refresh: click Refresh or navigate away and back</span>
    </div>
    <!-- Desktop Table View (shown >= 900px) -->
    <div class="admin-table-wrap admin-monitor-table-desktop" style="overflow-x:auto">
      <table class="admin-table monitor-table">
        <thead>
          <tr>
            <th class="col-user">Contestant</th>
            <th class="col-score">Score</th>
            <th class="col-solved">Solved Challenges</th>
            <th class="col-timing" style="min-width:140px">⏱️ Total & Step Time</th>
            <th class="col-current">Working On</th>
            <th class="col-last">Last Submission</th>
            <th class="col-violations">Tab Violations</th>
            <th class="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${allUsers.length === 0 ? `<tr><td colspan="8"><div class="empty-state"><div class="empty-state-title">No contestants yet</div></div></td></tr>` :
          allUsers.map(u => {
            const sub = lastSubmission(u);
            const solved = u.solvedChallenges || [];
            const cur = currentChallenge(u);
            const chName = challenges.find(c => c.id === cur)?.name || cur;
            const userChallenges = getUserChallenges(u);
            const examStartTime = Store.get('examStartTime', null);
            const timings = calculateContestantTimings(u, userChallenges, examStartTime);
            return `<tr style="${u.disqualified ? 'opacity:.6;background:#fff1f2' : ''}">
              <td class="col-user">
                <div style="font-weight:700;color:var(--text-bright)">${escapeHtml(u.name || u.username)}</div>
                <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim)">@${escapeHtml(u.username)}</div>
                <div style="margin-top:4px">${statusBadge(u)}</div>
              </td>
              <td class="col-score">
                <div style="font-family:var(--font-mono);font-size:20px;font-weight:800;color:var(--green)">${u.score || 0}</div>
                <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim)">pts</div>
              </td>
              <td class="col-solved">
                <div class="solved-pill-list">
                  ${solved.length === 0 ? '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim)">None yet</span>' :
                    solved.map(id => {
                      const ch = challenges.find(c => c.id === id);
                      return `<span class="solved-pill" title="${escapeHtml(ch?.name||id)}">${id}</span>`;
                    }).join('')}
                </div>
                <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);margin-top:4px">${solved.length} / ${userChallenges.length} solved</div>
              </td>
              <td class="col-timing">
                ${timings.isAllCompleted ? `
                  <div class="time-pill all-done" onclick="adminViewStepTimes('${u.id}')" title="Click to view step timings">
                    🏆 ${formatDuration(timings.totalCompletedTimeMs)}
                  </div>
                  <div style="font-family:var(--font-mono);font-size:10px;color:#047857;font-weight:700;margin-top:2px">✓ All ${timings.totalSteps} steps done!</div>
                  <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-secondary)">Avg: ${formatDuration(timings.avgTimePerStepMs)} / step</div>
                ` : timings.completedSteps > 0 ? `
                  <div class="time-pill in-progress" onclick="adminViewStepTimes('${u.id}')" title="Click to view step timings">
                    ⏱️ ${formatDuration(timings.totalCompletedTimeMs)}
                  </div>
                  <div style="font-family:var(--font-mono);font-size:10px;color:var(--cyan);font-weight:700;margin-top:2px">${timings.completedSteps}/${timings.totalSteps} steps done</div>
                  <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-secondary)">Avg: ${formatDuration(timings.avgTimePerStepMs)} / step</div>
                ` : `
                  <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim)">—</div>
                  <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);margin-top:2px">0 steps completed</div>
                `}
                <div>
                  <button class="btn-step-breakdown" onclick="adminViewStepTimes('${u.id}')" title="View time taken for each question and step">⏱️ Step Breakdown</button>
                </div>
              </td>
              <td class="col-current">
                <div style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--cyan)">${escapeHtml(cur)}</div>
                <div style="font-size:10px;color:var(--text-dim)">${escapeHtml(chName !== cur ? chName : '')}</div>
              </td>
              <td class="col-last">
                <div style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:${sub.correct===true?'var(--green)':sub.correct===false?'var(--red)':'var(--text-dim)'}">
                  ${sub.challengeId !== '—' ? escapeHtml(sub.challengeId) : '—'}
                </div>
                ${sub.value !== '—' ? `
                  <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-secondary);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(sub.value||'')}">
                    → ${escapeHtml((sub.value||'').substring(0,30))}
                  </div>
                  <div style="font-size:10px;margin-top:2px">
                    <span class="enabled-badge ${sub.correct?'yes':'no'}" style="font-size:9px">${sub.correct?'CORRECT':'WRONG'}</span>
                  </div>
                ` : ''}
              </td>
              <td class="col-violations">
                <span class="ac-badge-violations ${(u.tabSwitches||0) === 0 ? 'clean' : (u.tabSwitches||0) >= 3 ? 'critical' : 'warned'}">
                  <span class="badge-inner">${(u.tabSwitches||0) === 0 ? '✓ Clean' : `⚠ ${u.tabSwitches||0} violation${(u.tabSwitches||0)!==1?'s':''}`}</span>
                </span>
              </td>
              <td class="col-actions">
                <div class="action-btns" style="flex-direction:column;gap:6px">
                  <button class="btn btn-sm btn-primary" onclick="adminViewStepTimes('${u.id}')">⏱️ Steps</button>
                  ${!u.disqualified ? `<button class="btn btn-sm btn-danger" onclick="adminDisqualifyUser('${u.id}')">🚫 Disqualify</button>` : `<button class="btn btn-sm btn-secondary" onclick="adminReinstate('${u.id}')">↩ Reinstate</button>`}
                  <button class="btn btn-sm btn-secondary" onclick="adminResetUser('${u.id}')">🔄 Reset</button>
                  ${(u.tabSwitches||0) > 0 ? `<button class="btn btn-sm btn-secondary" onclick="adminResetViolations('${u.id}')">🛡️ Reset Strikes</button>` : ''}
                  ${!u.approved ? `<button class="btn btn-sm btn-green" onclick="adminApproveUser('${u.id}')">✓ Approve</button>` : ''}
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <!-- Mobile Card Layout (shown < 900px) -->
    <div class="admin-monitor-cards">
      ${allUsers.length === 0 ? `<div class="empty-state"><div class="empty-state-title">No contestants yet</div></div>` :
      allUsers.map(u => {
        const sub = lastSubmission(u);
        const solved = u.solvedChallenges || [];
        const cur = currentChallenge(u);
        const chName = challenges.find(c => c.id === cur)?.name || cur;
        const userChallenges = getUserChallenges(u);
        const examStartTime = Store.get('examStartTime', null);
        const timings = calculateContestantTimings(u, userChallenges, examStartTime);
        return `
          <div class="admin-monitor-card" style="${u.disqualified ? 'background:#fff1f2;border-color:#fecaca' : ''}">
            <div class="admin-monitor-card-header">
              <div>
                <div class="admin-monitor-card-name">${escapeHtml(u.name || u.username)}</div>
                <div class="admin-monitor-card-handle">@${escapeHtml(u.username)}</div>
              </div>
              <div style="text-align:right">
                <div>${statusBadge(u)}</div>
                <div style="margin-top:4px">
                  <span class="ac-badge-violations ${(u.tabSwitches||0) === 0 ? 'clean' : (u.tabSwitches||0) >= 3 ? 'critical' : 'warned'}">
                    <span class="badge-inner">${(u.tabSwitches||0) === 0 ? '✓ Clean' : `⚠ ${u.tabSwitches||0} violation${(u.tabSwitches||0)!==1?'s':''}`}</span>
                  </span>
                </div>
              </div>
            </div>

            <div class="admin-monitor-card-grid">
              <div class="admin-monitor-card-stat">
                <div class="admin-monitor-card-stat-label">Score</div>
                <div class="admin-monitor-card-stat-value" style="color:#059669">${u.score || 0} <span style="font-size:10px;color:#64748b">pts</span></div>
              </div>
              <div class="admin-monitor-card-stat">
                <div class="admin-monitor-card-stat-label">Solved</div>
                <div class="admin-monitor-card-stat-value">${solved.length} / ${userChallenges.length}</div>
              </div>
              <div class="admin-monitor-card-stat">
                <div class="admin-monitor-card-stat-label">Working On</div>
                <div class="admin-monitor-card-stat-value" style="font-size:12px;color:#0284c7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(cur)}</div>
              </div>
              <div class="admin-monitor-card-stat">
                <div class="admin-monitor-card-stat-label">Total Time</div>
                <div class="admin-monitor-card-stat-value" style="font-size:12px;color:#0284c7">
                  ${timings.completedSteps > 0 ? (timings.isAllCompleted ? '🏆 ' : '⏱️ ') + formatDuration(timings.totalCompletedTimeMs) : '—'}
                </div>
              </div>
            </div>

            ${sub.challengeId !== '—' ? `
              <div style="background:#f8fafc;border-radius:8px;padding:8px 10px;margin-bottom:12px;font-size:11px">
                <div style="color:#64748b;font-family:var(--font-mono);font-size:9px;text-transform:uppercase;margin-bottom:2px">Last Submission: ${escapeHtml(sub.challengeId)}</div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                  <div class="mono" style="color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((sub.value||'').substring(0,25))}</div>
                  <span class="enabled-badge ${sub.correct?'yes':'no'}">${sub.correct?'CORRECT':'WRONG'}</span>
                </div>
              </div>
            ` : ''}

            <div class="admin-monitor-card-actions">
              <button class="btn btn-sm btn-primary" onclick="adminViewStepTimes('${u.id}')">⏱️ Step Breakdown</button>
              ${!u.disqualified ? `<button class="btn btn-sm btn-danger" onclick="adminDisqualifyUser('${u.id}')">🚫 Disqualify</button>` : `<button class="btn btn-sm btn-secondary" onclick="adminReinstate('${u.id}')">↩ Reinstate</button>`}
              <button class="btn btn-sm btn-secondary" onclick="adminResetUser('${u.id}')">🔄 Reset</button>
              ${(u.tabSwitches||0) > 0 ? `<button class="btn btn-sm btn-secondary" onclick="adminResetViolations('${u.id}')">🛡️ Reset Strikes</button>` : ''}
              ${!u.approved ? `<button class="btn btn-sm btn-green" onclick="adminApproveUser('${u.id}')">✓ Approve</button>` : ''}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

window.adminDisqualifyUser = async (uid) => {
  const users = Store.get('users', getDefaultUsers());
  const u = users.find(u => u.id === uid);
  showModal('Disqualify Contestant?', `<p style="color:var(--red)">Disqualifying <strong>${escapeHtml(u?.username||'')}</strong> will immediately lock them out of the exam. They will see a disqualification screen.</p>`, [
    { label: '🚫 Disqualify', cls: 'btn-danger', action: async () => {
      try {
        await Api.put(`/api/users/${uid}/disqualify`);
        closeModal();
        toast('Disqualified', `${u?.username} has been disqualified.`, 'warning');
        Sound.play('wrong');
        await refreshAdminDataRealtime(true);
      } catch (err) { toast('Error', err.message, 'error'); }
    }},
    { label: 'Cancel', cls: 'btn-secondary', action: closeModal }
  ]);
};

function adminChallenges() {
  const challenges = challengesData.challenges;
  const users = Store.get('users', getDefaultUsers()).filter(u => u.role !== 'admin');

  return `
    <div class="admin-page-title">🎯 Challenge Management</div>
    <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);margin-bottom:14px">
      Total Challenge Bank: ${challenges.length} challenges (4 OSINT, 4 WEB, ${challenges.filter(c => c.round === 3).length} CODE Pool &bull; Each contestant receives 5 randomized CODE challenges [CODE-01 to CODE-05], 13 total)
    </div>
    <div style="margin-bottom:16px">
      <button class="btn btn-primary btn-sm" onclick="toast('Info','Challenge editor coming soon — edit data/challenges.json directly','info')">+ Add Challenge</button>
    </div>
    <div class="admin-table-wrap" style="overflow-x:auto">
      <table class="admin-table">
        <thead><tr><th>ID</th><th>Name</th><th>Round</th><th>Points</th><th>Difficulty</th><th>Solves</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          ${challenges.map(c => {
            const solves = users.filter(u => (u.solvedChallenges || []).includes(c.id)).length;
            return `<tr>
              <td class="mono" style="font-size:11px">${c.id}</td>
              <td class="bright">${escapeHtml(c.name)}</td>
              <td><span style="font-family:var(--font-mono);font-size:11px;color:${['','var(--cyan)','var(--green)','var(--purple)'][c.round]}">${['','OSINT','WEB','CODE'][c.round]}</span></td>
              <td class="mono" style="color:var(--yellow)">${c.points}</td>
              <td><span class="difficulty-badge difficulty-${c.difficulty}">${c.difficulty}</span></td>
              <td class="mono">${solves}</td>
              <td><span class="enabled-badge ${c.enabled ? 'yes' : 'no'}">${c.enabled ? 'Enabled' : 'Disabled'}</span></td>
              <td>
                <div class="action-btns">
                  <button class="btn btn-sm btn-secondary" onclick="adminEditChallenge('${c.id}')">Edit</button>
                  <button class="btn btn-sm btn-danger" onclick="adminToggleChallenge('${c.id}')">Toggle</button>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

window.adminEditChallenge = (id) => {
  const c = challengesData.challenges.find(ch => ch.id === id);
  if (!c) return;
  showModal(`Edit: ${c.name}`, `
    <div class="form-group"><label>Name</label><input class="form-input" id="edit-name" value="${escapeHtml(c.name)}"></div>
    <div class="form-group"><label>Points</label><input class="form-input" id="edit-points" type="number" value="${c.points}"></div>
    <div class="form-group"><label>Difficulty</label>
      <select class="form-input" id="edit-diff">
        <option ${c.difficulty==='easy'?'selected':''}>easy</option>
        <option ${c.difficulty==='medium'?'selected':''}>medium</option>
        <option ${c.difficulty==='hard'?'selected':''}>hard</option>
      </select>
    </div>
  `, [
    { label: 'Save Changes', cls: 'btn-primary', action: () => {
      c.name = $('#edit-name').value;
      c.points = parseInt($('#edit-points').value) || c.points;
      c.difficulty = $('#edit-diff').value;
      closeModal();
      adminNav('challenges');
      toast('Saved', `Challenge ${c.id} updated.`, 'success');
    }},
    { label: 'Cancel', cls: 'btn-secondary', action: closeModal }
  ]);
};

window.adminToggleChallenge = (id) => {
  const c = challengesData.challenges.find(ch => ch.id === id);
  if (!c) return;
  c.enabled = !c.enabled;
  adminNav('challenges');
  toast('Updated', `${c.id} ${c.enabled ? 'enabled' : 'disabled'}.`, 'info');
};

window.adminResetUser = (uid) => {
  showModal('Reset User?', `<p style="color:var(--text-secondary)">This will reset the user's score, solved challenges, hints, and tab switch violations. This cannot be undone.</p>`, [
    { label: 'Reset', cls: 'btn-danger', action: async () => {
      try {
        await Api.put(`/api/users/${uid}/reset`);
        closeModal();
        toast('Reset', 'User progress and tab violations have been reset.', 'warning');
        await refreshAdminDataRealtime(true);
      } catch (err) { toast('Error', err.message, 'error'); }
    }},
    { label: 'Cancel', cls: 'btn-secondary', action: closeModal }
  ]);
};

let adminSubFilter = 'all';
window.adminFilterSubmissions = (f) => {
  Sound.play('click');
  adminSubFilter = f;
  const area = $('#admin-content-area');
  if (area) area.innerHTML = withAnimEmojis(adminSubmissions());
};

function adminSubmissions() {
  const users = Store.get('users', getDefaultUsers()).filter(u => u.role !== 'admin');
  const challenges = challengesData.challenges;
  const all = users.flatMap(u => (u.submissions || []).map(s => ({ ...s, username: u.username, team: u.team })));
  all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const filtered = all.filter(s => {
    if (adminSubFilter === 'correct') return s.correct === true;
    if (adminSubFilter === 'wrong') return !s.correct;
    if (adminSubFilter === 'osint') return challenges.find(c => c.id === s.challengeId)?.round === 1;
    if (adminSubFilter === 'web') return challenges.find(c => c.id === s.challengeId)?.round === 2;
    if (adminSubFilter === 'code') return challenges.find(c => c.id === s.challengeId)?.round === 3;
    return true;
  });

  const correctCount = all.filter(s => s.correct).length;
  const wrongCount = all.length - correctCount;

  return `
    <div class="admin-page-title">📋 Submission Log</div>

    <!-- Filter Tabs -->
    <div class="admin-filter-tabs">
      <button class="admin-filter-tab${adminSubFilter === 'all' ? ' active' : ''}" onclick="adminFilterSubmissions('all')">All (${all.length})</button>
      <button class="admin-filter-tab${adminSubFilter === 'correct' ? ' active' : ''}" onclick="adminFilterSubmissions('correct')">✓ Correct (${correctCount})</button>
      <button class="admin-filter-tab${adminSubFilter === 'wrong' ? ' active' : ''}" onclick="adminFilterSubmissions('wrong')">✗ Wrong (${wrongCount})</button>
      <button class="admin-filter-tab${adminSubFilter === 'osint' ? ' active' : ''}" onclick="adminFilterSubmissions('osint')">🔍 OSINT</button>
      <button class="admin-filter-tab${adminSubFilter === 'web' ? ' active' : ''}" onclick="adminFilterSubmissions('web')">🌐 WEB</button>
      <button class="admin-filter-tab${adminSubFilter === 'code' ? ' active' : ''}" onclick="adminFilterSubmissions('code')">💻 CODE</button>
    </div>

    <div class="admin-table-wrap" style="overflow-x:auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Contestant</th>
            <th>Challenge</th>
            <th>Submitted Value</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.slice(0, 100).map(s => {
            const ch = challenges.find(c => c.id === s.challengeId);
            return `<tr>
              <td class="mono" style="font-size:11px">${formatTime(s.timestamp)}</td>
              <td class="bright">@${escapeHtml(s.username)}</td>
              <td>
                <span class="mono" style="font-weight:700;color:${ch?.round === 1 ? '#0284c7' : ch?.round === 2 ? '#059669' : '#7c3aed'}">${escapeHtml(s.challengeId)}</span>
                ${ch ? `<span style="font-size:11px;color:#64748b"> (${escapeHtml(ch.name)})</span>` : ''}
              </td>
              <td class="mono" style="font-size:11px;max-width:260px;word-break:break-all;color:${s.correct ? '#059669' : '#dc2626'}">${escapeHtml(s.value || '—')}</td>
              <td><span class="enabled-badge ${s.correct ? 'yes' : 'no'}">${s.correct ? 'CORRECT' : 'WRONG'}</span></td>
            </tr>`;
          }).join('')}
          ${filtered.length === 0 ? '<tr><td colspan="5"><div class="empty-state"><div class="empty-state-title">No submissions match this filter</div></div></td></tr>' : ''}
        </tbody>
      </table>
    </div>
  `;
}


function adminLeaderboard() {
  return `
    <div class="admin-page-title">🏆 Leaderboard</div>
    ${(() => {
      const lb = buildLeaderboard();
      return `<div class="leaderboard-container">
        <table class="leaderboard-table">
          <thead><tr><th>Rank</th><th>Team</th><th>Score</th><th>Solved</th><th>⏱️ Total Time</th><th>Last Solve</th><th>Step Breakdown</th></tr></thead>
          <tbody>
            ${lb.map((e, i) => `<tr>
              <td class="lb-rank">#${i+1}</td>
              <td class="lb-team">${escapeHtml(e.team)}</td>
              <td class="lb-score">${e.score}</td>
              <td class="lb-solved">${e.solved}</td>
              <td class="mono" style="font-size:11px;color:var(--cyan);font-weight:700">
                ${e.totalTimeMs ? `<span class="duration-badge ${e.isAllCompleted ? 'fast' : 'medium'}" style="cursor:pointer" onclick="adminViewStepTimes('${e.id}')">${e.isAllCompleted ? '🏆 ' : '⏱️ '}${formatDuration(e.totalTimeMs)}</span>` : '—'}
              </td>
              <td class="lb-time">${e.lastSolve ? formatTime(e.lastSolve) : '—'}</td>
              <td>
                <button class="btn btn-sm btn-secondary" onclick="adminViewStepTimes('${e.id}')" style="font-size:10px;padding:2px 8px">⏱️ View Steps</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    })()}
  `;
}

/* \u2500\u2500 Exam Control (Start / Stop) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
function adminContest() {
  const examStatus = Store.get('examStatus', 'waiting');
  const allUsers = Store.get('users', getDefaultUsers()).filter(u => u.role !== 'admin');
  const approved = allUsers.filter(u => u.approved && !u.disqualified).length;
  const pending  = allUsers.filter(u => !u.approved && !u.disqualified).length;

  const statusColors = { waiting: '#64748b', running: '#10b981', stopped: '#be123c' };
  const statusLabels = { waiting: '○ NOT STARTED', running: '● LIVE', stopped: '■ ENDED' };

  return `
    <div class="admin-page-title">⚙️ Exam Control</div>

    <!-- Status panel -->
    <div class="card" style="margin-bottom:16px;border:2px solid ${statusColors[examStatus]}20">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div>
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);text-transform:uppercase;margin-bottom:4px">Current Status</div>
          <div class="exam-status-pill ${examStatus}" style="font-size:14px;padding:8px 16px">
            <span class="sdot"></span> ${statusLabels[examStatus]}
          </div>
        </div>
        <div style="flex:1;display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:flex-end">
          ${examStatus !== 'running' ? `
            <button class="btn btn-green" onclick="adminStartExam()" style="padding:10px 20px;font-size:13px">
              ▶ START EXAM
            </button>` : ''}
          ${examStatus === 'running' ? `
            <button class="btn btn-secondary" onclick="adminPauseExam()" style="padding:10px 20px;font-size:13px">
              ⏸ PAUSE
            </button>
            <button class="btn btn-danger" onclick="adminStopExam()" style="padding:10px 20px;font-size:13px">
              ■ END EXAM
            </button>` : ''}
          ${examStatus === 'stopped' ? `
            <button class="btn btn-green" onclick="adminRestartExam()" style="padding:10px 20px;font-size:13px">
              🔄 RESTART EXAM
            </button>` : ''}
        </div>
      </div>
    </div>

    <!-- Stats -->
    <div class="stats-grid" style="margin-bottom:16px">
      <div class="stat-card"><div class="stat-card-value green">${approved}</div><div class="stat-card-label">Approved Contestants</div></div>
      <div class="stat-card"><div class="stat-card-value yellow">${pending}</div><div class="stat-card-label">Awaiting Approval</div></div>
    </div>

    ${pending > 0 ? `
      <div style="background:#fef3c7;border:1.5px solid #fcd34d;border-radius:12px;padding:12px 16px;margin-bottom:16px;font-family:var(--font-mono);font-size:12px;color:#92400e">
        ⚠️ ${pending} contestant${pending>1?'s':''} still pending approval. 
        <button class="btn btn-green btn-sm" style="margin-left:8px" onclick="adminApproveAll()">Approve All</button>
      </div>` : ''}

    <!-- Settings -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-title">Contest Settings</div>
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="lb-toggle" ${contestData.contest.leaderboard_visible ? 'checked' : ''} onchange="toggleLeaderboard()">
          <span class="text-secondary" style="font-family:var(--font-mono);font-size:12px">Leaderboard Visible</span>
        </label>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="fp-toggle" ${contestData.contest.free_play_mode ? 'checked' : ''} onchange="toggleFreePlay()">
          <span class="text-secondary" style="font-family:var(--font-mono);font-size:12px">Free Play Mode</span>
        </label>
      </div>
    </div>

    <!-- Danger Zone -->
    <div class="card" style="border:1.5px solid #fecaca;background:#fff5f5;margin-top:20px">
      <div class="card-title" style="color:#b91c1c;display:flex;align-items:center;gap:8px">
        <span class="material-symbols-outlined" style="font-size:20px;color:#dc2626">warning</span>
        <span>Danger Zone // Critical Administrative Operations</span>
      </div>
      <p style="font-size:12px;color:#7f1d1d;margin-bottom:14px;line-height:1.6;font-family:var(--font-mono)">
        <strong>PERMANENT DELETION:</strong> Clicking "Clear All Users" will permanently delete all contestant accounts, registration approvals, challenge solve records, flag submissions, hint reveals, and scoreboard progress. The admin account is protected.
      </p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-danger" onclick="adminClearAllUsers()" style="background:#dc2626;color:white;padding:10px 18px;font-size:12px;font-weight:800;display:inline-flex;align-items:center;gap:6px;box-shadow:0 4px 12px rgba(220,38,38,0.25);border-radius:8px;cursor:pointer">
          <span class="material-symbols-outlined" style="font-size:18px">delete_forever</span>
          <span>CLEAR ALL USERS &amp; PROGRESS</span>
        </button>
        <button class="btn btn-secondary btn-sm" onclick="adminResetAll()">Reset Scores Only</button>
        <button class="btn btn-secondary btn-sm" onclick="adminClearSubmissions()">Clear Submissions</button>
      </div>
    </div>
  `;
}

/* \u2500\u2500 Exam control actions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
window.adminStartExam = () => {
  showModal('Start Exam?', `<p>This will let all approved contestants into the exam immediately. They will be notified automatically.</p>`, [
    { label: '▶ Start Now', cls: 'btn-primary', action: async () => {
      await setExamStatus('running');
      closeModal();
      Sound.play('round');
      toast('Exam Started! ▶', 'All approved contestants have been notified.', 'success');
      await refreshAdminDataRealtime(true);
    }},
    { label: 'Cancel', cls: 'btn-secondary', action: closeModal }
  ]);
};

window.adminPauseExam = async () => {
  await setExamStatus('paused');
  toast('Paused ⏸', 'Exam is paused. Participants see a waiting screen.', 'info');
  await refreshAdminDataRealtime(true);
};

window.adminStopExam = () => {
  showModal('End Exam?', `<p style="color:var(--red)">This will immediately end the exam for all participants. They will see the final leaderboard and their scores. This cannot be undone easily.</p>`, [
    { label: '■ End Exam', cls: 'btn-danger', action: async () => {
      await setExamStatus('stopped');
      closeModal();
      Sound.play('victory');
      toast('Exam Ended ■', 'All participants now see the final results.', 'warning');
      await refreshAdminDataRealtime(true);
    }},
    { label: 'Cancel', cls: 'btn-secondary', action: closeModal }
  ]);
};

window.adminRestartExam = () => {
  showModal('Restart Exam?', `<p>Reset exam to "not started" state so contestants wait for a new start signal.</p>`, [
    { label: '🔄 Restart', cls: 'btn-primary', action: async () => {
      await setExamStatus('waiting');
      closeModal();
      toast('Exam Reset', 'Exam is back to waiting state.', 'info');
      await refreshAdminDataRealtime(true);
    }},
    { label: 'Cancel', cls: 'btn-secondary', action: closeModal }
  ]);
};

// Legacy alias kept for compatibility
window.setContestStatus = async (s) => {
  const map = { active: 'running', paused: 'paused', stopped: 'stopped', waiting: 'waiting' };
  await setExamStatus(map[s] || s);
  toast('Status', `Exam status set to ${s}`, 'info');
  await refreshAdminDataRealtime(true);
};

window.toggleLeaderboard = () => {
  contestData.contest.leaderboard_visible = !contestData.contest.leaderboard_visible;
  toast('Settings', `Leaderboard ${contestData.contest.leaderboard_visible ? 'visible' : 'hidden'}.`, 'info');
};
window.toggleFreePlay = () => {
  contestData.contest.free_play_mode = !contestData.contest.free_play_mode;
  toast('Settings', `Free Play mode ${contestData.contest.free_play_mode ? 'enabled' : 'disabled'}.`, 'info');
};
window.saveContestSettings = () => {
  toast('Saved', 'Contest settings updated.', 'success');
};

window.adminClearAllUsers = () => {
  showModal(
    'DELETE ALL CONTESTANTS & PROGRESS?',
    `
      <div style="color:#991b1b;font-family:var(--font-mono);font-size:12px;line-height:1.6">
        <p style="font-weight:800;font-size:14px;margin-bottom:8px">⚠️ Permanent Destructive Action!</p>
        <p style="margin-bottom:10px;color:#475569">
          You are about to permanently delete all contestant data from the platform database:
        </p>
        <ul style="list-style:disc;padding-left:20px;margin-bottom:12px;color:#b91c1c">
          <li>All registered participant accounts and approvals will be <strong>permanently deleted</strong>.</li>
          <li>All challenge progress, flag submissions, IDOR/Web exploits, and hint reveals will be <strong>wiped</strong>.</li>
          <li>All tournament scores and standings will be <strong>cleared</strong>.</li>
        </ul>
        <div style="background:#f1f5f9;padding:10px 12px;border-radius:8px;border:1px solid #cbd5e1;color:#334155;font-size:11px">
          🛡️ The <strong>admin account</strong> is protected and will NOT be deleted.
        </div>
      </div>
    `,
    [
      {
        label: '🗑️ YES, DELETE ALL USERS',
        cls: 'btn-danger',
        action: async () => {
          try {
            const res = await Api.post('/api/admin/clear-all');
            closeModal();
            _cachedAllUsers = [];
            _cachedLeaderboard = [];
            Store.set('users', []);
            await Promise.all([syncAllUsers(), syncLeaderboard()]);
            await refreshAdminDataRealtime(true);
            toast('Cleared! 🗑️', `Successfully deleted ${res.deletedCount || 0} contestants, approvals, and progress records.`, 'warning');
          } catch (err) {
            toast('Error', err.message || 'Failed to clear users', 'error');
          }
        }
      },
      { label: 'Cancel', cls: 'btn-secondary', action: closeModal }
    ],
    { icon: 'delete_forever', maxWidth: '520px' }
  );
};

window.adminResetAll = () => {
  showModal('Reset ALL Users?', '<p style="color:var(--red)">This will reset scores, solves, and hints for ALL participants. This cannot be undone.</p>', [
    { label: 'RESET ALL', cls: 'btn-danger', action: async () => {
      try {
        await Api.put('/api/users/reset-all');
        closeModal();
        toast('Reset', 'All users have been reset.', 'warning');
        await refreshAdminDataRealtime(true);
      } catch (err) { toast('Error', err.message, 'error'); }
    }},
    { label: 'Cancel', cls: 'btn-secondary', action: closeModal }
  ]);
};

window.adminClearSubmissions = async () => {
  try {
    await Api.del('/api/admin/submissions');
    adminNav('submissions');
    toast('Cleared', 'All submissions cleared.', 'info');
  } catch (err) { toast('Error', err.message, 'error'); }
};


/* ── Modal ───────────────────────────────────────────────── */
function showModal(title, bodyHtml, buttons = [], options = {}) {
  const existing = $('#modal-backdrop');
  if (existing) existing.remove();

  if (!buttons || buttons.length === 0) {
    buttons = [{ label: 'CLOSE', cls: 'bg-slate-800 text-white hover:bg-slate-900', action: () => closeModal() }];
  }

  const maxWidth = options.maxWidth || '480px';
  const maxHeight = options.maxHeight || '';

  const backdrop = el('div', 'modal-backdrop fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-[999] flex items-center justify-center p-4', `
    <div class="modal bg-white border border-slate-300 rounded-2xl shadow-2xl p-0 overflow-hidden font-sans text-slate-800 transform transition-all duration-200" id="modal-inner" role="dialog" aria-modal="true" style="max-width: ${maxWidth}; width: 100%; ${maxHeight ? `max-height: ${maxHeight}; display: flex; flex-direction: column;` : ''}">
      <div class="modal-header px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50 select-none">
        <div class="modal-title font-mono font-bold text-slate-900 text-xs sm:text-sm flex items-center gap-2">
          <span class="material-symbols-outlined text-amber-500 text-base">${options.icon || 'lightbulb'}</span>
          <span>${withAnimEmojis(title)}</span>
        </div>
        <button class="modal-close w-7 h-7 rounded-full bg-slate-200 hover:bg-slate-300 text-slate-700 flex items-center justify-center text-xs font-bold cursor-pointer transition-all" onclick="closeModal()" aria-label="Close">✕</button>
      </div>
      <div class="modal-body p-5 text-sm text-slate-700 font-sans leading-relaxed ${maxHeight ? 'overflow-y-auto flex-1' : ''}">${withAnimEmojis(bodyHtml)}</div>
      <div class="modal-footer px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2.5">
        ${buttons.map((b, i) => `
          <button class="px-4 py-2 rounded-lg font-mono font-bold text-xs cursor-pointer shadow-xs transition-all ${b.cls || 'bg-slate-200 hover:bg-slate-300 text-slate-800'}" data-modal-idx="${i}">
            ${withAnimEmojis(b.label)}
          </button>
        `).join('')}
      </div>
    </div>
  `);

  backdrop.id = 'modal-backdrop';
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
  document.body.appendChild(backdrop);

  // Safely attach event listeners to buttons by DOM index (immune to special characters)
  const footerButtons = backdrop.querySelectorAll('.modal-footer button');
  buttons.forEach((b, idx) => {
    if (footerButtons[idx]) {
      footerButtons[idx].addEventListener('click', (e) => {
        if (typeof b.action === 'function') b.action(e);
      });
    }
  });
}

window.closeModal = () => { $('#modal-backdrop')?.remove(); };

window.filterStepTable = (round, btn) => {
  const table = document.getElementById('step-timing-table');
  if (!table) return;
  const tabs = document.querySelectorAll('.step-tab');
  tabs.forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const rows = table.querySelectorAll('.step-row');
  rows.forEach(r => {
    if (round === 'all' || r.dataset.round === round) {
      r.style.display = '';
    } else {
      r.style.display = 'none';
    }
  });
};

window.adminViewStepTimes = (uid) => {
  const users = Store.get('users', getDefaultUsers());
  const u = users.find(x => x.id === uid);
  if (!u) return toast('User not found', `User ID ${uid} was not found.`, 'error');

  const userChallenges = getUserChallenges(u);
  const examStartTime = Store.get('examStartTime', null);
  const t = calculateContestantTimings(u, userChallenges, examStartTime);

  const durationBadge = (ms, status) => {
    if (status === 'locked') return `<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim)">Locked</span>`;
    if (status === 'in_progress') {
      return `<span class="duration-badge in-progress">⏳ ${formatDuration(ms)} (active)</span>`;
    }
    const mins = ms / 60000;
    const cls = mins < 2 ? 'fast' : mins < 6 ? 'medium' : 'slow';
    return `<span class="duration-badge ${cls}">✓ ${formatDuration(ms)}</span>`;
  };

  const bodyHtml = `
    <div class="step-timing-modal-container">
      <!-- User Info Header -->
      <div class="step-timing-user-bar">
        <div>
          <div class="step-timing-user-name">${escapeHtml(u.name || u.username)} <span class="step-timing-handle">@${escapeHtml(u.username)}</span></div>
          <div class="step-timing-team-tag">Squad: <strong>${escapeHtml(u.team || u.username)}</strong> · Score: <strong style="color:var(--green)">${u.score || 0} pts</strong> · Tab Strikes: <strong>${u.tabSwitches || 0}</strong></div>
        </div>
        <div>
          ${u.disqualified ? '<span class="badge-dq"><span class="badge-inner">🚫 DISQUALIFIED</span></span>' : u.approved ? '<span class="badge-approved"><span class="badge-inner">✓ APPROVED</span></span>' : '<span class="badge-pending"><span class="badge-inner">⏳ PENDING</span></span>'}
        </div>
      </div>

      <!-- KPI Summary Cards -->
      <div class="timing-kpi-grid">
        <div class="timing-kpi-card">
          <div class="timing-kpi-label">⏱️ TOTAL COMPLETION TIME</div>
          <div class="timing-kpi-val ${t.isAllCompleted ? 'all-done' : 'cyan'}">
            ${t.isAllCompleted ? `🏆 ${formatDuration(t.totalCompletedTimeMs)}` : t.completedSteps > 0 ? `⏱️ ${formatDuration(t.totalCompletedTimeMs)}` : '—'}
          </div>
          <div class="timing-kpi-sub">
            ${t.isAllCompleted ? `✓ All ${t.totalSteps} steps fully completed!` : t.completedSteps > 0 ? `Across ${t.completedSteps} solved steps (Active: ${formatDuration(t.elapsedActiveTimeMs)})` : 'No steps completed yet'}
          </div>
        </div>

        <div class="timing-kpi-card">
          <div class="timing-kpi-label">🎯 STEPS COMPLETED</div>
          <div class="timing-kpi-val green">${t.completedSteps} / ${t.totalSteps}</div>
          <div class="timing-kpi-progress">
            <div class="timing-kpi-bar" style="width:${Math.round((t.completedSteps / t.totalSteps) * 100)}%"></div>
          </div>
          <div class="timing-kpi-sub">${Math.round((t.completedSteps / t.totalSteps) * 100)}% contest clearance</div>
        </div>

        <div class="timing-kpi-card">
          <div class="timing-kpi-label">⚡ AVERAGE TIME / QUESTION</div>
          <div class="timing-kpi-val yellow">${t.completedSteps > 0 ? formatDuration(t.avgTimePerStepMs) : '—'}</div>
          <div class="timing-kpi-sub">${t.completedSteps > 0 ? `Pace across ${t.completedSteps} solved step${t.completedSteps !== 1 ? 's' : ''}` : 'Awaiting first solve'}</div>
        </div>

        <div class="timing-kpi-card">
          <div class="timing-kpi-label">🚀 FASTEST & SLOWEST QUESTION</div>
          <div style="margin-top:6px;font-size:12px;font-family:var(--font-mono)">
            <div><span style="color:var(--green);font-weight:700">Fastest:</span> ${t.fastestStep ? `${t.fastestStep.challengeId} (${formatDuration(t.fastestStep.durationMs)})` : '—'}</div>
            <div style="margin-top:4px"><span style="color:var(--yellow);font-weight:700">Slowest:</span> ${t.slowestStep ? `${t.slowestStep.challengeId} (${formatDuration(t.slowestStep.durationMs)})` : '—'}</div>
          </div>
          <div class="timing-kpi-sub" style="margin-top:4px">Total Submissions: ${u.submissions ? u.submissions.length : 0}</div>
        </div>
      </div>

      <!-- Round Filter Tabs -->
      <div class="step-filter-tabs">
        <button class="step-tab active" onclick="filterStepTable('all', this)">All Steps (${t.totalSteps})</button>
        <button class="step-tab" onclick="filterStepTable('1', this)">Round 1: OSINT (4)</button>
        <button class="step-tab" onclick="filterStepTable('2', this)">Round 2: WEB CTF (4)</button>
        <button class="step-tab" onclick="filterStepTable('3', this)">Round 3: CODE REVIEW (${t.steps.filter(s => s.round === 3).length})</button>
      </div>

      <!-- Step & Question Timing Breakdown Table -->
      <div class="step-table-wrap">
        <table class="admin-table step-timing-table" id="step-timing-table">
          <thead>
            <tr>
              <th style="width:65px">Step #</th>
              <th>Question / Challenge</th>
              <th>Round</th>
              <th style="width:75px">Points</th>
              <th style="width:85px">Attempts</th>
              <th>Started At</th>
              <th>Solved At</th>
              <th>⏱️ Time Taken</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${t.steps.map(s => `
              <tr class="step-row round-${s.round}" data-round="${s.round}" style="${s.status === 'completed' ? 'background:rgba(16,185,129,0.03)' : s.status === 'in_progress' ? 'background:rgba(2,132,199,0.04)' : 'opacity:0.65'}">
                <td class="mono" style="font-weight:700;color:var(--text-bright)">Step ${s.stepNum}</td>
                <td>
                  <div style="font-family:var(--font-mono);font-weight:700;color:var(--text-bright);font-size:12px">${escapeHtml(s.challengeId)}</div>
                  <div style="font-size:11px;color:var(--text-secondary);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>
                </td>
                <td>
                  <span class="step-round-badge round-${s.round}">${escapeHtml(s.roundName)}</span>
                </td>
                <td class="mono" style="font-weight:700;color:var(--yellow)">${s.points} pts</td>
                <td class="mono" style="font-size:11px">
                  ${s.attempts === 0 ? '<span style="color:var(--text-dim)">0</span>' :
                    s.wrongAttempts > 0 ? `<span style="color:var(--red)">${s.attempts} (${s.wrongAttempts} ✗)</span>` :
                    `<span style="color:var(--green)">${s.attempts} ✓</span>`}
                </td>
                <td class="mono" style="font-size:11px;color:var(--text-secondary)">
                  ${s.startTime ? formatTime(s.startTime) : '—'}
                </td>
                <td class="mono" style="font-size:11px;color:var(--text-bright)">
                  ${s.solvedAt ? formatTime(s.solvedAt) : '—'}
                </td>
                <td>
                  ${durationBadge(s.durationMs, s.status)}
                </td>
                <td>
                  ${s.status === 'completed' ? '<span class="badge-approved" style="font-size:10px"><span class="badge-inner">✓ SOLVED</span></span>' :
                    s.status === 'in_progress' ? '<span class="badge-pending" style="font-size:10px"><span class="badge-inner">⏳ ACTIVE</span></span>' :
                    '<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim)">🔒 LOCKED</span>'}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  showModal(`⏱️ Step & Question Timing Breakdown — @${escapeHtml(u.username)}`, bodyHtml, [
    { label: 'Close', cls: 'btn-secondary', action: closeModal }
  ], { maxWidth: '960px', maxHeight: '88vh', icon: 'timer' });
};

/* ── Chrome Browser Window Tab Simulation ──────────────────── */
window.openSimulatedChromeWindow = (targetUrl = 'https://oxraventest.com/login', title = '0xRAVEN Enterprise Portal') => {
  $('#simulated-chrome-backdrop')?.remove();

  let cleanDisplayUrl = targetUrl.replace(/^https?:\/\//i, '');
  if (!cleanDisplayUrl.includes('/')) {
    cleanDisplayUrl = cleanDisplayUrl + '/login';
  }

  let targetRoute = '/login';
  if (targetUrl.includes('oxraventest.com/')) {
    targetRoute = '/' + targetUrl.split('oxraventest.com/')[1];
  } else if (targetUrl.startsWith('/')) {
    targetRoute = targetUrl;
    cleanDisplayUrl = 'oxraventest.com' + targetUrl;
  }

  const backdrop = document.createElement('div');
  backdrop.id = 'simulated-chrome-backdrop';
  backdrop.className = 'fixed inset-0 z-[9999] bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 md:p-6 select-none transition-all duration-300';

  backdrop.innerHTML = `
    <div id="simulated-chrome-window" class="w-full max-w-6xl h-[90vh] bg-[#202124] rounded-2xl shadow-[0_25px_70px_rgba(0,0,0,0.85)] border border-slate-700/60 flex flex-col overflow-hidden animate-chrome-pop">
      <!-- Chrome Title Bar & Tabs -->
      <div class="bg-[#171717] px-3 pt-2.5 pb-0 flex items-center justify-between border-b border-[#2b2b2b]">
        <!-- Traffic Light Controls & Tabs -->
        <div class="flex items-center gap-3 overflow-x-auto no-scrollbar flex-1">
          <!-- Window Dots -->
          <div class="flex items-center gap-1.5 shrink-0 pl-1 pr-2">
            <button onclick="closeSimulatedChromeWindow()" title="Close Window" class="w-3 h-3 rounded-full bg-rose-500 hover:bg-rose-600 transition-all flex items-center justify-center text-[8px] font-bold text-rose-950 opacity-90 hover:opacity-100 cursor-pointer">✕</button>
            <button onclick="toggleChromeMaximize()" title="Minimize / Restore" class="w-3 h-3 rounded-full bg-amber-500 hover:bg-amber-600 transition-all flex items-center justify-center text-[8px] font-bold text-amber-950 opacity-90 hover:opacity-100 cursor-pointer">‒</button>
            <button onclick="toggleChromeMaximize()" title="Maximize" class="w-3 h-3 rounded-full bg-emerald-500 hover:bg-emerald-600 transition-all flex items-center justify-center text-[8px] font-bold text-emerald-950 opacity-90 hover:opacity-100 cursor-pointer">⤢</button>
          </div>

          <!-- Chrome Tab Strip -->
          <div class="flex items-center gap-1">
            <!-- Active Tab -->
            <div id="chrome-active-tab" class="chrome-active-tab px-3.5 py-2 text-xs font-sans text-slate-100 flex items-center gap-2 border-t-2 border-cyan-400 font-medium cursor-default shrink-0">
              <span class="material-symbols-outlined text-sm text-cyan-400">shield_lock</span>
              <span class="max-w-[220px] truncate font-bold">${escapeHtml(title || 'oxraventest.com')}</span>
              <button onclick="closeSimulatedChromeWindow()" class="hover:bg-slate-700 text-slate-400 hover:text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] ml-1 cursor-pointer">✕</button>
            </div>
            <!-- New Tab (+) -->
            <button onclick="reloadChromeFrame()" title="New Tab" class="w-7 h-7 rounded-full text-slate-400 hover:bg-slate-800 hover:text-white flex items-center justify-center text-sm font-mono transition-all cursor-pointer">+</button>
          </div>
        </div>

        <div class="flex items-center gap-2 text-slate-400 text-xs font-mono pr-1">
          <span class="text-[10px] bg-slate-800 px-2 py-0.5 rounded text-cyan-400 font-bold border border-slate-700">HTTPS LIVE TARGET</span>
        </div>
      </div>

      <!-- Chrome Address / Navigation Toolbar -->
      <div class="bg-[#292a2d] px-3 py-2 flex items-center justify-between gap-3 border-b border-[#3c4043]">
        <!-- Nav buttons -->
        <div class="flex items-center gap-1 shrink-0 text-slate-300">
          <button onclick="chromeNavBack()" title="Back" class="p-1.5 hover:bg-slate-700/60 rounded-full transition-all text-slate-400 hover:text-white cursor-pointer">
            <span class="material-symbols-outlined text-sm">arrow_back</span>
          </button>
          <button onclick="chromeNavFwd()" title="Forward" class="p-1.5 hover:bg-slate-700/60 rounded-full transition-all text-slate-400 hover:text-white cursor-pointer">
            <span class="material-symbols-outlined text-sm">arrow_forward</span>
          </button>
          <button onclick="chromeNavReload()" title="Reload page" class="p-1.5 hover:bg-slate-700/60 rounded-full transition-all text-slate-300 hover:text-cyan-400 cursor-pointer">
            <span class="material-symbols-outlined text-sm">refresh</span>
          </button>
        </div>

        <!-- Address Bar / Omnibox Form -->
        <form onsubmit="handleChromeOmnibox(event)" class="flex-1 bg-[#202124] border border-[#3c4043] hover:border-slate-500 focus-within:border-cyan-500 rounded-full px-4 py-1 flex items-center justify-between gap-2 transition-all">
          <div class="flex items-center gap-2 text-xs font-mono text-slate-200 truncate flex-1">
            <span class="material-symbols-outlined text-xs text-emerald-400">lock</span>
            <span class="text-slate-400 text-[11px]">https://</span>
            <input type="text" id="chrome-omnibox-input" value="${cleanDisplayUrl}" class="bg-transparent text-cyan-400 font-bold outline-none flex-1 font-mono text-xs" autocomplete="off" placeholder="oxraventest.com/...">
          </div>
          <div class="flex items-center gap-1">
            <button type="submit" title="Navigate" class="text-slate-400 hover:text-white text-xs p-1 cursor-pointer">
              <span class="material-symbols-outlined text-xs">arrow_forward</span>
            </button>
          </div>
        </form>

        <!-- Right Tools -->
        <div class="flex items-center gap-2 shrink-0">
          <button onclick="triggerFrameDevTools()" class="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-cyan-400 rounded-lg text-xs font-mono font-bold transition-all flex items-center gap-1 border border-slate-700 cursor-pointer">
            <span class="material-symbols-outlined text-xs">developer_mode</span>
            Inspect (F12)
          </button>
          <button onclick="closeSimulatedChromeWindow()" class="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-mono font-bold transition-all flex items-center gap-1 shadow-sm cursor-pointer">
            <span class="material-symbols-outlined text-xs">close</span>
            Exit Browser
          </button>
        </div>
      </div>

      <!-- Main Viewport Body -->
      <div class="flex-1 bg-[#090d16] relative overflow-hidden flex flex-col">
        <iframe id="simulated-chrome-iframe" src="target_app.html" class="w-full h-full border-none bg-[#090d16] transition-opacity duration-200"></iframe>
      </div>

      <!-- Chrome Status Bar -->
      <div class="bg-[#171717] px-4 py-1.5 border-t border-[#2b2b2b] text-[11px] font-mono text-slate-400 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <span class="text-emerald-400 flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> TLS 256-bit Encrypted Target Session</span>
          <span>//</span>
          <span>Target Endpoint: <code class="text-slate-200 font-bold">https://${cleanDisplayUrl}</code></span>
        </div>
        <div>Press <kbd class="px-1.5 py-0.5 bg-slate-800 text-slate-200 rounded border border-slate-700 text-[10px]">ESC</kbd> to exit</div>
      </div>
    </div>
  `;

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeSimulatedChromeWindow();
  });

  document.body.appendChild(backdrop);
  Sound.play('notify');

  const iframe = backdrop.querySelector('#simulated-chrome-iframe');
  if (iframe) {
    iframe.onload = () => {
      try {
        if (iframe.contentWindow && iframe.contentWindow.navigateTarget && targetRoute !== '/login') {
          setTimeout(() => {
            iframe.contentWindow.navigateTarget(targetRoute);
          }, 60);
        }
      } catch (err) {
        console.warn('Frame initial route dispatch:', err);
      }
    };
  }

  const handleKeydown = (e) => {
    if (e.key === 'Escape') {
      closeSimulatedChromeWindow();
      document.removeEventListener('keydown', handleKeydown);
    }
  };
  document.addEventListener('keydown', handleKeydown);
};

window.handleChromeOmnibox = (e) => {
  if (e) e.preventDefault();
  const input = $('#chrome-omnibox-input');
  if (!input) return;
  let val = input.value.trim();
  if (val.startsWith('https://')) val = val.replace('https://', '');
  if (val.startsWith('http://')) val = val.replace('http://', '');
  
  let route = '/login';
  if (val.includes('/')) {
    route = '/' + val.split('/').slice(1).join('/');
  }

  const iframe = $('#simulated-chrome-iframe');
  if (iframe && iframe.contentWindow && iframe.contentWindow.navigateTarget) {
    iframe.contentWindow.navigateTarget(route);
  }
};

window.triggerFrameDevTools = () => {
  const iframe = $('#simulated-chrome-iframe');
  if (iframe && iframe.contentWindow) {
    if (typeof iframe.contentWindow.toggleDevTools === 'function') {
      iframe.contentWindow.toggleDevTools();
    } else if (typeof iframe.contentWindow.toggleDt === 'function') {
      iframe.contentWindow.toggleDt();
    }
  }
};

window.chromeNavBack = () => {
  const iframe = $('#simulated-chrome-iframe');
  if (iframe && iframe.contentWindow && typeof iframe.contentWindow.hBack === 'function') {
    iframe.contentWindow.hBack();
  }
};

window.chromeNavFwd = () => {
  const iframe = $('#simulated-chrome-iframe');
  if (iframe && iframe.contentWindow && typeof iframe.contentWindow.hFwd === 'function') {
    iframe.contentWindow.hFwd();
  }
};

window.chromeNavReload = () => {
  const iframe = $('#simulated-chrome-iframe');
  if (iframe && iframe.contentWindow && typeof iframe.contentWindow.hReload === 'function') {
    iframe.contentWindow.hReload();
  } else {
    reloadChromeFrame();
  }
};

window.closeSimulatedChromeWindow = () => {
  const backdrop = $('#simulated-chrome-backdrop');
  if (!backdrop) return;
  const win = $('#simulated-chrome-window');
  if (win) {
    win.classList.remove('animate-chrome-pop');
    win.classList.add('animate-chrome-fade-out');
  }
  setTimeout(() => backdrop.remove(), 240);
};

window.reloadChromeFrame = () => {
  const iframe = $('#simulated-chrome-iframe');
  if (iframe) {
    iframe.style.opacity = '0.3';
    iframe.src = iframe.src;
    setTimeout(() => iframe.style.opacity = '1', 250);
  }
};

window.toggleChromeMaximize = () => {
  const win = $('#simulated-chrome-window');
  if (win) {
    win.classList.toggle('max-w-6xl');
    win.classList.toggle('h-[90vh]');
    win.classList.toggle('max-w-none');
    win.classList.toggle('h-[98vh]');
  }
};

/* ── User persistence ────────────────────────────────────── */
/**
 * saveUser() — persists the current user's state to the server.
 * Called after score changes, solves, skips, hints.
 * The server is the source of truth; this keeps the local object in sync.
 * Note: flag validation is done client-side here AND server-side on POST /api/submit.
 */
async function saveUser() {
  if (!currentUser?.id) return;
  try {
    // Persist current challenge position
    await Api.put(`/api/users/${currentUser.id}/current-challenge`, {
      challengeId: currentUser.currentChallenge || null
    }).catch(() => {});
  } catch {}
  // The score and solvedChallenges are updated server-side when submitFlag or submitCodeAnswer
  // POST to /api/submit. saveUser() handles non-submission state (current challenge, UI state).
}


/* ── Data Loading ─────────────────────────────────────────── */
async function loadData() {
  // Use inline globals injected by index.html (works with file:// and servers)
  if (window.CONTEST_DATA && window.CHALLENGES_DATA) {
    contestData = window.CONTEST_DATA;
    challengesData = window.CHALLENGES_DATA;
    return;
  }
  // Fallback: try fetch (works on HTTP servers)
  try {
    const [contestRes, challengesRes] = await Promise.all([
      fetch('data/contest.json').then(r => r.json()),
      fetch('data/challenges.json').then(r => r.json())
    ]);
    contestData = contestRes;
    challengesData = challengesRes;
  } catch (e) {
    console.warn('Could not load data files, using minimal fallback:', e);
    contestData = {
      contest: { id: 'demo', title: 'THE VANISHING DEVELOPER', subtitle: 'Operation 0xRAVEN', tagline: 'He left a trail. Can you follow it?', status: 'active', leaderboard_visible: true, free_play_mode: false, story: { intro: 'The investigation begins.', chapter1: 'Follow the clues.', chapter2: 'Dig deeper.', outro: 'Investigation complete.' } },
      rounds: [{id:1,slug:'osint',name:'ROUND 1 — OSINT',subtitle:'Cryptic Investigation',description:'',icon:'🔍',color:'#00F5FF',unlock_condition:null}],
      rules: ['Play fair.', 'No flag sharing.']
    };
    challengesData = { challenges: [] };
  }
}

/* ── Bootstrap ───────────────────────────────────────────── */
async function bootstrap() {
  // First interaction needed for audio
  document.addEventListener('click', () => Sound.resume(), { once: true });
  document.addEventListener('keydown', () => Sound.resume(), { once: true });

  // Apply Store monkey-patch so Store.get/set('examStatus') goes to API
  _patchStoreForExamStatus();
  // Patch Store.get('users') to return API-synced cache
  _extendPatchForUsers();


  // Load contest/challenge data from JSON files (static)
  await loadData();

  // Sync exam status from server (Redis)
  await syncExamStatus();

  // Try to restore session from stored token
  const token = Api.getToken();
  if (token) {
    try {
      const { user } = await Api.get('/api/session');
      if (user) {
        currentUser = user;
        const screen = $('#loading-screen');
        if (screen) {
          screen.style.display = 'flex';
          await runLoadingScreen();
        } else {
          initApp(user.role === 'admin');
        }
        return;
      }
    } catch {
      // Token expired or invalid — clear it and show login
      Api.setToken(null);
    }
  }

  await runLoadingScreen();
}

// Expose navigate globally for admin
if (typeof window !== 'undefined') {
  window.navigate = window.navigate || navigate;
}

// Start browser app
bootstrap();
