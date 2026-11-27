// Shared, DOM-free evidence builder. Runs the real chain to produce the numbers
// the compatibility doc cites. Used by gen-width-samples.mjs (to emit files) and
// maintenance-check.mjs (to recompute independently). Never reads hand-edited
// numbers: every value here is measured at call time.

import { renderChain } from '../web/js/chain.js';
import { getBuiltinMaterial } from '../web/js/audio/materials.js';
import { DEFAULT_CONFIG, POLICY_FIELDS } from '../web/js/config.js';
import {
  DECORRELATOR_CONTRACT, buildPhaseSample, buildBandSample, foldPolarityAware,
  bandCorrelationEvidence, decorrelatorEvidence, powerAccounts, bandEdges,
} from '../web/js/dsp/contract.js';
import { processStage, msEncode, msDecode } from '../web/js/dsp/pipeline.js';
import { rms, db } from '../web/js/analysis/measure.js';
import { mulberry32 } from '../web/js/audio/materials.js';

export const SR = 48000;

function noise(n, seed, amp = 0.3) {
  const rnd = mulberry32(seed);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * (rnd() * 2 - 1);
  return x;
}

const r4 = (v) => Number(Number(v).toFixed(4));
const r2 = (v) => Number(Number(v).toFixed(2));

export function buildEvidence() {
  const pairA = getBuiltinMaterial('pair_a');
  const pairB = getBuiltinMaterial('pair_b');

  // 1. Defaults that the doc's preset table must reproduce.
  const defaults = {};
  for (const key of POLICY_FIELDS) defaults[key] = DEFAULT_CONFIG[key];

  // 2. Decorrelator IR facts.
  const decorr = decorrelatorEvidence(SR);

  // 3. Executable phase/frequency samples.
  const phaseSample = buildPhaseSample(SR, 0.5, 80, 0.5);
  const phaseFold = foldPolarityAware(phaseSample.L, phaseSample.R, SR);
  const bandSample = buildBandSample(SR, 1.0);
  const bandEv = bandCorrelationEvidence(bandSample.L, bandSample.R, 180, SR);

  // 4. Fold response + correlation for the matched pair (the anti-phase set).
  const bPreserve = renderChain(pairB.L, pairB.R, SR, {
    sr: SR, autoProtect: false, lowMode: 'preserve', broadcast: 'direct_mid',
    stageMode: 'crossover', structure: 'ms', width: 1, decorr: 0,
  }, pairB.markers);
  const bCenter = renderChain(pairB.L, pairB.R, SR, {
    sr: SR, autoProtect: false, lowMode: 'center', broadcast: 'direct_mid',
    stageMode: 'crossover', structure: 'ms', width: 1, decorr: 0,
  }, pairB.markers);

  // 5. Dual power accounts: symmetric widen vs asymmetric Haas.
  const n = 65536;
  const { L, R } = msDecode(noise(n, 7, 0.35), noise(n, 8, 0.3));
  const sym = processStage(L, R, { sr: SR, stageMode: 'widen', structure: 'ms', width: 1.8, decorr: 0, centerLock: false }, { cls: 'normal' });
  const haas = processStage(L, R, { sr: SR, stageMode: 'widen', structure: 'haas', width: 1, decorr: 0.9, haasMs: 12 }, { cls: 'normal' });
  const accSym = powerAccounts(sym.L, sym.R, SR);
  const accHaas = powerAccounts(haas.L, haas.R, SR);

  // 6. Width-is-not-quality: two widths on the asymmetric structure.
  const wBase = { stageMode: 'widen', structure: 'haas', decorr: 0.6, haasMs: 12, autoProtect: false };
  const wNarrow = renderChain(pairB.L, pairB.R, SR, { ...wBase, width: 1.0 }, pairB.markers);
  const wWide = renderChain(pairB.L, pairB.R, SR, { ...wBase, width: 2.2 }, pairB.markers);

  const worstPreserve = bPreserve.measurements.bandDistortion.worstBand;
  const worstCenter = bCenter.measurements.bandDistortion.worstBand;

  return {
    sampleRate: SR,
    generatedFrom: 'web/js/ (production DSP, read-only)',
    defaults,
    decorrelators: {
      allpassMaxMagDevDb: decorr.allpassMaxMagDevDb,
      allpassPhaseSpanRad: decorr.allpassPhaseSpanRad,
      delayCommandSamples: decorr.delayCommandSamples,
      delayPeakSample: decorr.delayPeakSample,
    },
    contract: DECORRELATOR_CONTRACT,
    bandEdges: bandEdges({ stageMode: 'crossover', crossover: true, fc: 180 }),
    phaseSample: {
      freq: phaseSample.freq,
      channelRmsDb: r2(db(rms(phaseSample.L))),
      plainFoldRmsDb: r2(phaseFold.plainFoldEnergyDb),
      deltaVsChannelDb: r2(phaseFold.plainFoldEnergyDb - db(rms(phaseSample.L))),
      polaritySign: phaseFold.sign,
    },
    bandSample: {
      fc: bandEv.fc,
      lowRho: bandEv.low.correlation,
      highRho: bandEv.high.correlation,
      lowEnergyL: bandEv.low.energyDbL,
      lowEnergyR: bandEv.low.energyDbR,
      highEnergyL: bandEv.high.energyDbL,
      highEnergyR: bandEv.high.energyDbR,
    },
    antiPhaseFold: {
      preserveWorstBand: worstPreserve.name,
      preserveWorstRetentionDb: worstPreserve.retentionDb,
      preserveWorstRho: worstPreserve.rho,
      centerWorstBand: worstCenter.name,
      centerWorstRetentionDb: worstCenter.retentionDb,
      pairBrho: bPreserve.measurements.stage.rho,
      pairBrhoBass: bPreserve.measurements.stage.rhoBass,
    },
    powerAccounts: {
      symmetricPerChannelEqual: accSym.perChannelEqual,
      symmetricFoldMidDeltaDb: r2(accSym.foldMidDeltaDb),
      haasBalanceDb: r2(accHaas.balanceDb),
    },
    widthNotQuality: {
      narrowRho: wNarrow.measurements.stage.rho,
      wideRho: wWide.measurements.stage.rho,
      narrowWorstRetentionDb: wNarrow.measurements.bandDistortion.worstBand.retentionDb,
      wideWorstRetentionDb: wWide.measurements.bandDistortion.worstBand.retentionDb,
      narrowHfMaxDb: wNarrow.measurements.coloration.hfMaxDb,
      wideHfMaxDb: wWide.measurements.coloration.hfMaxDb,
    },
    samples: {
      phase: { name: 'sample-phase-antiphase-80hz.wav', L: phaseSample.L, R: phaseSample.R },
      band: { name: 'sample-band-split-180hz.wav', L: bandSample.L, R: bandSample.R },
    },
  };
}

// Strip the raw buffers for a JSON-safe view.
export function evidenceForJson(ev) {
  const { samples, ...rest } = ev;
  return {
    ...rest,
    samples: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.name])),
  };
}
