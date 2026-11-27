// Isomorphic requirement checks. Used by test/run.mjs (Node) and by the
// in-browser self-test panel. Every assertion runs the real DSP chain.

import { msEncode, msDecode, processStage, processBroadcast } from '../dsp/pipeline.js';
import { lr4Split } from '../dsp/crossover.js';
import { allpassImpulse, delayImpulse, delayInSamples } from '../dsp/decorrelator.js';
import { correlation, rms, db, energy } from '../analysis/measure.js';
import { renderChain } from '../chain.js';
import { getBuiltinMaterial, buildSweep, mulberry32 } from '../audio/materials.js';
import { fft, impulseSpectrum } from '../dsp/fft.js';
import {
  DECORRELATOR_CONTRACT, powerAccounts, foldPolarityAware,
  bandCorrelationEvidence, decorrelatorEvidence, buildPhaseSample, buildBandSample,
} from '../dsp/contract.js';

const SR = 48000;

function maxAbsDiff(x, y) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]));
  return m;
}

function tone(n, sr, f, amp = 0.4) {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr);
  return x;
}

function noise(n, seed = 1, amp = 0.3) {
  const rnd = mulberry32(seed);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * (rnd() * 2 - 1);
  return x;
}

function stereoFromMS(M, S) {
  const { L, R } = msDecode(M, S);
  return { L, R };
}

export const CHECKS = [
  {
    id: 'ms_identity',
    title: 'M/S 矩阵编码-解码恒等',
    run() {
      const n = 4096;
      const L = noise(n, 11, 0.5);
      const R = noise(n, 22, 0.5);
      const { M, S } = msEncode(L, R);
      const back = msDecode(M, S);
      const err = Math.max(maxAbsDiff(L, back.L), maxAbsDiff(R, back.R));
      return {
        ok: err < 1e-12,
        detail: '随机立体声经 M/S 再解码的最大采样误差 ' + err.toExponential(2),
        metrics: { maxError: Number(err.toExponential(3)) },
      };
    },
  },

  {
    id: 'branch_real_not_swap_or_mute',
    title: '真实处理：不是交换左右，也不是单声道静音把戏',
    run() {
      const n = 8192;
      const L = tone(n, SR, 440, 0.5);
      const R = tone(n, SR, 660, 0.5);
      const cfg = { sr: SR, stageMode: 'widen', structure: 'ap', width: 1.6, decorr: 0.6 };
      const st = processStage(L, R, cfg, { cls: 'normal' });
      const swapErr = maxAbsDiff(st.L, R); // if L'≈R it would look like a swap
      const rmsL = rms(st.L), rmsR = rms(st.R);
      const bothActive = db(rmsL) > -35 && db(rmsR) > -35;
      const notSwap = swapErr > 0.05;
      const ok = bothActive && notSwap;
      return {
        ok,
        detail: '处理后左右 RMS=' + db(rmsL).toFixed(1) + '/' + db(rmsR).toFixed(1) +
          ' dB，L 与原 R 的差异 ' + swapErr.toFixed(3) + '（>0.05 排除换通道）',
        metrics: { rmsL: db(rmsL).toFixed(2), rmsR: db(rmsR).toFixed(2), diffFromSwap: Number(swapErr.toFixed(4)) },
      };
    },
  },

  {
    id: 'width_side_only',
    title: '宽度增益只改变侧声，不改变中轨/折叠单声道',
    run() {
      const n = 65536;
      const M = noise(n, 3, 0.35);
      const S = noise(n, 4, 0.3);
      const { L, R } = stereoFromMS(M, S);
      const rows = [];
      let prevSide = -1, prevRho = 2;
      let monoFoldErrMax = 0;
      for (const width of [0, 0.5, 1, 1.5, 2]) {
        const cfg = { sr: SR, stageMode: 'widen', structure: 'ms', width, decorr: 0, centerLock: false };
        const st = processStage(L, R, cfg, { cls: 'normal' });
        const enc = msEncode(st.L, st.R);
        let eS = 0;
        for (let i = 0; i < n; i++) eS += enc.S[i] * enc.S[i];
        const rho = correlation(st.L, st.R);
        const fold = new Float64Array(n);
        for (let i = 0; i < n; i++) fold[i] = 0.5 * (st.L[i] + st.R[i]);
        monoFoldErrMax = Math.max(monoFoldErrMax, maxAbsDiff(fold, M));
        rows.push({ width, sideEnergy: Number(eS.toFixed(1)), rho: Number(rho.toFixed(4)) });
        if (width > 0) {
          if (!(eS >= prevSide * 0.999)) throw new Error('side energy not monotonic at width ' + width);
          if (!(rho <= prevRho + 1e-9)) throw new Error('correlation not decreasing at width ' + width);
        }
        prevSide = eS; prevRho = rho;
      }
      const ratio4 = rows[4].sideEnergy / rows[2].sideEnergy; // w=2 vs w=1 -> 4
      const ok = rows[0].rho > 0.999 && monoFoldErrMax < 1e-12 && Math.abs(ratio4 - 4) < 0.02;
      return {
        ok,
        detail: '宽度 0→2 时侧声能量单调上升、ρ 单调下降；折叠=M 误差 ' +
          monoFoldErrMax.toExponential(1) + '；E_S(2)/E_S(1)=' + ratio4.toFixed(3) + '（理论 4）',
        metrics: { rows, foldError: Number(monoFoldErrMax.toExponential(2)), energyRatio: Number(ratio4.toFixed(3)) },
      };
    },
  },

  {
    id: 'pure_mono_policy',
    title: '纯单声道政策：宽度增益无效，去相关才产生真实侧声',
    run() {
      const n = 65536;
      const x = noise(n, 5, 0.4);
      // shape it a little so it is not full-band white
      const mono = x;
      const cfgNoop = { sr: SR, stageMode: 'widen', structure: 'ms', width: 2.5, decorr: 0 };
      const noop = renderChain(mono, mono, SR, cfgNoop, null);
      const noopErr = Math.max(maxAbsDiff(noop.stage.L, mono), maxAbsDiff(noop.stage.R, mono));

      const cfgAp = { sr: SR, stageMode: 'widen', structure: 'ap', width: 1, decorr: 0.7, centerLock: true };
      const ap = renderChain(mono, mono, SR, cfgAp, null);

      const cfgDl = { sr: SR, stageMode: 'widen', structure: 'delay', width: 1, decorr: 0.9, delayMs: 11, centerLock: true };
      const dl = renderChain(mono, mono, SR, cfgDl, null);

      const classifiedMono = noop.analysis.cls === 'mono';
      const ok = classifiedMono && noopErr < 1e-12 &&
        noop.measurements.stage.rho > 0.999 &&
        ap.measurements.stage.rho < 0.9 &&
        Math.abs(ap.measurements.stage.balanceDb) < 0.3 &&
        dl.measurements.stage.rho < 0.97;
      return {
        ok,
        detail: '分类=' + noop.analysis.cls + '；宽度 250%/0 去相关时样本误差 ' + noopErr.toExponential(1) +
          '、ρ=' + noop.measurements.stage.rho + '；全通 0.7 后 ρ=' + ap.measurements.stage.rho +
          '、平衡 ' + ap.measurements.stage.balanceDb + ' dB；延迟后 ρ=' + dl.measurements.stage.rho,
        metrics: {
          noopError: Number(noopErr.toExponential(2)),
          rhoWidthOnly: noop.measurements.stage.rho,
          rhoAllpass: ap.measurements.stage.rho,
          balanceAllpassDb: ap.measurements.stage.balanceDb,
          rhoDelay: dl.measurements.stage.rho,
        },
      };
    },
  },

  {
    id: 'matched_rho_pair',
    title: '等总相关双版本：一版低频反相，总 ρ 相同而低频 ρ 两极',
    run() {
      const a = getBuiltinMaterial('pair_a');
      const b = getBuiltinMaterial('pair_b');
      const info = a.rhoInfo;
      const rhoDiff = Math.abs(info.rhoA - info.rhoB);

      const midA = new Float64Array(a.L.length), midB = new Float64Array(b.L.length);
      for (let i = 0; i < a.L.length; i++) {
        midA[i] = 0.5 * (a.L[i] + a.R[i]);
        midB[i] = 0.5 * (b.L[i] + b.R[i]);
      }
      const bassA = rms(lowpassProxy(midA, SR));
      const bassB = rms(lowpassProxy(midB, SR));
      const bassDelta = db(bassA) - db(bassB);

      const ok = rhoDiff < 2e-3 && info.rhoBassA > 0.95 && info.rhoBassB < -0.95 && bassDelta > 15;
      return {
        ok,
        detail: 'ρA=' + info.rhoA + '，ρB=' + info.rhoB + '（差 ' + rhoDiff.toExponential(1) +
          '）；低频 ρ=' + info.rhoBassA + ' / ' + info.rhoBassB +
          '；标准中轨低频幅值 A 比 B 高 ' + bassDelta.toFixed(1) + ' dB —— 单个总相关读数无法区分二者。',
        metrics: { ...info, rhoDifference: Number(rhoDiff.toExponential(2)), midBassDeltaDb: Number(bassDelta.toFixed(2)) },
      };
    },
  },

  {
    id: 'routing_marker_branches',
    title: '两路取流 + 字头/低音探针检验路由分支',
    run() {
      const probe = getBuiltinMaterial('probe_ok');
      const flip = getBuiltinMaterial('probe_flip');
      const rows = [];

      // Branch 1: discrete mid, must be sample exact and transient aligned.
      const cfgMid = { sr: SR, broadcast: 'direct_mid', stageMode: 'widen', structure: 'ms', width: 1.4 };
      const rMid = renderChain(probe.L, probe.R, SR, cfgMid, probe.markers);
      const midExact = maxAbsDiff(rMid.broadcast.mono, rMid.dryMid) < 1e-13;
      rows.push(branchRow('独立中轨直送', rMid.measurements.markers.broadcast));

      // Branch 2: phase-safe rescue on anti-phase bass.
      const cfgSafe = { sr: SR, broadcast: 'phase_safe', lowMode: 'rescue', stageMode: 'crossover' };
      const rSafeFlip = renderChain(flip.L, flip.R, SR, cfgSafe, flip.markers);
      const rSafeOk = renderChain(probe.L, probe.R, SR, cfgSafe, probe.markers);
      const rMidFlip = renderChain(flip.L, flip.R, SR, { sr: SR, broadcast: 'direct_mid' }, flip.markers);
      const rescueDb = rSafeFlip.measurements.markers.broadcast.bassAmpDb -
        rMidFlip.measurements.markers.broadcast.bassAmpDb;
      const rescueShown = rescueDb > 60 ? '>' + 60 : rescueDb.toFixed(1);
      const rescueToneMatch = Math.abs(
        rSafeFlip.measurements.markers.broadcast.bassAmpDb -
        rSafeOk.measurements.markers.broadcast.bassAmpDb);
      rows.push(branchRow('相位安全(反相版)', rSafeFlip.measurements.markers.broadcast));
      rows.push(branchRow('独立中轨(反相版)', rMidFlip.measurements.markers.broadcast));

      // Branch 3: asymmetric Haas fold, smear + comb must show.
      const cfgHaas = {
        sr: SR, broadcast: 'fold_stage', stageMode: 'widen',
        structure: 'haas', decorr: 0.9, haasMs: 12, width: 1.0, autoProtect: false,
      };
      const rHaas = renderChain(probe.L, probe.R, SR, cfgHaas, probe.markers);
      rows.push(branchRow('Haas 折叠', rHaas.measurements.markers.broadcast));
      const centroidShift = rHaas.measurements.markers.broadcast.consonantCentroidMs -
        rMid.measurements.markers.broadcast.consonantCentroidMs;
      const lateDelta = rHaas.measurements.markers.broadcast.consonantLateRatio -
        rMid.measurements.markers.broadcast.consonantLateRatio;
      const bassCombDelta = Math.abs(
        rHaas.measurements.markers.broadcast.bassAmpDb -
        rMid.measurements.markers.broadcast.bassAmpDb);

      // Branch 4: mono-safe all-pass crossover fold.
      const cfgAp = {
        sr: SR, broadcast: 'fold_stage', stageMode: 'crossover',
        structure: 'ap', decorr: 0.55, width: 1.3, autoProtect: false,
      };
      const rAp = renderChain(probe.L, probe.R, SR, cfgAp, probe.markers);
      const apBassDelta = Math.abs(
        rAp.measurements.markers.broadcast.bassAmpDb -
        rMid.measurements.markers.broadcast.bassAmpDb);

      // Simultaneous feeds: stage stays stereo, broadcast is dual mono.
      const simultaneous = rHaas.stage.L !== rHaas.stage.R &&
        maxAbsDiff(rHaas.broadcast.L, rHaas.broadcast.R) === 0;

      const ok = midExact &&
        Math.abs(rMid.measurements.markers.broadcast.consonantOffsetMs) <= 3 &&
        rescueDb > 12 && rescueToneMatch < 2.5 &&
        (centroidShift >= 1.5 || lateDelta >= 0.08) && bassCombDelta >= 2 &&
        apBassDelta < 1.5 && rAp.measurements.coloration.hfMaxDb < 2.5 &&
        simultaneous;

      return {
        ok,
        detail: '中轨直送逐样本相等、字头峰偏 ' +
          rMid.measurements.markers.broadcast.consonantOffsetMs + 'ms；反相版中轨低音 ' +
          rMidFlip.measurements.markers.broadcast.bassAmpDb + 'dB，相位安全 ' +
          rSafeFlip.measurements.markers.broadcast.bassAmpDb + 'dB（救援 ' + rescueShown +
          'dB，与同相版差 ' + rescueToneMatch.toFixed(1) +
          'dB）；Haas 字头质心 +' + centroidShift.toFixed(1) + 'ms/晚到比 +' + lateDelta.toFixed(2) +
          '、低音差 ' + bassCombDelta.toFixed(1) + 'dB；全通安全折叠低音差 ' + apBassDelta.toFixed(2) + 'dB。',
        metrics: {
          rows, rescueDb: Number(Math.min(rescueDb, 999).toFixed(2)), rescueDisplayDb: rescueDb > 60 ? '>60' : Number(rescueDb.toFixed(1)),
          centroidShiftMs: Number(centroidShift.toFixed(2)),
          lateDelta: Number(lateDelta.toFixed(3)),
          bassCombDeltaDb: Number(bassCombDelta.toFixed(2)),
          apBassDeltaDb: Number(apBassDelta.toFixed(2)),
        },
      };
    },
  },

  {
    id: 'crossover_recon',
    title: 'LR4 分频重组平坦、相位可测，低频合成复查',
    run() {
      const n = 16384;
      const delta = new Float64Array(n);
      delta[0] = 1;
      const { lo, hi } = lr4Split(delta, 180, SR);
      const sum = new Float64Array(n);
      for (let i = 0; i < n; i++) sum[i] = lo[i] + hi[i];
      const spec = impulseSpectrum(sum, SR, 16384);
      let maxDev = 0, phaseAtFc = null;
      for (let k = 2; k < spec.freqs.length; k++) {
        const f = spec.freqs[k];
        if (f >= 60 && f <= 12000) maxDev = Math.max(maxDev, Math.abs(spec.magDb[k]));
        if (phaseAtFc === null && f >= 178) phaseAtFc = Math.abs(spec.phase[k]);
      }

      // LF synthesis on real bass material.
      const a = getBuiltinMaterial('pair_a');
      const unity = renderChain(a.L, a.R, SR, {
        sr: SR, stageMode: 'crossover', structure: 'ms', width: 1, decorr: 0, lowMode: 'center',
      }, a.markers);
      const inBass = db(rms(lowpassProxy(a.L, SR, 150)));
      const outBass = db(rms(lowpassProxy(unity.stage.L, SR, 150)));
      const bassDelta = outBass - inBass;

      const flip = getBuiltinMaterial('pair_b');
      const rescue = renderChain(flip.L, flip.R, SR, {
        sr: SR, stageMode: 'crossover', lowMode: 'rescue', structure: 'ms', width: 1, decorr: 0,
      }, flip.markers);
      const rescueBass = db(rms(lowpassProxy(rescue.stage.L, SR, 150)));
      const rescueVsA = Math.abs(rescueBass - outBass);

      const ok = maxDev < 0.25 && bassDelta > -1.0 && rescueVsA < 2.0;
      return {
        ok,
        detail: 'LR4 LP+HP 重组幅度最大偏差 ' + maxDev.toFixed(3) + 'dB（60Hz–12k），fc 处合成相位≈' +
          (phaseAtFc ? phaseAtFc.toFixed(2) : '?') + 'rad；同相低音居中前后 RMS 差 ' + bassDelta.toFixed(2) +
          'dB；反相版救援后与同相版低音差 ' + rescueVsA.toFixed(2) + 'dB。',
        metrics: { reconstructionMaxDevDb: Number(maxDev.toFixed(3)), phaseAtFcRad: Number(phaseAtFc?.toFixed(2)), bassDeltaDb: Number(bassDelta.toFixed(2)), rescueMatchDb: Number(rescueVsA.toFixed(2)) },
      };
    },
  },

  {
    id: 'mag_phase_delay_separate',
    title: '幅度响应 / 相位差 / 延迟分别可测且与参数一致',
    run() {
      // All-pass network: flat magnitude, large phase excursion, ~0 bulk delay.
      const apIr = allpassImpulse(SR, 1, 4096);
      const apSpec = impulseSpectrum(apIr, SR, 4096);
      let apMaxDev = 0, phMin = 99, phMax = -99;
      for (let k = 1; k < apSpec.freqs.length; k++) {
        const f = apSpec.freqs[k];
        if (f >= 120 && f <= 10000) {
          apMaxDev = Math.max(apMaxDev, Math.abs(apSpec.magDb[k]));
          phMin = Math.min(phMin, apSpec.phase[k]);
          phMax = Math.max(phMax, apSpec.phase[k]);
        }
      }
      const phaseSpan = phMax - phMin;

      // Delay network: exact lag and linear phase slope.
      const ms = 7;
      const d = delayInSamples(ms, SR);
      const dlIr = delayImpulse(SR, ms, 4096);
      let peak = 0, peakIdx = -1;
      for (let i = 0; i < dlIr.length; i++) if (Math.abs(dlIr[i]) > peak) { peak = Math.abs(dlIr[i]); peakIdx = i; }
      let sumXY = 0, sumXX = 0;
      for (let k = 20; k < 400; k++) {
        const f = apSpec.freqs[k] ? (k * SR) / 4096 : 0;
        if (f < 200 || f > 2200) continue;
        const ph = impulseSpectrumPhaseAt(dlIr, SR, 4096, k);
        sumXY += k * ph; sumXX += k * k;
      }
      // phase[k] ~ -2*pi*d*k/N  => slope per bin
      const slope = sumXY / sumXX;
      const dEst = (-slope * 4096) / (2 * Math.PI);

      // Full chain side impulse must sit exactly at the commanded delay.
      const n = 8192;
      const dL = new Float64Array(n), dR = new Float64Array(n);
      dL[0] = 1; dR[0] = 1;
      const st = processStage(dL, dR, {
        sr: SR, stageMode: 'widen', structure: 'delay', width: 1,
        decorr: 0.8, delayMs: ms, centerLock: false,
      }, { cls: 'mono' });
      let sidePeak = 0, sideIdx = -1;
      for (let i = 1; i < n; i++) {
        const s = 0.5 * (st.L[i] - st.R[i]);
        if (Math.abs(s) > sidePeak) { sidePeak = Math.abs(s); sideIdx = i; }
      }

      const ok = apMaxDev < 0.6 && phaseSpan > 3 && peakIdx === d &&
        Math.abs(dEst - d) <= 1.5 && sideIdx === d;
      return {
        ok,
        detail: '全通链幅度偏差 <' + apMaxDev.toFixed(2) + 'dB、相位行程 ' + phaseSpan.toFixed(2) +
          'rad；延迟块峰值采样 ' + peakIdx + '（命令 ' + d + '），相位斜率估出 ' + dEst.toFixed(1) +
          ' 采样；整链侧声脉冲峰在 ' + sideIdx + '。',
        metrics: {
          apMagnitudeMaxDevDb: Number(apMaxDev.toFixed(3)),
          apPhaseSpanRad: Number(phaseSpan.toFixed(2)),
          delayCommandSamples: d, delayPeakSamples: peakIdx,
          delaySlopeEstimateSamples: Number(dEst.toFixed(2)),
          chainSidePeakSamples: sideIdx,
        },
      };
    },
  },

  {
    id: 'sweep_matches_impulse',
    title: '对数频率扫描经谱除法得到的响应与脉冲法一致',
    run() {
      const N = 131072;
      const sweep = buildSweep(SR, 1.7, 24, 19000);
      const cfg = { sr: SR, stageMode: 'widen', structure: 'ap', width: 1.2, decorr: 0.5, centerLock: false };
      const y = processStage(sweep.L, sweep.R, cfg, { cls: 'normal' }).L;

      const reX = new Float64Array(N), imX = new Float64Array(N);
      const reY = new Float64Array(N), imY = new Float64Array(N);
      const impL = new Float64Array(N); impL[0] = 1;
      const impR = new Float64Array(N); impR[0] = 1;
      const impOut = processStage(impL, impR, cfg, { cls: 'mono' });
      for (let i = 0; i < sweep.L.length; i++) { reX[i] = sweep.L[i]; reY[i] = y[i]; }
      fft(reX, imX); fft(reY, imY);

      const impSpec = impulseSpectrum(impOut.L, SR, N);
      let maxX = 0;
      for (let k = 1; k < N / 2; k++) maxX = Math.max(maxX, Math.hypot(reX[k], imX[k]));

      let sum = 0, cnt = 0, maxDiff = 0;
      for (let k = 2; k < N / 2; k++) {
        const f = (k * SR) / N;
        if (f < 300 || f > 6000) continue;
        const xm = Math.hypot(reX[k], imX[k]);
        if (xm < 0.04 * maxX) continue;
        const hr = (reY[k] * reX[k] + imY[k] * imX[k]) / (xm * xm);
        const hi = (imY[k] * reX[k] - reY[k] * imX[k]) / (xm * xm);
        const sweepDb = 20 * Math.log10(Math.hypot(hr, hi) + 1e-12);
        const d = Math.abs(sweepDb - impSpec.magDb[k]);
        sum += d; cnt++; maxDiff = Math.max(maxDiff, d);
      }
      const meanDiff = sum / Math.max(1, cnt);
      const ok = cnt > 100 && meanDiff < 1.2;
      return {
        ok,
        detail: '300–6k 有效频点 ' + cnt + ' 个，扫描谱除法与脉冲 FFT 幅度平均差 ' +
          meanDiff.toFixed(3) + 'dB、最大 ' + maxDiff.toFixed(2) + 'dB',
        metrics: { bins: cnt, meanDiffDb: Number(meanDiff.toFixed(3)), maxDiffDb: Number(maxDiff.toFixed(2)) },
      };
    },
  },

  {
    id: 'energy_center_accounting',
    title: '能量恒等式与声像中心偏移可量化',
    run() {
      const n = 65536;
      const mono = noise(n, 9, 0.4);
      const cfg = { sr: SR, stageMode: 'widen', structure: 'ap', width: 1.2, decorr: 0.55, centerLock: true };
      const r = renderChain(mono, mono, SR, cfg, null);
      const L = r.stage.L, R = r.stage.R;
      const eLR = energy(L) + energy(R);
      let eM = 0, eS = 0;
      for (let i = 0; i < n; i++) {
        const m = 0.5 * (L[i] + R[i]), s = 0.5 * (L[i] - R[i]);
        eM += m * m; eS += s * s;
      }
      const identityErr = Math.abs(eLR - 2 * (eM + eS)) / eLR;
      const bal = r.measurements.stage.balanceDb;
      const foldErr = maxAbsDiff(r.stageFold, r.dryMid);
      const ok = identityErr < 1e-10 && Math.abs(bal) < 0.3 && foldErr < 1e-12;
      return {
        ok,
        detail: 'E_L+E_R=2(E_M+E_S) 相对误差 ' + identityErr.toExponential(1) +
          '；左右平衡 ' + bal + 'dB；安全拓扑折叠=(L+R)/2 与 dry M 误差 ' + foldErr.toExponential(1),
        metrics: { identityError: Number(identityErr.toExponential(2)), balanceDb: bal, foldError: Number(foldErr.toExponential(2)) },
      };
    },
  },

  {
    id: 'expose_cancellation_comb',
    title: '暴露低频抵消与梳状变化，不宣称无损',
    run() {
      const b = getBuiltinMaterial('pair_b');
      const rCancel = renderChain(b.L, b.R, SR, {
        sr: SR, autoProtect: false, lowMode: 'center', broadcast: 'direct_mid',
        stageMode: 'crossover', structure: 'ap', decorr: 0.3,
      }, b.markers);
      const cancelWarned = rCancel.warnings.some((w) => w.code === 'anti_phase_lf' && w.level === 'danger');
      const loss = rCancel.measurements.input.lfMonoLossDb;

      const x = noise(65536, 13, 0.4);
      const rComb = renderChain(x, x, SR, {
        sr: SR, broadcast: 'fold_stage', stageMode: 'widen',
        structure: 'haas', decorr: 1, haasMs: 11, width: 1, autoProtect: false,
      }, null);
      const combWarned = rComb.warnings.some((w) => w.code === 'comb');
      const hfMax = rComb.measurements.coloration.hfMaxDb;

      const ok = loss < -12 && cancelWarned && hfMax >= 3 && combWarned;
      return {
        ok,
        detail: '反相素材未保护时低频折叠损失 ' + loss + 'dB 并给出危险警告=' + cancelWarned +
          '；Haas 折叠高频频谱最大偏差 ' + hfMax + 'dB 并给出梳状警告=' + combWarned,
        metrics: { lfMonoLossDb: loss, cancelWarned, hfColorationMaxDb: hfMax, combWarned },
      };
    },
  },

  {
    id: 'dual_power_accounts',
    title: '双口径：各声道功率相等 与 合并后声能相等，并复核极性',
    run() {
      // Account 1 vs account 2 on a symmetric widen: L/R stay equal, fold keeps M.
      const n = 65536;
      const M = noise(n, 21, 0.35);
      const S = noise(n, 22, 0.3);
      const { L, R } = stereoFromMS(M, S);
      const st = processStage(L, R, {
        sr: SR, stageMode: 'widen', structure: 'ms', width: 1.8, decorr: 0, centerLock: false,
      }, { cls: 'normal' });
      const acc = powerAccounts(st.L, st.R, SR);
      const perChannelEqual = acc.perChannelEqual;                 // E_L ≈ E_R
      const foldKeepsMid = Math.abs(acc.foldMidDeltaDb) < 0.01;    // E_fold ≈ E_M

      // Asymmetric Haas: per-channel power equality must NOT be assumed, while
      // the fold-energy account is what actually moves. The two accounts differ.
      const stHaas = processStage(L, R, {
        sr: SR, stageMode: 'widen', structure: 'haas', width: 1, decorr: 0.9, haasMs: 12,
      }, { cls: 'normal' });
      const accHaas = powerAccounts(stHaas.L, stHaas.R, SR);
      const accountsDiverge = Math.abs(accHaas.balanceDb) > 0.5;

      // Polarity: an inverted channel must be detected, and the corrected fold
      // must recover real energy instead of reading as a total collapse.
      const toneL = tone(n, SR, 110, 0.5);
      const toneR = new Float64Array(n);
      for (let i = 0; i < n; i++) toneR[i] = -toneL[i];
      const pol = foldPolarityAware(toneL, toneR, SR);

      const ok = perChannelEqual && foldKeepsMid && accountsDiverge &&
        pol.polarityReversed && pol.energyRecoveredDb > 20;
      return {
        ok,
        detail: '对称扩宽 E_L≈E_R=' + perChannelEqual + '、折叠=M 偏差 ' + acc.foldMidDeltaDb.toFixed(2) +
          'dB；Haas 左右平衡 ' + accHaas.balanceDb.toFixed(2) + 'dB（两口径确实分离）；' +
          '反相输入被判定=' + pol.polarityReversed + '，极性校正折叠回收 ' + pol.energyRecoveredDb.toFixed(1) + 'dB。',
        metrics: {
          perChannelEqual, foldMidDeltaDb: acc.foldMidDeltaDb,
          haasBalanceDb: accHaas.balanceDb, polarityReversed: pol.polarityReversed,
          energyRecoveredDb: Number(pol.energyRecoveredDb.toFixed(2)),
        },
      };
    },
  },

  {
    id: 'phase_freq_samples',
    title: '相位/频率样例可执行：反相与分频带抵消风险可复核',
    run() {
      const phase = buildPhaseSample(SR, 0.5, 80, 0.5);
      const plain = foldPolarityAware(phase.L, phase.R, SR);
      // Full inversion ⇒ plain fold collapses far below either channel.
      const plainVsChanDb = plain.plainFoldEnergyDb - db(rms(phase.L));

      const band = buildBandSample(SR, 1.0);
      const ev = bandCorrelationEvidence(band.L, band.R, 180, SR);
      const lowCancels = ev.low.correlation < -0.9;
      const highKeeps = ev.high.correlation > 0.5;

      const ok = plainVsChanDb < -20 && lowCancels && highKeeps;
      return {
        ok,
        detail: '80Hz 反相正弦标准折叠比单声道低 ' + plainVsChanDb.toFixed(1) +
          'dB（完全抵消）；分频样例低带 ρ=' + ev.low.correlation + '（抵消）、高带 ρ=' +
          ev.high.correlation + '（保持）——风险只在分频点以下。',
        metrics: {
          phaseFoldVsChanDb: Number(plainVsChanDb.toFixed(2)),
          bandLowRho: ev.low.correlation, bandHighRho: ev.high.correlation,
        },
      };
    },
  },

  {
    id: 'band_feedback_and_monitor_fold',
    title: '失真频带回传宽度自动化；监听折叠读取工程侧声策略',
    run() {
      const b = getBuiltinMaterial('pair_b');
      // Unprotected preserve-low on anti-phase bass: sub band must be the
      // reported worst band, and the automation suggestion must name it.
      const rRaw = renderChain(b.L, b.R, SR, {
        sr: SR, autoProtect: false, lowMode: 'preserve', broadcast: 'direct_mid',
        stageMode: 'crossover', structure: 'ms', width: 1, decorr: 0,
      }, b.markers);
      const rawWorst = rRaw.measurements.distortedBand;
      const rawSuggest = rRaw.widthAutomation.suggestion;
      const named = !!rawSuggest && rawSuggest.includes(rawWorst.name + '(');

      // Centered-low policy must protect the sub band: retention rises sharply.
      const rCenter = renderChain(b.L, b.R, SR, {
        sr: SR, autoProtect: false, lowMode: 'center', broadcast: 'direct_mid',
        stageMode: 'crossover', structure: 'ms', width: 1, decorr: 0,
      }, b.markers);
      const centerRetention = rCenter.measurements.bandDistortion.worstBand.retentionDb;
      const improved = centerRetention > rawWorst.retentionDb + 10;

      // Monitor fold honours the foldPolarity policy read from the project.
      const invL = tone(65536, SR, 110, 0.5);
      const invR = new Float64Array(invL.length);
      for (let i = 0; i < invL.length; i++) invR[i] = -invL[i];
      const plainRun = renderChain(invL, invR, SR, { sr: SR, foldPolarity: 'plain', stageMode: 'preserve' }, null);
      const autoRun = renderChain(invL, invR, SR, { sr: SR, foldPolarity: 'auto', stageMode: 'preserve' }, null);
      const plainRms = rms(plainRun.monitorFold);
      const autoRms = rms(autoRun.monitorFold);
      const monitorReadsPolicy = db(autoRms) - db(plainRms) > 20;

      const ok = named && improved && monitorReadsPolicy;
      return {
        ok,
        detail: '未保护最差频带 ' + rawWorst.name + '(' + rawWorst.low + '–' + rawWorst.high +
          'Hz) 保留 ' + rawWorst.retentionDb + 'dB，自动化提示已点名；居中后提升到 ' +
          centerRetention.toFixed(2) + 'dB；监听折叠按策略区分 plain/auto，能量差 ' +
          (db(autoRms) - db(plainRms)).toFixed(1) + 'dB。',
        metrics: {
          rawWorstBand: rawWorst.name, rawRetentionDb: rawWorst.retentionDb,
          centerRetentionDb: centerRetention, monitorPolicyDeltaDb: Number((db(autoRms) - db(plainRms)).toFixed(2)),
        },
      };
    },
  },

  {
    id: 'contract_matches_implementation',
    title: '维护契约与实现一致（结构、响应、分频相关度）',
    run() {
      const ev = decorrelatorEvidence(SR);
      // Published decorrelator facts must agree with a clean-room IR measurement.
      const apOk = ev.allpassMaxMagDevDb < 0.6 && ev.allpassPhaseSpanRad > 3;
      const dlOk = ev.delayPeakSample === ev.delayCommandSamples;

      // Contract says symmetric structures preserve the fold; verify with the
      // actual stage on a decorrelated input (not self-referential).
      const n = 32768;
      const M = noise(n, 41, 0.35);
      const S = noise(n, 42, 0.3);
      const { L, R } = stereoFromMS(M, S);
      let foldOk = true;
      for (const structure of ['ms', 'ap', 'delay']) {
        const st = processStage(L, R, {
          sr: SR, stageMode: 'widen', structure, width: 1.7, decorr: 0.6,
          delayMs: 7, centerLock: true,
        }, { cls: 'normal' });
        const fold = new Float64Array(n);
        for (let i = 0; i < n; i++) fold[i] = 0.5 * (st.L[i] + st.R[i]);
        const err = maxAbsDiff(fold, M);
        if (err > 1e-12) foldOk = false;
      }
      // Haas is the documented exception: its fold must NOT equal M.
      const stH = processStage(L, R, {
        sr: SR, stageMode: 'widen', structure: 'haas', width: 1, decorr: 0.9, haasMs: 10,
      }, { cls: 'normal' });
      const foldH = new Float64Array(n);
      for (let i = 0; i < n; i++) foldH[i] = 0.5 * (stH.L[i] + stH.R[i]);
      const haasDiffers = maxAbsDiff(foldH, M) > 1e-3;

      const declaredExact = DECORRELATOR_CONTRACT.haas.monoFoldExact === false;

      // Band coherence evidence at the crossover frequency must separate bands.
      const band = buildBandSample(SR, 1.0);
      const bev = bandCorrelationEvidence(band.L, band.R, 180, SR);
      const bandsSeparate = bev.low.correlation < -0.5 && bev.high.correlation > 0.3;

      const ok = apOk && dlOk && foldOk && haasDiffers && declaredExact && bandsSeparate;
      return {
        ok,
        detail: '全通幅度偏差 ' + ev.allpassMaxMagDevDb + 'dB/相位行程 ' + ev.allpassPhaseSpanRad +
          'rad；延迟峰 ' + ev.delayPeakSample + '=' + ev.delayCommandSamples + '；' +
          '对称结构折叠=M 保持=' + foldOk + '，Haas 折叠偏离=' + haasDiffers +
          '；分频相关度低/高=' + bev.low.correlation + '/' + bev.high.correlation + '。',
        metrics: {
          allpassMaxMagDevDb: ev.allpassMaxMagDevDb, delayPeakSample: ev.delayPeakSample,
          symmetricFoldExact: foldOk, haasFoldDiffers: haasDiffers, bandsSeparate,
        },
      };
    },
  },
];

function branchRow(name, mm) {
  return {
    branch: name,
    onsetPeakOffsetMs: mm.consonantOffsetMs,
    centroidMs: mm.consonantCentroidMs,
    lateRatio: mm.consonantLateRatio,
    bassAmpDb: mm.bassAmpDb,
  };
}

// Low-pass RMS helper using the production LR4 crossover.
function lowpassProxy(x, sr, cutoff = 150) {
  return lr4Split(x, cutoff, sr).lo;
}

function impulseSpectrumPhaseAt(ir, sr, nfft, k) {
  const spec = impulseSpectrum(ir, sr, nfft);
  return spec.phase[k];
}

export async function runAllChecks(onProgress) {
  const results = [];
  for (let i = 0; i < CHECKS.length; i++) {
    const c = CHECKS[i];
    if (onProgress) onProgress({ index: i, total: CHECKS.length, id: c.id, title: c.title, status: 'running' });
    // Let the browser paint the running state before synchronous DSP work.
    await new Promise((r) => setTimeout(r, 24));
    const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let result;
    try {
      result = await c.run();
    } catch (err) {
      result = { ok: false, detail: '检查抛出异常: ' + (err && err.message ? err.message : String(err)) };
    }
    result.id = c.id;
    result.title = c.title;
    result.ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
    results.push(result);
    if (onProgress) onProgress({ index: i, total: CHECKS.length, id: c.id, status: result.ok ? 'pass' : 'fail', result });
    // Yield to the browser event loop so progress can paint.
    await new Promise((r) => setTimeout(r, 0));
  }
  return {
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    allOk: results.every((r) => r.ok),
    results,
  };
}
