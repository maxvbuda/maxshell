'use strict';

const fs = require('fs');
const os = require('os');

const { BUILTINS } = require('./builtins');
const { RESERVED } = require('./lexer');

function commonPrefix(items) {
  if (!items.length) return '';
  let prefix = items[0];
  for (const item of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < item.length && prefix[i] === item[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

// Completions for the word ending at `cursor`. Returns the candidate list plus
// the partial word they should replace.
function completions(line, cursor, shell) {
  const upto = line.slice(0, cursor);
  const match = /(\S*)$/.exec(upto);
  const partial = match ? match[1] : '';
  const before = upto.slice(0, upto.length - partial.length);
  const isCommandSlot = /(^|[|&;(]|\b(?:do|then|else|elif)\s)\s*$/.test(before);

  const items = new Set();

  if (isCommandSlot && !partial.includes('/')) {
    for (const name of Object.keys(BUILTINS)) items.add(name);
    for (const name of shell.funcs.keys()) items.add(name);
    for (const name of shell.aliases.keys()) items.add(name);
    for (const name of RESERVED) if (/^[a-z]+$/.test(name)) items.add(name);
    for (const dir of (shell.env.PATH || '').split(':').filter(Boolean)) {
      try {
        for (const name of fs.readdirSync(dir)) items.add(name);
      } catch { /* unreadable PATH entry */ }
    }
  }

  const slash = partial.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : partial.slice(0, slash + 1);
  const basePart = slash === -1 ? partial : partial.slice(slash + 1);
  try {
    const home = shell.getVar('HOME') || os.homedir();
    const base = dirPart
      ? shell.resolve(dirPart.replace(/^~(?=\/|$)/, home))
      : shell.cwd;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.name.startsWith(basePart)) continue;
      if (!basePart && entry.name.startsWith('.')) continue;
      items.add(dirPart + entry.name + (entry.isDirectory() ? '/' : ''));
    }
  } catch { /* not a directory */ }

  const list = [...items].filter((c) => c.startsWith(partial)).sort();
  return { items: list, partial };
}

module.exports = { completions, commonPrefix };
