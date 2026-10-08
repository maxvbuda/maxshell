#!/usr/bin/env node
'use strict';

// A stand-in for Wan (mlx-video) in tests: takes sage video's command line,
// echoes the prompt (--prompt or --prompt-file), prints stages and a tqdm
// bar like Wan's (per segment with --segments), and writes a small file to --output-path. A prompt with
// "fail" fails.

const fs = require('fs');
const { sleepSync } = require('../src/keys');

const args = process.argv.slice(2);
const opt = (name) => args[args.indexOf(name) + 1];
const prompt = args.includes('--prompt-file') ? fs.readFileSync(opt('--prompt-file'), 'utf8') : opt('--prompt');
process.stdout.write(`prompt: ${prompt}\nframes: ${opt('--num-frames')}${args.includes('--image') ? `\nimage: ${opt('--image')}` : ''}\nLoading T5 encoder...\n`);
if (/fail/.test(prompt)) { process.stderr.write('Error: out of memory\n'); process.exit(1); }
const steps = Number(opt('--steps') || 4);
const segments = Number(args.includes('--segments') ? opt('--segments') : 1);
for (let n = 1; n <= segments; n++) {
  if (segments > 1) process.stdout.write(`segment ${n}/${segments}\n`);
  for (let i = 1; i <= steps; i++) {
    process.stderr.write(`\rDiffusion: ${Math.round((i / steps) * 100)}%|███| ${i}/${steps} [00:0${i}<00:00,  1.00s/it]`);
    sleepSync(20);
  }
  process.stdout.write('\nDecoding with VAE...\n');
}
fs.writeFileSync(opt('--output-path'), 'not really an mp4');
