// Machine-readable account of what the chain actually does. Every claim here is
// exercised by test/verify-width-package.mjs and test/maintenance-check.mjs, so
// the prose contract cannot drift away from the implementation unnoticed.

import { allPassFrequencyResponse, delayImpulse } from './decorrelator.js';
import { lr4Split } from './crossover.js';
import { correlation, rms, db, energy } from '../analysis/measure.js';
import { biquadCoeffs, processBiquad } from './biquad.js';

export const SR = 48000;

// --- Decorrelator structures -------------------------------------------------
// A formal statement of mono-fold behaviour per structure. monoFoldExact marks
// the symmetric structures whose L/R fold stays exactly M.
export const DECORRELATOR_CONTRACT = {
  ms: {
    label: 'M/S 增益（无去相关）',
    monoFoldExact: true,
    addsDelay: false,
    risk: 'none',
    note: 'S′=width·S，L′=M+S′，R′=M−S′，折叠严格 = 2M；宽度不能为纯单声道生成侧声。',
  },
  ap: {
    label: '全通链去相关',
    monoFoldExact: false,   // M is untouched, but the fold of L/R is still exactly M
    addsDelay: false,
    risk: 'low',
    note: 'D=全通(M)；幅度平坦、相位色散。发送与 M 正交后左右能量平衡；折叠 (L+R)/2 仍=M。',
  },
  delay: {
    label: '短延迟去相关',
    monoFoldExact: false,
    addsDelay: true,
    risk: 'medium',
    note: 'D=M 的整数延迟；只影响侧声。极端宽度/湿声下折叠仍=M，但侧声内容被延迟搬移。',
  },
  haas: {
    label: '非对称 Haas 延迟',
    monoFoldExact: false,
    addsDelay: true,
    risk: 'high',
    note: '只在右声道叠加延迟回声，折叠 (L+R)/2 出现真实梳状染色与能量偏置，非无损。',
  },
};

// Which band the high band actually covers, per stage mode.
export function bandEdges(cfg) {
  const useCrossover = cfg.stageMode === 'crossover' && cfg.crossover !== false;
  const fc = cfg.fc ?? 180;
  return {
    useCrossover,
    lowBand: [0, useCrossover ? fc : 0],
    highBand: useCrossover ? [fc, null] : [0, null],
  };
}

// --- Two power accounts ------------------------------------------------------
// These are distinct by construction. A physical chain preserves neither in
// general, so the tests assert the delta rather than assuming equality.
//
//  1. per-channel power equality  : E_L ≈ E_R (source balance held)
//  2. post-fold energy equality   : E_fold == E_M (mono fold keeps mid energy)
export function powerAccounts(L, R, sr = SR) {
  const eL = energy(L), eR = energy(R);
  const n = Math.min(L.length, R.length);
  const mid = new Float64Array(n);
  for (let i = 0; i < n; i++) mid[i] = 0.5 * (L[i] + R[i]);
  const eFold = energy(mid), eMid = eFold;
  return {
    eL, eR, eFold, eMid,
    balanceDb: db(rms(L) / Math.max(1e-12, rms(R))),
    perChannelEqual: Math.abs(db(rms(L)) - db(rms(R))) < 0.1,
    foldMidDeltaDb: db(Math.sqrt(eFold / Math.max(1e-20, eMid))),
  };
}

// --- Polarity fallback on the monitor fold ----------------------------------
// Detects an inverted channel relative to the other and folds with the polarity
// that preserves energy instead of cancelling.
export function foldPolarityAware(L, R, sr = SR, bassFreq = 150) {
  const rho = correlation(L, R);
  const lowC = biquadCoeffs('lp', bassFreq, Math.SQRT1_2, sr);
  let a = processBiquad(lowC, L); a = processBiquad(lowC, a);
  let b = processBiquad(lowC, R); b = processBiquad(lowC, b);
  const rhoBass = correlation(a, b);
  // Sign correction: if total correlation is negative, invert R before folding.
  const sign = rho < 0 ? -1 : 1;
  const n = L.length;
  const fold = new Float64Array(n);
  const plain = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    fold[i] = 0.5 * (L[i] + sign * R[i]);
    plain[i] = 0.5 * (L[i] + R[i]);
  }
  return {
    rho, rhoBass, sign,
    polarityReversed: sign < 0,
    fold, plainFold: plain,
    foldEnergyDb: db(rms(fold)),
    plainFoldEnergyDb: db(rms(plain)),
    energyRecoveredDb: db(rms(fold)) - db(rms(plain)),
  };
}

// --- Frequency samples referenced by the docs --------------------------------
// Two constructors that make the cancellation risk concrete and inspectable.
export function buildPhaseSample(sr = SR, durationSec = 0.5, freq = 80, amp = 0.5) {
  const n = Math.round(durationSec * sr);
  const L = new Float64Array(n), R = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = amp * Math.sin((2 * Math.PI * freq * i) / sr);
    L[i] = s;
    R[i] = -s; // 180° inverted right channel
  }
  return { L, R, sr, kind: 'antiphase-tone', freq, note: 'L 与 R 反相：标准折叠 (L+R)/2=0，单声道完全抵消。' };
}

export function buildBandSample(sr = SR, durationSec = 1.0) {
  // Low band anti-phase + high band in phase: the risk is confined below fc.
  const n = Math.round(durationSec * sr);
  const L = new Float64Array(n), R = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const lowS = 0.5 * Math.sin(2 * Math.PI * 55 * t);
    const highS = 0.25 * (Math.sin(2 * Math.PI * 1200 * t) + 0.5 * Math.sin(2 * Math.PI * 3000 * t));
    L[i] = lowS + highS;
    R[i] = -lowS + highS;
  }
  return {
    L, R, sr,
    kind: 'band-split',
    note: '低频反相、高频同相：抵消风险只落在分频点以下。',
  };
}

// --- Response / coherence evidence ------------------------------------------
// Per-band correlation of L/R around a split, so a fold claim can be checked at
// the same fc the chain uses instead of one whole-buffer number.
export function bandCorrelationEvidence(L, R, fc, sr = SR) {
  const lSplit = lr4Split(L, fc, sr);
  const rSplit = lr4Split(R, fc, sr);
  return {
    fc,
    low: {
      correlation: Number(correlation(lSplit.lo, rSplit.lo).toFixed(4)),
      energyDbL: Number(db(rms(lSplit.lo)).toFixed(2)),
      energyDbR: Number(db(rms(rSplit.lo)).toFixed(2)),
    },
    high: {
      correlation: Number(correlation(lSplit.hi, rSplit.hi).toFixed(4)),
      energyDbL: Number(db(rms(lSplit.hi)).toFixed(2)),
      energyDbR: Number(db(rms(rSplit.hi)).toFixed(2)),
    },
    broadbandCorrelation: Number(correlation(L, R).toFixed(4)),
  };
}

// Impulse-response facts used to verify decorrelator claims in a clean dir.
export function decorrelatorEvidence(sr = SR) {
  const ap = allPassFrequencyResponse(sr, 1);
  const dMs = 6;
  const dl = delayImpulse(sr, dMs, 2048);
  let peakIdx = 0, peak = 0;
  for (let i = 0; i < dl.length; i++) {
    const a = Math.abs(dl[i]);
    if (a > peak) { peak = a; peakIdx = i; }
  }
  return {
    allpassMaxMagDevDb: ap.maxDevDb,
    allpassPhaseSpanRad: ap.phaseSpanRad,
    delayCommandSamples: Math.round((dMs * sr) / 1000),
    delayPeakSample: peakIdx,
  };
}
