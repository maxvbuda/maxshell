# maxshell — guide for Claude sessions

maxshell is a zsh-flavoured shell written from scratch in Node.js (no runtime
dependencies): its own lexer, parser, word expansion and interpreter, a custom
line editor, and a set of full-screen tools (editor, pager, Finder-style file
browser, process monitor, git/GitHub UI). Repo: github.com/maxvbuda/maxshell
(public). `maxshell` on this Mac is a global npm link to this folder, so every
change is live immediately.

The README is the user-facing reference for every feature; read it before
changing behaviour, and keep it updated with each feature.

## Running and testing

```sh
node bin/maxshell.js            # REPL   (maxshell -c 'cmd', or a script path)
npm test                        # 13 suites, ~25 seconds; all must pass
```

Suites: `test/run.js` (language), `interactive.js` (line editor, highlight,
prompt), `pyedit.js` (editor buffer, Python tokenizer, key reader),
`gitui.js`, `tools.js` (languages, view, files, top), `features.js` (history
search, did-you-mean, j/back/forward, alerts), `look.js` (themes, logo,
prompt), `modern.js` (completion menu, context prompt, ls), `github.js`
(gitui's GitHub support against a fake `gh`), `jobs.js` (job control,
streaming pipelines), `palette.js` (palette, picker, explain, dash,
snippets/bookmarks), `ai.js` (the on-device model), `sage.js` (Sage's app,
Sage Code's tools, the engine plumbing). New features get tests in a
suite; new suites get appended to the `test` script in package.json.

## Architecture

**Language core** — `lexer.js` → `parser.js` (AST) → `interpreter.js`
(`Shell`: variables/scopes, redirection, pipelines, subshells) with
`expand.js` (parameters, fields, globs, patterns), `arith.js`, `builtins.js`,
`signals.js`. zsh semantics throughout: arrays are 1-indexed, bare `$arr`
expands to all elements, unquoted `$x` is not split or globbed. Scripts are
parsed and run one top-level command at a time (so aliases, expanded at
parse time, apply from the next line). Runs of external stages in a
pipeline go to `/bin/bash -c` as one streaming pipeline; builtin stages are
buffered in-process.

**Jobs** — `jobs.js` + `jobrun.c`: a C helper (compiled on first use into
`~/.cache/maxshell`, `MAXSHELL_CACHE` overrides) runs each foreground program
at the terminal in its own process group and reports stop/exit through a
status file; the interpreter stays synchronous and polls it. `Ctrl-C`/`Ctrl-Z`
set `shell.interrupted`, which abandons the rest of the command line.

**Setup** — `install.sh` and `src/setup.js`: `--make-default` writes a sh
login wrapper (`~/.maxshell/bin/maxshell`, absolute Node path, falls back to
zsh), adds it to /etc/shells, runs chsh, and saves PATH to
`~/.maxshell_profile` (loaded by login shells, detected via -l or a `login`
parent). The REPL offers this once on first run (`~/.maxshell_state`).

**AI** — `ai` runs mx, a 15M-parameter GPT trained for maxshell: `ai/`
holds how it's made (`make-dataset.js` → `ai/data/dataset.jsonl`,
`train.py` with PyTorch/MPS → `models/mx.bin` int8 + `mx-tokenizer.json`);
`src/ai.js` is the dependency-free JS runtime (BPE, forward pass with KV
cache, sampling). After changing the architecture or export format, check
`python3 ai/train.py --parity` against the JS logits. Python/PyTorch are
training-time only; `ai/data/` is gitignored, `models/` is committed.
mx2 (`ai/mx2/`): hand-written data (`code/`, validated by `validate.js`;
`sitegen.js`; `knowledge/*.md`) → `make-corpus.js` → `train.py` (RMSNorm,
RoPE, SwiGLU; 512-token phase then 2048). `ai --train start` installs the
LaunchAgent `com.maxshell.mx2-train` running `run-training.sh`, which starts
`sleepwatch` (IOKit: SIGUSR1 → save before sleep) and `caffeinate`. The
runtime is `src/mx2.js` (worker threads + `src/mx2kernels.wasm`, built from
`mx2kernels.c` with the clang command at its top — commit both); check it
with `ai/mx2/parity.py`. mx3 (`ai/mx3/`: `make-corpus.js`, `talk.js`,
`eval.js`, `train.args`) is the same architecture trained by
`ai/mx2/train.py --name mx3`, with a learned self-check ("check: does the
answer fit?" → yes/no) that `checkedReply` uses. `ai` prefers mx3, then mx2,
then mx (`MAXSHELL_AI` overrides). Evaluate on dates other than Tuesday
29 Sep 2026 10:15 — mx2's old fixed date still confuses mx3.
`sage` (`src/gemma.js`) is Sage, Gemma 4 E4B (default) or
E2B (FP8 builds from `leon-se/gemma-4-E{4,2}B-it-FP8-Dynamic`, in
`~/.maxshell/gemma/e4b` and `~/.maxshell/gemma`) run by `src/gemma.py` in
`~/.maxshell/gemma/venv` via transformers: text weights only, the per-layer
embedding memory-mapped from disk, KV cache kept across turns, CPU while mx
training runs. At a terminal, `sage` / `sage code` open `src/sage.js`, a
full-screen app (`SageApp` state + `render()`, model dropdown) that runs
`gemma.py --serve` as a separate process: JSON commands appended to a file,
JSON events read back from another (`Engine`), so it stays synchronous.
`sage code` gives Gemma tools (native tool calls, parsed in gemma.py) that
the app runs via `src/sagetools.js` — reads in the project are free,
writes/edits show a diff and ask, replaced files go to the Trash. Tests
use `test/fake-sage-engine.js` (`MAXSHELL_SAGE_ENGINE`). Off a terminal,
gemma.py prints replies through `node src/markdown.js` (streaming markdown +
`src/tex.js` math; NUL ends a reply and is acked on stderr).

**Interactive shell** — `bin/maxshell.js` runs the REPL: `lineeditor.js`
(raw-mode editor: highlighting, ghost suggestions, Ctrl-R search, completion
menu, did-you-mean fix), `highlight.js`, `complete.js` (context-aware
completion with icons/descriptions), `prompt.js` + `context.js` +
`gitprompt.js` (one-line prompt with a right side, trimmed after Enter; Starship-style
version modules), `history.js` (history with folder + time), `suggest.js`,
`alerts.js` (✓/✗ lines, macOS notifications), `jump.js` (frecency `j`),
`banner.js`, `theme.js`, `ls.js` (modern ls). The editor hands Ctrl-P
(palette), Alt-H (explain) and Alt-S (save snippet) back to the REPL as
flags on its result; `shell.prefill` puts text on the next prompt.

**Full-screen tools** — `pyedit.js` is the editor for every language (`edit`,
`pyedit`), with languages in `syntax.js` (+ `pyhighlight.js` for Python) and
colouring in `paint.js`; `dash.js` dashboard; `picker.js` (the fuzzy list
behind the palette, snippets and bookmarks); `view.js` pager; `files.js` + `fileops.js` (icon and
column views, mouse, undoable file ops); `top.js`; `gitui.js` + `git.js`, with
GitHub in `github.js` + `githubview.js` (via the `gh` CLI). Shared plumbing in
`tui.js` (fullscreen, bars, width-aware `fit`), `keys.js`, `ansi.js`.

## Rules that are easy to break

- **Test the shell against zsh.** A differential runner (same snippet
  through `zsh -f -c` and `maxshell -c`, compare output) finds language bugs
  fast; keep new behaviour zsh-compatible unless there's a reason not to.
- **Builtins run synchronously.** Full-screen tools read keys with
  `KeyReader` (blocking `fs.readSync`), never Node's keypress events;
  `reader.next(ms)` returns `{ name: 'timeout' }` for polling. Only the REPL's
  `LineEditor` is async.
- **Every colour comes from `theme.js`** (`theme.current().ui/prompt/shell/
  syntax`, `theme.style`, `tui.bar`). Never hard-code colours or use reverse
  video for bars/selection. Eight themes; every theme must define every key
  (`test/look.js` checks).
- **Nothing may overflow the terminal width.** Use `tui.textWidth` / `fit`
  (emoji and CJK count as 2). Tests render screens and assert every line fits.
- **Models are separate from screens** so logic is testable without a tty:
  `EditorBuffer`/`PyEditor`, `Pager`/`PagerScreen`, `FileBrowser`/
  `FilesScreen`, `ProcessTable`/`TopScreen`, `GitHubView` (swap `gh` with
  `github.setRunner`).
- **Nothing deletes user files.** `fileops.js` moves to the Trash and every
  operation is undoable.
- **Modern behaviour only at the prompt.** The fancy `ls` runs only when
  interactive at a terminal with flags it knows; scripts, pipes and unknown
  flags get the real `ls`. Colour is off for `-c` and scripts.
- **Env overrides keep tests off real files:** `MAXSHELL_TRASH`,
  `MAXSHELL_SNIPPETS_FILE`, `MAXSHELL_MARKS_FILE`, `MAXSHELL_CACHE`,
  `MAXSHELL_STATE_FILE`, `MAXSHELL_WRAPPER`, `MAXSHELL_BOT_FILE`, and **`MAXSHELL_SETUP=0` in every
  pty run** (else the one-time "make maxshell your default shell?" offer
  appears and is marked as answered on the user's machine),
  `MAXSHELL_HISTORY_FILE`, `MAXSHELL_DIRS_FILE`, `MAXSHELL_THEME_FILE`,
  `MAXSHELL_THEME`, `MAXSHELL_BANNER=0`, `MAXSHELL_ICONS=0`,
  `MAXSHELL_FILES_VIEW=columns`.

## Verify in a real terminal, not just unit tests

Unit tests have passed while features were broken (e.g. Tab still bound to the
old insert, so block indent didn't work). For anything interactive, drive the
real program through a pty and check the result:

```sh
( sleep 2.5; printf 'ls\r'; sleep 1; printf '\x12'; sleep .5 ) \
  | MAXSHELL_SETUP=0 MAXSHELL_BANNER=0 TERM=xterm-256color perl -e 'alarm 30; exec @ARGV' \
    script -q /dev/null node bin/maxshell.js > log 2>&1
```

Keys: `\r` Enter, `\t` Tab, `\x1b[A..D` arrows, `\x1b[1;2B` shift-down,
`\x1bX` Alt-X, `\x0f` ^O, `\x18` ^X, `\x12` ^R, `\x03` ^C, mouse
`\x1b[<0;COL;ROWM` press + `…m` release. To *see* a screen, write a small
Python terminal emulator that replays the log (SGR colours, cursor movement,
half blocks) into a PNG and Read it — read the log with `newline=''` or `\r`
is lost. Use a temp dir for all scratch output, and when removing one, write
`rm -rf "${DIR:?}"` (the harness blocks `rm -rf "$DIR/…"`).

## Working with the user

- Keep answers short and on the question; no speculative warnings or
  tangents.
- For open-ended requests ("make it better", "more modern"), offer a few
  concrete options with AskUserQuestion; if they say "continue", pick and say
  what you picked in one sentence.
- After each feature: update README, bump the minor version in
  package.json, run `npm test`, and commit. **Don't ask "Push it?" after every
  commit** — the user finds that repetitive. Just mention the work is
  committed; push only when the user asks for a push.
- Stage files by name; never `git add -A`. Commit messages explain why, and
  end with the attribution lines from the session's system reminder.
- Another Claude session ("maxshell (2)", which wrote gitui) has worked in
  this same tree. Check `git status` for changes you didn't make and use
  ListAgents/SendMessage to coordinate before touching shared files.

## Decided already

- A built-in AI helper (`?`, `why`) was proposed and **declined**: this Mac
  has no Anthropic API key, and the user chose to skip it. `bot` is not
  that: it's deliberately fake — scored rules, README retrieval and a
  trigram Markov chain over bundled text — no API, network or dependencies.
- `view` and `top` deliberately shadow the system commands inside maxshell;
  `command view` / `command top` reach the originals.
- Command position completes commands only (like zsh/fish); files complete
  in argument positions.
