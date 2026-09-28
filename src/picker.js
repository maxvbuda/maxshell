'use strict';

const ansi = require('./ansi');
const theme = require('./theme');
const { fit, textWidth, bar, fullscreen } = require('./tui');
const { KeyReader } = require('./keys');
const { fuzzyMatch } = require('./history');

// A full-screen, fuzzy-filtered list: the command palette, snippets and
// bookmarks all pick through it. Items are { label, desc, icon, group, value }.
// The model is separate from the screen so it can be tested without a tty.

class Picker {
  constructor(items, { title = 'pick', hint = '' } = {}) {
    this.items = items;
    this.title = title;
    this.hint = hint;
    this.query = '';
    this.index = 0;
    this.top = 0;
    this.refilter();
  }

  // Every word of the query must match (in any order); groups keep their
  // order when there's no query, best matches come first when there is.
  refilter() {
    const tokens = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) {
      this.rows = this.items.map((item) => ({ item, positions: new Set() }));
    } else {
      const scored = [];
      this.items.forEach((item, order) => {
        const m = fuzzyMatch(`${item.label} ${item.desc || ''} ${item.group || ''}`, tokens);
        if (m) scored.push({ item, positions: m.positions, score: m.score, order });
      });
      scored.sort((a, b) => b.score - a.score || a.order - b.order);
      this.rows = scored;
    }
    this.index = Math.min(this.index, Math.max(0, this.rows.length - 1));
  }

  type(text) { this.query += text; this.index = 0; this.refilter(); }

  backspace() { this.query = [...this.query].slice(0, -1).join(''); this.index = 0; this.refilter(); }

  move(d) {
    if (!this.rows.length) return;
    this.index = Math.max(0, Math.min(this.rows.length - 1, this.index + d));
  }

  get selected() { return this.rows[this.index] ? this.rows[this.index].item : null; }

  render(cols, rows) {
    const { ui } = theme.current();
    const R = ansi.reset();
    const width = cols;
    const out = [bar(` ${this.title}`, width)];
    const q = `  › ${this.query}`;
    out.push(`${ansi.fg(ui.accent)}${ansi.bold()}${fit(q, width - 12)}${R}${ansi.fg(ui.muted)}${fit(`${this.rows.length} of ${this.items.length}`.padStart(11), 12)}${R}`);
    out.push('');
    const listRows = Math.max(1, rows - 4);
    if (this.index < this.top) this.top = this.index;
    if (this.index >= this.top + listRows) this.top = this.index - listRows + 1;
    const labelW = Math.min(Math.floor(width * 0.5), Math.max(12, ...this.rows.slice(this.top, this.top + listRows).map((r) => textWidth(r.item.label))));
    let lastGroup = null;
    for (let i = this.top; i < Math.min(this.rows.length, this.top + listRows); i++) {
      const { item } = this.rows[i];
      const selected = i === this.index;
      let icon = item.icon || '·';
      if (textWidth(icon) < 2) icon += ' ';
      const group = !this.query && item.group !== lastGroup ? item.group : null;
      lastGroup = item.group;
      const tag = group ? fit(group, 10) : ' '.repeat(10);
      const head = ` ${tag} ${icon} ${fit(item.label, labelW)}  `;
      const desc = fit(item.desc || '', Math.max(0, width - textWidth(head)));
      if (selected) out.push(`${ansi.sgr(`48;5;${ui.select.bg}`)}${ansi.fg(ui.select.fg)}${head}${desc}${R}`);
      else out.push(` ${ansi.fg(ui.muted)}${tag}${R} ${icon} ${fit(item.label, labelW)}  ${ansi.fg(ui.muted)}${desc}${R}`);
    }
    if (!this.rows.length) out.push(`${ansi.fg(ui.muted)}${fit('   nothing matches', width)}${R}`);
    while (out.length < rows - 1) out.push('');
    out.push(bar(` ↑↓ move · enter ${this.hint || 'choose'} · esc close · type to filter`, width));
    return out.slice(0, rows);
  }

  // Keys → true when done (this.chosen holds the pick, or null).
  handleKey(key) {
    const n = key.name;
    if (n === 'escape' || (key.ctrl && (n === 'c' || n === 'g' || n === 'p'))) { this.chosen = null; return true; }
    if (n === 'return') { this.chosen = this.selected; return true; }
    if (n === 'up' || (key.ctrl && n === 'k')) this.move(-1);
    else if (n === 'down' || (key.ctrl && n === 'j') || n === 'tab') this.move(1);
    else if (n === 'pageup') this.move(-10);
    else if (n === 'pagedown') this.move(10);
    else if (n === 'backspace') this.backspace();
    else if (key.ctrl && n === 'u') { this.query = ''; this.refilter(); } else if (key.printable && key.str) this.type(key.str);
    return false;
  }
}

// Shows the picker full-screen and returns the chosen item (or null).
function pick(items, opts) {
  const picker = new Picker(items, opts);
  return fullscreen(() => {
    const reader = new KeyReader(0);
    const draw = () => {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      process.stdout.write(`\x1b[H${picker.render(cols, rows).map((l) => `${l}\x1b[K`).join('\r\n')}\x1b[J`);
    };
    draw();
    for (;;) {
      const key = reader.next();
      if (key.name === 'eof') return null;
      if (picker.handleKey(key)) return picker.chosen;
      draw();
    }
  }, { cursor: false });
}

module.exports = { Picker, pick };
