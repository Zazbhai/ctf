/* ============================================================
   CODEVERSE — Cybersecurity Contest Platform
   Sound Engine (Web Audio API — no external files required)
   ============================================================ */

const SoundEngine = (() => {
  let ctx = null;
  let masterGain = null;
  let enabled = true;
  let initialized = false;

  function init() {
    if (initialized) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.4;
      masterGain.connect(ctx.destination);
      initialized = true;
    } catch (e) {
      console.warn('[Sound] Web Audio API not available:', e);
    }
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  function enable() { enabled = true; }
  function disable() { enabled = false; }
  function toggle() { enabled = !enabled; return enabled; }
  function isEnabled() { return enabled; }

  /* --- Low-level oscillator helpers --- */
  function osc(type, freq, startTime, duration, gainVal = 0.3) {
    if (!ctx || !enabled) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gainVal, startTime);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    o.connect(g);
    g.connect(masterGain);
    o.start(startTime);
    o.stop(startTime + duration);
    return { osc: o, gain: g };
  }

  function sweep(type, fromFreq, toFreq, startTime, duration, gainVal = 0.3) {
    if (!ctx || !enabled) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(fromFreq, startTime);
    o.frequency.exponentialRampToValueAtTime(toFreq, startTime + duration);
    g.gain.setValueAtTime(gainVal, startTime);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    o.connect(g);
    g.connect(masterGain);
    o.start(startTime);
    o.stop(startTime + duration);
  }

  function noise(startTime, duration, gainVal = 0.15) {
    if (!ctx || !enabled) return;
    const bufSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const g = ctx.createGain();
    filter.type = 'bandpass';
    filter.frequency.value = 800;
    filter.Q.value = 0.5;
    source.buffer = buffer;
    source.connect(filter);
    filter.connect(g);
    g.connect(masterGain);
    g.gain.setValueAtTime(gainVal, startTime);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    source.start(startTime);
    source.stop(startTime + duration);
  }

  /* ============================================================
     Named Sound Effects
  ============================================================ */

  const sounds = {

    /* Boot sequence — plays during loading screen */
    boot() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      sweep('sawtooth', 80, 160, t, 0.4, 0.2);
      sweep('sine', 200, 400, t + 0.3, 0.5, 0.15);
      osc('square', 440, t + 0.7, 0.1, 0.1);
      osc('square', 880, t + 0.85, 0.1, 0.1);
      osc('sine', 1320, t + 1.0, 0.3, 0.2);
      noise(t + 0.05, 0.8, 0.08);
    },

    /* Correct flag submitted */
    correct() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      osc('sine', 523, t, 0.1, 0.35);        // C5
      osc('sine', 659, t + 0.1, 0.1, 0.35);  // E5
      osc('sine', 784, t + 0.2, 0.1, 0.35);  // G5
      osc('sine', 1047, t + 0.3, 0.25, 0.4); // C6
      sweep('sine', 1047, 2093, t + 0.55, 0.2, 0.15); // shimmer
    },

    /* Wrong flag submitted */
    wrong() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      sweep('sawtooth', 220, 110, t, 0.3, 0.3);
      osc('square', 100, t + 0.05, 0.25, 0.2);
      noise(t, 0.2, 0.12);
    },

    /* Challenge unlocked */
    unlock() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      sweep('sine', 440, 880, t, 0.15, 0.25);
      osc('triangle', 1320, t + 0.1, 0.2, 0.3);
      osc('sine', 1760, t + 0.25, 0.15, 0.25);
    },

    /* Round complete — big fanfare */
    roundComplete() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      const notes = [523, 659, 784, 1047, 784, 1047, 1319];
      const times = [0, 0.12, 0.24, 0.36, 0.52, 0.64, 0.76];
      notes.forEach((freq, i) => {
        osc('sine', freq, t + times[i], 0.2, i === notes.length - 1 ? 0.5 : 0.3);
      });
      noise(t + 0.7, 0.4, 0.08);
    },

    /* Hint revealed */
    hint() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      sweep('sine', 660, 440, t, 0.15, 0.2);
      osc('triangle', 330, t + 0.1, 0.2, 0.25);
    },

    /* Button hover */
    hover() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      osc('sine', 880, t, 0.04, 0.08);
    },

    /* Button click */
    click() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      osc('square', 440, t, 0.05, 0.12);
      osc('sine', 660, t + 0.02, 0.05, 0.08);
    },

    /* Rate limited */
    rateLimited() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      for (let i = 0; i < 3; i++) {
        osc('square', 200, t + i * 0.15, 0.1, 0.2);
      }
    },

    /* Already solved */
    alreadySolved() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      osc('triangle', 440, t, 0.1, 0.2);
      osc('triangle', 330, t + 0.08, 0.15, 0.2);
    },

    /* Ambient hum for loading */
    ambient() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      sweep('sine', 60, 80, t, 2.0, 0.05);
      sweep('sine', 65, 75, t + 0.5, 2.0, 0.04);
    },

    /* Login success */
    loginSuccess() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      sweep('sine', 330, 660, t, 0.2, 0.25);
      osc('sine', 880, t + 0.15, 0.2, 0.3);
    },

    /* Notification / new message */
    notify() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      osc('sine', 1047, t, 0.08, 0.2);
      osc('sine', 1319, t + 0.1, 0.08, 0.2);
    },

    /* Final win */
    victory() {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      const melody = [523, 523, 784, 784, 880, 880, 784, 659, 659, 587, 587, 523];
      const dur = [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.4, 0.2, 0.2, 0.2, 0.2, 0.4];
      let acc = 0;
      melody.forEach((freq, i) => {
        osc('sine', freq, t + acc, dur[i], 0.35);
        acc += dur[i];
      });
    }
  };

  /* ============================================================
     Ambient loop (subtle background)
  ============================================================ */
  let ambientTimer = null;
  function startAmbient() {
    if (!enabled || !ctx) return;
    sounds.ambient();
    ambientTimer = setTimeout(startAmbient, 4000);
  }
  function stopAmbient() {
    if (ambientTimer) clearTimeout(ambientTimer);
    ambientTimer = null;
  }

  return {
    init,
    resume,
    enable,
    disable,
    toggle,
    isEnabled,
    play: (name) => {
      if (!initialized) init();
      resume();
      if (sounds[name]) sounds[name]();
    },
    startAmbient: () => { if (!initialized) init(); resume(); startAmbient(); },
    stopAmbient
  };
})();

export default SoundEngine;
