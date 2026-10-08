#!/usr/bin/env node
'use strict';

// A stand-in for `sage.py --image-prompt REQ OUT` in tests: writes a
// "detailed prompt" made from the request. A prompt with "mute" fails.

const fs = require('fs');

const [, , flag, reqPath, out] = process.argv;
if (flag !== '--image-prompt') process.exit(2);
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
if (/mute/.test(req.prompt)) { process.stderr.write('only 12% of memory is free\n'); process.exit(1); }
const text = req.kind === 'video'
  ? `MOTION${req.edit ? ' (from a picture)' : ''}: ${req.prompt}, the camera slowly pushes in.`
  : req.edit
  ? `EDIT: ${req.prompt}; keep everything else.${req.context ? ` [context: ${req.context}]` : ''}`
  : `DETAILED: ${req.prompt}, in warm evening light, a wide shot, a photo.`;
fs.writeFileSync(out, text);
