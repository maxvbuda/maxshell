'use strict';

// Runs one of Sage Code's tools for ai/sage/eval.py, the way the app does
// (src/sagetools.js) but saying yes to every change:
//   node tool.js ROOT NAME ARGS_JSON   → what the model is told, on stdout
// Replaced files go to $MAXSHELL_TRASH (the eval sets a temp folder).

const tools = require('../../src/sagetools');

const [root, name, json] = process.argv.slice(2);
const args = JSON.parse(json || '{}');
let text;
if (tools.READS.has(name)) text = tools.look(name, args, root).text;
else if (tools.CHANGES.has(name)) {
  const p = tools.plan(name, args, root);
  text = p.error || tools.apply(p).text;
} else if (tools.COMMANDS.has(name)) text = tools.runCommand(args, root).text;
else text = `There is no tool called ${name}.`;
process.stdout.write(text);
