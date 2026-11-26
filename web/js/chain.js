// Orchestrates one full render: policy analysis -> stage feed + broadcast
// mono feed -> measurements -> explainable warnings.

import { DEFAULT_CONFIG } from './config.js';
import { analyzeInput, measureRender, stereoResponseData, rms, db } from './analysis/measure.js';
import { processStage, processBroadcast, foldStereo } from './dsp/pipeline.js';
import { lowPass, lr4Split } from './dsp/crossover.js';
import { impulseSpectrum } from './dsp/fft.js';

export function renderChain(inputL, inputR, sampleRate, config = {}, markers = null) {
  const cfg = { ...DEFAULT_CONFIG, ...config, sr: sampleRate };
  const analysis = analyzeInput(inputL, inputR, sampleRate);

  const stage = processStage(inputL, inputR, cfg, analysis);
  const broadcast = processBroadcast(inputL, inputR, stage, cfg, analysis);
  const stageFold = foldStereo(stage);

  const n = inputL.length;
  const dryMid = new Float64Array(n);
  for (let i = 0; i < n; i++) dryMid[i] = 0.5 * (inputL[i] + inputR[i]);

  const measurements = measureRender({
    inputL, inputR,
    stageL: stage.L, stageR: stage.R,
    bcL: broadcast.L, bcR: broadcast.R,
    stageFold, dryMid,
    sr: sampleRate,
    markers,
  });

  // How much bass the standard M=(L+R)/2 fold loses vs one channel.
  const bassM = rms(lowPass(dryMid, 150, sampleRate, 4));
  const bassL = rms(lowPass(inputL, 150, sampleRate, 4));
  const bassR = rms(lowPass(inputR, 150, sampleRate, 4));
  measurements.input.lfMonoLossDb = Number((db(bassM) - db(Math.max(bassL, bassR))).toFixed(2));

  let clipCount = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(stage.L[i]) > 0.9995) clipCount++;
    if (Math.abs(stage.R[i]) > 0.9995) clipCount++;
  }
  measurements.stage.clipSamples = clipCount;

  const warnings = buildWarnings(cfg, analysis, measurements, stage.effective, broadcast.route);

  return {
    cfg, analysis, stage, broadcast, stageFold, dryMid,
    measurements, warnings,
    effective: { ...stage.effective, broadcastRoute: broadcast.route },
  };
}

function buildWarnings(cfg, a, m, eff, route) {
  const w = [];
  if (a.cls === 'mono') {
    w.push({
      level: 'info', code: 'policy_mono',
      text: '检测到纯单声道（ρ=' + a.rho + '）。S=0，单纯把宽度调大不会产生任何变化；必须加入全通/延迟去相关来生成侧声。',
    });
    if ((cfg.decorr ?? 0) < 0.02 && cfg.structure !== 'haas') {
      w.push({ level: 'warn', code: 'width_noop', text: '当前去相关量为 0：宽度增益对纯单声道无效，左右完全相同。' });
    }
  } else if (a.cls === 'correlated') {
    w.push({ level: 'info', code: 'policy_corr', text: '强相关素材（ρ=' + a.rho + '）：适合 M/S 扩宽，默认低频居中以保证单声道兼容。' });
  }

  if (a.rhoBass < -0.4) {
    const protectedLow = eff.lowMode === 'rescue' || route === 'phase_safe';
    w.push({
      level: protectedLow ? 'info' : 'danger',
      code: 'anti_phase_lf',
      text: protectedLow
        ? '检测到低频反相（ρ低频=' + a.rhoBass + '）。已启用相位安全路由/低频救援，单声道低音由 S 分量重建。'
        : '输入低频已反相（ρ低频=' + a.rhoBass + '），标准 (L+R)/2 折叠会抵消：测得低频折叠损失 ' + m.input.lfMonoLossDb + ' dB。可切换“相位安全单声道/救援低频”恢复。',
    });
  }

  if (m.coloration && (m.coloration.hfAvgDb >= 0.6 || m.coloration.hfMaxDb >= 4)) {
    w.push({
      level: 'warn', code: 'comb',
      text: '单声道折叠在 220Hz 以上出现可闻频谱偏差（平均 ' + m.coloration.hfAvgDb +
        ' dB / 峰值 ' + m.coloration.hfMaxDb + ' dB），来自延迟/Haas 的梳状或分频相位，并非“无损变宽”。',
    });
  }

  if (m.coloration && Math.abs(m.coloration.lowAvgDb) >= 2) {
    const rescue = eff.lowMode === 'rescue' || route === 'phase_safe';
    w.push({
      level: rescue ? 'info' : 'warn',
      code: 'low_synthesis',
      text: rescue
        ? '低频救援改变了折叠合成：相对原中轨平均变化 ' + m.coloration.lowAvgDb +
          ' dB（原 M 中反相低频处于抵消底噪）；LP/HP 重组平坦性与低频幅值已由自检复查。'
        : '分频低频合成相对原始中轨平均变化 ' + m.coloration.lowAvgDb + ' dB（峰值偏差 ' +
          m.coloration.lowMaxDb + ' dB）；已复查 LP/HP 重组与低频幅值。',
    });
  }

  if (Math.abs(m.stage.balanceDb) > 1.5) {
    w.push({ level: 'warn', code: 'balance', text: '左右 RMS 不平衡 ' + m.stage.balanceDb + ' dB：非对称 Haas 结构的能量偏移已量化在此。' });
  }

  if (m.stage.clipSamples > 0) {
    w.push({ level: 'danger', code: 'clip', text: '输出有 ' + m.stage.clipSamples + ' 个采样接近/超过满刻度，需要降低电平或宽度/湿声。' });
  }
  return w;
}

// Run the real stage chain on a delta impulse and return response curves.
export function measureImpulseResponse(config, sampleRate = 48000) {
  const cfg = { ...DEFAULT_CONFIG, ...config, sr: sampleRate };
  const n = 8192;
  const L = new Float64Array(n), R = new Float64Array(n);
  L[24] = 1; R[24] = 1;
  const analysis = analyzeInput(L, R, sampleRate);
  const stage = processStage(L, R, cfg, analysis);
  const resp = stereoResponseData(stage.L, stage.R, sampleRate);

  // Explicit crossover phase / reconstruction readout at the chosen fc.
  const xoDelta = new Float64Array(n);
  xoDelta[0] = 1;
  const xo = lr4Split(xoDelta, cfg.fc ?? 180, sampleRate);
  const xoSum = new Float64Array(n);
  for (let i = 0; i < n; i++) xoSum[i] = xo.lo[i] + xo.hi[i];
  const xoSpec = impulseSpectrum(xoSum, sampleRate, 16384);
  const xoNfft = 16384;
  const kFc = Math.round((cfg.fc ?? 180) * xoNfft / sampleRate);
  let reconMax = 0;
  for (let k = 2; k < xoSpec.freqs.length; k++) {
    const f = xoSpec.freqs[k];
    if (f >= 60 && f <= 12000) reconMax = Math.max(reconMax, Math.abs(xoSpec.magDb[k]));
  }
  resp.crossover = {
    fc: cfg.fc ?? 180,
    phaseAtFcRad: Number(Math.abs(xoSpec.phase[Math.min(kFc, xoSpec.phase.length - 1)]).toFixed(2)),
    reconMaxDevDb: Number(reconMax.toFixed(3)),
  };
  return resp;
}
