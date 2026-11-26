// UI wiring: every control invokes the real DSP chain; every meter/chart is
// populated from measurements of the rendered buffers. No mock values.

import { getBuiltinMaterial } from '../audio/materials.js';
import { renderChain, measureImpulseResponse } from '../chain.js';
import { DEFAULT_CONFIG, STRUCTURE_LABELS } from '../config.js';
import { encodeWav16 } from '../audio/wav.js';
import { Player, formatTime } from './player.js';
import { drawTrace, drawSpectrum, drawMagnitude, drawPhase } from './charts.js';
import { runAllChecks, CHECKS } from '../selftest/checks.js';

const $ = (id) => document.getElementById(id);

const state = {
  audio: null,          // {L,R,sr,markers,name}
  materialId: 'pair_a',
  uploaded: null,
  last: null,           // { result, response }
  renderTimer: 0,
  renderToken: 0,
  seeking: false,
};

const player = new Player();
player.current = 'original';

// ---------- config ----------

function readConfig() {
  const stageBtn = document.querySelector('#stage-mode .btn.active');
  return {
    ...DEFAULT_CONFIG,
    stageMode: stageBtn ? stageBtn.dataset.value : 'crossover',
    width: parseFloat($('width').value),
    structure: $('structure').value,
    decorr: parseFloat($('decorr').value),
    delayMs: parseFloat($('delay-ms').value),
    haasMs: parseFloat($('haas-ms').value),
    crossover: $('crossover-enabled').checked,
    fc: parseFloat($('fc').value),
    lowMode: $('low-mode').value,
    broadcast: $('broadcast-route').value,
    centerLock: $('center-lock').checked,
    autoProtect: $('auto-protect').checked,
    outGainDb: parseFloat($('out-gain').value),
  };
}

function updateLabels() {
  $('width-val').textContent = parseFloat($('width').value).toFixed(2) + '×';
  $('decorr-val').textContent = Math.round(parseFloat($('decorr').value) * 100) + '%';
  $('delay-ms-val').textContent = parseFloat($('delay-ms').value).toFixed(1) + ' ms';
  $('haas-ms-val').textContent = parseFloat($('haas-ms').value).toFixed(1) + ' ms';
  $('fc-val').textContent = $('fc').value + ' Hz';
  const g = parseFloat($('out-gain').value);
  $('out-gain-val').textContent = (g >= 0 ? '+' : '') + g.toFixed(1) + ' dB';

  const st = $('structure').value;
  $('delay-row').classList.toggle('hidden', st !== 'delay');
  $('haas-row').classList.toggle('hidden', st !== 'haas');
}

// ---------- material ----------

function loadSelectedMaterial() {
  const id = $('material-select').value;
  state.materialId = id;
  if (id === 'upload' && state.uploaded) {
    state.audio = state.uploaded;
  } else {
    state.audio = getBuiltinMaterial(id);
  }
  const a = state.audio;
  const dur = a.L.length / a.sr;
  $('material-meta').textContent =
    `${a.name || id} · ${a.sr} Hz · ${dur.toFixed(2)} s · ${a.L.length.toLocaleString()} 采样/声道`;

  const info = a.rhoInfo;
  if (info) {
    $('rho-info').classList.remove('hidden');
    $('rho-info').textContent =
      `构造实测：ρ(A)=${info.rhoA}  ρ(B)=${info.rhoB}\n` +
      `低频相关 A=${info.rhoBassA}  B=${info.rhoBassB}\n` +
      `B 版额外高频侧声增益 g=${info.sideWashGainB}（闭式+二分匹配总 ρ）`;
  } else {
    $('rho-info').classList.add('hidden');
  }
  scheduleRender(0);
}

// ---------- render + update ----------

function scheduleRender(delay = 110) {
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(doRender, delay);
}

function doRender() {
  if (!state.audio) return;
  const token = ++state.renderToken;
  const cfg = readConfig();
  let result, response;
  try {
    result = renderChain(state.audio.L, state.audio.R, state.audio.sr, cfg, state.audio.markers);
    response = measureImpulseResponse(cfg, state.audio.sr);
  } catch (err) {
    console.error(err);
    $('policy-text').textContent = '渲染失败：' + err.message;
    return;
  }
  if (token !== state.renderToken) return; // a newer render superseded
  state.last = { result, response };

  updatePolicy(result);
  updateMeters(result, response);
  updateWarnings(result.warnings);
  updateMarkerTable(result.measurements);
  drawAll(result.measurements, response);

  player.refreshBuffers({
    original: state.audio,
    stage: result.stage,
    broadcast: result.broadcast,
    fold: { L: result.stageFold, R: result.stageFold },
  }, state.audio.sr);
}

function rhoCategory(r) {
  if (r < -0.2) return ['反相风险', 'danger'];
  if (r < 0.15) return ['很宽 / 弱相关', 'good'];
  if (r < 0.55) return ['适度去相关', 'good'];
  if (r < 0.85) return ['较好相关', ''];
  if (r < 0.995) return ['强相关', ''];
  return ['完全同相（单声）', ''];
}

function setTile(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = cls;
}

function updatePolicy(result) {
  const a = result.analysis;
  const badge = $('policy-badge');
  const labels = {
    mono: '纯单声道',
    correlated: '强相关',
    anti_phase_lf: '低频反相',
    normal: '常规立体声',
  };
  badge.textContent = labels[a.cls] || a.cls;
  badge.className = 'badge ' + a.cls;
  const policyCopy = {
    mono: '声明政策：S≈0，M/S 宽度增益无作用；只有全通/短延迟去相关能生成真实侧声，相关性会真实下降。',
    correlated: '声明政策：可安全用 M/S 增益扩宽；默认分频并把低频居中，保护单声道转播。',
    anti_phase_lf: '声明政策：标准 (L+R)/2 会抵消低频。自动模式改用低频 S 分量救援 + 相位安全单声道；关闭自动保护可观察并听到抵消。',
    normal: '声明政策：按所选总线模式处理；所有单声道抵消与梳状染色均以实测数值暴露，不承诺任意素材无损变宽。',
  };
  $('policy-text').textContent = policyCopy[a.cls];
  $('route-effective').textContent =
    `实际路由：转播=${result.effective.broadcastRoute} ｜ 舞台低频=${result.effective.lowMode || '—'} ｜ ` +
    `模式=${result.effective.stageMode}${result.effective.useCrossover ? ' / 分频中' : ' / 全带'}`;
}

function updateMeters(result, response) {
  const m = result.measurements;
  const rho = m.stage.rho;
  $('rho-big').textContent = rho.toFixed(3);
  const [tag, cls] = rhoCategory(rho);
  const tagEl = $('rho-tag');
  tagEl.textContent = tag;
  tagEl.style.color = cls === 'danger' ? 'var(--danger)' : cls === 'good' ? 'var(--accent-2)' : 'var(--muted)';
  const pct = ((Math.max(-1, Math.min(1, rho)) + 1) / 2) * 100;
  $('rho-marker').style.left = pct + '%';

  $('rho-input').textContent = m.input.rho.toFixed(3);
  $('rho-bass-in').textContent = m.input.rhoBass.toFixed(3);
  $('rho-bass-out').textContent = m.stage.rhoBass.toFixed(3);

  setTile('t-rms-l', m.stage.rmsL + ' dB');
  setTile('t-rms-r', m.stage.rmsR + ' dB');
  const bal = m.stage.balanceDb;
  setTile('t-balance', (bal >= 0 ? '+' : '') + bal + ' dB', Math.abs(bal) > 1.5 ? 'warn' : 'good');
  setTile('t-peak', m.stage.peak + ' dB', m.stage.peak > -0.3 ? 'warn' : '');
  setTile('t-clips', String(m.stage.clipSamples), m.stage.clipSamples > 0 ? 'danger' : 'good');
  const comb = m.coloration.hfMaxDb;
  const combBad = m.coloration.hfAvgDb >= 0.6 || comb >= 4;
  setTile('t-comb', comb.toFixed(2) + ' / 均 ' + m.coloration.hfAvgDb.toFixed(2), combBad ? 'warn' : 'good');
  const ld = m.bassFold.deltaDb;
  setTile('t-lowdelta', (ld >= 0 ? '+' : '') + ld + ' dB', Math.abs(ld) >= 3 ? 'warn' : 'good');
  setTile('t-itd', response.itdMs.toFixed(2) + ' ms (γ=' + response.gcc + ')');
  if (response.crossover) {
    const x = response.crossover;
    $('xo-meta').textContent =
      `LR4 分频 @${x.fc}Hz：LP+HP 重组幅度最大偏差 ${x.reconMaxDevDb} dB，合成相位量级 |φ(fc)|≈${x.phaseAtFcRad} rad（≈π 的相位旋转，符号随 FFT 展开/分箱在 ±π 间等价）；去相关发送仅取自高通中轨以避开该重叠区，低频合成已复查。`;
  }
}

function updateWarnings(warnings) {
  const box = $('warnings');
  box.innerHTML = '';
  if (!warnings.length) {
    const p = document.createElement('p');
    p.className = 'meta';
    p.textContent = '当前参数下没有触发警告阈值。';
    box.appendChild(p);
    return;
  }
  for (const w of warnings) {
    const div = document.createElement('div');
    div.className = 'warning ' + w.level;
    const icon = w.level === 'danger' ? '✕' : w.level === 'warn' ? '!' : 'i';
    div.innerHTML = `<span class="dot-i">${icon}</span><span></span>`;
    div.querySelector('span:last-child').textContent = w.text;
    box.appendChild(div);
  }
}

function updateMarkerTable(measurements) {
  const tbody = $('marker-table').querySelector('tbody');
  tbody.innerHTML = '';
  if (!measurements.markers) {
    tbody.innerHTML = '<tr><td colspan="5" class="meta">该素材没有标记点；选择路由探针或 A/B 乐曲查看字头/低音实测。</td></tr>';
    return;
  }
  const nameMap = { dryMid: '原始中轨 M', stageFold: '舞台折叠', broadcast: '送出的转播单声道' };
  for (const key of ['dryMid', 'stageFold', 'broadcast']) {
    const mm = measurements.markers[key];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${nameMap[key]}</td><td>${mm.consonantOffsetMs ?? '—'}</td>` +
      `<td>${mm.consonantCentroidMs ?? '—'}</td><td>${mm.consonantLateRatio ?? '—'}</td>` +
      `<td>${mm.bassAmpDb ?? '—'}</td>`;
    tbody.appendChild(tr);
  }
}

function drawAll(m, resp) {
  drawTrace($('chart-trace'), m.rhoTrace, m.inputRhoTrace);
  drawSpectrum($('chart-spectrum'), m.spectrum);
  drawMagnitude($('chart-mag'), resp);
  drawPhase($('chart-phase'), resp);
}

// ---------- self test panel ----------

async function runSelfTest() {
  const btn = $('run-selftest');
  btn.disabled = true;
  const list = $('selftest-list');
  list.innerHTML = '';
  const items = new Map();
  for (const c of CHECKS) {
    const div = document.createElement('div');
    div.className = 'check-item running';
    div.id = 'check-' + c.id;
    div.innerHTML = `<div class="ci-head"><span class="mark">…</span><span>${c.title}</span></div>` +
      `<div class="ci-detail">排队中…</div>`;
    list.appendChild(div);
    items.set(c.id, div);
  }
  $('selftest-summary').textContent = '自检运行中…（每一项都在浏览器里真实执行 DSP）';

  const summary = await runAllChecks((p) => {
    const div = items.get(p.id);
    if (!div) return;
    if (p.status === 'running') {
      div.className = 'check-item running';
      div.querySelector('.mark').textContent = '…';
      div.querySelector('.ci-detail').textContent = '计算中…';
    } else if (p.result) {
      const r = p.result;
      div.className = 'check-item ' + (r.ok ? 'pass' : 'fail');
      div.querySelector('.mark').textContent = r.ok ? 'PASS' : 'FAIL';
      let detail = r.detail;
      const d = div.querySelector('.ci-detail');
      d.textContent = detail;
      const head = div.querySelector('.ci-head');
      let ms = head.querySelector('.ci-ms');
      if (!ms) { ms = document.createElement('span'); ms.className = 'ci-ms'; head.appendChild(ms); }
      ms.textContent = r.ms + ' ms';
    }
  });

  $('selftest-summary').textContent = summary.allOk
    ? `全部 ${summary.total} 项检查通过（与 npm test 同一套代码）。`
    : `${summary.passed}/${summary.total} 通过，${summary.total - summary.passed} 项失败，请查看红色条目。`;
  btn.disabled = false;
}

// ---------- upload / export ----------

async function handleUpload(file) {
  try {
    await player.ensureContext();
    const buf = await player.ctx.decodeAudioData(await file.arrayBuffer());
    let L = buf.getChannelData(0);
    let R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    // Keep the panel responsive: analyze/audition a centered max-24 s excerpt.
    const maxSamples = 24 * buf.sampleRate;
    let start = 0;
    if (L.length > maxSamples) start = Math.floor((L.length - maxSamples) / 2);
    const len = Math.min(L.length, maxSamples);
    const L64 = Float64Array.from(L.subarray(start, start + len));
    const R64 = Float64Array.from(R.subarray(start, start + len));
    state.uploaded = {
      L: L64, R: R64, sr: buf.sampleRate, markers: null,
      name: file.name + (L.length > maxSamples ? '（中段 24s 节选）' : ''),
    };
    const sel = $('material-select');
    sel.querySelector('option[value="upload"]').textContent = '上传：' + file.name;
    sel.value = 'upload';
    loadSelectedMaterial();
  } catch (err) {
    console.error(err);
    alert('解码失败：' + err.message);
  }
}

function exportWav() {
  if (!state.last) return;
  const { stage } = state.last.result;
  const blob = encodeWav16(stage.L, stage.R, state.audio.sr);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stereo-width-stage.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- wiring ----------

function bind() {
  $('material-select').addEventListener('change', loadSelectedMaterial);
  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleUpload(f);
  });

  for (const id of ['width', 'decorr', 'delay-ms', 'haas-ms', 'fc', 'out-gain']) {
    $(id).addEventListener('input', () => { updateLabels(); scheduleRender(); });
  }
  for (const id of ['structure', 'low-mode', 'broadcast-route']) {
    $(id).addEventListener('change', () => { updateLabels(); scheduleRender(); });
  }
  for (const id of ['crossover-enabled', 'center-lock', 'auto-protect']) {
    $(id).addEventListener('change', scheduleRender);
  }

  document.querySelectorAll('#stage-mode .btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#stage-mode .btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      scheduleRender();
    });
  });

  document.querySelectorAll('.source').forEach((btn) => {
    btn.addEventListener('click', () => player.playSource(btn.dataset.source));
  });

  $('play-pause').addEventListener('click', () => player.togglePlay());
  $('btn-ab').addEventListener('click', async () => {
    const target = player.current === 'original' ? 'stage' : 'original';
    await player.playSource(target);
  });
  $('btn-export').addEventListener('click', exportWav);
  $('run-selftest').addEventListener('click', runSelfTest);

  const seek = $('seek');
  seek.addEventListener('pointerdown', () => { state.seeking = true; });
  window.addEventListener('pointerup', () => {
    if (state.seeking) { state.seeking = false; player.seekFraction(parseFloat(seek.value) / 1000); }
  });
  seek.addEventListener('input', () => {
    if (!state.seeking) player.seekFraction(parseFloat(seek.value) / 1000);
    $('time-current').textContent = formatTime((parseFloat(seek.value) / 1000) * player.duration);
  });

  player.onTick = (t, dur) => {
    if (!state.seeking && dur > 0) seek.value = String(Math.round((t / dur) * 1000));
    $('time-current').textContent = formatTime(t);
    $('time-total').textContent = formatTime(dur);
  };
  player.onPlayState = (playing, current) => {
    $('play-pause').textContent = playing ? '❚❚' : '▶';
    document.querySelectorAll('.source').forEach((b) => {
      b.classList.toggle('active', b.dataset.source === current);
    });
    const names = { original: '原输入', stage: '舞台立体声', broadcast: '转播单声道', fold: '舞台折叠检查' };
    $('now-source').textContent = `当前：${names[current] || current} · Web Audio 真实播放 DSP 渲染结果`;
  };

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.last) drawAll(state.last.result.measurements, state.last.response);
    }, 120);
  });
}

function init() {
  bind();
  updateLabels();
  loadSelectedMaterial();
  // Auto-run the real requirement suite once shortly after first paint.
  setTimeout(runSelfTest, 600);
}

init();
