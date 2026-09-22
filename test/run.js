'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Shell } = require('../src/interpreter');

function makeShell() {
  const lines = [];
  const errors = [];
  const shell = new Shell({
    output: (l) => lines.push(l),
    error: (l) => errors.push(l),
  });
  return { shell, lines, errors };
}

// Runs shell source and returns the lines written to stdout.
function sh(source) {
  const { shell, lines } = makeShell();
  shell.run(source);
  return lines;
}

// Runs shell source and returns its exit status.
function status(source) {
  const { shell } = makeShell();
  return shell.run(source);
}

let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`not ok - ${name}`);
    console.error(`  ${e.message}`);
  }
}

// --- words, quoting, expansion ---------------------------------------------

test('runs an external command', () => {
  assert.deepStrictEqual(sh('echo hello'), ['hello']);
});

test('variable assignment and expansion', () => {
  assert.deepStrictEqual(sh('name=World\necho "Hello, $name!"'), ['Hello, World!']);
});

test('single quotes suppress expansion', () => {
  assert.deepStrictEqual(sh("x=1\necho '$x'"), ['$x']);
});

test('braces delimit a parameter name', () => {
  assert.deepStrictEqual(sh('a=foo\necho ${a}bar'), ['foobar']);
});

test('default values with :- and :+', () => {
  assert.deepStrictEqual(sh('echo ${missing:-fallback}'), ['fallback']);
  assert.deepStrictEqual(sh('set_var=yes\necho ${set_var:+present}'), ['present']);
});

test('assign-if-unset with :=', () => {
  assert.deepStrictEqual(sh('echo ${v:=init}\necho $v'), ['init', 'init']);
});

test('length, prefix and suffix removal', () => {
  const src = `
    file=archive.tar.gz
    echo \${#file}
    echo \${file%%.*}
    echo \${file%.gz}
    echo \${file#*.}
    echo \${file##*.}
  `;
  assert.deepStrictEqual(sh(src), ['14', 'archive', 'archive.tar', 'tar.gz', 'gz']);
});

test('pattern substitution', () => {
  const src = `
    s=one-two-one
    echo \${s/one/1}
    echo \${s//one/1}
  `;
  assert.deepStrictEqual(sh(src), ['1-two-one', '1-two-1']);
});

test('substring expansion', () => {
  assert.deepStrictEqual(sh('s=abcdef\necho ${s:1:3}'), ['bcd']);
});

test('command substitution', () => {
  assert.deepStrictEqual(sh('echo "today is $(echo Tuesday)"'), ['today is Tuesday']);
  assert.deepStrictEqual(sh('echo `echo backticks`'), ['backticks']);
});

test('field splitting of unquoted expansions', () => {
  assert.deepStrictEqual(sh('v="a b c"\nfor x in $v; do echo $x; done'), ['a', 'b', 'c']);
});

test('quoting prevents field splitting', () => {
  assert.deepStrictEqual(sh('v="a b c"\nfor x in "$v"; do echo $x; done'), ['a b c']);
});

// --- arithmetic -------------------------------------------------------------

test('arithmetic expansion', () => {
  assert.deepStrictEqual(sh('echo $((2 + 3 * 4))'), ['14']);
  assert.deepStrictEqual(sh('echo $((10 / 3))'), ['3']);
  assert.deepStrictEqual(sh('echo $((2 ** 10))'), ['1024']);
});

test('arithmetic command assigns and sets status', () => {
  assert.deepStrictEqual(sh('(( x = 5 + 5 ))\necho $x'), ['10']);
  assert.strictEqual(status('(( 1 ))'), 0);
  assert.strictEqual(status('(( 0 ))'), 1);
});

test('arithmetic reads and writes shell variables', () => {
  assert.deepStrictEqual(sh('n=4\necho $(( n * n ))'), ['16']);
});

// --- arrays -----------------------------------------------------------------

test('arrays are 1-indexed like zsh', () => {
  const src = `
    fruits=(apple banana cherry)
    echo $fruits[1]
    echo \${fruits[2]}
    echo \${#fruits}
  `;
  assert.deepStrictEqual(sh(src), ['apple', 'banana', '3']);
});

test('a bare array name expands to all elements', () => {
  assert.deepStrictEqual(sh('a=(x y z)\nfor e in $a; do echo $e; done'), ['x', 'y', 'z']);
});

test('appending to an array', () => {
  assert.deepStrictEqual(sh('a=(1 2)\na+=(3)\necho ${#a}\necho $a[3]'), ['3', '3']);
});

// --- control flow -----------------------------------------------------------

test('if / elif / else', () => {
  const src = `
    classify() {
      if [[ $1 -gt 10 ]]; then
        echo big
      elif [[ $1 -gt 0 ]]; then
        echo medium
      else
        echo small
      fi
    }
    classify 20
    classify 5
    classify -1
  `;
  assert.deepStrictEqual(sh(src), ['big', 'medium', 'small']);
});

test('while loop', () => {
  const src = `
    i=0
    while (( i < 3 )); do
      echo $i
      (( i++ ))
    done
  `;
  assert.deepStrictEqual(sh(src), ['0', '1', '2']);
});

test('until loop', () => {
  assert.deepStrictEqual(sh('i=0\nuntil (( i >= 2 )); do echo $i; (( i++ )); done'), ['0', '1']);
});

test('C-style for loop', () => {
  assert.deepStrictEqual(sh('for ((i=0; i<3; i++)); do echo $i; done'), ['0', '1', '2']);
});

test('for-in with break and continue', () => {
  const src = `
    for n in 1 2 3 4 5; do
      if (( n == 2 )); then continue; fi
      if (( n == 4 )); then break; fi
      echo $n
    done
  `;
  assert.deepStrictEqual(sh(src), ['1', '3']);
});

test('repeat loop', () => {
  assert.deepStrictEqual(sh('repeat 3 do echo hi; done'), ['hi', 'hi', 'hi']);
});

test('foreach ... end (zsh style)', () => {
  assert.deepStrictEqual(sh('foreach x (a b) echo $x; end'), ['a', 'b']);
});

test('case with alternation and a default', () => {
  const src = `
    match() {
      case $1 in
        yes|y) echo affirmative ;;
        n*)    echo negative ;;
        *)     echo unknown ;;
      esac
    }
    match y
    match nope
    match maybe
  `;
  assert.deepStrictEqual(sh(src), ['affirmative', 'negative', 'unknown']);
});

// --- functions --------------------------------------------------------------

test('functions take positional parameters', () => {
  assert.deepStrictEqual(sh('greet() { echo "hi $1 and $2"; }\ngreet a b'), ['hi a and b']);
});

test('function keyword form', () => {
  assert.deepStrictEqual(sh('function f { echo called; }\nf'), ['called']);
});

test('return sets the exit status', () => {
  assert.strictEqual(status('f() { return 3; }\nf'), 3);
});

test('local variables do not leak', () => {
  const src = `
    x=outer
    f() { local x=inner; echo $x; }
    f
    echo $x
  `;
  assert.deepStrictEqual(sh(src), ['inner', 'outer']);
});

test('recursion works', () => {
  const src = `
    fact() {
      if (( $1 <= 1 )); then echo 1; return; fi
      local prev=$(fact $(( $1 - 1 )))
      echo $(( $1 * prev ))
    }
    fact 5
  `;
  assert.deepStrictEqual(sh(src), ['120']);
});

// --- conditionals -----------------------------------------------------------

test('[[ ]] string and pattern comparison', () => {
  assert.strictEqual(status('[[ abc == a* ]]'), 0);
  assert.strictEqual(status('[[ abc == b* ]]'), 1);
  assert.strictEqual(status('[[ abc != b* ]]'), 0);
  assert.strictEqual(status('[[ -z "" && -n x ]]'), 0);
});

test('[[ ]] numeric comparison and negation', () => {
  assert.strictEqual(status('[[ 5 -gt 3 ]]'), 0);
  assert.strictEqual(status('[[ ! 5 -gt 3 ]]'), 1);
});

test('test builtin and [ ]', () => {
  assert.strictEqual(status('test 1 -eq 1'), 0);
  assert.strictEqual(status('[ 1 -eq 2 ]'), 1);
  assert.strictEqual(status('[ -d . ]'), 0);
});

// --- lists, pipelines, status ----------------------------------------------

test('&& and || short-circuit', () => {
  assert.deepStrictEqual(sh('true && echo yes'), ['yes']);
  assert.deepStrictEqual(sh('false && echo no'), []);
  assert.deepStrictEqual(sh('false || echo recovered'), ['recovered']);
});

test('pipelines pass stdout along', () => {
  assert.deepStrictEqual(sh("printf 'pear\\napple\\nfig\\n' | sort | head -n 1"), ['apple']);
});

test('pipeline status is the last command', () => {
  assert.strictEqual(status('true | false'), 1);
  assert.strictEqual(status('false | true'), 0);
});

test('! negates a pipeline', () => {
  assert.strictEqual(status('! false'), 0);
});

test('$? reports the previous status', () => {
  assert.deepStrictEqual(sh('false\necho $?\ntrue\necho $?'), ['1', '0']);
});

test('unknown command reports 127', () => {
  const { shell } = makeShell();
  assert.strictEqual(shell.run('definitely-not-a-real-command-xyz'), 127);
});

// --- redirection ------------------------------------------------------------

test('redirect to a file and read it back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxshell-'));
  const file = path.join(dir, 'out.txt');
  const src = `
    echo first > ${file}
    echo second >> ${file}
    cat < ${file}
  `;
  assert.deepStrictEqual(sh(src), ['first', 'second']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('here-document expands parameters', () => {
  const src = `
    who=world
    cat <<EOF
hello $who
EOF
  `;
  assert.deepStrictEqual(sh(src), ['hello world']);
});

test('quoted here-document delimiter disables expansion', () => {
  const src = `
    who=world
    cat <<'EOF'
hello $who
EOF
  `;
  assert.deepStrictEqual(sh(src), ['hello $who']);
});

test('here-string feeds stdin', () => {
  assert.deepStrictEqual(sh('cat <<< "a line"'), ['a line']);
});

test('stdout redirected to /dev/null is discarded', () => {
  assert.deepStrictEqual(sh('echo hidden > /dev/null'), []);
});

// --- builtins ---------------------------------------------------------------

test('cd changes the working directory', () => {
  const { shell, lines } = makeShell();
  shell.run('cd test\npwd\ncd ..\npwd');
  assert.strictEqual(lines[0], fs.realpathSync(path.resolve(__dirname)));
  assert.strictEqual(lines[1], fs.realpathSync(path.resolve(__dirname, '..')));
});

test('export makes a variable visible to children', () => {
  assert.deepStrictEqual(sh('export GREETING=hi\nprintenv GREETING'), ['hi']);
});

test('assignment prefix applies only to that command', () => {
  assert.deepStrictEqual(sh('X=once printenv X\necho "after=$X"'), ['once', 'after=']);
});

test('alias expands the first word', () => {
  assert.deepStrictEqual(sh('alias ll="echo aliased"\nll'), ['aliased']);
});

test('shift drops positional parameters', () => {
  assert.deepStrictEqual(sh('f() { shift; echo $1; }\nf a b'), ['b']);
});

test('read consumes a line from stdin', () => {
  assert.deepStrictEqual(sh('echo "one two" | { read a b; echo "$b-$a"; }'), ['two-one']);
});

test('printf formats its arguments', () => {
  assert.deepStrictEqual(sh("printf '%s=%d\\n' width 42"), ['width=42']);
  assert.deepStrictEqual(sh("printf '%-5s|\\n' ab"), ['ab   |']);
});

test('echo -n suppresses the trailing newline', () => {
  assert.deepStrictEqual(sh('echo -n a\necho b'), ['ab']);
});

test('type identifies builtins, functions, and aliases', () => {
  const src = `
    f() { :; }
    alias a=ls
    type cd
    type f
    type a
  `;
  assert.deepStrictEqual(sh(src), [
    'cd is a shell builtin',
    'f is a shell function',
    'a is an alias for ls',
  ]);
});

test('eval runs a constructed command', () => {
  assert.deepStrictEqual(sh('cmd="echo built"\neval $cmd'), ['built']);
});

test('subshell changes do not escape', () => {
  assert.deepStrictEqual(sh('x=outer\n( x=inner; echo $x )\necho $x'), ['inner', 'outer']);
});

test('grouping shares the enclosing shell', () => {
  assert.deepStrictEqual(sh('{ y=set; }\necho $y'), ['set']);
});

// --- globbing ---------------------------------------------------------------

test('globs expand against the filesystem', () => {
  const { shell, lines } = makeShell();
  shell.run(`cd ${path.resolve(__dirname, '..')}\nfor f in src/*.js; do echo $f; done`);
  assert.ok(lines.includes('src/lexer.js'), `expected src/lexer.js in ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('src/parser.js'));
});

test('a glob with no matches stays literal', () => {
  assert.deepStrictEqual(sh('echo /nonexistent-dir-xyz/*.none'), ['/nonexistent-dir-xyz/*.none']);
});

// --- errors -----------------------------------------------------------------

test('syntax errors are reported, not crashes', () => {
  const { shell } = makeShell();
  assert.throws(() => shell.run('if true; then'), /unexpected end of input|syntax error/);
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
