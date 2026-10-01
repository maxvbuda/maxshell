'use strict';

// Helpers for the exercise files: one task, a Python and a JavaScript
// program, the exact output each prints, and many ways to ask for it — so
// the model learns the skill, not one phrasing.

const thirdPerson = (task) => task.replace(/^(\w+)/, (v) => {
  if (/(s|sh|ch|x|z|o)$/.test(v)) return `${v}es`;
  if (/[^aeiou]y$/.test(v)) return `${v.slice(0, -1)}ies`;
  return `${v}s`;
});

function asksFor(task) {
  const does = thirdPerson(task);
  return [
    `write a function that ${does}`,
    `write a {lang} function that ${does}`,
    `how do i ${task} in {lang}?`,
    `${task} in {lang}`,
    `can you write code to ${task}?`,
    `make a {lang} function which ${does}`,
    `i need a function that ${does}`,
    `show me how to ${task} in {lang}`,
    `{lang} code to ${task}`,
    `write a program to ${task}`,
    `function to ${task}`,
    `how would you ${task} in {lang}`,
    `code that ${does}`,
    `help me ${task} with {lang}`,
    `can you code something that ${does}?`,
    `how can i ${task} using {lang}?`,
  ];
}

// ex('add two numbers', py, js, '5\n', { python: 'explain', javascript: 'explain' })
// `out` is the same for both languages, or { python, javascript }.
function ex(task, py, js, out, explain, extra = {}) {
  const outFor = (lang) => (typeof out === 'string' ? out : out[lang]);
  const why = (lang) => (typeof explain === 'string' ? explain : explain[lang]);
  return {
    task,
    asks: asksFor(task),
    impls: {
      python: { code: py.replace(/^\n/, ''), explain: why('python'), run: { ...extra, out: outFor('python') } },
      javascript: { code: js.replace(/^\n/, ''), explain: why('javascript'), run: { ...extra, out: outFor('javascript') } },
    },
  };
}

module.exports = { ex, asksFor, thirdPerson };
