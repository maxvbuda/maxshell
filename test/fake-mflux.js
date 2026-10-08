#!/usr/bin/env node
'use strict';

// A stand-in for mflux-generate-qwen-2.1 in tests: prints a progress bar like
// tqdm's and writes a tiny PNG to --output. A prompt with "fail" fails;
// the prompt (--prompt or --prompt-file) is echoed first.

const fs = require('fs');
const { sleepSync } = require('../src/keys');

const args = process.argv.slice(2);
const opt = (name) => args[args.indexOf(name) + 1];
const steps = Number(opt('--steps') || 4);
const prompt = args.includes('--prompt-file') ? fs.readFileSync(opt('--prompt-file'), 'utf8') : opt('--prompt');
process.stderr.write(`prompt: ${prompt}\n`);
if (/fail/.test(prompt)) { process.stderr.write('Error: out of memory\n'); process.exit(1); }
for (let i = 1; i <= steps; i++) {
  process.stderr.write(`\r${Math.round((i / steps) * 100)}%|███| ${i}/${steps} [00:0${i}<00:00,  1.00s/it]`);
  sleepSync(30);
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(opt('--output'), PNG);
process.stderr.write('\n');
