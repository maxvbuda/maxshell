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

## Interactive shell

maxshell ships its own line editor rather than using Node's `readline`, so the
prompt is a live surface:

**Syntax highlighting as you type.** Commands are resolved against builtins,
functions, aliases and `PATH` while you type — a name that resolves goes green,
one that doesn't goes red, so you see a typo before you run it. Strings are
yellow, `$variables` and `$(substitutions)` cyan, operators magenta, comments
grey.

**Ghost suggestions.** The most recent matching history entry appears dimmed
ahead of the cursor. Press `→` or `ctrl-e` at the end of the line to accept it.

**Git-aware prompt.** Inside a repository the prompt shows the branch plus
markers: `↑2` ahead, `↓1` behind, `+` staged, `!` modified, `?` untracked.
Git state is cached briefly so redrawing stays cheap even in large repos.

**Right-hand prompt.** `RPROMPT` is drawn flush right on the first row and
hidden automatically when the line grows long enough to need the space.

### Keys

| Key | Action |
|---|---|
| `→` / `ctrl-e` | accept the ghost suggestion (at end of line) |
| `tab` | complete; lists candidates when ambiguous |
| `↑` / `↓`, `ctrl-p` / `ctrl-n` | walk history |
| `ctrl-a` / `ctrl-e` | start / end of line |
| `ctrl-b` / `ctrl-f`, `←` / `→` | move by character |
| `alt-b` / `alt-f` | move by word |
| `ctrl-w` | delete previous word |
| `ctrl-u` / `ctrl-k` | kill to start / end of line |
| `ctrl-l` | clear the screen |
| `ctrl-c` | cancel the line |
| `ctrl-d` | exit on an empty line |

### Configuring the prompt

Set `PROMPT` (or `PS1`), `RPROMPT`, and `PS2` for continuation lines — in
`~/.maxshellrc` to make it stick:

```sh
PROMPT='%F{cyan}%~%f%g %# '
RPROMPT='%F{244}%V · %T%f'
PS2='%F{gray}   ...>%f '
```

| Escape | Expands to |
|---|---|
| `%~` / `%d` / `%c` | cwd with `~` / full cwd / basename |
| `%g` | git segment (branch and markers), empty outside a repo |
| `%n` / `%m` / `%M` | user / short host / full host |
| `%T` / `%t` | time `HH:MM` / `HH:MM:SS` |
| `%V` | node version |
| `%?` | last exit status |
| `%#` | `%` normally, `#` for root |
| `%F{name}` … `%f` | colour on / off (name or 0-255) |
| `%B` … `%b`, `%U` … `%u` | bold, underline |

Colour is disabled automatically when output is not a terminal, when `NO_COLOR`
is set, or when `TERM=dumb`. If either stdin or stdout is not a tty, maxshell
falls back to a plain line-buffered REPL.

## pyedit — the built-in Python editor

maxshell ships a nano-style editor tuned for Python. It reuses the shell's own
terminal layer, so there is nothing to install:

```sh
pyedit script.py      # open (or create) a file
pyedit                # start an empty buffer
```

It looks and behaves like nano — modeless, with the shortcut bar along the
bottom — but knows Python:

**Syntax highlighting** for keywords, builtins, constants, numbers, decorators,
comments, and strings, including triple-quoted strings tracked across lines and
`f`/`r`/`b` prefixes.

**Indentation that understands the language.** Enter keeps the current indent
and adds a level after a line ending in `:` or an opening bracket — but not
when that colon is inside a trailing comment. Backspace inside leading
whitespace removes a whole four-space stop rather than one character. `Tab` and
`Shift-Tab` indent and dedent.

**Run without leaving the editor.** `^T` pipes the buffer straight to `python3`
and shows the output in a pager, so you can run code you have not saved yet.

**Syntax check on save.** Writing a `.py` file parses it with `ast.parse` and
reports the first syntax error, with its line number, in the status bar.

**It watches the file.** If another program writes the file while it is open,
pyedit notices within about half a second, without you touching a key. An
untouched buffer is reloaded for you. If you have unsaved edits of your own it
says so in the title bar instead of choosing for you — `^R` takes their
version, and `^O` asks before overwriting it with yours.

### Keys

| Key | Action | Key | Action |
|---|---|---|---|
| `^O` | write the file out | `^X` | exit, offering to save |
| `^T` | run the buffer with python3 | `^G` | help screen |
| `^W` | search | `M-W` | search again |
| `^K` | cut the line (repeat to cut a run) | `^U` | paste |
| `^Z` / `M-U` | undo | `M-E` | redo |
| `^R` | re-read the file from disk | | |
| `M-3` | toggle a `#` comment | `M-N` | toggle line numbers |
| `^A` / `^E` | start / end of line | `^_` | go to line |
| `^Y` / `^V` | page up / down | `^D` | delete character |

`pyedit` needs an interactive terminal; it exits with an error if stdin or
stdout is redirected.

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
| `pyedit` | the built-in Python editor (see above) |

Anything that is not a builtin, function, or alias is run as a real program.

## Project layout

```
bin/maxshell.js     CLI entry point and the interactive loop
src/lexer.js        Tokenizer: words, quoting, operators, here-documents
src/parser.js       Recursive-descent parser producing an AST
src/expand.js       Word expansion: parameters, fields, globbing, patterns
src/arith.js        Arithmetic expression evaluator
src/builtins.js     Builtin commands and test primitives
src/interpreter.js  The Shell: execution, redirection, pipelines, scope
src/signals.js      break / continue / return / exit control-flow signals
src/lineeditor.js   Line editor: keys, history, suggestions, rendering
src/highlight.js    Tolerant syntax highlighter for partial input
src/complete.js     Tab-completion candidates
src/prompt.js       Prompt escape expansion
src/gitprompt.js    Cached git repository status
src/ansi.js         Colour helpers and escape-aware width
src/pyedit.js       nano-style Python editor (buffer model + screen)
src/pyhighlight.js  Python tokenizer and syntax colouring
src/keys.js         Blocking key reader for full-screen editing
examples/demo.mxsh  A tour of the language
test/run.js         Language test suite
test/interactive.js Line editor, highlighter and prompt test suite
test/pyedit.js      Python editor, tokenizer and key reader test suite
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
