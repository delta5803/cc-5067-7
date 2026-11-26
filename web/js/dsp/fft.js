// Minimal radix-2 FFT and spectral helpers. Pure JS, no DOM / Node APIs.

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// In-place iterative radix-2 DIT FFT. re/im must have power-of-two length.
export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('fft length must be power of two');

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const vr = re[b] * cwr - im[b] * cwi;
        const vi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

export function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

// Average Welch power spectrum. Returns magnitude (sqrt power) averaged.
export function welchMagnitude(x, sampleRate, fftSize = 4096, maxSegments = 20) {
  const n = x.length;
  fftSize = Math.min(fftSize, nextPow2(Math.max(64, n)));
  if ((fftSize & (fftSize - 1)) !== 0) fftSize = nextPow2(fftSize);
  const win = hannWindow(fftSize);
  const hop = fftSize >> 1;
  const bins = fftSize >> 1;
  const acc = new Float64Array(bins);
  let count = 0;
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  let starts = [];
  if (n <= fftSize) {
    starts = [0];
  } else {
    for (let s = 0; s + fftSize <= n; s += hop) starts.push(s);
    if (starts.length > maxSegments) {
      const stride = starts.length / maxSegments;
      const picked = [];
      for (let i = 0; i < maxSegments; i++) picked.push(starts[Math.floor(i * stride)]);
      starts = picked;
    }
  }

  let winPower = 0;
  for (let i = 0; i < fftSize; i++) winPower += win[i] * win[i];

  for (const s of starts) {
    for (let i = 0; i < fftSize; i++) {
      const idx = s + i < n ? s + i : 0;
      re[i] = x[idx] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      acc[k] += (re[k] * re[k] + im[k] * im[k]) / (winPower || 1);
    }
    count++;
  }

  const freqs = new Float64Array(bins);
  const mag = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    freqs[k] = (k * sampleRate) / fftSize;
    mag[k] = Math.sqrt(acc[k] / Math.max(1, count));
  }
  return { freqs, mag, fftSize };
}

// Complex transfer H = Y / X at the given FFT size for two equal-length signals.
export function transferFunction(x, y, sampleRate, fftSize) {
  const n = Math.max(x.length, y.length);
  fftSize = fftSize || nextPow2(n);
  const reX = new Float64Array(fftSize);
  const imX = new Float64Array(fftSize);
  const reY = new Float64Array(fftSize);
  const imY = new Float64Array(fftSize);
  for (let i = 0; i < Math.min(n, fftSize); i++) {
    reX[i] = x[i] || 0;
    reY[i] = y[i] || 0;
  }
  fft(reX, imX);
  fft(reY, imY);
  const bins = fftSize >> 1;
  const freqs = new Float64Array(bins);
  const mag = new Float64Array(bins);
  const phase = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const xr = reX[k], xi = imX[k];
    const yr = reY[k], yi = imY[k];
    const denom = xr * xr + xi * xi + 1e-20;
    // H = Y * conj(X) / |X|^2
    const hr = (yr * xr + yi * xi) / denom;
    const hi = (yi * xr - yr * xi) / denom;
    freqs[k] = (k * sampleRate) / fftSize;
    mag[k] = Math.hypot(hr, hi);
    phase[k] = Math.atan2(hi, hr);
  }
  return { freqs, mag, phase, fftSize };
}

// FFT of a finite impulse / signal segment, returning magnitude and unwrapped phase.
export function impulseSpectrum(ir, sampleRate, fftSize) {
  fftSize = fftSize || nextPow2(Math.max(64, ir.length));
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < Math.min(ir.length, fftSize); i++) re[i] = ir[i];
  fft(re, im);
  const bins = fftSize >> 1;
  const freqs = new Float64Array(bins);
  const magDb = new Float64Array(bins);
  const phase = new Float64Array(bins);
  let prev = 0;
  for (let k = 0; k < bins; k++) {
    freqs[k] = (k * sampleRate) / fftSize;
    const m = Math.hypot(re[k], im[k]);
    magDb[k] = 20 * Math.log10(m + 1e-12);
    let ph = Math.atan2(im[k], re[k]);
    if (k > 0) {
      while (ph - prev > Math.PI) ph -= 2 * Math.PI;
      while (ph - prev < -Math.PI) ph += 2 * Math.PI;
    }
    phase[k] = ph;
    prev = ph;
  }
  return { freqs, magDb, phase, fftSize };
}
