#!/usr/bin/env node
'use strict';

// A stand-in for sageaudio.py in tests: VIDEO OUT --prompt P. Says
// "sound 1/1", and appends "+sound(P)" to OUT (VIDEO's contents first).

const fs = require('fs');

const args = process.argv.slice(2);
const prompt = args[args.indexOf('--prompt') + 1];
const [video, out] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--prompt');
process.stdout.write('sound 1/1\n');
fs.writeFileSync(out, `${fs.readFileSync(video, 'utf8')}+sound(${prompt})`);
process.stdout.write(`added sound to ${out}\n`);
