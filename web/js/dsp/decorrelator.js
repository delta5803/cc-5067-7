// Explicit decorrelation structures.
//  - ap:     dispersive chain of RBJ all-pass biquads (flat magnitude, shifted phase)
//  - delay:  exact short integer delay (linear phase vs frequency)
//  - haas:   asymmetric channel delay mixed in by the pipeline

import { biquadCoeffs, processChain } from './biquad.js';

export function delaySamples(x, delayInSamples) {
  const d = Math.max(0, Math.round(delayInSamples));
  const y = new Float64Array(x.length);
  if (d === 0) {
    y.set(x);
    return y;
  }
  for (let i = d; i < x.length; i++) y[i] = x[i - d];
  return y;
}

export function delayInSamples(ms, sampleRate) {
  return Math.max(1, Math.round((ms * sampleRate) / 1000));
}

const AP_FREQS = [230, 470, 940, 1850, 3600, 6900];
const AP_QS = [0.62, 0.72, 0.85, 1.0, 1.15, 1.3];

export function allpassDecorrelator(x, sampleRate, character = 1) {
  const coeffs = AP_FREQS.map((f, i) => {
    const freq = Math.min(f * character, sampleRate * 0.42);
    return biquadCoeffs('ap', freq, AP_QS[i], sampleRate);
  });
  return processChain(coeffs, x);
}

// Impulse response of the all-pass network for response measurement.
export function allpassImpulse(sampleRate, character = 1, length = 4096) {
  const delta = new Float64Array(length);
  delta[0] = 1;
  return allpassDecorrelator(delta, sampleRate, character);
}

export function delayImpulse(sampleRate, ms, length = 4096) {
  const delta = new Float64Array(length);
  delta[0] = 1;
  return delaySamples(delta, delayInSamples(ms, sampleRate));
}
