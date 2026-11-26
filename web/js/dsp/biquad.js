// RBJ cookbook biquads (normalized coefficients) and mono processing.

export function biquadCoeffs(type, f0, q, sampleRate, gainDb = 0) {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);
  const A = Math.pow(10, gainDb / 40);

  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') {
    b0 = (1 - cosw) / 2;
    b1 = 1 - cosw;
    b2 = (1 - cosw) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosw;
    a2 = 1 - alpha;
  } else if (type === 'hp') {
    b0 = (1 + cosw) / 2;
    b1 = -(1 + cosw);
    b2 = (1 + cosw) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosw;
    a2 = 1 - alpha;
  } else if (type === 'ap') {
    b0 = 1 - alpha;
    b1 = -2 * cosw;
    b2 = 1 + alpha;
    a0 = 1 + alpha;
    a1 = -2 * cosw;
    a2 = 1 - alpha;
  } else if (type === 'peak') {
    const beta = Math.sqrt(A) / q;
    b0 = 1 + alpha * A;
    b1 = -2 * cosw;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cosw;
    a2 = 1 - alpha / A;
    void beta;
  } else {
    throw new Error('unknown biquad type ' + type);
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

// Direct Form I with per-call state (fresh state = no history).
export function processBiquad(c, x) {
  const n = x.length;
  const y = new Float64Array(n);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const b0 = c.b0, b1 = c.b1, b2 = c.b2, a1 = c.a1, a2 = c.a2;
  for (let i = 0; i < n; i++) {
    const x0 = x[i];
    let y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    // Guard against any pathological coefficient blow-up.
    if (!Number.isFinite(y0)) y0 = 0;
    y[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  return y;
}

export function processChain(coeffs, x) {
  let y = x;
  for (const c of coeffs) y = processBiquad(c, y);
  return y;
}

// Stateful biquad for real-time-style block processing / repeated calls.
export function createBiquadState(c) {
  return { c, x1: 0, x2: 0, y1: 0, y2: 0 };
}

export function processBiquadState(st, x) {
  const c = st.c;
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = c.b0 * x0 + c.b1 * st.x1 + c.b2 * st.x2 - c.a1 * st.y1 - c.a2 * st.y2;
    y[i] = y0;
    st.x2 = st.x1; st.x1 = x0;
    st.y2 = st.y1; st.y1 = y0;
  }
  return y;
}
