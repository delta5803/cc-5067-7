// Browser smoke: drives the real panel in headless Chromium. Verifies the width
// controls, mono checks, correlation + audition status, automation feedback and
// the documented WAV export. Command-line helpers live in test/*.mjs.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav16 } from '../web/js/audio/wav.js';

// Self-generated real WAV so the upload check has no external fixture.
const uploadPath = join(tmpdir(), 'sw-upload-test.wav');
{
  const sr = 44100;
  const n = sr * 2;
  const L = new Float64Array(n), R = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, i / 200) * Math.exp(-((i % 22050) / sr) * 4);
    L[i] = 0.4 * env * Math.sin(2 * Math.PI * 330 * t) + 0.15 * Math.sin(2 * Math.PI * 82.4 * t);
    R[i] = L[i] + 0.12 * Math.sin(2 * Math.PI * 495 * t);
  }
  writeFileSync(uploadPath, Buffer.from(await encodeWav16(L, R, sr).arrayBuffer()));
}

const BASE = process.env.BASE || 'http://127.0.0.1:8770/';
const shots = '/workspace/shots';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });

// Initial real render must populate the correlation readout.
await page.waitForFunction(() => {
  const t = document.getElementById('rho-big')?.textContent;
  return t && t !== '—' && Number.isFinite(parseFloat(t));
}, { timeout: 30000 });

const rhoA = await page.textContent('#rho-big');
console.log('initial rho =', rhoA);

// Canvas should contain drawn pixels, not a blank decorative box.
const chartPixels = await page.evaluate(() => {
  const c = document.getElementById('chart-trace');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let nonZero = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonZero++;
  return { width: c.width, height: c.height, nonZero };
});
console.log('trace canvas pixels =', JSON.stringify(chartPixels));
if (chartPixels.nonZero < 200) throw new Error('trace chart appears blank');

await page.screenshot({ path: `${shots}/01-panel-a.png`, fullPage: true });

// Wait for the auto-run requirement suite.
await page.waitForFunction(() => {
  const t = document.getElementById('selftest-summary')?.textContent || '';
  return t.includes('全部 15 项') || t.includes('失败');
}, { timeout: 120000 });
const summary = await page.textContent('#selftest-summary');
console.log('selftest:', summary);
const failCount = await page.locator('.check-item.fail').count();
const passCount = await page.locator('.check-item.pass').count();
console.log(`browser checks pass=${passCount} fail=${failCount}`);

// Switch to the anti-phase matched version B.
await page.selectOption('#material-select', 'pair_b');
await page.waitForTimeout(1400);
const rhoB = await page.textContent('#rho-big');
const rhoBassIn = await page.textContent('#rho-bass-in');
const policyBadge = await page.textContent('#policy-badge');
console.log('pair B rho =', rhoB, 'rhoBass =', rhoBassIn, 'policy =', policyBadge);
await page.screenshot({ path: `${shots}/02-panel-b-antiphase.png`, fullPage: true });

// Turn OFF auto protect and force direct mid to expose cancellation.
await page.check('#auto-protect'); // ensure on first
await page.uncheck('#auto-protect');
await page.selectOption('#broadcast-route', 'direct_mid');
await page.selectOption('#low-mode', 'center');
await page.waitForTimeout(900);
const dangerWarnings = await page.locator('.warning.danger').count();
console.log('danger warnings after unprotected flip =', dangerWarnings);

// Crank width + allpass decorrelation via real input events.
await page.evaluate(() => {
  const w = document.getElementById('width');
  w.value = '2.1'; w.dispatchEvent(new Event('input', { bubbles: true }));
  const d = document.getElementById('decorr');
  d.value = '0.85'; d.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(900);
const rhoWide = await page.textContent('#rho-big');
console.log('wide rho =', rhoWide);

// Switch structure to Haas and widen mode to surface comb warning.
await page.click('#stage-mode .btn[data-value="widen"]');
await page.selectOption('#structure', 'haas');
await page.waitForTimeout(900);
const combTile = await page.textContent('#t-comb');
const warnCount = await page.locator('.warning').count();
console.log('haas comb tile =', combTile, 'warnings =', warnCount);

// Audition buttons must not throw and should start the AudioContext.
await page.click('.source[data-source="stage"]');
await page.waitForTimeout(400);
const playLabel = await page.textContent('#play-pause');
console.log('play label after source click =', playLabel);
await page.click('#play-pause');
await page.waitForTimeout(300);
await page.click('#play-pause');

// Routing probe material -> marker table rows.
await page.selectOption('#material-select', 'probe_flip');
await page.waitForTimeout(1200);
const markerRows = await page.locator('#marker-table tbody tr').count();
console.log('marker table rows =', markerRows);
await page.screenshot({ path: `${shots}/03-probe-haas.png`, fullPage: true });

// Crossover phase/reconstruction readout must be populated from the real IR.
await page.waitForFunction(() => {
  const t = document.getElementById('xo-meta')?.textContent || '';
  return t.includes('LR4') && /偏差 -?\d/.test(t);
}, { timeout: 10000 });
const xoMeta = await page.textContent('#xo-meta');
console.log('xo meta =', xoMeta.slice(0, 90));

// Export must download a real stereo 16-bit WAV rendered by the DSP chain.
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.click('#btn-export'),
]);
const dlPath = await download.path();
const wavHead = readFileSync(dlPath);
const riff = wavHead.subarray(0, 4).toString('ascii');
const wave = wavHead.subarray(8, 12).toString('ascii');
const channels = wavHead.readUInt16LE(22);
const bitsPerSample = wavHead.readUInt16LE(34);
console.log('export download =', download.suggestedFilename(), wavHead.length, 'bytes', riff, wave, 'ch=' + channels, 'bits=' + bitsPerSample);
if (riff !== 'RIFF' || wave !== 'WAVE' || channels !== 2 || bitsPerSample !== 16) {
  throw new Error('exported file is not a stereo 16-bit WAV');
}

// Folded mono export must also be a real WAV, produced from the monitor fold.
const [foldDownload] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.click('#btn-export-fold'),
]);
const foldPath = await foldDownload.path();
const foldHead = readFileSync(foldPath);
console.log('fold export =', foldDownload.suggestedFilename(), foldHead.length, 'bytes');
if (foldHead.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error('fold export is not a WAV');

// Upload path: decode a real generated WAV and run it through the chain.
await page.setInputFiles('#file-input', uploadPath);
await page.waitForFunction(() => document.getElementById('material-select').value === 'upload', null, { timeout: 15000 });
await page.waitForFunction(() => {
  const t = document.getElementById('rho-big')?.textContent;
  return t && Number.isFinite(parseFloat(t));
}, { timeout: 15000 });
await page.waitForTimeout(800);
const uploadMeta = await page.textContent('#material-meta');
const uploadRho = await page.textContent('#rho-big');
console.log('upload rendered =', uploadMeta, 'rho =', uploadRho);
if (!/44100/.test(uploadMeta)) throw new Error('uploaded WAV sample rate not reflected');

// --- Width automation: the distorted band is surfaced and can be applied -----
await page.selectOption('#material-select', 'pair_b');
await page.waitForTimeout(1000);
const autoBand = await page.textContent('#automation-band');
const autoHint = await page.textContent('#automation-hint');
console.log('automation band =', autoBand);
console.log('automation hint =', autoHint);
if (!/最差频带/.test(autoBand) || /—$/.test(autoBand)) throw new Error('automation band not populated');

const widthBefore = parseFloat(await page.inputValue('#width'));
await page.click('#btn-apply-automation');
await page.waitForTimeout(500);
const widthAfter = parseFloat(await page.inputValue('#width'));
console.log('automation width', widthBefore, '->', widthAfter);
if (!(widthAfter < widthBefore)) throw new Error('apply automation did not reduce width');

// --- Width slider actually changes the measured correlation ------------------
// Use the well-behaved correlated pair A (pair_b is anti-phase low-end, where a
// single whole-buffer correlation is not monotonic in width).
await page.selectOption('#material-select', 'pair_a');
await page.waitForTimeout(900);
await page.evaluate(() => {
  const w = document.getElementById('width');
  w.value = '2.4'; w.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(700);
const rhoWide2 = await page.textContent('#rho-big');
await page.evaluate(() => {
  const w = document.getElementById('width');
  w.value = '0.5'; w.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(700);
const rhoNarrow = await page.textContent('#rho-big');
console.log('width 2.4 rho =', rhoWide2, 'width 0.5 rho =', rhoNarrow);
if (parseFloat(rhoWide2) >= parseFloat(rhoNarrow)) throw new Error('width did not change correlation');

// --- Runtime status card shows chain + correlation + fold policy ------------
const runStatus = await page.textContent('#run-status');
const stRho = await page.textContent('#st-rho');
const stChain = await page.textContent('#st-chain');
console.log('status =', runStatus, '|', stChain, '| rho', stRho);
if (!/待机|运行中/.test(runStatus)) throw new Error('run status not shown');
if (!/分频|全带/.test(stChain)) throw new Error('status chain not populated');
if (!Number.isFinite(parseFloat(stRho))) throw new Error('status correlation not populated');

// --- Fold policy is persisted and switches the monitor fold -----------------
await page.selectOption('#fold-polarity', 'auto');
await page.waitForTimeout(400);
const stFoldPolicy = await page.textContent('#st-fold-policy');
const persisted = await page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('sw-project-side-policy-v1') || '{}'); } catch { return {}; }
});
console.log('fold policy =', stFoldPolicy, '| persisted =', JSON.stringify(persisted));
if (!/极性校正/.test(stFoldPolicy)) throw new Error('fold policy label not updated');
if (persisted.foldPolarity !== 'auto') throw new Error('fold policy not persisted with project');

await page.screenshot({ path: `${shots}/05-status-automation.png`, fullPage: true });

// Mobile width screenshot.
await page.setViewportSize({ width: 430, height: 900 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${shots}/04-mobile.png`, fullPage: false });

console.log('consoleErrors =', consoleErrors.length, JSON.stringify(consoleErrors.slice(0, 5)));
console.log('pageErrors =', pageErrors.length, JSON.stringify(pageErrors.slice(0, 5)));

if (failCount !== 0) throw new Error('browser self-test has failures: ' + failCount);
if (dangerWarnings === 0) throw new Error('expected danger cancellation warning');
if (markerRows < 3) throw new Error('marker table not populated');
if (pageErrors.length) throw new Error('page errors: ' + pageErrors.join(' | '));

await browser.close();
console.log('BROWSER SMOKE OK');
