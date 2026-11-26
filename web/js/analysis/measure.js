// Real measurements computed from actual sample buffers.
// Every meter / chart in the UI is fed by these functions; no decorative data.

import { fft, nextPow2, welchMagnitude, impulseSpectrum } from '../dsp/fft.js';
import { lowPass, bandLimit } from '../dsp/crossover.js';

export function mean(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  return m / x.length;
}

// Pearson-style stereo correlation over the whole buffer.
export function correlation(x, y) {
  const n = Math.min(x.length, y.length);
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    sxy += a * b; sxx += a * a; syy += b * b;
  }
  const den = Math.sqrt(sxx * syy);
  if (den < 1e-20) return 0;
  const r = sxy / den;
  return Math.max(-1, Math.min(1, r));
}

export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

export function peakAbs(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

export function energy(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return s;
}

export function db(v, floor = -120) {
  if (v <= 1e-12) return floor;
  return Math.max(floor, 20 * Math.log10(v));
}

export function bandCorrelation(L, R, cutoff, sr, order = 4) {
  const lL = lowPass(L, cutoff, sr, order);
  const lR = lowPass(R, cutoff, sr, order);
  return correlation(lL, lR);
}

// Short-window correlation trace for the scrolling/static correlation graph.
export function correlationTrace(L, R, sr, windowMs = 100, points = 180) {
  const win = Math.max(64, Math.round((windowMs * sr) / 1000));
  const n = L.length;
  const hop = Math.max(1, Math.floor((n - win) / points));
  const out = [];
  for (let start = 0; start + win <= n; start += hop) {
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = start; i < start + win; i++) {
      const a = L[i], b = R[i];
      sxy += a * b; sxx += a * a; syy += b * b;
    }
    const den = Math.sqrt(sxx * syy);
    let r = den < 1e-12 ? 1 : sxy / den;
    r = Math.max(-1, Math.min(1, r));
    out.push(Number(r.toFixed(4)));
    if (out.length >= points) break;
  }
  return out;
}

export function analyzeInput(L, R, sr, bassFreq = 150) {
  const rho = correlation(L, R);
  const rhoBass = bandCorrelation(L, R, bassFreq, sr, 4);
  const eL = energy(L), eR = energy(R);
  const { M, S } = { M: null, S: null };
  let eM = 0, eS = 0;
  const n = L.length;
  for (let i = 0; i < n; i++) {
    const m = 0.5 * (L[i] + R[i]);
    const s = 0.5 * (L[i] - R[i]);
    eM += m * m; eS += s * s;
  }
  const sideRatioDb = db(Math.sqrt(eS / Math.max(1e-20, eM)));
  const balanceDb = db(rms(L) / Math.max(1e-12, rms(R)));

  let cls = 'normal';
  if (rho > 0.995 && sideRatioDb < -42) cls = 'mono';
  else if (rhoBass < -0.4 && eS > eM * 0.02) cls = 'anti_phase_lf';
  else if (rho > 0.85) cls = 'correlated';

  const flags = [];
  if (cls === 'mono') flags.push('pure_mono');
  if (rhoBass < -0.4) flags.push('anti_phase_lf');
  if (rho < 0) flags.push('negative_correlation');
  if (peakAbs(L) > 0.999 || peakAbs(R) > 0.999) flags.push('hot_level');

  return {
    cls,
    flags,
    rho: Number(rho.toFixed(5)),
    rhoBass: Number(rhoBass.toFixed(5)),
    sideRatioDb: Number(sideRatioDb.toFixed(2)),
    balanceDb: Number(balanceDb.toFixed(2)),
    rmsL: Number(db(rms(L)).toFixed(2)),
    rmsR: Number(db(rms(R)).toFixed(2)),
    peak: Number(db(Math.max(peakAbs(L), peakAbs(R))).toFixed(2)),
  };
}

// Sample a spectrum onto log-spaced frequency bins.
export function logSpectrum(signal, sr, fftSize = 4096, points = 130, fmin = 24, fmax = 19000) {
  const { freqs, mag } = welchMagnitude(signal, sr, fftSize);
  return sampleLog(freqs, mag.map((m) => db(m)), points, fmin, Math.min(fmax, sr / 2 * 0.92));
}

export function sampleLog(freqs, values, points, fmin, fmax) {
  const outF = new Array(points);
  const outV = new Array(points);
  const logMin = Math.log(fmin), logMax = Math.log(fmax);
  const bins = freqs.length;
  for (let p = 0; p < points; p++) {
    const f = Math.exp(logMin + ((logMax - logMin) * p) / (points - 1));
    // nearest bin with small +/-1 averaging for stability
    let idx = 1;
    while (idx < bins - 1 && freqs[idx] < f) idx++;
    let v = values[idx];
    if (idx > 0 && idx < bins) v = 0.5 * (values[idx - 1] + values[idx]);
    outF[p] = Math.round(f * 10) / 10;
    outV[p] = Number(v.toFixed(2));
  }
  return { freqs: outF, values: outV };
}

// 1/12-octave smoothed log spectra compared for mono coloration.
export function spectralDifferenceDb(a, b, sr, fftSize = 8192) {
  const sa = welchMagnitude(a, sr, fftSize, 12);
  const sb = welchMagnitude(b, sr, fftSize, 12);
  const points = 96;
  const fmax = Math.min(15000, sr * 0.4);
  const la = sampleLog(sa.freqs, Array.from(sa.mag, (m) => db(m)), points, 40, fmax);
  const lb = sampleLog(sb.freqs, Array.from(sb.mag, (m) => db(m)), points, 40, fmax);
  let maxD = 0, sumD = 0, cnt = 0;
  let hfMax = 0, hfSum = 0, hfCnt = 0;
  let lowMax = 0, lowSum = 0, lowCnt = 0;
  const curve = [];
  for (let i = 0; i < points; i++) {
    const f = la.freqs[i];
    const d = lb.values[i] - la.values[i];
    curve.push(Number(d.toFixed(2)));
    if (f >= 80 && f <= 12000) {
      maxD = Math.max(maxD, Math.abs(d));
      sumD += Math.abs(d); cnt++;
    }
    if (f >= 220 && f <= 12000) {
      hfMax = Math.max(hfMax, Math.abs(d));
      hfSum += Math.abs(d); hfCnt++;
    }
    if (f >= 45 && f < 220) {
      lowMax = Math.max(lowMax, Math.abs(d));
      lowSum += Math.abs(d); lowCnt++;
    }
  }
  return {
    maxDb: Number(hfMax.toFixed(2)),
    avgDb: Number((hfSum / Math.max(1, hfCnt)).toFixed(2)),
    broadbandMaxDb: Number(maxD.toFixed(2)),
    hfMaxDb: Number(hfMax.toFixed(2)),
    hfAvgDb: Number((hfSum / Math.max(1, hfCnt)).toFixed(2)),
    lowMaxDb: Number(lowMax.toFixed(2)),
    lowAvgDb: Number((lowSum / Math.max(1, lowCnt)).toFixed(2)),
    freqs: la.freqs, curve,
  };
}

// Peak lag of normalized cross-correlation (gcc) in samples.
export function gccLag(x, y, maxLag = 64) {
  let best = 0, bestV = -Infinity;
  const e = Math.sqrt(energy(x) * energy(y)) || 1;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let v = 0;
    for (let i = 0; i < x.length; i++) {
      const j = i + lag;
      if (j >= 0 && j < y.length) v += x[i] * y[j];
    }
    v /= e;
    if (v > bestV) { bestV = v; best = lag; }
  }
  return { lag: best, value: Number(bestV.toFixed(4)) };
}

// Full response data for a stereo impulse result: magnitudes + phase difference + ITD.
export function stereoResponseData(irL, irR, sr) {
  const nfft = 8192;
  const sL = impulseSpectrum(irL, sr, nfft);
  const sR = impulseSpectrum(irR, sr, nfft);
  const fftN = nfft;
  const re = new Float64Array(fftN), im = new Float64Array(fftN);
  for (let i = 0; i < Math.min(irL.length, fftN); i++) re[i] = irL[i];
  fft(re, im);
  const lRe = re.slice(), lIm = im.slice();
  const re2 = new Float64Array(fftN), im2 = new Float64Array(fftN);
  for (let i = 0; i < Math.min(irR.length, fftN); i++) re2[i] = irR[i];
  fft(re2, im2);

  const points = 150;
  const fmin = 30, fmax = Math.min(18000, sr * 0.45);
  const logMin = Math.log(fmin), logMax = Math.log(fmax);
  const freqs = [], magL = [], magR = [], phaseDiff = [];
  let prevWrap = 0;
  for (let p = 0; p < points; p++) {
    const f = Math.exp(logMin + ((logMax - logMin) * p) / (points - 1));
    const k = Math.max(1, Math.min(fftN / 2 - 1, Math.round((f * fftN) / sr)));
    freqs.push(Math.round(f));
    magL.push(Number(sL.magDb[k].toFixed(2)));
    magR.push(Number(sR.magDb[k].toFixed(2)));
    // cross phase angle(H_L * conj(H_R))
    const hr = lRe[k] * re2[k] + lIm[k] * im2[k];
    const hi = lIm[k] * re2[k] - lRe[k] * im2[k];
    let ph = Math.atan2(hi, hr);
    while (ph - prevWrap > Math.PI) ph -= 2 * Math.PI;
    while (ph - prevWrap < -Math.PI) ph += 2 * Math.PI;
    prevWrap = ph;
    phaseDiff.push(Number(ph.toFixed(3)));
  }
  const itd = gccLag(irL, irR, 80);
  return {
    freqs, magL, magR, phaseDiff,
    itdSamples: itd.lag,
    itdMs: Number(((itd.lag / sr) * 1000).toFixed(3)),
    gcc: itd.value,
  };
}

// ---- Routing probe markers: syllable onsets (字头) and bass pulses ----

function envelopePeakOffset(signal, marker, sr, preMs = 6, windowMs = 80, rmsWinMs = 8) {
  const pre = Math.round((preMs * sr) / 1000);
  const win = Math.round((windowMs * sr) / 1000);
  const hop = Math.max(1, Math.round(sr / 1000)); // 1 ms hops
  const rmsN = Math.max(8, Math.round((rmsWinMs * sr) / 1000));
  const start = Math.max(0, marker - pre);
  const end = Math.min(signal.length, marker + win);
  let best = -1, bestV = -1;
  for (let pos = start; pos + rmsN < end; pos += hop) {
    let s = 0;
    for (let i = pos; i < pos + rmsN; i++) s += signal[i] * signal[i];
    const v = s / rmsN;
    if (v > bestV) { bestV = v; best = pos; }
  }
  return { offsetSamples: best - marker, offsetMs: ((best - marker) / sr) * 1000, peakRms: Math.sqrt(bestV) };
}

export function markerMetrics(mono, sr, markers) {
  const result = { consonants: [], bass: [] };
  if (!markers) return result;

  if (markers.consonants && markers.consonants.length) {
    const bright = bandLimit(mono, 1700, 9500, sr);
    for (const m of markers.consonants) {
      const pk = envelopePeakOffset(bright, m, sr);
      // Transient density: first 40 ms bright energy vs 40..200 ms tail.
      const e1 = windowEnergy(bright, m, Math.round(0.04 * sr));
      const e2 = windowEnergy(bright, m + Math.round(0.04 * sr), Math.round(0.16 * sr));
      // Energy centroid and late-arriving energy share over a 70 ms window:
      // this catches decorrelator smear even when the first peak stays loud.
      const W = Math.round(0.07 * sr);
      let wsum = 0, tsum = 0, eAll = 0, eLate = 0;
      for (let i = 0; i < W && m + i < bright.length; i++) {
        const v = bright[m + i] * bright[m + i];
        wsum += v * i; eAll += v;
        if (i >= Math.round(0.008 * sr)) eLate += v;
      }
      const centroidMs = eAll > 1e-12 ? (wsum / eAll / sr) * 1000 : 0;
      const lateRatio = eAll > 1e-12 ? eLate / eAll : 0;
      result.consonants.push({
        offsetMs: Number(pk.offsetMs.toFixed(2)),
        centroidMs: Number(centroidMs.toFixed(2)),
        lateRatio: Number(lateRatio.toFixed(3)),
        peakDb: Number(db(pk.peakRms).toFixed(2)),
        attackRatio: Number((e1 / (e1 + e2 + 1e-12)).toFixed(3)),
      });
    }
    const offsets = result.consonants.map((c) => c.offsetMs);
    result.consonantOffsetMs = Number(median(offsets).toFixed(2));
    result.consonantCentroidMs = Number(median(result.consonants.map((c) => c.centroidMs)).toFixed(2));
    result.consonantLateRatio = Number(mean(result.consonants.map((c) => c.lateRatio)).toFixed(3));
    result.consonantPeakDb = Number(median(result.consonants.map((c) => c.peakDb)).toFixed(2));
    result.consonantAttackRatio = Number(mean(result.consonants.map((c) => c.attackRatio)).toFixed(3));
  }

  if (markers.bass && markers.bass.length) {
    const low = lowPass(mono, 170, sr, 4);
    for (const m of markers.bass) {
      const a = windowRms(low, m + Math.round(0.012 * sr), Math.round(0.24 * sr));
      result.bass.push({ ampDb: Number(db(a).toFixed(2)), amp: Number(a.toFixed(6)) });
    }
    result.bassAmpDb = Number(median(result.bass.map((b) => b.ampDb)).toFixed(2));
    result.bassAmp = Number(median(result.bass.map((b) => b.amp)).toFixed(6));
  }
  return result;
}

function windowEnergy(x, start, len) {
  let s = 0;
  const end = Math.min(x.length, start + len);
  for (let i = Math.max(0, start); i < end; i++) s += x[i] * x[i];
  return s;
}

function windowRms(x, start, len) {
  const a = Math.max(0, start);
  const b = Math.min(x.length, start + len);
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
}

// Whole-render measurement bundle (JSON-safe).
export function measureRender(bundle) {
  const { inputL, inputR, stageL, stageR, bcL, bcR, stageFold, dryMid, sr, markers } = bundle;
  const out = {};

  out.input = {
    rho: Number(correlation(inputL, inputR).toFixed(4)),
    rhoBass: Number(bandCorrelation(inputL, inputR, 150, sr).toFixed(4)),
    rmsL: Number(db(rms(inputL)).toFixed(2)),
    rmsR: Number(db(rms(inputR)).toFixed(2)),
    peak: Number(db(Math.max(peakAbs(inputL), peakAbs(inputR))).toFixed(2)),
  };
  out.stage = {
    rho: Number(correlation(stageL, stageR).toFixed(4)),
    rhoBass: Number(bandCorrelation(stageL, stageR, 150, sr).toFixed(4)),
    rmsL: Number(db(rms(stageL)).toFixed(2)),
    rmsR: Number(db(rms(stageR)).toFixed(2)),
    peak: Number(db(Math.max(peakAbs(stageL), peakAbs(stageR))).toFixed(2)),
    balanceDb: Number(db(rms(stageL) / Math.max(1e-12, rms(stageR))).toFixed(2)),
  };
  out.broadcast = {
    rho: Number(correlation(bcL, bcR).toFixed(4)),
    rms: Number(db(rms(bcL)).toFixed(2)),
    peak: Number(db(peakAbs(bcL)).toFixed(2)),
  };

  // Mono compatibility: how much the stage fold deviates from the dry mid.
  out.coloration = spectralDifferenceDb(dryMid, stageFold, sr);
  out.bassFold = {
    dryMidDb: Number(db(rms(lowPass(dryMid, 150, sr, 4))).toFixed(2)),
    stageFoldDb: Number(db(rms(lowPass(stageFold, 150, sr, 4))).toFixed(2)),
  };
  out.bassFold.deltaDb = Number((out.bassFold.stageFoldDb - out.bassFold.dryMidDb).toFixed(2));

  out.rhoTrace = correlationTrace(stageL, stageR, sr);
  out.inputRhoTrace = correlationTrace(inputL, inputR, sr);

  out.spectrum = {
    inputMid: logSpectrum(dryMid, sr, 4096),
    stageFold: logSpectrum(stageFold, sr, 4096),
    broadcast: logSpectrum(bcL, sr, 4096),
  };

  if (markers) {
    out.markers = {
      broadcast: markerMetrics(bcL, sr, markers),
      stageFold: markerMetrics(stageFold, sr, markers),
      dryMid: markerMetrics(dryMid, sr, markers),
    };
  }
  return out;
}
