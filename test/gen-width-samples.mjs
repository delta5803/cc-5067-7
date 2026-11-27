#!/usr/bin/env node
// Emit executable phase/frequency samples plus measured evidence. Writes only
// into the directory you pass; refuses to drop files into the repo's tracked
// docs by accident unless explicitly targeted there.
//
//   node test/gen-width-samples.mjs <outDir>

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvidence, evidenceForJson } from './width-evidence.mjs';
import { encodeWav16Node } from './wav-node.mjs';

const outDir = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(fileURLToPath(new URL('..', import.meta.url)), 'doc/samples');

const ev = buildEvidence();
mkdirSync(outDir, { recursive: true });

for (const [, sample] of Object.entries(ev.samples)) {
  writeFileSync(join(outDir, sample.name), encodeWav16Node(sample.L, sample.R, ev.sampleRate));
}
writeFileSync(join(outDir, 'width-evidence.json'), JSON.stringify(evidenceForJson(ev), null, 2) + '\n');

console.log('wrote to ' + outDir);
for (const [, sample] of Object.entries(ev.samples)) console.log('  ' + sample.name);
console.log('  width-evidence.json');
