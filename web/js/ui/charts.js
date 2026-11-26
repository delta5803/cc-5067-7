// Dependency-free canvas charts. Every call draws real measured arrays.

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 200;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const PAD = { l: 46, r: 12, t: 10, b: 22 };

function grid(ctx, w, h, yMin, yMax, yTicks, fmtY) {
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'middle';
  for (const t of yTicks) {
    const y = PAD.t + (h - PAD.t - PAD.b) * (1 - (t - yMin) / (yMax - yMin));
    ctx.strokeStyle = 'rgba(120,145,180,.16)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke();
    ctx.fillStyle = '#7d8ea6';
    ctx.textAlign = 'right';
    ctx.fillText(fmtY ? fmtY(t) : String(t), PAD.l - 6, y);
  }
}

function line(ctx, w, h, values, color, yMin, yMax, width = 1.8) {
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    const x = PAD.l + (iw * i) / Math.max(1, values.length - 1);
    const y = PAD.t + ih * (1 - (values[i] - yMin) / (yMax - yMin));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function freqAxis(ctx, w, h, freqs) {
  const marks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 18000];
  const fmin = freqs[0], fmax = freqs[freqs.length - 1];
  const iw = w - PAD.l - PAD.r;
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const f of marks) {
    if (f < fmin || f > fmax) continue;
    const x = PAD.l + iw * (Math.log(f / fmin) / Math.log(fmax / fmin));
    ctx.strokeStyle = 'rgba(120,145,180,.12)';
    ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, h - PAD.b); ctx.stroke();
    ctx.fillStyle = '#7d8ea6';
    ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), x, h - PAD.b + 6);
  }
}

export function drawTrace(canvas, stageTrace, inputTrace) {
  const { ctx, w, h } = setup(canvas);
  grid(ctx, w, h, -1, 1, [-1, -0.5, 0, 0.5, 1], (t) => t.toFixed(1));
  const zeroY = PAD.t + (h - PAD.t - PAD.b) * 0.5;
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  ctx.beginPath(); ctx.moveTo(PAD.l, zeroY); ctx.lineTo(w - PAD.r, zeroY); ctx.stroke();
  if (inputTrace && inputTrace.length) line(ctx, w, h, inputTrace, '#b58cff', -1, 1, 1.2);
  if (stageTrace && stageTrace.length) line(ctx, w, h, stageTrace, '#4f9cff', -1, 1, 1.8);
}

export function drawSpectrum(canvas, spectrum) {
  const { ctx, w, h } = setup(canvas);
  if (!spectrum) return;
  const all = [
    ...spectrum.inputMid.values, ...spectrum.stageFold.values, ...spectrum.broadcast.values,
  ].filter(Number.isFinite);
  let hi = Math.ceil(Math.max(...all, -30) / 6) * 6 + 3;
  let lo = Math.floor(Math.min(...all, -120) / 6) * 6 - 3;
  hi = Math.min(hi, 12); lo = Math.max(lo, -132);
  const ticks = [];
  for (let t = Math.ceil(lo / 12) * 12; t <= hi; t += 12) ticks.push(t);
  grid(ctx, w, h, lo, hi, ticks, (t) => t + '');
  freqAxis(ctx, w, h, spectrum.inputMid.freqs);
  line(ctx, w, h, spectrum.inputMid.values, '#8fa6c2', lo, hi, 1.3);
  line(ctx, w, h, spectrum.stageFold.values, '#4f9cff', lo, hi, 1.8);
  line(ctx, w, h, spectrum.broadcast.values, '#37d0a3', lo, hi, 1.4);
}

export function drawMagnitude(canvas, resp) {
  const { ctx, w, h } = setup(canvas);
  if (!resp) return;
  const all = [...resp.magL, ...resp.magR];
  let hi = Math.max(4, Math.ceil(Math.max(...all) / 3) * 3);
  let lo = Math.min(-6, Math.floor(Math.min(...all) / 3) * 3);
  lo = Math.max(lo, -42);
  const ticks = [];
  for (let t = Math.ceil(lo / 6) * 6; t <= hi; t += 6) ticks.push(t);
  grid(ctx, w, h, lo, hi, ticks, (t) => t + '');
  freqAxis(ctx, w, h, resp.freqs);
  line(ctx, w, h, resp.magL, '#4f9cff', lo, hi, 1.7);
  line(ctx, w, h, resp.magR, '#f5a623', lo, hi, 1.5);
}

export function drawPhase(canvas, resp) {
  const { ctx, w, h } = setup(canvas);
  if (!resp) return;
  const vals = resp.phaseDiff;
  let lo = Math.min(...vals, 0), hi = Math.max(...vals, 0);
  const pad = Math.max(0.4, (hi - lo) * 0.08);
  lo -= pad; hi += pad;
  const ticks = [lo, 0, hi];
  grid(ctx, w, h, lo, hi, ticks, (t) => t.toFixed(1));
  freqAxis(ctx, w, h, resp.freqs);
  line(ctx, w, h, vals, '#b58cff', lo, hi, 1.7);
  const zeroY = PAD.t + (h - PAD.t - PAD.b) * (1 - (0 - lo) / (hi - lo));
  ctx.strokeStyle = 'rgba(255,255,255,.22)';
  ctx.beginPath(); ctx.moveTo(PAD.l, zeroY); ctx.lineTo(w - PAD.r, zeroY); ctx.stroke();
}
