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

test('unquoted $v stays one word, as in zsh; ${=v} and shwordsplit split it', () => {
  assert.deepStrictEqual(sh('v="a b c"\nfor x in $v; do echo $x; done'), ['a b c']);
  assert.deepStrictEqual(sh('v="a b c"\nfor x in ${=v}; do echo $x; done'), ['a', 'b', 'c']);
  assert.deepStrictEqual(sh('setopt shwordsplit\nv="a b c"\nfor x in $v; do echo $x; done'), ['a', 'b', 'c']);
  assert.deepStrictEqual(sh('for x in $(echo a b); do echo $x; done'), ['a', 'b']);
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


// --- zsh parity -------------------------------------------------------------

test('brace expansion: lists, ranges, padding, steps, nesting', () => {
  assert.deepStrictEqual(sh('echo {a,b,c} x{1..3} {1..10..4} {05..07} {c..a} {a,{b,c}}d pre{,x}'),
    ['a b c x1 x2 x3 1 5 9 05 06 07 c b a ad bd cd pre prex']);
  assert.deepStrictEqual(sh(`echo "{a,b}" '{c,d}' {a} {}`), ['{a,b} {c,d} {a} {}']);
  assert.deepStrictEqual(sh('for i in {1..3}; do echo -n $i; done; echo'), ['123']);
});

test('arrays keep their elements through quoting and splicing', () => {
  assert.deepStrictEqual(sh('a=(one "two three")\nprintf "[%s]" "${a[@]}"; echo'), ['[one][two three]']);
  assert.deepStrictEqual(sh('a=(one "two three")\nprintf "[%s]" $a; echo'), ['[one][two three]']);
  assert.deepStrictEqual(sh('a=(one two)\nprintf "[%s]" "$a"; echo'), ['[one two]']);
  assert.deepStrictEqual(sh('a=()\necho ${#a}\na+=(x)\na=(0 $a)\necho $a'), ['0', '0 x']);
  assert.deepStrictEqual(sh('a=(1 2 3 4)\na[2,3]=(x)\necho $a\na[1]=()\necho $a'), ['1 x 4', 'x 4']);
  assert.deepStrictEqual(sh('a=(a b c d e)\necho ${a[2,-2]} ${a[(r)c*]} ${a[(i)d]} $#a ${a:1:2}'), ['b c d c 4 5 b c']);
  assert.deepStrictEqual(sh('a=(a b)\necho x${^a}y'), ['xay xby']);
});

test('associative arrays', () => {
  const src = `
    typeset -A h
    h=(one 1 two 2)
    k=three
    h[$k]=3
    echo \${#h} $h[two] \${h[three]} \${+h[one]} \${+h[nope]}
    for k v in \${(kv)h}; do echo $k=$v; done
    unset 'h[one]'
    echo \${(k)h}
  `;
  assert.deepStrictEqual(sh(src), ['3 2 3 1 0', 'one=1', 'two=2', 'three=3', 'two three']);
});

test('parameter flags', () => {
  assert.deepStrictEqual(sh('x=hello\necho ${(U)x} ${(C)${:-hello world}}'), ['HELLO Hello World']);
  assert.deepStrictEqual(sh('a=(c a b b)\necho ${(o)a} ${(O)a} ${(u)a} ${(j:,:)a}'), ['a b b c c b b a c a b c,a,b,b']);
  assert.deepStrictEqual(sh('s=a:b:c\necho ${(s.:.)s[2]} ${${(s.:.)s}[2]} ${#${(s.:.)s}}'), ['b 3']);
  assert.deepStrictEqual(sh('n=7\necho ${(l:3::0:)n} ${(r:4::-:)n}'), ['007 7---']);
  assert.deepStrictEqual(sh('v=HOME\n[[ ${(P)v} == $HOME ]] && echo indirect'), ['indirect']);
  assert.deepStrictEqual(sh('lines=$(printf "a\\nb\\nc")\narr=(${(f)lines})\necho ${#arr}'), ['3']);
});

test('modifiers, bare and braced', () => {
  assert.deepStrictEqual(sh('f=/usr/lib/libz.1.dylib\necho $f:t $f:h ${f:t:r} ${f:e} ${f:h:h:t}'), ['libz.1.dylib /usr/lib libz.1 dylib usr']);
  assert.deepStrictEqual(sh('x=hello\necho ${x:u} ${x:s/l/L/} ${x:gs/l/L/}'), ['HELLO heLlo heLLo']);
  assert.deepStrictEqual(sh('x=/\necho ${x:h} file:h'), ['/ file:h']);
});

test('pattern operators honour anchors and quoting', () => {
  assert.deepStrictEqual(sh('w=word\necho ${w/#w/W} ${w/%d/D} ${w//[ow]/_}'), ['Word worD __rd']);
  assert.deepStrictEqual(sh('x="a*b"\necho ${x#"a*"} ${x#a*}'), ['b *b']);
  assert.deepStrictEqual(sh('set -- a b c d\necho ${@:2} ${*:2:2}'), ['b c d b c']);
});

test("$'...' quoting", () => {
  assert.deepStrictEqual(sh("echo $'a\\tb' $'it\\'s' $'\\x41\\u00e9'"), ['a\tb it\'s Aé']);
});

test('arithmetic: 64-bit, bases, floats, short-circuit, array elements', () => {
  assert.deepStrictEqual(sh('echo $(( 1 << 62 )) $(( 2#101 + 16#ff )) $(( 7 / 2. )) $(( -7 / 2 ))'), ['4611686018427387904 260 3.5 -3']);
  assert.deepStrictEqual(sh('x=0 y=0\n(( x && y++ ))\n(( 1 || y++ ))\necho $y $(( 1 ? 5 : 1/0 ))'), ['0 5']);
  assert.deepStrictEqual(sh('a=(1 2 3)\n(( a[2] += 5 ))\necho $a $(( a[3] * 2 )) $(( $#a ))'), ['1 7 3 6 3']);
  assert.deepStrictEqual(sh('e="2+3"\necho $(( e * 2 ))'), ['10']);
  assert.deepStrictEqual(sh('typeset -A m\nm[x]=1\n(( ${+m[x]} )) && echo has'), ['has']);
});

test('typeset attributes: integer, readonly, case, arrays as arguments', () => {
  assert.deepStrictEqual(sh('integer i=3+4\ni+=2\necho $i\ntypeset -u u=hi\necho $u'), ['9', 'HI']);
  const { shell, lines } = makeShell();
  assert.throws(() => shell.run('readonly r=1\nr=2\necho unreached'), /read-only variable: r/);
  assert.deepStrictEqual(lines, []);
  assert.deepStrictEqual(sh('declare -a z=(1 "2 3")\necho ${#z}\nf() { local -a q=(x y); echo ${#q}; }\nf\necho "[$q]"'), ['2', '2', '[]']);
  assert.deepStrictEqual(sh('f() { typeset x=inner; g; }\ng() { echo $x; }\nx=outer\nf\necho $x'), ['inner', 'outer']);
});

test('the status of x=$(cmd) is the status of cmd', () => {
  assert.deepStrictEqual(sh('x=$(exit 7)\necho $?\ny=$(true)\necho $?'), ['7', '0']);
});

test('[[ ]] patterns and regexes may use parentheses', () => {
  assert.deepStrictEqual(sh('[[ abc =~ ^a(b)c$ ]] && echo $match[1] $MATCH'), ['b abc']);
  assert.deepStrictEqual(sh('[[ foo.ts == *.(js|ts) ]] && echo ext\nv="*"\n[[ x == $v ]] || echo literal'), ['ext', 'literal']);
});

test('case: alternation in patterns, ;& and ;|', () => {
  assert.deepStrictEqual(sh('case foo.h in *.(c|h)) echo csrc;; esac'), ['csrc']);
  assert.deepStrictEqual(sh('case x in x) echo one;| x) echo two;; x) echo no;; esac'), ['one', 'two']);
  assert.deepStrictEqual(sh('case x in x) echo one;& y) echo two;; esac'), ['one', 'two']);
});

test('short loops, repeat, select, always', () => {
  assert.deepStrictEqual(sh('for i (a b) echo $i\nfor ((i=3; i>0; i-=2)) echo $i\nrepeat 2 echo r'), ['a', 'b', '3', '1', 'r', 'r']);
  assert.deepStrictEqual(sh('{ echo try; false } always { echo finally }'), ['try', 'finally']);
  const { shell, lines } = makeShell();
  shell.run('select x in red green; do echo "picked $x"; break; done <<< 2');
  assert.deepStrictEqual(lines, ['picked green']);
});

test("break inside a function ends the caller's loop; at top level it is an error", () => {
  assert.deepStrictEqual(sh('f() { break; }\nfor i in 1 2; do echo $i; f; done\necho end'), ['1', 'end']);
  const { shell, errors } = makeShell();
  assert.strictEqual(shell.run('break'), 1);
  assert.ok(/not in while/.test(errors.join('')));
});

test('traps: EXIT and ERR', () => {
  const { shell, lines } = makeShell();
  shell.run("trap 'echo bye' EXIT\necho main");
  shell.runExitTrap();
  assert.deepStrictEqual(lines, ['main', 'bye']);
  assert.deepStrictEqual(sh("trap 'echo failed' ERR\nfalse\necho on"), ['failed', 'on']);
});

test('getopts walks options with OPTARG and OPTIND', () => {
  assert.deepStrictEqual(sh('while getopts "ab:c" o -a -b val -c rest; do echo "$o ${OPTARG:-}"; done\necho $OPTIND'), ['a ', 'b val', 'c ', '5']);
  assert.deepStrictEqual(sh('set -- -xy\nwhile getopts xy o; do echo $o; done'), ['x', 'y']);
});

test('process substitution', () => {
  assert.deepStrictEqual(sh('cat <(echo from sub)\ndiff <(echo a) <(echo a) && echo same'), ['from sub', 'same']);
  assert.deepStrictEqual(sh('echo hi > >(tr a-z A-Z)'), ['HI']);
});

test('aliases: operators inside, trailing space, global and suffix', () => {
  assert.deepStrictEqual(sh("alias both='echo one && echo two'\nboth"), ['one', 'two']);
  assert.deepStrictEqual(sh("alias e='echo '\nalias w=world\ne w w"), ['world w']);
  assert.deepStrictEqual(sh("alias -g C='| tr a-z A-Z'\necho shout C"), ['SHOUT']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxalias-'));
  fs.writeFileSync(path.join(dir, 'n.txt'), 'note\n');
  assert.deepStrictEqual(sh(`cd ${dir}\nalias -s txt=cat\nn.txt`), ['note']);
});

test('glob qualifiers and alternation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxglob-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.js'), '');
  fs.writeFileSync(path.join(dir, 'b.ts'), '');
  fs.writeFileSync(path.join(dir, '.hidden'), '');
  assert.deepStrictEqual(sh(`cd ${dir}\necho *(/)\necho *(.)\necho *.(js|ts)\necho *(D.)\necho *.none(N) end`),
    ['sub', 'a.js b.ts', 'a.js b.ts', '.hidden a.js b.ts', 'end']);
  assert.deepStrictEqual(sh(`cd ${dir}\nsetopt nullglob\necho x *.none y`), ['x y']);
});

test('cd keeps the logical path and supports cd old new', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mxcd-'));
  fs.mkdirSync(path.join(base, 'real', 'v1'), { recursive: true });
  fs.mkdirSync(path.join(base, 'real', 'v2'), { recursive: true });
  fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
  assert.deepStrictEqual(sh(`cd ${base}/link/v1\npwd\ncd v1 v2\npwd\ncd ..\npwd`), [
    `${base}/link/v1`, `${base}/link/v2`, `${base}/link`,
  ]);
});

test('whence, which, command -v', () => {
  assert.deepStrictEqual(sh('which cd\nwhence -v cd\ncommand -v cd'), ['cd: shell built-in command', 'cd is a shell builtin', 'cd']);
  assert.match(sh('command -v sed')[0], /\/sed$/);
});

test('print, printf -v and %q, echo \\c', () => {
  assert.deepStrictEqual(sh('print -- -n\nprint -rl a b\nprint -f "%s-%s\\n" a b c d'), ['-n', 'a', 'b', 'a-b', 'c-d']);
  assert.deepStrictEqual(sh("printf -v out '%03d' 7\necho $out\nprintf '%q\\n' 'a b'\nprintf '%#x\\n' 255"), ['007', 'a\\ b', '0xff']);
  assert.deepStrictEqual(sh('echo "a\\cb"\necho next'), ['anext']);
});

test('read -A and IFS', () => {
  assert.deepStrictEqual(sh('read -A arr <<< "p q r"\necho ${#arr} $arr[2]\nIFS=: read -r x y <<< "a:b:c"\necho "$x|$y"'), ['3 q', 'a|b:c']);
});

test('setopt and set -o share one set of options', () => {
  const { shell } = makeShell();
  shell.run('set -o errexit\nsetopt no_nomatch pipefail');
  assert.ok(shell.options.has('e') && shell.options.has('pipefail'));
  shell.run('unsetopt ERR_EXIT');
  assert.ok(!shell.options.has('e'));
});

test('auto-cd: a folder on its own goes there, when interactive', () => {
  const lines = [];
  const shell = new Shell({ interactive: true, output: (l) => lines.push(l), error: () => {} });
  shell.run('cd /\nusr\npwd');
  assert.deepStrictEqual(lines, ['/usr']);
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
