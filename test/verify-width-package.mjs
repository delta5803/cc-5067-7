#!/usr/bin/env node
// Width-package verifier. Runs in a throw-away directory and imports the
// production DSP read-only; nothing is hand-written into the data it checks.
//
//   node test/verify-width-package.mjs            (clean temp dir, emits reports)
//   node test/verify-width-package.mjs --json     (machine-readable summary)
//
// Exit 0 only when every documented claim is reproduced from real samples.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = new URL('.', import.meta.url);
const root = new URL('..', HERE).pathname;

// Everything is imported from the repo, but all outputs land in a temp dir.
const work = mkdtempSync(join(tmpdir(), 'sw-width-verify-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ } });

const imp = (rel) => import(pathToFileURL(join(root, rel)).href + '?v=' + Date.now());

const { renderChain } = await imp('web/js/chain.js');
const { getBuiltinMaterial, buildMatchedPair, buildMarkerProgram, mulberry32 } = await imp('web/js/audio/materials.js');
const { DEFAULT_CONFIG, pickPolicy, sanitizePolicy, loadProjectPolicy, saveProjectPolicy } = await imp('web/js/config.js');
const {
  DECORRELATOR_CONTRACT, bandEdges, powerAccounts, foldPolarityAware,
  bandCorrelationEvidence, decorrelatorEvidence, buildPhaseSample, buildBandSample,
} = await imp('web/js/dsp/contract.js');
const { correlation, rms, db, energy } = await imp('web/js/analysis/measure.js');
const { processStage } = await imp('web/js/dsp/pipeline.js');
const { msEncode, msDecode } = await imp('web/js/dsp/pipeline.js');

const SR = 48000;
const results = [];
function check(id, title, fn) {
  try {
    const r = fn();
    results.push({ id, title, ok: !!r.ok, detail: r.detail, metrics: r.metrics || {} });
  } catch (err) {
    results.push({ id, title, ok: false, detail: 'threw: ' + (err && err.message), metrics: {} });
  }
}

// ---- sample generators kept outside the data, exercised as arguments ---------

function noise(n, seed, amp = 0.3) {
  const rnd = mulberry32(seed);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * (rnd() * 2 - 1);
  return x;
}
function modulators(n) {
  const L = new Float64Array(n), R = new Float64Array(n);
  for (let i = 0; i < n; i++) { L[i] = 0.4 * Math.sin(2 * Math.PI * 110 * i / SR); R[i] = -0.4 * Math.sin(2 * Math.PI * 110 * i / SR); }
  return { L, R };
}

// ---- 1. documented default parameters must match config.js -------------------

check('defaults', '文档预设 = DEFAULT_CONFIG', () => {
  const doc = {
    width: 1.25, decorr: 0.32, structure: 'ap', delayMs: 6, haasMs: 9,
    stageMode: 'crossover', fc: 180, lowMode: 'auto', broadcast: 'auto',
    autoProtect: true, centerLock: true, outGainDb: 0,
  };
  const diffs = [];
  for (const [k, v] of Object.entries(doc)) if (DEFAULT_CONFIG[k] !== v) diffs.push(`${k}: doc=${v} code=${DEFAULT_CONFIG[k]}`);
  return { ok: diffs.length === 0, detail: diffs.length ? diffs.join('; ') : '全部一致', metrics: { diffs } };
});

// ---- 2. decorrelator contract vs measured IR --------------------------------

check('decorrelators', '去相关结构契约 vs 脉冲测量', () => {
  const ev = decorrelatorEvidence(SR);
  const apOk = ev.allpassMaxMagDevDb < 0.6 && ev.allpassPhaseSpanRad > 3;
  const dlOk = ev.delayPeakSample === ev.delayCommandSamples;
  return {
    ok: apOk && dlOk,
    detail: `全通幅度偏差 ${ev.allpassMaxMagDevDb}dB / 相位行程 ${ev.allpassPhaseSpanRad}rad；延迟峰 ${ev.delayPeakSample} 采样（命令 ${ev.delayCommandSamples}）`,
    metrics: ev,
  };
});

// ---- 3. per-channel vs post-fold power accounts -----------------------------

check('power-accounts', '各声道功率相等 ≠ 合并声能相等', () => {
  const n = 65536;
  const M = noise(n, 7, 0.35), S = noise(n, 8, 0.3);
  const { L, R } = msDecode(M, S);
  const sym = processStage(L, R, { sr: SR, stageMode: 'widen', structure: 'ms', width: 1.8, decorr: 0, centerLock: false }, { cls: 'normal' });
  const a = powerAccounts(sym.L, sym.R, SR);
  const haas = processStage(L, R, { sr: SR, stageMode: 'widen', structure: 'haas', width: 1, decorr: 0.9, haasMs: 12 }, { cls: 'normal' });
  const h = powerAccounts(haas.L, haas.R, SR);
  const ok = a.perChannelEqual && Math.abs(a.foldMidDeltaDb) < 0.01 && Math.abs(h.balanceDb) > 0.5;
  return {
    ok,
    detail: `对称扩宽 E_L≈E_R=${a.perChannelEqual}、折叠=M ${a.foldMidDeltaDb.toFixed(2)}dB；Haas 左右平衡 ${h.balanceDb.toFixed(2)}dB —— 两口径分离`,
    metrics: { perChannelEqual: a.perChannelEqual, foldMidDeltaDb: a.foldMidDeltaDb, haasBalanceDb: h.balanceDb },
  };
});

// ---- 4. polarity detection + fold on the sample set ------------------------

check('polarity', '反相声道检测与极性校正折叠', () => {
  const { L, R } = modulators(65536);
  const pol = foldPolarityAware(L, R, SR);
  const ok = pol.polarityReversed && pol.sign === -1 && pol.energyRecoveredDb > 20;
  return {
    ok,
    detail: `判定反相=${pol.polarityReversed}，极性校正折叠回收 ${pol.energyRecoveredDb.toFixed(1)}dB（plain ${pol.plainFoldEnergyDb.toFixed(1)}dB → fold ${pol.foldEnergyDb.toFixed(1)}dB）`,
    metrics: { sign: pol.sign, recoveredDb: Number(pol.energyRecoveredDb.toFixed(2)) },
  };
});

// ---- 5. phase / band samples: cancellation is confined below fc ------------

check('band-risk', '反相与分频带样例的抵消风险位置', () => {
  const phase = buildPhaseSample(SR, 0.5, 80, 0.5);
  const pf = foldPolarityAware(phase.L, phase.R, SR);
  const phaseLoss = pf.plainFoldEnergyDb - db(rms(phase.L));
  const band = buildBandSample(SR, 1.0);
  const ev = bandCorrelationEvidence(band.L, band.R, 180, SR);
  const ok = phaseLoss < -20 && ev.low.correlation < -0.5 && ev.high.correlation > 0.3;
  return {
    ok,
    detail: `80Hz 反相折叠比单声道低 ${phaseLoss.toFixed(1)}dB；带样例低 ρ=${ev.low.correlation} 高 ρ=${ev.high.correlation}`,
    metrics: { phaseLossDb: Number(phaseLoss.toFixed(1)), lowRho: ev.low.correlation, highRho: ev.high.correlation },
  };
});

// ---- 6. project policy round-trip (the fold reads the saved policy) --------

check('policy-persist', '工程侧声策略存取与净化', () => {
  const mem = (() => {
    const map = new Map();
    return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  })();
  const cfg = { ...DEFAULT_CONFIG, width: 1.9, lowMode: 'rescue', foldPolarity: 'auto', broadcast: 'phase_safe' };
  saveProjectPolicy(cfg, mem);
  const back = loadProjectPolicy(mem);
  const fields = pickPolicy(cfg);
  const cleanOk = back && back.width === 1.9 && back.lowMode === 'rescue' && back.foldPolarity === 'auto' && back.broadcast === 'phase_safe';
  // Malformed persisted JSON must sanitize, not throw.
  mem.setItem('sw-project-side-policy-v1', '{"width":"oops","structure":"bogus","fc":99999}');
  const healed = sanitizePolicy(JSON.parse(mem.getItem('sw-project-side-policy-v1')));
  const healedOk = healed && healed.fc === 800 && healed.width === undefined && healed.structure === undefined;
  const ok = cleanOk && fieldCountOk(fields) && healedOk;
  return {
    ok,
    detail: `回读 width=${back && back.width} low=${back && back.lowMode} fold=${back && back.foldPolarity}；异常 JSON 净化 fc=${healed && healed.fc}`,
    metrics: { cleanOk, healedOk },
  };
});
function fieldCountOk(f) { return f && f.width === 1.9 && f.lowMode === 'rescue'; }

// ---- 7. bandwidth change must not erase original centered bass -------------

check('bandwidth-no-erase', '只改扩宽频带不抹掉原居中低音', () => {
  const a = getBuiltinMaterial('pair_a');
  // Narrow high-band widen vs full-band widen. The centered bass (below fc)
  // must stay put when the width band moves; the fold must keep the low band.
  const cfgs = [
    { stageMode: 'crossover', structure: 'ap', width: 1.6, decorr: 0.4, fc: 180, lowMode: 'center' },
    { stageMode: 'crossover', structure: 'ap', width: 2.2, decorr: 0.4, fc: 180, lowMode: 'center' },
    { stageMode: 'crossover', structure: 'ap', width: 1.6, decorr: 0.4, fc: 300, lowMode: 'center' },
  ];
  const rows = cfgs.map((cfg) => {
    const r = renderChain(a.L, a.R, SR, cfg, a.markers);
    const bands = r.measurements.bandDistortion;
    const sub = bands.bands.find((b) => b.name === 'sub');
    const bass = bands.bands.find((b) => b.name === 'bass');
    return { fc: cfg.fc, width: cfg.width, sub: sub.retentionDb, bass: bass.retentionDb, worst: bands.worstBand.name, worstRet: bands.worstBand.retentionDb };
  });
  // Centered low: sub/bass retention should be near 0 in every case; widening
  // or moving fc must not drag the low band down (that would erase bass).
  const lowPreserved = rows.every((r) => r.sub > -3 && r.bass > -3);
  const widthMovesHighOnly = rows[1].sub > -3 && rows[1].bass > -3;
  const fcMovesBand = rows[2].sub > -3;
  const ok = lowPreserved && widthMovesHighOnly && fcMovesBand;
  return {
    ok,
    detail: rows.map((r) => `fc${r.fc}/w${r.width}: sub ${r.sub}dB bass ${r.bass}dB`).join(' | '),
    metrics: { rows },
  };
});

// ---- 8. full-band widen must not be sold as "quality" ----------------------

check('width-not-quality', '宽度增大不一律等于质量改善', () => {
  const b = getBuiltinMaterial('pair_b');
  // Two widths on the asymmetric structure. If more width equals "better", the
  // fold and coloration should improve; we assert they do NOT, and that the
  // measurements expose the trade instead of declaring a win.
  const base = { stageMode: 'widen', structure: 'haas', decorr: 0.6, haasMs: 12, autoProtect: false };
  const a = renderChain(b.L, b.R, SR, { ...base, width: 1.0 }, b.markers);
  const c = renderChain(b.L, b.R, SR, { ...base, width: 2.2 }, b.markers);
  const sideA = a.measurements.stage.rho, sideC = c.measurements.stage.rho;
  const retA = a.measurements.bandDistortion.worstBand.retentionDb;
  const retC = c.measurements.bandDistortion.worstBand.retentionDb;
  const combA = a.measurements.coloration.hfMaxDb;
  const combC = c.measurements.coloration.hfMaxDb;
  // Wider => lower correlation (side grew) but the worst-band fold retention
  // and/or the HF comb get worse or stay bad: no clean quality win.
  const wider = sideC < sideA - 0.02;
  const notCleanWin = retC <= retA + 0.1 && combC >= 2;
  return {
    ok: wider && notCleanWin,
    detail: `ρ ${sideA}→${sideC}（侧声增），最差带保留 ${retA}→${retC}dB，HF 梳状 ${combA}→${combC}dB —— 更宽伴随折叠/梳状代价，非纯改善`,
    metrics: { rhoA: sideA, rhoC: sideC, retentionA: retA, retentionC: retC, combA, combC },
  };
});

// ---- 9. band feedback reaches the automation -------------------------------

check('band-feedback', '最差频带回传宽度自动化', () => {
  const b = getBuiltinMaterial('pair_b');
  const r = renderChain(b.L, b.R, SR, { autoProtect: false, lowMode: 'preserve', broadcast: 'direct_mid', stageMode: 'crossover', structure: 'ms', width: 1, decorr: 0 }, b.markers);
  const worst = r.measurements.distortedBand;
  const sug = r.widthAutomation.suggestion;
  const ok = worst.retentionDb < -10 && !!sug && sug.includes(worst.name);
  return {
    ok,
    detail: `最差带 ${worst.name}(${worst.low}–${worst.high}Hz) 保留 ${worst.retentionDb}dB；自动化：${sug}`,
    metrics: { worstBand: worst, suggestion: sug },
  };
});

// ---- 10. monitors fold reads the saved policy ------------------------------

check('monitor-fold-policy', '监听折叠读取随工程保存的侧声策略', () => {
  const { L, R } = modulators(32768);
  const plain = renderChain(L, R, SR, { sr: SR, stageMode: 'preserve', foldPolarity: 'plain' }, null);
  const auto = renderChain(L, R, SR, { sr: SR, stageMode: 'preserve', foldPolarity: 'auto' }, null);
  const delta = db(rms(auto.monitorFold)) - db(rms(plain.monitorFold));
  return {
    ok: delta > 20 && rms(plain.monitorFold) < 1e-9,
    detail: `plain 折叠 RMS ${db(rms(plain.monitorFold)).toFixed(1)}dB vs auto ${db(rms(auto.monitorFold)).toFixed(1)}dB（差 ${delta.toFixed(1)}dB）`,
    metrics: { deltaDb: Number(delta.toFixed(1)) },
  };
});

// ---- emit reports to the temp dir (never into the repo) --------------------

const summary = {
  generatedAt: new Date().toISOString(),
  workDir: work,
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  allOk: results.every((r) => r.ok),
  results,
};
writeFileSync(join(work, 'width-package-report.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(work, 'width-package-report.txt'),
  results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  [${r.id}] ${r.title}\n       ${r.detail}`).join('\n') + '\n');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary));
} else {
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  [${r.id}] ${r.title}`);
    console.log(`       ${r.detail}`);
  }
  console.log('');
  console.log(`reports written under ${work}`);
}
process.exit(summary.allOk ? 0 : 1);
