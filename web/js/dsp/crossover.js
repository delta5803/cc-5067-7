// Linkwitz-Riley 4th-order crossover: two cascaded Butterworth-2 sections.
// LR4 low + high sums to flat magnitude with an all-pass phase rotation,
// which the measurement layer exposes instead of hiding.

import { biquadCoeffs, processBiquad } from './biquad.js';

const BUTTERWORTH_Q = Math.SQRT1_2;

export function lr4Coefficients(freq, sampleRate) {
  const lp2 = biquadCoeffs('lp', freq, BUTTERWORTH_Q, sampleRate);
  const hp2 = biquadCoeffs('hp', freq, BUTTERWORTH_Q, sampleRate);
  return { lp: [lp2, lp2], hp: [hp2, hp2] };
}

export function lr4Split(x, freq, sampleRate) {
  const { lp, hp } = lr4Coefficients(freq, sampleRate);
  // Identical coefficient objects cascaded with independent fresh state.
  let lo = processBiquad(lp[0], x);
  lo = processBiquad(lp[1], lo);
  let hi = processBiquad(hp[0], x);
  hi = processBiquad(hp[1], hi);
  return { lo, hi };
}

// Single Butterworth-2 band pass via lp/hp cascade, used by marker analysis.
export function bandLimit(x, lowFreq, highFreq, sampleRate) {
  let y = x;
  if (highFreq && highFreq < sampleRate / 2) {
    const c = biquadCoeffs('lp', highFreq, BUTTERWORTH_Q, sampleRate);
    y = processBiquad(c, y);
  }
  if (lowFreq && lowFreq > 0) {
    const c = biquadCoeffs('hp', lowFreq, BUTTERWORTH_Q, sampleRate);
    y = processBiquad(c, y);
  }
  return y;
}

export function lowPass(x, freq, sampleRate, order = 4) {
  const sections = order === 4 ? 2 : 1;
  const c = biquadCoeffs('lp', freq, BUTTERWORTH_Q, sampleRate);
  let y = x;
  for (let i = 0; i < sections; i++) y = processBiquad(c, y);
  return y;
}

export function highPass(x, freq, sampleRate, order = 4) {
  const sections = order === 4 ? 2 : 1;
  const c = biquadCoeffs('hp', freq, BUTTERWORTH_Q, sampleRate);
  let y = x;
  for (let i = 0; i < sections; i++) y = processBiquad(c, y);
  return y;
}
