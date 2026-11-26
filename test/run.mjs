#!/usr/bin/env node
// Headless test runner: node test/run.mjs  (also `npm test`)
// Runs the exact same requirement checks as the in-browser self-test button.

import { runAllChecks } from '../web/js/selftest/checks.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

const summary = await runAllChecks((p) => {
  if (p.status === 'running') {
    process.stdout.write(dim(`  ... [${p.index + 1}/${p.total}] ${p.title}\n`));
  }
});

console.log('');
for (const r of summary.results) {
  const mark = r.ok ? green('PASS') : red('FAIL');
  console.log(`${mark}  ${r.title} ${dim('(' + r.ms + 'ms)')}`);
  console.log(`       ${r.detail}`);
  if (!r.ok && r.metrics) console.log(dim('       metrics=' + JSON.stringify(r.metrics)));
}
console.log('');
if (summary.allOk) {
  console.log(green(`All ${summary.total} checks passed.`));
  process.exit(0);
} else {
  console.log(red(`${summary.passed}/${summary.total} passed; ${summary.total - summary.passed} failed.`));
  process.exit(1);
}
