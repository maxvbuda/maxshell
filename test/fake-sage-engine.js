'use strict';

// A stand-in for sage.py --serve in tests: the same protocol, no model.
// "edit" asks for an edit_file of a.py (return 1 → return 2); anything else
// is echoed back in two pieces. An image-prompt comes back as "DETAILED …"
// (empty for a prompt with "mute").

const fs = require('fs');
const { sleepSync } = require('../src/keys');

const [cmdFile, mode] = process.argv.slice(2);
const emit = (ev) => fs.writeSync(1, `${JSON.stringify(ev)}\n`);
const app = Number(process.env.MAXSHELL_SAGE_APP || 0);
let pos = 0;
let pending = '';

function next() {
  for (;;) {
    const s = fs.readFileSync(cmdFile, 'utf8');
    pending += s.slice(pos);
    pos = s.length;
    const nl = pending.indexOf('\n');
    if (nl >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      return JSON.parse(line);
    }
    if (app) { try { process.kill(app, 0); } catch { return { op: 'quit' }; } }
    sleepSync(20);
  }
}

emit({ ev: 'loading', model: process.env.MAXSHELL_SAGE_NAME || 'E4B' });
emit({ ev: 'ready', model: process.env.MAXSHELL_SAGE_NAME || 'E4B', device: 'cpu' });
for (;;) {
  const cmd = next();
  if (cmd.op === 'quit') process.exit(0);
  if (cmd.op === 'reset') { emit({ ev: 'ready' }); continue; }
  if (cmd.op === 'image-prompt') { emit({ ev: 'image-prompt', id: cmd.id, text: /mute/.test(cmd.prompt) ? '' : `DETAILED ${cmd.prompt}`, stopped: false }); continue; }
  if (cmd.op !== 'ask') continue;
  if (mode === 'code' && /edit/.test(cmd.text)) {
    emit({ ev: 'text', s: 'Changing it.' });
    emit({ ev: 'tool', name: 'edit_file', args: { path: 'a.py', old_text: 'return 1', new_text: 'return 2' } });
    let r = next();
    while (r.op !== 'result') r = next();
    emit({ ev: 'text', s: ` Result: ${r.text}` });
  } else {
    emit({ ev: 'text', s: 'You said: ' });
    emit({ ev: 'text', s: cmd.text });
  }
  emit({ ev: 'done', stopped: false, tokens: 10, seconds: 1 });
}
