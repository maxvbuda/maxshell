# maxshell

A shell language in the zsh/bash family, implemented from scratch in Node.js.

maxshell is not a wrapper around `/bin/zsh`. It has its own lexer, recursive-descent
parser, word-expansion engine, arithmetic evaluator, and tree-walking interpreter.
It runs real programs with `child_process`, but every piece of *language* —
quoting, expansion, pipelines, redirection, control flow, functions — is
implemented here.

```sh
maxshell %~ % for f in src/*.js; do
   ...>   echo "${f:t} has $(wc -l < $f | tr -d ' ') lines"
   ...> done
```

## Install / run

```sh
npm install -g .        # exposes the `maxshell` command
# or, without installing:
node bin/maxshell.js
```

## Usage

```sh
maxshell                      # interactive shell
maxshell script.mxsh a b c    # run a script with arguments
maxshell -c 'echo hello'      # run one command
maxshell --version
```

The interactive shell reads `~/.maxshellrc` at startup and saves input to
`~/.maxshell_history`. Tab completion works for commands and file paths.

## The language

### Commands, pipelines, and lists

```sh
ls -la                      # run a program
sort file | uniq -c | head  # pipeline
cmd |& grep error           # pipe stdout *and* stderr
make && ./run || echo fail  # run on success / on failure
a; b; c                     # sequence
sleep 5 &                   # background
! grep -q foo file          # negate the exit status
```

### Redirection

```sh
echo hi > out.txt        # truncate
echo hi >> out.txt       # append
wc -l < in.txt           # stdin from a file
cmd 2> errors.txt        # stderr only
cmd &> all.txt           # stdout and stderr
cmd 2>&1 | less          # merge stderr into stdout
cat <<< "a here-string"

cat <<EOF                # here-document (expands $vars)
home is $HOME
EOF

cat <<'EOF'              # quoted delimiter: no expansion
literal $HOME
EOF
```

### Variables and parameter expansion

```sh
name=World               # assignment (no spaces around =)
greeting="Hi, $name"
export PATH="$PATH:$HOME/bin"
readonly=no local=yes    # ordinary names, nothing special

echo $name  ${name}      # expand
echo "${name:-default}"  # default if unset or empty
echo "${name:=default}"  # assign a default
echo "${name:+set}"      # alternate value if set
echo "${name:?message}"  # error if unset
echo ${#name}            # length
echo ${name#prefix}      # remove shortest prefix     (## = longest)
echo ${name%suffix}      # remove shortest suffix     (%% = longest)
echo ${name/a/b}         # replace first              (// = all)
echo ${name:2:3}         # substring
```

Special parameters: `$?` (last exit status), `$#` (argument count), `$@` and
`$*` (all arguments), `$0`–`$9` (positional), `$$` (pid), `$!` (last background
pid), `$RANDOM`, `$SECONDS`, `$PWD`, `$OLDPWD`.

### Arrays

Arrays are **1-indexed**, as in zsh, and a bare array name expands to all of its
elements:

```sh
fruits=(apple banana cherry)
echo $fruits[2]           # banana
echo ${fruits[2]}         # banana
echo ${fruits[-1]}        # cherry
echo ${#fruits}           # 3
fruits+=(date)            # append
for f in $fruits; do echo $f; done
```

### Arithmetic

```sh
echo $((2 + 3 * 4))       # arithmetic expansion
(( count = 10 ))          # arithmetic command; status 0 if non-zero
(( count++ ))
if (( count > 5 )); then echo big; fi
let 'x = 3 * 3'
```

Supports `+ - * / % **`, comparisons, `&& || !`, bitwise `& | ^ ~ << >>`,
`?:`, and assignment forms like `+=` and `++`. Integer division truncates.

### Conditionals

```sh
if [[ -f config && $mode == prod* ]]; then
  echo ready
elif [[ -d config ]]; then
  echo directory
else
  echo missing
fi
```

`[[ ... ]]` supports file tests (`-e -f -d -r -w -x -s -L`), string tests
(`-z -n`), pattern matching (`==` and `!=` treat the right side as a glob),
regex matching (`=~`), numeric comparison (`-eq -ne -lt -le -gt -ge`), file
comparison (`-nt -ot -ef`), grouping with `( )`, and `! && ||`.

The POSIX `test` / `[ ... ]` builtins are available too.

### Loops

```sh
for x in a b c; do echo $x; done
for x (a b c) { echo $x }           # zsh short forms
foreach x (a b c) echo $x; end
for ((i = 0; i < 10; i++)); do echo $i; done
while read -r line; do echo "> $line"; done < input.txt
until (( done )); do work; done
repeat 3 do echo again; done
```

`break` and `continue` accept a level count (`break 2`).

### case

```sh
case $answer in
  yes|y)  echo affirmative ;;
  n*)     echo negative ;;
  *)      echo unknown ;;
esac
```

### Functions

```sh
greet() {
  local who=${1:-world}
  echo "hello, $who"
  return 0
}

function shout {
  echo "$1!!!"
}

greet maxshell
```

Functions get their own positional parameters (`$1`, `$@`, `$#`) and can declare
`local` variables. `return` exits a function with a status.

### Grouping and subshells

```sh
{ echo a; echo b; } > both.txt    # same shell
( cd /tmp; pwd )                  # subshell: cd doesn't escape
```

### Globbing

`*`, `?`, `[abc]`, `[!abc]`, alternation `(a|b)`, and recursive `**/` are
expanded against the filesystem. A pattern with no matches is left alone.

## Builtins

| Builtin | Purpose |
|---|---|
| `cd`, `pwd`, `pushd`, `popd`, `dirs` | directory navigation and the directory stack |
| `echo`, `print`, `printf` | output (`echo` interprets `\n`-style escapes, like zsh) |
| `export`, `unset`, `declare`, `typeset`, `local` | variable scope and environment |
| `alias`, `unalias` | command aliases |
| `source` / `.`, `eval`, `command` | run code from a file, a string, or bypassing functions |
| `read` | read a line of stdin into variables |
| `set`, `shift` | shell options (`-e`, `-u`, `-x`, `-o pipefail`) and positional parameters |
| `test`, `[`, `let` | conditionals and arithmetic |
| `true`, `false`, `:` | trivial exit statuses |
| `type`, `whence`, `which` | what does this name refer to? |
| `history`, `jobs`, `help` | session information |
| `break`, `continue`, `return`, `exit` | control flow |
| `unfunction` | remove a function |

Anything that is not a builtin, function, or alias is run as a real program.

## Project layout

```
bin/maxshell.js     CLI entry point, REPL, tab completion
src/lexer.js        Tokenizer: words, quoting, operators, here-documents
src/parser.js       Recursive-descent parser producing an AST
src/expand.js       Word expansion: parameters, fields, globbing, patterns
src/arith.js        Arithmetic expression evaluator
src/builtins.js     Builtin commands and test primitives
src/interpreter.js  The Shell: execution, redirection, pipelines, scope
src/signals.js      break / continue / return / exit control-flow signals
examples/demo.mxsh  A tour of the language
test/run.js         Test suite (npm test)
```

## Differences from zsh

- Arrays are 1-indexed and bare `$arr` expands to all elements (zsh behaviour),
  not bash behaviour.
- Pipelines run stage by stage: each stage completes before the next starts, so
  output is buffered rather than streamed. Interactive programs work when run on
  their own, not in the middle of a pipeline.
- Background jobs (`&`) start a detached process; there is no job control
  (`fg`, `bg`, `%1`).
- Not implemented: `trap`, `getopts`, process substitution `<(...)`, coprocesses,
  zsh glob qualifiers, and zsh's parameter expansion flags like `${(U)x}`.

## License

MIT
