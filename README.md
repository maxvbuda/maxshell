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
git clone https://github.com/maxvbuda/maxshell
cd maxshell
./install.sh
```

`install.sh` checks for Node.js (16 or newer), installs the `maxshell`
command, and offers to make maxshell **your default shell**, so every new
terminal window opens in it. If you skip that — or install another way, e.g.
`npm install -g .` — maxshell asks once, the first time you start it, and
`maxshell --make-default` does it any time.

Making it the default writes a small login wrapper (`~/.maxshell/bin/maxshell`)
that starts maxshell with the Node you have now — and falls back to zsh if
Node or maxshell ever goes missing, so you're never locked out of the
terminal. It's added to `/etc/shells` (your password, for `sudo`) and set
with `chsh`. Your current `PATH` is saved in `~/.maxshell_profile`, which a
login maxshell loads, so Homebrew and your other tools stay on hand. To go
back: `chsh -s /bin/zsh`.

## Usage

```sh
maxshell                      # interactive shell
maxshell script.mxsh a b c    # run a script with arguments
maxshell -c 'echo hello'      # run one command
maxshell -l                   # a login shell (also -lc, -i, as zsh accepts)
maxshell --make-default       # make it your login shell
maxshell --version
```

A login shell loads the system `PATH` and `~/.maxshell_profile` first. The
interactive shell reads `~/.maxshellrc` at startup and saves input to
`~/.maxshell_history`. Tab completion works for commands and file paths.

## The look

maxshell greets you with its logo painted in the current theme's gradient,
plus a tip about something it can do:

```
  █▀▄▀█ ▄▀█ ▀▄▀ █▀ █ █ █▀▀ █   █      maxshell 0.28.0 · theme maxshell
  █ ▀ █ █▀█ █ █ ▄█ █▀█ ██▄ █▄▄ █▄▄    tip: j cook jumps to the folder you use most
```

### The prompt

The default prompt is one line: the folder you're in and its git state, then
a `❯` that turns the theme's error colour when the last command failed.

```
~/maxshell · main !? ❯ git status                 📦 v0.28.0 · ⬢ 25.1.0 · 12:04
```

maxshell also tells the terminal where you are, so the window or tab title
shows the folder, and a new tab (⌘T) opens in the same folder, as it does
with zsh.

The right side is **context-aware**, like Starship: it shows a tool's version
only inside projects that use it — ⬢ Node (and the 📦 package version) where
there's a `package.json`, 🐍 Python with the active virtualenv, 🦀 Rust, 🐹 Go,
💎 Ruby, 🐳 Docker — plus `took 4.2s` after a slow command, and the time.
Outside any project it's just the time. Long paths shorten fish-style
(`~/p/w/src`) so there's room to type, and if the window is narrow the modules
give way before the time does; the right side also hides itself when your
command grows long enough to need the space.

Once you press Enter the right side is dropped, so scrollback reads as a
clean list of what you ran:

```
~/maxshell ❯ git status
~/maxshell ❯ npm test
```

Set your own `PROMPT` (or `PS1`) and maxshell uses that instead; theme colour
names work in it, e.g. `PROMPT='%F{accent}%~%f %# '`.

### Themes

```sh
theme            # list them all, each with a live preview
theme nord       # switch everywhere, and remember it
```

| Theme | |
|---|---|
| `maxshell` | electric cyan to magenta — the house style |
| `dracula` | purple, pink and neon green on dark |
| `nord` | cool arctic blues and frost |
| `gruvbox` | warm retro yellows, oranges and olive |
| `solarized` | the precise, balanced classic |
| `tokyo-night` | city-light blues and violets |
| `sunset` | golden hour: amber, coral and rose |
| `mono` | no colour, just weight and shade |

A theme restyles everything at once: the logo, the prompt, command-line
highlighting, `Ctrl-R`, code in `edit` and `view`, and the bars, selection and
**folder icons** in `files`, `top` and `gitui`. The choice is saved to
`~/.maxshell_theme`; `MAXSHELL_THEME=nord maxshell` tries one for a single
session. `BANNER=off` in `~/.maxshellrc` (or `MAXSHELL_BANNER=0`) skips the
logo.

## The language

### Commands, pipelines, and lists

```sh
ls -la                      # run a program
sort file | uniq -c | head  # pipeline
tail -f log | grep error    # pipelines stream
cmd |& grep error           # pipe stdout *and* stderr
make && ./run || echo fail  # run on success / on failure
a; b; c                     # sequence
sleep 5 &                   # background
! grep -q foo file          # negate the exit status
```

Pipelines of programs run concurrently and stream, like any shell; builtins
and functions in a pipeline (`… | while read line; do …; done`) run in
maxshell itself, so variables they set are still there afterwards, as in
zsh. `$pipestatus` holds every stage's status.

### Jobs

At the prompt, **`Ctrl-Z` suspends** whatever is running — an editor, a
build, a whole pipeline — and gives you the prompt back:

```sh
vim notes.md      # …Ctrl-Z
jobs              # [1]  + suspended  vim notes.md
bg                # carry on in the background   (bg %2, %vim, %?notes)
fg                # back to the foreground; %1 on its own does the same
kill %1           # signal a job;  wait waits for them;  disown forgets one
```

`Ctrl-C` stops the command in front of you *and the rest of the line* — a
loop, or the commands after `;` — rather than just one step of it. Anything
can go in the background, loops and groups included (`{ make; say done } &`).
When a background job finishes, the next prompt says so. Leaving with
suspended jobs warns once first.

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

As in zsh, an unquoted `$name` is **one word** — it isn't split on spaces or
globbed — so filenames with spaces just work. Ask for splitting with `${=name}`
and globbing with `${~name}`, or `setopt shwordsplit` for the bash behaviour.

zsh's extras all work:

```sh
echo ${name:u} ${name:l}          # upper / lower case
echo $file:t $file:h $file:r $file:e   # tail, head, root, extension
echo ${file:t:r} ${path:gs/\//:/}  # chain them; :s/old/new/ substitutes
echo ${+name}                     # 1 if set, 0 if not
echo ${${name#pre}%suf}           # nest expansions
echo ${(U)x} ${(L)x} ${(C)x}      # flags: case,
echo ${(j:,:)arr} ${(s:,:)str}    # join / split,
echo ${(o)arr} ${(O)arr} ${(u)arr}  # sort, reverse sort, unique,
echo ${(f)"$(cmd)"}               # lines, ${(k)h} keys, ${(kv)h} pairs,
echo ${(l:5::0:)n}                # pad, ${(q)x} quote, ${(P)x} indirect
echo x${^arr}y                    # combine with each element
```

Special parameters: `$?` (last exit status), `$#` (argument count), `$@` and
`$*` (all arguments), `$0`–`$9` (positional), `$$` (pid), `$!` (last background
pid), `$RANDOM`, `$SECONDS`, `$EPOCHSECONDS`, `$PWD`, `$OLDPWD`.

### Brace expansion

```sh
echo {a,b,c}.txt          # a.txt b.txt c.txt
mkdir -p src/{lib,test}   # nests and combines
echo {1..10..3} {05..07}  # 1 4 7 10  05 06 07
echo {a..e}               # a b c d e
```

### Quoting

`'single'` is literal, `"double"` expands, `\x` escapes one character, and
`$'…'` understands escapes: `$'tab\there'`, `$'\x41'`, `$'\u00e9'`.

### Arrays

Arrays are **1-indexed**, as in zsh, and a bare array name expands to all of its
elements:

```sh
fruits=(apple banana cherry)
echo $fruits[2]           # banana
echo ${fruits[-1]}        # cherry
echo ${fruits[2,3]}       # banana cherry  (a range)
echo ${#fruits} $#fruits  # 3 3
echo ${fruits[(i)cherry]} # 3  (find: (i) index, (r) value)
fruits+=(date)            # append
fruits[2,3]=(kiwi)        # replace a slice
for f in $fruits; do echo $f; done
for k v in a 1 b 2; do echo $k=$v; done   # several at a time
```

Associative arrays:

```sh
typeset -A color
color=(apple red banana yellow)
color[kiwi]=green
echo $color[apple] ${(k)color} ${#color}
for fruit c in ${(kv)color}; do echo "$fruit is $c"; done
```

`typeset` (also `local`, `declare`) sets attributes: `-a` array, `-A`
associative, `-i` integer (`integer n=2+3`), `-F` float, `-r` read-only
(`readonly`), `-x` export, `-l`/`-u` lower/upper case, `-g` global; inside a
function it declares locals.

### Arithmetic

```sh
echo $((2 + 3 * 4))       # arithmetic expansion
(( count = 10 ))          # arithmetic command; status 0 if non-zero
(( count++ ))
if (( count > 5 )); then echo big; fi
let 'x = 3 * 3'
```

Supports `+ - * / % **`, comparisons, `&& || !` (short-circuiting), bitwise
`& | ^ ~ << >>`, `?:`, assignment forms like `+=` and `++`, array elements
(`(( a[2] += 1 ))`), and numbers in any base (`16#ff`, `2#1010`, `0x1f`).
Integers are 64-bit, as in zsh; a float anywhere (`7 / 2.`) gives a float.

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
(`-z -n -v`), pattern matching (`==` and `!=` treat the right side as a glob,
with alternation: `[[ $f == *.(js|ts) ]]`), regex matching (`=~`, setting
`$MATCH` and `$match`), numeric comparison (`-eq -ne -lt -le -gt -ge`), file
comparison (`-nt -ot -ef`), grouping with `( )`, and `! && ||`.

The POSIX `test` / `[ ... ]` builtins are available too.

### Loops

```sh
for x in a b c; do echo $x; done
for x (a b c) { echo $x }           # zsh short forms
foreach x (a b c) echo $x; end
for x (a b c) echo $x               # one command, no do/done
for ((i = 0; i < 10; i++)); do echo $i; done
while read -r line; do echo "> $line"; done < input.txt
until (( done )); do work; done
repeat 3 echo again
select color in red green blue; do echo $color; break; done
```

`break` and `continue` accept a level count (`break 2`).

### case

```sh
case $answer in
  yes|y)  echo affirmative ;;
  n*)     echo negative ;;
  *.(c|h)) echo C source ;;
  *)      echo unknown ;;
esac
```

`;;` ends a branch, `;&` falls into the next one, and `;|` carries on testing
the patterns that follow.

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
{ risky } always { cleanup }      # cleanup runs whatever happens
```

### Process substitution

```sh
diff <(sort a.txt) <(sort b.txt)  # a command's output as a file
make 2> >(grep error)             # a file whose contents go to a command
```

### Aliases

```sh
alias gs='git status && git log --oneline -3'   # operators are fine
alias -g L='| less'               # global: ls -l L
alias -s md=edit                  # suffix: notes.md opens in edit
```

### Traps and options

```sh
trap 'rm -f $tmp' EXIT            # also ERR, INT, TERM, …
while getopts "vo:" opt; do …; done
setopt nullglob autocd            # zsh option names; set -o works too
```

### Globbing

`*`, `?`, `[abc]`, `[!abc]`, alternation `src/(lexer|parser).js`, and
recursive `**/` are expanded against the filesystem. zsh's **glob
qualifiers** filter and sort the matches:

```sh
ls -d *(/)          # folders          *(.) files, *(@) links, *(*) executables
echo *(om[1,3])     # the three newest (o sorts: n name, m modified, L size)
echo *(D)           # include dotfiles
echo *.bak(N)       # nothing (instead of the pattern) when nothing matches
```

A pattern with no matches is left alone (`setopt nullglob` removes it,
`setopt nomatch` makes it an error).

### Directories

`cd` keeps the path as you typed it, symlinks and all (`cd -P` resolves
them), `cd old new` swaps part of the current path (`~/v1/src` →
`~/v2/src`), `CDPATH` is searched for relative names, and a `chpwd`
function runs after every change. At the prompt, **typing a folder's name on
its own goes there** (`..`, `~/code`, `src`) — `unsetopt autocd` turns that
off.

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
| `tab` | complete — a menu when there are several choices |
| `↑` / `↓`, `ctrl-p` / `ctrl-n` | walk history; with something typed, only commands that start with it |
| `ctrl-r` | fuzzy history search |
| `ctrl-p` | the command palette |
| `alt-h` | explain the line before running it |
| `alt-s` | save the line as a snippet |
| `ctrl-a` / `ctrl-e` | start / end of line |
| `ctrl-b` / `ctrl-f`, `←` / `→` | move by character |
| `alt-b` / `alt-f`, `ctrl-←` / `ctrl-→` | move by word |
| `ctrl-w` / `alt-backspace` | delete the previous word / path segment |
| `ctrl-u` / `ctrl-k` | kill to start / end of line |
| `ctrl-y` | paste back what was last killed |
| `ctrl-z` (or `ctrl-_`) | undo — while a command is running, `ctrl-z` still suspends it |
| `alt-.` | insert the last word of the previous command (repeat to go further back) |
| `alt-u` / `alt-l` / `alt-c` | upper / lower / capitalise the next word |
| `ctrl-t` | swap the two characters at the cursor |
| `alt-enter` | a newline without running |
| `ctrl-l` | clear the screen |
| `ctrl-c` | cancel the line |
| `ctrl-d` | exit on an empty line |

**Paste safely.** A pasted block goes onto the line as one edit, newlines and
all, and runs only when you press Enter.

**Pairs.** Typing `"`, `'`, `(`, `[` or `{` at the end of a word adds its
partner; typing the partner steps over it, and Backspace on an empty pair
removes both. `AUTOPAIR=off` in `~/.maxshellrc` turns this off.

**Abbreviations**, as in fish: `abbr gco='git checkout'` makes `gco` expand
in place when you press space or Enter, so what you see (and what history
keeps) is the real command. `abbr` lists them, `abbr -e gco` removes one.

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

## edit / pyedit — the built-in editor

maxshell ships a nano-style editor. It reuses the shell's own terminal layer,
so there is nothing to install:

```sh
edit app.js           # language picked from the extension or #! line
edit --lang=sh deploy # or forced: py, js, cpp, c, sh, json, md
pyedit script.py      # the same editor, always in Python mode
```

It knows **Python, JavaScript, C, C++, shell, JSON and Markdown**. Each
language brings its own highlighting, its own rule for where Enter adds an
indent (`:` in Python, `{` in JavaScript and C/C++, `then`/`do` in shell), its
own comment marker for `M-3`, its own way to run for `^T`, and its own syntax
check on save:

| Language | Extensions | `^T` runs it with | Checked on save by |
|---|---|---|---|
| Python | `.py` | `python3` | `ast.parse` |
| JavaScript | `.js` `.mjs` `.cjs` | `node` | `node --check` |
| C++ | `.cpp` `.cc` `.cxx` `.hpp` `.h` … | compiles with `c++`, runs the binary | `c++ -fsyntax-only` |
| C | `.c` | compiles with `cc`, runs the binary | `cc -fsyntax-only` |
| shell | `.sh` `.zsh` `.mxsh` | maxshell | maxshell's parser |
| JSON | `.json` | — | `JSON.parse` |
| Markdown | `.md` | — | — |

C and C++ are compiled into a scratch directory and the binary is run from
your current directory; the file's own folder is on the include path, so
`#include "local.h"` works. Compile errors show in the output view with the
file's name. Anything unrecognised opens as plain text; `--lang=` overrides. Enter between a pair like `f(|)` opens it onto three lines,
and a `}`, `]` or `)` typed at the start of a line steps back a level. The rest
of this section describes Python, the language it started with.

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

**Selection and block editing.** `M-A` sets a mark and moving selects from it;
shift-arrows select without setting one first. With a selection open, `Tab` and
`Shift-Tab` shift every line in it, and `M-3` comments or uncomments the whole
block — commenting it unless every line already is. `^K` cuts the selection,
`M-6` copies it, `^U` pastes. `Escape` drops the mark.

**Matching brackets** on either side of the cursor are highlighted as you move,
across lines.

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
| `M-3` | comment / uncomment the block | `M-N` | toggle line numbers |
| `M-A` | set or clear the mark | shift-arrows | select |
| `M-6` | copy the selection | `Escape` | clear the mark |
| `Tab` / `Shift-Tab` | indent / dedent the block | | |
| `^A` / `^E` | start / end of line | `^_` | go to line |
| `^Y` / `^V` | page up / down | `^D` | delete character |

`pyedit` needs an interactive terminal; it exits with an error if stdin or
stdout is redirected.

## gitui — the built-in git browser

`gitui` stages, diffs and commits without leaving the shell:

```sh
gitui
```

```
  gitui  on main ↑2              1 staged, 2 changed, 3 untracked
 Staged (1)
    M src/pyedit.js
 Unstaged (2)
  ▸ M README.md
    M package.json
 Untracked (3)
    ? notes.txt
 ── diff: README.md ──────────────────────────────────────────────
 @@ -180,6 +180,12 @@
 +**Selection and block editing.** `M-A` sets a mark and moving
 +selects from it; shift-arrows select without setting one first.
```

The file list is grouped into staged, unstaged and untracked, and the pane
below always shows the diff for whatever is selected — the staged diff for a
staged file, the worktree diff otherwise, and the whole file for something
untracked.

### Keys

| Key | Action | Key | Action |
|---|---|---|---|
| `↑` / `↓`, `k` / `j` | move between files | `space` | stage, or unstage if staged |
| `a` | stage everything | `U` | unstage everything |
| `c` | commit what is staged | `^T` | push |
| `^D` / `^U` | scroll the diff | `PgUp` / `PgDn` | scroll a page |
| `d` | discard changes | `r` | re-read the repository |
| `^G` or `?` | help | `q` or `^X` | quit |

Anything irreversible asks first: `d` makes you type `yes` in full, because it
throws away changes (or deletes an untracked file) with no way back, and `^T`
names the remote before pushing to it. A staged file cannot be discarded at all
until you unstage it.

Status is re-read every couple of seconds, so a commit or checkout you make in
another terminal shows up on its own.

### GitHub

gitui talks to GitHub through the [GitHub CLI](https://cli.github.com) (`gh`),
so there's nothing to configure beyond signing in once with `gh auth login`.

The title bar shows the repository and **this branch's pull request with its
checks** — `maxvbuda/maxshell · PR #12 ✓ 3`, or `✗ 1/3` when something fails.

| Key | Action |
|---|---|
| `G` | the GitHub screen: **Pull requests**, **Issues** and **Actions** runs in tabs |
| `P` | open a pull request for this branch — publishes the branch first if GitHub hasn't seen it, and suggests the last commit as the title |
| `O` | open this branch's pull request (or the repository) in your browser |

On the GitHub screen, `←` `→` switch tabs and `↑` `↓` select. `Enter` shows the
details — a pull request's description, size, review state, every check and
the comments; a run's jobs — and `o` opens it in the browser. `n` creates a
pull request or an issue, `c` checks a pull request out locally, and `m`
squash-merges one and deletes its branch. Merging changes the shared
repository, so it asks you to **type `merge`**, and warns when checks are
failing or still running.

`^T` now also publishes a branch that has never been pushed (`git push -u
origin <branch>`) instead of failing. Without `gh`, or without signing in,
gitui works exactly as before and tells you what's missing.

## view, files and top

Three more full-screen tools, sharing the editor's highlighting and terminal
layer.

### view — a pager

```sh
view server.log              # open a file
git log -p | view            # or read a pipe — the language is sniffed
view -f server.log           # start in follow mode, like tail -f
```

Like `less`, with syntax highlighting. `/` and `?` search forwards and back,
case-insensitive unless you type a capital; matches are highlighted and `n` /
`N` step through them, wrapping at the ends. `F` follows a file as it grows.
`#` toggles line numbers, `←` `→` scroll sideways, `g` / `G` jump to the ends.
When its output is not a terminal (`view f > out`), `view` just prints, like
`cat`.

### files — a Finder-style browser

```sh
files            # browse from here
files ~/code     # or from somewhere else
```

It opens in **icon view**, like Finder: a grid of large icons, each with its
name centred underneath. The icons are small pixel drawings made from
half-block characters, so each terminal row holds two rows of pixels — enough
for a macOS-style folder with its tab, back panel, highlighted front and
rounded corners, carrying Finder's glyph on Downloads, Movies, Public and the
other special folders. Files are pages with a folded corner and their kind's
glyph. Long names wrap onto two lines at a space and are shortened in the
middle so the extension stays visible (`Screenshot` / `2025-05-0…5.43.png`),
and the selected item's full name appears in a tooltip. Arrows move around the
grid, `Enter` opens, `Backspace` goes to the enclosing folder.

**The mouse works as in Finder:** click to select, **double-click to open** a
folder or file, scroll with the wheel, and click the sidebar or any folder in
the path bar to go there. (`files --no-mouse` leaves the mouse to your
terminal, e.g. for selecting text.)

Press **`V`** for **column view** (or start there with
`MAXSHELL_FILES_VIEW=columns`), laid out like Finder's: a **Favorites sidebar** (Home, Desktop,
Documents, Downloads, Applications, iCloud Drive, your disks), the enclosing
folder, the current folder, and a **preview** of the selected item — its kind,
size and date, then the highlighted start of a file or a folder's contents. A
path bar and a status bar ("7 items, 176G available") run along the bottom.
Items get Finder-style icons and kinds (🐍 Python source, 🎨 PNG image, 📦 ZIP
archive…); set `MAXSHELL_ICONS=0` for plain text.

| Key | Action | Key | Action |
|---|---|---|---|
| `V` | icon view ⇄ column view | arrows | move (around the grid in icon view) |
| `Enter` | open | `Backspace` | enclosing folder |
| `[` `]` | back / forward | `Tab`, `1`–`9` | sidebar, jump to a favorite |
| `Enter` on a file | text and code open in `edit`; anything else in its Mac app | `Space` | **Quick Look** (text in a pager, the rest in macOS Quick Look) |
| `o` | open with the default app | `e` / `v` | edit / view |
| `n` / `N` | new folder / new file | `r` | rename |
| `d` | duplicate ("name copy") | `c` `x` `p` | copy / cut / paste |
| `t` `Delete` | **move to Trash** | `u` `^Z` | **undo** |
| `m` | mark, to act on several | `a` / `A` | mark all / none |
| `s` | sort by name, date, size, kind | `i` | **Get Info** (incl. folder size) |
| `/` | filter this folder | `f` | search subfolders by name |
| `.` | show hidden files | `b` | hide the sidebar |
| `q` | quit, **leaving the shell in this folder** | `Q` | quit without moving |

Nothing is ever deleted outright: `t` moves things to the Trash, and every
change — new, rename, duplicate, copy, move, trash — can be undone with `u`.
Pasting over a name that exists keeps both, like Finder's "Keep Both". The
view refreshes by itself when another program changes the folder.

### top — a process monitor

A live view in the spirit of htop: a meter per CPU core, memory in use, load
average and uptime, then every process with its CPU, memory and command line.
It refreshes every second and a half.

| Key | Action |
|---|---|
| `c` `m` `p` `n` | sort by CPU, memory, pid, or name |
| `/` | filter by command, user, or pid |
| `k` / `K` | send SIGTERM / SIGKILL to the selected process (asks first) |
| `r` | refresh now |
| `↑` `↓` | select — the selection follows the process, not the row |

`view` and `top` share names with system commands. The builtins win inside
maxshell; `command top` or `command view` reaches the system ones.

## Modern conveniences

### A completion menu

Press `Tab` and a menu opens under the prompt, each choice with an icon and a
short description — and it knows what you're typing:

```
maxshell ❯ git st
 ›  stash    shelve changes
 ›  status   what has changed
```

- commands and builtins say what they do; aliases say what they stand for
- `git` subcommands are explained; after `git checkout` / `switch` / `merge` /
  `rebase` you get your **branches**
- `npm run` lists **this project's scripts** with what each one runs
- `cd`, `j` and `files` offer only folders; `theme` offers the themes
- files show their icon, kind and size, and names with spaces or quotes go
  in escaped (or inside the quote you opened)
- `$` completes variable names, showing their values; `%` after `fg` / `kill`
  completes jobs; the word after `sudo`, `time`, `env` or `xargs` is a command

`Tab` / `↓` and `Shift-Tab` / `↑` move — the line previews the highlighted
choice as you go — `Enter` or `→` picks (without running anything), typing
narrows the list, and `Esc` closes it. A single match still completes at once.

### ls, modernised

At the prompt, `ls` lists folders first with icons and colours by kind, in a
grid sized to the window:

```sh
ls              # the grid
ls -l           # permissions, size, when, git status, name
ls --tree       # a tree (--level=N sets the depth)
ls -la src      # -a, -A, -l, -1, -t, -S, -r combine as usual
```

`ls -l` shows each file's git status — `M` modified, `N` new, `+` staged, `D`
deleted — and folders carry the status of what's inside them. In scripts, in
pipes (`ls | wc -l`), and with any flag it doesn't know, `ls` is the real
`ls`, byte for byte; `command ls` always is.

## Things terminals should have had years ago

### The command palette — Ctrl-P

`Ctrl-P` opens one searchable list of everything you can do right now: your
jobs, the tools (`dash`, `files`, `gitui`, `top`…), this project's `npm`
scripts and `make` targets, git actions and recent branches, your snippets
and bookmarks, the folders you visit most, every theme, and recent commands.
Type any words to narrow it; `Enter` runs the choice as if you'd typed it
(snippets and recent commands go on the line to edit instead). `↑` still
walks history; `palette` opens it from a script or alias.

### What will this do? — Alt-H

Type a command and press **`Alt-H`** (or run `explain 'cmd'`) to have it
taken apart before you run it: each program and what it is, each flag as
its manual describes it (`-czf` is split into `-c`, `-z`, `-f`), what globs
and `$variables` expand to, and what `|`, `&&`, `>`, `2>&1` mean. Nothing
runs — `$(…)` is described, not executed. Your line comes back to edit.

```
~ ❯ tar -czf site.tgz *.html
tar       manipulate tape archives · /usr/bin/tar
  -czf    several options together:
    -c    Create a new archive containing the specified items.
    -z    (c mode only) Compress the resulting archive with gzip(1).
    -f    Read the archive from or write the archive to the specified file.
  *.html  matches index.html about.html
```

### The dashboard — dash

`dash` is one live screen with what you'd otherwise check with five
commands: the project's branch, changes and last commits; CPU, memory and
battery meters and the busiest processes; your jobs; and what you ran in
this folder recently. It refreshes every second and a half; `g` `f` `t` `e`
`j` `p` jump to gitui, files, top, edit, jobs or the palette, `q` leaves.

### Snippets and bookmarks

Press **`Alt-S`** to save the line you're typing as a snippet (you're asked
for a name). `snip` picks one to put back on the prompt; `snip NAME` does it
by name.

```sh
snip add deploy 'npm run build && rsync -a dist/ server:/www'
snip save last-build        # the command you just ran
snip -l    snip mv a b    snip rm a
mark                        # bookmark this folder (named after it)
mark work                   # …or give it a name
go work    go               # go there, or pick from a list;  marks lists them
```

Snippets live in `~/.maxshell_snippets` and bookmarks in `~/.maxshell_marks`;
both show up in the palette.

### cleanup — free memory or CPU

```sh
cleanup         # quit what isn't needed
cleanup -r      # …then pick from what uses the most memory
cleanup -c      # …then pick from what keeps the CPU busy
cleanup -n      # just show what isn't needed
cleanup --keep Slack    # never count Slack as unnecessary
```

`cleanup` finds and quits, without asking, what isn't doing anything for
you:

- **apps you can't see** — no window on screen: none open, or all of them
  hidden (⌘H), minimised or on another Space — other than the app you're
  using and ones people keep in the background on purpose (Music, Spotify,
  Mail, Messages, your terminal…, plus anything you `--keep`);
- **dev servers and scripts left running with no terminal** — `node`,
  `python`, `ruby` and friends whose window was closed (services started by
  Homebrew or an app are left alone);
- **helpers left behind** by an app you've already quit;
- **suspended programs whose shell has closed**, which nothing can resume.

Apps get a normal Quit, so one with unsaved work still asks. Only your own
programs from `/Applications` are touched — never macOS itself, other users'
programs, or the terminal you're in. With `-r` or `-c` it then lists your
biggest remaining users (an app's helpers counted together) and asks which
of those to quit too (`1 3`, `2-4`, `all`, or Enter for none), and shows how
much memory came back.

### bot

`bot` opens a chat with maxshell's "AI". It isn't one: it's a big set of
rules plus a little word statistics, fully offline — no AI API, no network,
no neural network (ask it, and it admits it). It answers at a `🤖 bot ❯` line
while you type at `you ❯`.

- **It scores what you said against every intent** — patterns and weighted
  keywords — and answers with the best fit, after expanding contractions
  and fixing small typos (only in words that aren't real words).
- **It follows the conversation.** "That's funny" after a joke gets a thank
  you and "want another?"; "lame" gets an apology; "another", "again",
  "why?" and "say that again" refer to the last thing; yes/no answer its
  questions; games keep going until you stop.
- **It remembers you, between chats** — your name, what you like, your
  favourites and your birthday, in `~/.maxshell_bot` ("what do you know
  about me", "days until my birthday", "forget me").
- **It knows things** — jokes, facts and quotes that don't repeat until
  they've all been used; maths, percentages, roots, averages and unit
  conversions (`100 f to c`, `5 miles in km`); dates ("days until
  Christmas", "what day is July 4"); dice, coins, "pick pizza or tacos", a
  magic 8-ball, passwords; reverse, spell and count; trivia, riddles, rock
  paper scissors and guess the number; your Mac's battery, memory, CPU and
  disk; "what is grep" (from its manual) and `explain tar -xzf a.tgz`.
- **It answers maxshell questions from this README**, finding the section
  whose words best match yours (TF-IDF) and quoting it.
- **When nothing fits, it rambles.** A word-trigram Markov chain, trained
  on `src/botcorpus.txt` and this README, strings together a sentence or
  two seeded with your words — GPT-2-flavoured nonsense, filtered to be
  well formed and marked 💭 so you know it's generated.

`bye`, `exit`, `quit` or Ctrl-D leave; `bot what time is it` answers one
question and returns.

### ai — a small AI that runs on your Mac

`ai` chats with **mx**, a 15-million-parameter GPT-style language model made
for maxshell and trained on a Mac — its dataset, tokenizer and architecture
included (see `ai/README.md`). It runs entirely on your computer, in plain
JavaScript: no internet, no API, nothing you type leaves the machine.

```
~ ❯ ai what does grep do
✨ ai ❯ `grep` — file pattern searcher.
~ ❯ ai
you ❯ hi! what time is it?
✨ ai ❯ It’s 10:15 AM. ⏰
```

When you tell it your name ("my name is Max", or just "Max" when it asks),
maxshell gives it to the model directly and remembers it — shared with `bot` —
since a model this small is bad at copying names from the chat. Sums go
through a calculator the same way. It knows maxshell, your Mac's commands,
small talk, simple facts and sums, and the date and time (and your name, if
you told `bot`), and keeps track of the conversation. It's small — about an
eighth the size of GPT-2 small — so it can be confidently wrong about things
outside that; it'll tell you so if you ask. `ai --info` describes the model.
`bot` is the rule-based chat; `ai` is the trained one.

Every reply is checked before you see it, so `ai` doesn't just say random
things. A small model's typical mistake is answering with something it
learned for a *different* question, so `ai` looks its answer up in an index
of what it was trained on (`models/mx-index.json`, made by
`ai/make-index.js`) and checks that those questions are about what you
asked. Each word's confidence counts too. If an answer doesn't fit, it tries
again. If nothing fits, `bot`'s rules can answer (when one really matches),
and otherwise it says honestly that it didn't follow rather than make
something up. `node ai/eval.js` scores what `ai` shows, including questions
it was never taught; `--raw` scores the model alone.

**mx3** is the newest: the same 43M-parameter design as mx2, trained on a
balanced mix of hand-written data — conversation in many phrasings, about
330 coding exercises and programs (every one run before training), a
programming glossary and 190 knowledge articles, poems and stories, and
websites. It also learned to **check its own answers**: given a question
and an answer, it says whether the answer fits, and `ai` asks it about the
opening of every reply before showing it, so a reply that starts off wrong
is dropped and rewritten. `node ai/mx3/eval.js` runs the code it writes and
scores the checker.

**mx2**, its bigger successor (43M parameters, Llama-style, trained to code
— websites especially — and to answer general questions), trains in the
background for most of a day:

| Command | What it does |
|---|---|
| `ai --train start [mx3]` | start training as a macOS background service |
| `ai --status` | progress, loss, time left (in minutes, hours, days or weeks), samples, sleep pauses |
| `ai --train stop` | save and stop for good |

When training finishes it writes `models/mx2.bin`, and `ai` switches to it
by itself (`MAXSHELL_AI=mx` keeps the old one). mx2 runs on-device too: its
matrix maths is WebAssembly SIMD spread over several CPU cores, so it writes
about 100 tokens a second — a whole website in half a minute. Long answers
stream as they're written, code blocks are coloured, and **Ctrl-C** or
**Esc** stops an answer.

Training is sleep-safe. Before the Mac sleeps (lid closed, Sleep, idle) a
small helper tells it to save a checkpoint, and holds off sleep until the
save is done; on wake it just carries on. While it runs, the Mac won't
idle-sleep, but closing the lid still sleeps it. If the Mac restarts or
training stops for any reason, it starts again at login and picks up from
the last checkpoint.

### 6-7

`6-7` turns on **brainrot mode** for the session: the prompt gets a 💀 and a
🗿 (😭 after a failure), finished commands are a "W 🔥" or an "L 💀 skill
issue", a mistyped command is "who is bro 💀 — you meant git, no cap", a loud
theme goes on, and anything with a 67 in it gets 🤷 6️⃣7️⃣. `6-7` again
(or `6-7 off`) goes back to normal, your own theme included.

### Fuzzy history search — Ctrl-R

`Ctrl-R` opens a live search over every command you've ever run. Type any
words, in any order (`push git` finds `git push origin main`), or skip letters
(`gpo`). Results are ranked by how well they match, then by whether you ran
them **in this folder**, how recently, and how often. Each row shows the folder
it last ran in (`•` marks this one) and when.

| Key | Action |
|---|---|
| type | narrow the search |
| `↑` `↓`, `Ctrl-R` | move through the matches |
| `Enter` | run the selected command |
| `Tab` / `→` | put it on the line to edit first |
| `Esc` / `Ctrl-G` | cancel, restoring what you had typed |

History records the folder and time of each command, and keeps multi-line
commands (loops, here-documents, pastes) whole. Existing history files keep
working.

### Did you mean …?

```
maxshell % gti stauts
maxshell: command not found: gti — did you mean git?
maxshell % git status   ⏎ runs it
```

A mistyped command gets a suggestion from your builtins, functions, aliases and
everything on your `PATH`, and the corrected line — subcommands too, for
git, npm, brew, docker, cargo, pip and gh — waits dimmed on the next prompt.
**Press Enter to run it**, `→` to edit it first, or just type something else.

### Done alerts

After a command that took a second or more, or that failed, a quiet line says
how it went: `✓ 42.3s`, `✗ exit 2 · 3.2s`, `✗ interrupted`. When a command runs
longer than 10 seconds and you've switched to another app, you get a **macOS
notification** saying it finished (or failed). Set `NOTIFY_AFTER=30` to change
the threshold, or `NOTIFY_AFTER=0` to turn notifications off.

`Ctrl-C` now stops the running command without taking maxshell down with it.

### Smart folder jumping — j, back, forward

```sh
j cook          # → ~/cooking, the folder you visit most that matches
j max src       # → ~/maxshell/src  (words in order, the last in the folder name)
j -l cook       # list the candidates with their scores
back            # the previous folder, like a browser
forward         # and forward again  (back 3 / forward 2 take counts)
```

`j` learns from where you actually go — every folder you `cd` into, jump to, or
leave `files` in counts, with recent visits weighing more. It never "jumps" to
the folder you're already in, forgets folders that have been deleted, and a
real path still works (`j ../other` acts like `cd`).

## Builtins

| Builtin | Purpose |
|---|---|
| `cd`, `pwd`, `pushd`, `popd`, `dirs` | directory navigation and the directory stack |
| `echo`, `print`, `printf` | output (`echo` interprets `\n`-style escapes, like zsh; `print -l`, `-r`, `-P`, `-f`; `printf -v`, `%q`) |
| `export`, `unset`, `declare`, `typeset`, `local`, `readonly`, `integer`, `float` | variables, attributes and environment |
| `alias`, `unalias` | command aliases (`-g` global, `-s` suffix) |
| `source` / `.`, `eval`, `command`, `builtin` | run code from a file or a string; skip functions (`command -v` says what a name is) |
| `read` | read a line into variables (`-r`, `-p`, `-A` array, `-s` silent, `-k n`, `-d`, `-q`) |
| `set`, `setopt`, `unsetopt`, `shift` | options (`errexit`, `nounset`, `xtrace`, `pipefail`, `nullglob`, `autocd`, `shwordsplit`, …) and positional parameters |
| `trap`, `getopts` | run code on EXIT/ERR/signals; parse options |
| `test`, `[`, `let` | conditionals and arithmetic |
| `true`, `false`, `:` | trivial exit statuses |
| `type`, `whence`, `which`, `where` | what does this name refer to? |
| `history`, `jobs`, `help` | session information |
| `break`, `continue`, `return`, `exit` | control flow |
| `unfunction` | remove a function |
| `edit`, `pyedit` | the built-in editor (see above) |
| `view`, `files`, `top` | pager, file browser, process monitor (see above) |
| `j`, `back`, `forward` | jump to frequent folders; walk folder history (see above) |
| `jobs`, `fg`, `bg`, `kill`, `wait`, `disown` | job control (see above) |
| `theme` | list or switch colour themes (see above) |
| `abbr` | fish-style abbreviations that expand as you type |
| `palette`, `explain`, `dash` | the command palette, command explainer, live dashboard (see above) |
| `snip`, `mark`, `marks`, `go` | snippets and folder bookmarks (see above) |
| `cleanup` | quit what isn't needed; `-r` / `-c` then free memory / CPU (see above) |
| `6-7` | brainrot mode (see above) |
| `bot` | chat with a rules-only "AI" bot (see above) |
| `ai` | chat with mx, a small AI model running on this Mac (see above) |
| `ls` | icons, colours, git status, `-l` and `--tree` at the prompt; the real `ls` elsewhere |
| `gitui` | the built-in git browser (see above) |

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
src/pyedit.js       the editor (buffer model + screen), for every language
src/pyhighlight.js  Python tokenizer and syntax colouring
src/keys.js         Blocking key reader for full-screen editing
src/syntax.js       Language table, detection, and the JS/C/C++/shell/JSON/Markdown tokenizers
src/paint.js        Token colours and selection-aware line painting
src/tui.js          Shared full-screen plumbing: raw mode, bars, meters
src/view.js         view: pager model and screen
src/files.js        files: browser model, column view, sidebar, previews
src/fileops.js      Undoable file operations: new, rename, copy, move, Trash
src/history.js      History with folder and time; fuzzy search and ranking
src/suggest.js      Did-you-mean: edit distance, command and subcommand fixes
src/jump.js         Frecency folder database for j
src/alerts.js       Command status lines and desktop notifications
src/theme.js        The eight colour themes; every colour is looked up here
src/banner.js       The logo and startup tips
src/context.js      Project detection and the prompt's version modules
src/ls.js           The modern ls: grid, long view, tree, git status
src/top.js          top: ps parsing, process table, screen
src/jobs.js         Job control: starting, waiting on and steering jobs
src/jobrun.c        The job helper: process groups, the terminal, stop/continue
src/picker.js       The fuzzy full-screen list the palette and pickers share
src/palette.js      What the command palette offers
src/explain.js      Alt-H: a command line explained from the manuals
src/dash.js         The live dashboard
src/snippets.js     Snippet and bookmark storage
src/cleanup.js      cleanup: the biggest memory and CPU users, and quitting them
src/brainrot.js     6-7
src/bot.js          bot: a chat made of if/else rules, with conversation state
src/botdata.js      bot's jokes, facts, riddles, trivia and quotes
src/botmodel.js     bot's word-trigram Markov chain and README retrieval
src/botcorpus.txt   the text the Markov chain learns from
src/ai.js           ai: runs mx (tokenizer, transformer, sampling) in plain JavaScript
models/             mx's weights (int8) and tokenizer
ai/                 how mx is made: dataset generator, training script (PyTorch)
src/gitui.js        git browser: status, staging, diffs, commit
src/git.js          git plumbing and porcelain v2 status parsing
src/github.js       GitHub through gh: repo, pull requests, issues, runs, checks
src/githubview.js   gitui's GitHub screen
examples/demo.mxsh  A tour of the language
test/run.js         Language test suite
test/interactive.js Line editor, highlighter and prompt test suite
test/pyedit.js      Python editor, tokenizer and key reader test suite
test/gitui.js       git layer and browser test suite
test/tools.js       Languages, view, files and top test suite
test/features.js    History search, did-you-mean, j/back/forward, alerts
test/look.js        Themes, logo, banner and the prompt
test/modern.js      Completion menu, context-aware prompt, ls
test/github.js      gitui's GitHub support, against a fake gh
test/jobs.js        Job control and streaming pipelines
test/palette.js     Palette, picker, explain, dash, snippets and bookmarks
test/ai.js          mx: tokenizer, prompts, sampling and the model
```

## Differences from zsh

maxshell follows zsh's defaults: arrays are 1-indexed, a bare `$arr` expands
to all its elements, and unquoted `$x` isn't split or globbed. Where it
differs:

- Where a builtin or function sits in the middle of a pipeline, its input is
  gathered before it runs (programs on either side still stream), and
  process substitution uses temporary files.
- Job control relies on a small C helper (`src/jobrun.c`) that is compiled
  on first use; on a machine without a C compiler, Ctrl-Z isn't available.
  A job continued from another terminal (`kill -CONT`) shows as suspended
  until it next changes state (macOS doesn't report it).
- Signal traps (`trap … INT`) run once the current command has finished.
- Not implemented: coprocesses, `EXTENDED_GLOB` operators (`^`, `~`, `#`),
  zle widgets and `bindkey`, and zsh's completion system (maxshell has its
  own).

## License

MIT
