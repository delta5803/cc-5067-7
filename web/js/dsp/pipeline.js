// Mid/Side matrix and the real stereo width chain.
//
// Topology (crossover / full-band):
//   M = (L+R)/2, S = (L-R)/2
//   S' = width * S + decorr * D(M)   (D = all-pass chain or short delay)
//   L' = M + S', R' = M - S'
// In this symmetric topology the mono fold L'+R' = 2M is preserved exactly
// apart from the LR4 crossover phase rotation. The asymmetric 'haas'
// structure deliberately adds a one-sided delayed echo, so its mono fold
// exhibits a measurable comb coloration (exposed by the analysis layer).

import { lr4Split, highPass } from './crossover.js';
import { allpassDecorrelator, delaySamples, delayInSamples } from './decorrelator.js';

export function msEncode(L, R) {
  const n = L.length;
  const M = new Float64Array(n);
  const S = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    M[i] = 0.5 * (L[i] + R[i]);
    S[i] = 0.5 * (L[i] - R[i]);
  }
  return { M, S };
}

export function msDecode(M, S) {
  const n = M.length;
  const L = new Float64Array(n);
  const R = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = M[i] + S[i];
    R[i] = M[i] - S[i];
  }
  return { L, R };
}

export function cloneStereo(st) {
  return { L: new Float64Array(st.L), R: new Float64Array(st.R) };
}

function decorrSend(source, structure, sampleRate, cfg) {
  if (structure === 'ap') return allpassDecorrelator(source, sampleRate, cfg.apCharacter ?? 1);
  if (structure === 'delay') {
    return delaySamples(source, delayInSamples(cfg.delayMs ?? 6, sampleRate));
  }
  return new Float64Array(source.length);
}

// Build the side-chain send and optionally orthogonalize it against the mid
// source: D <- D - (<M,D>/<M,M>) M. This removes the zero-lag mid/send cross
// term that would otherwise tilt L/R energy, keeping the phantom center stable.
// The removed scalar is a real, measurable part of the chain.
function buildSend(source, structure, sampleRate, cfg) {
  if (structure !== 'ap' && structure !== 'delay') return null;
  const D = decorrSend(source, structure, sampleRate, cfg);
  if (cfg.centerLock !== false) {
    let md = 0, mm = 0;
    for (let i = 0; i < source.length; i++) {
      md += source[i] * D[i];
      mm += source[i] * source[i];
    }
    const c = md / (mm + 1e-20);
    for (let i = 0; i < source.length; i++) D[i] -= c * source[i];
    D.projectionGain = c;
  }
  return D;
}

function applyOutputGain(stage, cfg) {
  const g = Math.pow(10, (cfg.outGainDb ?? 0) / 20);
  if (g === 1) return stage;
  for (let i = 0; i < stage.L.length; i++) { stage.L[i] *= g; stage.R[i] *= g; }
  return stage;
}

// Resolve the effective low-frequency handling under the declared policy.
export function resolveLowMode(cfg, analysis) {
  if (cfg.lowMode === 'auto') {
    return cfg.autoProtect !== false && analysis && analysis.cls === 'anti_phase_lf' ? 'rescue' : 'center';
  }
  return cfg.lowMode;
}

export function resolveBroadcastRoute(cfg, analysis) {
  if (cfg.broadcast === 'auto') {
    return cfg.autoProtect !== false && analysis && analysis.cls === 'anti_phase_lf' ? 'phase_safe' : 'fold_stage';
  }
  return cfg.broadcast;
}

// Stage (stereo feed) processing only. analysis may be null; then lowMode must be explicit.
export function processStage(L, R, cfg, analysis = null) {
  const sr = cfg.sr;
  const n = L.length;

  if (cfg.stageMode === 'preserve') {
    return { L: new Float64Array(L), R: new Float64Array(R), effective: { stageMode: 'preserve' } };
  }

  const width = cfg.width ?? 1;
  const decorr = cfg.decorr ?? 0;
  const structure = cfg.structure ?? 'ap';
  const useCrossover = cfg.stageMode === 'crossover' && cfg.crossover !== false;
  const lowMode = resolveLowMode(cfg, analysis);

  const { M, S } = msEncode(L, R);
  let Lo, Ro;

  if (useCrossover) {
    const fc = cfg.fc ?? 200;
    const mSplit = lr4Split(M, fc, sr);
    const sSplit = lr4Split(S, fc, sr);
    const Mlo = mSplit.lo, Mhi = mSplit.hi;
    const Slo = sSplit.lo, Shi = sSplit.hi;

    // Low band: preserve original side, center the mid, or phase-aware rescue.
    const lowL = new Float64Array(n);
    const lowR = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (lowMode === 'preserve') {
        lowL[i] = Mlo[i] + Slo[i];
        lowR[i] = Mlo[i] - Slo[i];
      } else if (lowMode === 'rescue') {
        // Chosen globally by band energy below; per-sample copy afterwards.
        lowL[i] = Mlo[i];
      } else {
        // center (default): anti-phase energy in Slo is discarded.
        lowL[i] = Mlo[i];
        lowR[i] = Mlo[i];
      }
    }
    if (lowMode === 'rescue') {
      let eM = 0, eS = 0;
      for (let i = 0; i < n; i++) { eM += Mlo[i] * Mlo[i]; eS += Slo[i] * Slo[i]; }
      const rescueSrc = eS > eM ? Slo : Mlo;
      for (let i = 0; i < n; i++) { lowL[i] = rescueSrc[i]; lowR[i] = rescueSrc[i]; }
    }

    // High band: M/S width + decorrelation send.
    const D = decorr > 0 ? buildSend(Mhi, structure === 'haas' ? 'none' : structure, sr, cfg) : null;
    const highL = new Float64Array(n);
    const highR = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let ShiW = Shi[i] * width;
      if (D) ShiW += decorr * D[i];
      highL[i] = Mhi[i] + ShiW;
      highR[i] = Mhi[i] - ShiW;
    }

    Lo = new Float64Array(n);
    Ro = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      Lo[i] = lowL[i] + highL[i];
      Ro[i] = lowR[i] + highR[i];
    }
  } else {
    // Full-band widen.
    const D = decorr > 0 ? buildSend(M, structure === 'haas' ? 'none' : structure, sr, cfg) : null;
    Lo = new Float64Array(n);
    Ro = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let Sw = S[i] * width;
      if (D) Sw += decorr * D[i];
      Lo[i] = M[i] + Sw;
      Ro[i] = M[i] - Sw;
    }
  }

  // Optional asymmetric Haas echo (delayed copy mixed into the right channel).
  if (structure === 'haas' && decorr > 0) {
    const dSamples = delayInSamples(cfg.haasMs ?? 9, sr);
    const k = 0.25 + 0.75 * decorr; // decorr 0..1 -> k .25..1.0
    let echoSrc = Ro;
    if (useCrossover && cfg.crossover !== false) {
      echoSrc = highPass(Ro, cfg.fc ?? 200, sr, 4);
    }
    const echo = delaySamples(echoSrc, dSamples);
    for (let i = 0; i < n; i++) Ro[i] += k * echo[i];
  }

  applyOutputGain({ L: Lo, R: Ro }, cfg);
  return { L: Lo, R: Ro, effective: { stageMode: cfg.stageMode, useCrossover, lowMode } };
}

// Broadcast mono feed. Returns dual-mono L/R plus the raw mono array.
export function processBroadcast(Lin, Rin, stage, cfg, analysis = null) {
  const n = Lin.length;
  const route = resolveBroadcastRoute(cfg, analysis);
  const mono = new Float64Array(n);

  if (route === 'direct_mid') {
    for (let i = 0; i < n; i++) mono[i] = 0.5 * (Lin[i] + Rin[i]);
  } else if (route === 'fold_stage') {
    for (let i = 0; i < n; i++) mono[i] = 0.5 * (stage.L[i] + stage.R[i]);
  } else if (route === 'phase_safe') {
    // Phase-aware managed mono around the same crossover frequency.
    const fc = cfg.fc ?? 200;
    const { M, S } = msEncode(Lin, Rin);
    const mSplit = lr4Split(M, fc, cfg.sr);
    const sLo = lr4Split(S, fc, cfg.sr).lo;
    let eM = 0, eS = 0;
    for (let i = 0; i < n; i++) { eM += mSplit.lo[i] ** 2; eS += sLo[i] ** 2; }
    const low = eS > eM ? sLo : mSplit.lo;
    for (let i = 0; i < n; i++) mono[i] = low[i] + mSplit.hi[i];
  } else {
    throw new Error('unknown broadcast route ' + route);
  }

  const L = new Float64Array(n);
  const R = new Float64Array(n);
  L.set(mono); R.set(mono);
  return { L, R, mono, route };
}

export function foldStereo(stage) {
  const n = stage.L.length;
  const mono = new Float64Array(n);
  for (let i = 0; i < n; i++) mono[i] = 0.5 * (stage.L[i] + stage.R[i]);
  return mono;
}
