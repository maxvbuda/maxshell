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

## The look

maxshell greets you with its logo painted in the current theme's gradient,
plus a tip about something it can do:

```
  █▀▄▀█ ▄▀█ ▀▄▀ █▀ █ █ █▀▀ █   █      maxshell 0.9.0 · theme maxshell
  █ ▀ █ █▀█ █ █ ▄█ █▀█ ██▄ █▄▄ █▄▄    tip: j cook jumps to the folder you use most
```

### The prompt

The default prompt is two lines: a framed information line, then a short
input line whose `❯` turns the theme's error colour when the last command
failed.

```
╭─ ~/maxshell · main !?                          📦 v0.9.0 · ⬢ 25.1.0 · 12:04
╰─❯ git status
```

The right side is **context-aware**, like Starship: it shows a tool's version
only inside projects that use it — ⬢ Node (and the 📦 package version) where
there's a `package.json`, 🐍 Python with the active virtualenv, 🦀 Rust, 🐹 Go,
💎 Ruby, 🐳 Docker — plus `took 4.2s` after a slow command, and the time.
Outside any project it's just the time. Long paths shorten fish-style
(`~/p/w/src`) so the right side keeps its room, and if the window is narrow the
modules give way before the time does.

Once you press Enter the prompt **collapses to a single line**, so scrollback
reads as a clean list of what you ran rather than a wall of frames:

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
- files show their icon, kind and size

`Tab` / `↓` and `Shift-Tab` / `↑` move, `Enter` or `→` picks (without running
anything), typing narrows the list, and `Esc` closes it. A single match still
completes at once.

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

History now records the folder and time of each command. Existing history
files keep working.

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
| `edit`, `pyedit` | the built-in editor (see above) |
| `view`, `files`, `top` | pager, file browser, process monitor (see above) |
| `j`, `back`, `forward` | jump to frequent folders; walk folder history (see above) |
| `theme` | list or switch colour themes (see above) |
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
test/look.js        Themes, logo, banner and the two-line prompt
test/modern.js      Completion menu, context-aware prompt, ls
test/github.js      gitui's GitHub support, against a fake gh
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
