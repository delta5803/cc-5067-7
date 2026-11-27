#!/usr/bin/env node
// Maintenance check: proves the compatibility doc and its cited samples still
// match the implementation. Nothing here trusts hand-edited numbers — every
// value is recomputed from the production DSP.
//
//   node test/maintenance-check.mjs            (human output)
//   node test/maintenance-check.mjs --json     (machine summary)
//
// Checks:
//   A. doc constants (defaults, contract facts) match code within tolerance
//   B. committed samples regenerate byte-for-byte from code
//   C. committed evidence JSON matches a fresh measurement
//   D. fold response + per-band coherence reproduce under a clean measurement

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvidence } from './width-evidence.mjs';
import { encodeWav16Node } from './wav-node.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DOC = join(root, 'doc', 'stereo-width-compatibility.md');
const SAMPLES = join(root, 'doc', 'samples');

const results = [];
function add(id, ok, detail, extra = {}) { results.push({ id, ok, detail, ...extra }); }

const ev = buildEvidence();

// ---- A. doc citation check --------------------------------------------------
function approx(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= tol; }

if (!existsSync(DOC)) {
  add('doc-exists', false, '缺少文档 ' + DOC);
} else {
  const doc = readFileSync(DOC, 'utf8');
  const cite = (tag) => {
    const m = doc.match(new RegExp('\\[%' + tag + '%\\]\\s*([-+0-9.]+)'));
    return m ? Number(m[1]) : null;
  };
  const want = [
    ['ap-max-dev-db', ev.decorrelators.allpassMaxMagDevDb, 0.6],
    ['ap-phase-span-rad', ev.decorrelators.allpassPhaseSpanRad, 3],
    ['delay-command-samples', ev.decorrelators.delayCommandSamples, 0],
    ['phase-delta-vs-channel-db', ev.phaseSample.deltaVsChannelDb, 2],
    ['band-low-rho', ev.bandSample.lowRho, 0.05],
    ['band-high-rho', ev.bandSample.highRho, 0.05],
    ['antiphase-worst-retention-db', ev.antiPhaseFold.preserveWorstRetentionDb, 1.0],
    ['center-worst-retention-db', ev.antiPhaseFold.centerWorstRetentionDb, 1.0],
    ['symmetric-fold-mid-delta-db', ev.powerAccounts.symmetricFoldMidDeltaDb, 0.05],
    ['haas-balance-db', ev.powerAccounts.haasBalanceDb, 0.5],
  ];
  const missing = [], bad = [];
  for (const [tag, codeVal, tol] of want) {
    const docVal = cite(tag);
    if (docVal === null) missing.push(tag);
    else if (!approx(docVal, codeVal, tol)) bad.push(`${tag}: doc=${docVal} code=${codeVal}`);
  }
  add('doc-cites', missing.length === 0 && bad.length === 0,
    missing.length ? '缺少标记: ' + missing.join(', ') : bad.length ? '不一致: ' + bad.join('; ') : `全部 ${want.length} 个引用与实现一致`,
    { missing, bad });
}

// ---- B. committed samples regenerate byte-for-byte --------------------------
const regen = mkdtempSync(join(tmpdir(), 'sw-regen-'));
try {
  for (const [, s] of Object.entries(ev.samples)) {
    writeFileSync(join(regen, s.name), encodeWav16Node(s.L, s.R, ev.sampleRate));
  }
  const sampleRows = [];
  let allMatch = true;
  for (const [, s] of Object.entries(ev.samples)) {
    const committed = join(SAMPLES, s.name);
    if (!existsSync(committed)) { sampleRows.push(`${s.name}: 缺失`); allMatch = false; continue; }
    const a = readFileSync(committed);
    const b = readFileSync(join(regen, s.name));
    const same = a.length === b.length && a.equals(b);
    if (!same) allMatch = false;
    sampleRows.push(`${s.name}: ${same ? '一致' : '不一致(' + a.length + '/' + b.length + ')'}`);
  }
  add('samples-regen', allMatch, sampleRows.join('; '));
} finally {
  rmSync(regen, { recursive: true, force: true });
}

// ---- C. committed evidence JSON matches fresh measurement -------------------
const evPath = join(SAMPLES, 'width-evidence.json');
if (!existsSync(evPath)) {
  add('evidence-json', false, '缺少 width-evidence.json');
} else {
  const committed = JSON.parse(readFileSync(evPath, 'utf8'));
  const fresh = buildEvidence();
  const diffs = [];
  const cmp = (path, a, b, tol) => {
    if (typeof a === 'number' && typeof b === 'number') {
      if (Math.abs(a - b) > tol) diffs.push(`${path}: ${a} vs ${b}`);
    } else if (a && b && typeof a === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (k === 'samples') continue;
        cmp(path + '.' + k, a[k], b[k], tol);
      }
    } else if (a !== b) diffs.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  };
  cmp('evidence', committed, {
    ...fresh,
    samples: undefined,
    generatedFrom: committed.generatedFrom, // provenance string, not a measurement
  }, 0.05);
  add('evidence-json', diffs.length === 0, diffs.length ? '漂移: ' + diffs.slice(0, 6).join(' | ') : 'committed 证据与现测一致');
}

// ---- D. fold response + per-band coherence reproduce ------------------------
{
  const ev2 = buildEvidence();
  const foldStable =
    Math.abs(ev2.antiPhaseFold.preserveWorstRetentionDb - ev.antiPhaseFold.preserveWorstRetentionDb) < 1e-9;
  const bandStable = ev2.bandSample.lowRho < -0.5 && ev2.bandSample.highRho > 0.3;
  const structureExact = await structureFoldExact();
  add('fold-coherence', foldStable && bandStable && structureExact,
    `保留带 ${ev2.antiPhaseFold.preserveWorstBand} ${ev2.antiPhaseFold.preserveWorstRetentionDb}dB 复测稳定=${foldStable}；` +
    `分频相关低/高=${ev2.bandSample.lowRho}/${ev2.bandSample.highRho}；对称折叠精确=${structureExact}`);
}

async function structureFoldExact() {
  const { processStage, msDecode } = await import(new URL('../web/js/dsp/pipeline.js', import.meta.url).href);
  const { mulberry32 } = await import(new URL('../web/js/audio/materials.js', import.meta.url).href);
  const n = 16384;
  const rnd = mulberry32(5);
  const M = new Float64Array(n), S = new Float64Array(n);
  for (let i = 0; i < n; i++) { M[i] = 0.3 * (rnd() * 2 - 1); S[i] = 0.25 * (rnd() * 2 - 1); }
  const { L, R } = msDecode(M, S);
  for (const structure of ['ms', 'ap', 'delay']) {
    const st = processStage(L, R, { sr: ev.sampleRate, stageMode: 'widen', structure, width: 1.6, decorr: 0.6, delayMs: 7 }, { cls: 'normal' });
    for (let i = 0; i < n; i++) {
      const fold = 0.5 * (st.L[i] + st.R[i]);
      if (Math.abs(fold - M[i]) > 1e-12) return false;
    }
  }
  return true;
}

// ---- report -----------------------------------------------------------------
const summary = {
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  allOk: results.every((r) => r.ok),
  results,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary));
} else {
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  [${r.id}] ${r.detail}`);
  }
  console.log('');
  console.log(summary.allOk ? `维护检查通过 (${summary.passed}/${summary.total})` : `${summary.passed}/${summary.total} 通过`);
}
process.exit(summary.allOk ? 0 : 1);
