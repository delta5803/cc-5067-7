// Deterministic synthetic test material:
//  - center-vocal substitute (additive/formant-ish with consonant bursts = 字头)
//  - low bass decoration
//  - the matched-correlation pair: identical full-band rho, B version has
//    channel-relative anti-phase low end.

import { biquadCoeffs, processBiquad } from '../dsp/biquad.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeRms(x, target) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  const rms = Math.sqrt(s / x.length) || 1;
  const g = target / rms;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

function peakScaleStereo(L, R, ceiling = 0.89) {
  let p = 0;
  for (let i = 0; i < L.length; i++) {
    p = Math.max(p, Math.abs(L[i]), Math.abs(R[i]));
  }
  if (p > ceiling || p === 0) {
    const g = ceiling / Math.max(p, 1e-9);
    for (let i = 0; i < L.length; i++) { L[i] *= g; R[i] *= g; }
  }
}

// ---- Center-vocal substitute with syllable onsets ----

const PENTA = [220.0, 261.63, 293.66, 329.63, 293.66, 261.63, 220.0, 196.0];
const FORMANTS = [
  { f: 680, w: 0.16, a: 1.0 },
  { f: 1150, w: 0.18, a: 0.72 },
  { f: 2700, w: 0.14, a: 0.5 },
  { f: 3650, w: 0.12, a: 0.32 },
];

function formantGain(freq) {
  let g = 0.18;
  const lf = Math.log(freq);
  for (const fm of FORMANTS) {
    const d = (lf - Math.log(fm.f)) / fm.w;
    g += fm.a * Math.exp(-0.5 * d * d);
  }
  return g;
}

function synthVocal(n, sr) {
  const x = new Float64Array(n);
  const breath = new Float64Array(n);
  const starts = [];
  const period = 0.4;
  const sylLen = 0.34;
  let idx = 0;
  for (let t0 = 0.28; t0 < n / sr - 0.25; t0 += period) {
    const start = Math.round(t0 * sr);
    starts.push(start);
    const f0 = PENTA[idx % PENTA.length] * (idx % 7 === 3 ? 1.12 : 1);
    idx++;
    const len = Math.min(Math.round(sylLen * sr), n - start);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      let env = Math.min(1, t / 0.022);
      const relStart = sylLen - 0.085;
      if (t > relStart) env *= Math.max(0, (sylLen - t) / 0.085);
      env *= 0.82 + 0.18 * Math.min(1, t / 0.06);
      const vib = 1 + 0.0045 * Math.sin(2 * Math.PI * 5.4 * t) * Math.min(1, t / 0.18);
      let s = 0;
      for (let h = 1; h <= 15; h++) {
        const hf = f0 * h * vib;
        const amp = Math.pow(h, -1.18) * formantGain(hf);
        s += amp * Math.sin(2 * Math.PI * hf * t + h * 0.35);
      }
      x[start + i] += 0.16 * env * s;
    }
    // 字头: bright noise burst at the onset.
    const rnd = mulberry32(1000 + idx * 77);
    const clen = Math.round(0.075 * sr);
    for (let i = 0; i < clen && start + i < n; i++) {
      const t = i / sr;
      const e = Math.exp(-t / 0.02) * Math.min(1, t * sr / 6);
      breath[start + i] += (rnd() * 2 - 1) * e;
    }
  }
  const hp = biquadCoeffs('hp', 1700, 0.9, sr);
  const bright = processBiquad(hp, breath);
  for (let i = 0; i < n; i++) x[i] += 0.5 * bright[i];
  normalizeRms(x, 0.3);
  return { data: x, starts };
}

// ---- Low bass decoration ----

const BASS_NOTES = [55.0, 55.0, 65.41, 49.0, 55.0, 82.41, 65.41, 49.0];

function synthBass(n, sr) {
  const x = new Float64Array(n);
  const starts = [];
  let k = 0;
  for (let t0 = 0.28; t0 < n / sr - 0.3; t0 += 0.4) {
    const start = Math.round(t0 * sr);
    starts.push(start);
    const f = BASS_NOTES[k % BASS_NOTES.length];
    k++;
    const len = Math.round(0.36 * sr);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / sr;
      const atk = Math.min(1, t / 0.008);
      const env = atk * Math.exp(-t * 8.5);
      const ph = 2 * Math.PI * f * t;
      const s = Math.sin(ph) + 0.28 * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph);
      x[start + i] += 0.5 * env * s;
    }
  }
  normalizeRms(x, 0.17);
  return { data: x, starts };
}

// ---- High side wash (decorrelated noise), kept out of the bass band ----

function synthPad(n, sr, seed) {
  const rnd = mulberry32(seed);
  let x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = rnd() * 2 - 1;
  const hp = biquadCoeffs('hp', 520, 0.7, sr);
  x = processBiquad(hp, x);
  const lp = biquadCoeffs('lp', 5200, 0.7, sr);
  x = processBiquad(lp, x);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const lfo = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.37 * t + seed);
    const fade = Math.min(1, t / 0.8, (n / sr - t) / 0.8);
    x[i] *= lfo * Math.max(0, fade);
  }
  normalizeRms(x, 1);
  return x;
}

function fullCorr(L, R) {
  let sxy = 0, sxx = 0, syy = 0;
  const n = L.length;
  for (let i = 0; i < n; i++) {
    sxy += L[i] * R[i]; sxx += L[i] * L[i]; syy += R[i] * R[i];
  }
  return sxy / Math.sqrt(sxx * syy);
}

function lowCorr(L, R, sr, cutoff = 150) {
  // FFT-free quick low correlation via the same LR4 filter would create an
  // import cycle concern only in tests; here use a tiny moving average proxy
  // is NOT acceptable, so import lazily through global: use biquad lp twice.
  const c = biquadCoeffs('lp', cutoff, Math.SQRT1_2, sr);
  let a = processBiquad(c, L); a = processBiquad(c, a);
  let b = processBiquad(c, R); b = processBiquad(c, b);
  return fullCorr(a, b);
}

// Build the matched pair. Returns stereo buffers plus construction metadata.
export function buildMatchedPair(sr = 48000, durationSec = 7.6) {
  const n = Math.round(durationSec * sr);
  const vocal = synthVocal(n, sr);
  const bass = synthBass(n, sr);
  const n1 = synthPad(n, sr, 4242);
  const n2 = synthPad(n, sr, 9871);
  const V = vocal.data, B = bass.data;

  const gA = 0.2;
  const LA = new Float64Array(n), RA = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const M = V[i] + B[i];
    const S = gA * n1[i];
    LA[i] = M + S; RA[i] = M - S;
  }
  const rhoTarget = fullCorr(LA, RA);

  // B version: anti-phase bass lives in S. Tune its extra side-wash gain so
  // the FULL-BAND correlation equals A exactly (bisection on real samples).
  const LB = new Float64Array(n), RB = new Float64Array(n);
  const buildB = (g) => {
    for (let i = 0; i < n; i++) {
      LB[i] = V[i] + B[i] + g * n2[i];
      RB[i] = V[i] - B[i] - g * n2[i];
    }
    return fullCorr(LB, RB);
  };
  let lo = 0, hi = 2.5, gB = hi;
  const rhoAt0 = buildB(0);
  if (rhoAt0 <= rhoTarget) {
    gB = 0;
  } else {
    for (let it = 0; it < 42; it++) {
      const mid = 0.5 * (lo + hi);
      const r = buildB(mid);
      if (r > rhoTarget) lo = mid; else hi = mid;
    }
    gB = 0.5 * (lo + hi);
    buildB(gB);
  }

  peakScaleStereo(LA, RA);
  peakScaleStereo(LB, RB);

  return {
    sr,
    A: { L: LA, R: RA },
    B: { L: LB, R: RB },
    markers: { consonants: vocal.starts, bass: bass.starts },
    info: {
      rhoA: Number(fullCorr(LA, RA).toFixed(6)),
      rhoB: Number(fullCorr(LB, RB).toFixed(6)),
      rhoBassA: Number(lowCorr(LA, RA, sr).toFixed(4)),
      rhoBassB: Number(lowCorr(LB, RB, sr).toFixed(4)),
      sideWashGainA: gA,
      sideWashGainB: Number(gB.toFixed(5)),
    },
  };
}

export function buildPureMono(sr = 48000, durationSec = 7.6) {
  const pair = buildMatchedPair(sr, durationSec);
  const n = pair.A.L.length;
  const M = new Float64Array(n);
  for (let i = 0; i < n; i++) M[i] = 0.5 * (pair.A.L[i] + pair.A.R[i]);
  return { L: M, R: new Float64Array(M), sr, markers: pair.markers };
}

// ---- Routing probe: crisp 字头 bursts + isolated bass pulses ----

export function buildMarkerProgram(sr = 48000) {
  const dur = 2.4;
  const n = Math.round(dur * sr);
  const consonantTimes = [0.2, 0.95, 1.7];
  const bassTimes = [0.52, 1.34];
  const consonants = consonantTimes.map((t) => Math.round(t * sr));
  const bass = bassTimes.map((t) => Math.round(t * sr));

  const c = new Float64Array(n);
  const rnd = mulberry32(777);
  for (const m of consonants) {
    const len = Math.round(0.06 * sr);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const e = Math.exp(-t / 0.016) * Math.min(1, i / 5);
      c[m + i] += (rnd() * 2 - 1) * e;
    }
  }
  const hp = biquadCoeffs('hp', 1900, 0.8, sr);
  const bright = processBiquad(hp, c);

  const b = new Float64Array(n);
  for (const m of bass) {
    const len = Math.round(0.34 * sr);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.007) * Math.exp(-t * 7.5);
      b[m + i] += 0.9 * env * Math.sin(2 * Math.PI * 72 * t);
    }
  }

  const okL = new Float64Array(n), okR = new Float64Array(n);
  const flipL = new Float64Array(n), flipR = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    okL[i] = 0.5 * bright[i] + 0.6 * b[i];
    okR[i] = okL[i];
    flipL[i] = 0.5 * bright[i] + 0.6 * b[i];
    flipR[i] = 0.5 * bright[i] - 0.6 * b[i];
  }
  peakScaleStereo(okL, okR);
  peakScaleStereo(flipL, flipR);
  return {
    sr,
    ok: { L: okL, R: okR },
    flip: { L: flipL, R: flipR },
    markers: { consonants, bass },
  };
}

export function buildImpulse(sr = 48000, lengthSec = 0.18) {
  const n = Math.round(lengthSec * sr);
  const L = new Float64Array(n), R = new Float64Array(n);
  L[24] = 1; R[24] = 1;
  return { L, R, sr, markers: null };
}

// Log sine sweep (Farina-style phase law), stereo identical.
export function buildSweep(sr = 48000, durationSec = 2.6, f0 = 24, f1 = 20000) {
  const n = Math.round(durationSec * sr);
  const x = new Float64Array(n);
  const k = (durationSec * 2 * Math.PI * f0) / Math.log(f1 / f0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const phase = k * (Math.exp((t / durationSec) * Math.log(f1 / f0)) - 1);
    let s = Math.sin(phase);
    const fade = Math.min(1, i / 200, (n - i) / 400);
    x[i] = 0.5 * s * Math.max(0, fade);
  }
  return { L: x, R: new Float64Array(x), sr, markers: null };
}

let cache = null;
export function getBuiltinMaterial(id) {
  if (!cache) {
    const pair = buildMatchedPair();
    const markers = buildMarkerProgram();
    cache = { pair, markers };
  }
  switch (id) {
    case 'pair_a':
      return { id, name: 'A 版 · 中心人声 + 低频装饰（同相）', ...cache.pair.A, sr: 48000, markers: cache.pair.markers, rhoInfo: cache.pair.info };
    case 'pair_b':
      return { id, name: 'B 版 · 总相关相同，低频已反相', ...cache.pair.B, sr: 48000, markers: cache.pair.markers, rhoInfo: cache.pair.info };
    case 'mono':
      return { id, name: '纯单声道（政策验证）', ...buildPureMono(), sr: 48000 };
    case 'probe_ok':
      return { id, name: '路由探针 · 低频同相', ...cache.markers.ok, sr: 48000, markers: cache.markers.markers };
    case 'probe_flip':
      return { id, name: '路由探针 · 低频反相', ...cache.markers.flip, sr: 48000, markers: cache.markers.markers };
    case 'impulse':
      return { id, name: '脉冲响应信号', ...buildImpulse(), sr: 48000 };
    case 'sweep':
      return { id, name: '对数频率扫描', ...buildSweep(), sr: 48000 };
    default:
      throw new Error('unknown material ' + id);
  }
}

export const MATERIAL_IDS = ['pair_a', 'pair_b', 'mono', 'probe_ok', 'probe_flip', 'impulse', 'sweep'];
