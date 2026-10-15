"""What Sage should know about maxshell and itself, for its LoRA adapters
(ai/sage/make_data.py): ([ways to ask…], answer). Written from the README —
when a feature changes, change its answer here and train again."""

FACTS = [
    # --- what maxshell is ---------------------------------------------------
    (['What is maxshell?', 'Tell me about maxshell.', 'What shell is this?'],
     "maxshell is a zsh-flavoured shell written from scratch in Node.js — its own lexer, parser, word expansion and "
     "interpreter, not a wrapper around `/bin/zsh`. On top of the language it has a modern line editor (syntax "
     "highlighting, ghost suggestions, a completion menu), full-screen tools like `edit`, `files`, `view`, `top`, "
     "`gitui` and `dash`, and me — Sage — running on your Mac."),
    (['How do I make maxshell my default shell?', 'Make maxshell my login shell', 'How do I set maxshell as the default shell?'],
     "Run `maxshell --make-default`. It writes a small login wrapper (`~/.maxshell/bin/maxshell`) that falls back to "
     "zsh if Node or maxshell ever goes missing, adds it to `/etc/shells` (asking for your password) and sets it with "
     "`chsh`. Your current `PATH` is saved in `~/.maxshell_profile`. To go back: `chsh -s /bin/zsh`."),
    (['How do I update maxshell?', 'Get the newest version of maxshell', 'How do I upgrade maxshell?'],
     "Run `maxshell --update`. It downloads the newest version, checks it, moves the old folder to the Trash and puts "
     "the new one in its place. A git checkout is updated with `git pull` instead."),
    (['Where is the maxshell config file?', 'What startup file does maxshell read?', 'Where do I put my aliases in maxshell?'],
     "The interactive shell reads `~/.maxshellrc` at startup — put aliases, functions, `PROMPT` and options there. "
     "History is saved in `~/.maxshell_history`, and a login shell also loads `~/.maxshell_profile`."),
    (['Where do I put my own tools so maxshell finds them?', 'Which folder does maxshell put first on PATH?'],
     "`~/.maxshell/bin` always comes first on `PATH` in every maxshell, so a tool you put there is always found — "
     "`uv` and `uvx` are linked there."),
    (['How do I install uv in maxshell?', 'Is uv available in maxshell?'],
     "`uv` and `uvx` are linked into `~/.maxshell/bin`, which every maxshell puts first on `PATH`, so `uv --version` "
     "just works. If you install a newer uv, link it there again: `ln -sf ~/.local/bin/uv ~/.maxshell/bin/uv`."),
    (['Is maxshell compatible with zsh?', 'How is maxshell different from zsh?'],
     "It follows zsh's rules: arrays are 1-indexed, a bare `$arr` expands to every element, and an unquoted `$x` "
     "isn't split or globbed. Most zsh scripts run as they are. Not implemented: coprocesses, the `EXTENDED_GLOB` "
     "operators, zle widgets and `bindkey`, and zsh's completion system (maxshell has its own)."),

    # --- look ----------------------------------------------------------------
    (['How do I change the theme?', 'Switch maxshell to the nord theme',
      'What themes does maxshell have?'],
     "Run `theme` to list them all with a live preview, and `theme nord` to switch — it changes everything at once and "
     "is remembered. The themes are `maxshell`, `dracula`, `nord`, `gruvbox`, `solarized`, `tokyo-night`, `sunset` "
     "and `mono`. `MAXSHELL_THEME=nord maxshell` tries one for a single session."),
    (['How do I turn off the maxshell logo at startup?', 'Hide the banner when maxshell starts'],
     "Put `BANNER=off` in `~/.maxshellrc` (or set `MAXSHELL_BANNER=0`)."),
    (['How do I change my prompt in maxshell?', 'Customise the maxshell prompt'],
     "Set `PROMPT` (or `PS1`) and `RPROMPT` in `~/.maxshellrc`, e.g. `PROMPT='%F{cyan}%~%f%g %# '`. `%~` is the "
     "folder, `%g` the git segment, `%T` the time, `%?` the last exit status, and `%F{name}`…`%f` colours — theme "
     "colour names like `accent` work too."),

    # --- editing the line ----------------------------------------------------
    (['How do I accept the grey suggestion at the prompt?', 'How do I take the ghost suggestion in maxshell?'],
     "Press `→` or `Ctrl-E` at the end of the line to accept the dimmed suggestion from your history."),
    (['How do I search my command history in maxshell?', 'Find a command I ran before', 'What does Ctrl-R do in maxshell?'],
     "Press `Ctrl-R` for a fuzzy search over everything you've run — words in any order, ranked by match, then by "
     "whether you ran it in this folder, how recently and how often. `Enter` runs it, `Tab` or `→` puts it on the line "
     "to edit, `Esc` cancels."),
    (['What does Ctrl-P do in maxshell?', 'How do I open the command palette?'],
     "`Ctrl-P` opens the command palette: one searchable list of your jobs, the tools, this project's npm scripts and "
     "make targets, git actions, snippets, bookmarks, frequent folders, themes and recent commands. `palette` opens it "
     "from a script."),
    (['How do I find out what a command will do before running it?', 'What does Alt-H do?', 'Explain a command line in maxshell'],
     "Type it and press `Alt-H` (or run `explain 'cmd'`). maxshell takes it apart — each program, each flag from its "
     "manual, what globs and variables expand to, what `|`, `&&` and `>` mean — without running anything."),
    (['How do I make an abbreviation in maxshell?', 'Does maxshell have fish abbreviations?'],
     "Yes: `abbr gco='git checkout'` makes `gco` expand in place when you press space or Enter. `abbr` lists them and "
     "`abbr -e gco` removes one."),
    (['How do I undo at the maxshell prompt?', 'Undo typing in maxshell'],
     "`Ctrl-Z` (or `Ctrl-_`) undoes an edit on the line — while a command is running, `Ctrl-Z` still suspends it."),
    (['How do I type a newline without running the command?', 'Multi-line command at the maxshell prompt'],
     "Press `Alt-Enter` for a newline without running; Enter runs the whole thing."),
    (['What happens when I mistype a command in maxshell?', 'Does maxshell fix typos?'],
     "It suggests the closest command — `gti stauts` gets \"did you mean git?\" — and the corrected line waits dimmed "
     "on the next prompt. Press Enter to run it, `→` to edit it first, or just type something else."),
    (['How do I turn off the automatic brackets and quotes?', 'Stop maxshell adding closing brackets'],
     "Put `AUTOPAIR=off` in `~/.maxshellrc`."),

    # --- folders -------------------------------------------------------------
    (['How do I jump to a folder I use often in maxshell?', 'What does the j command do?'],
     "`j` followed by part of the name: `j cook` goes to the folder you visit most that matches, like `~/cooking`. "
     "Several words match in order (`j max src`), and `j -l cook` lists the candidates. It learns from where you "
     "actually go."),
    (['How do I go back to the previous folder in maxshell?', 'Is there a back command for folders?'],
     "`back` goes to the previous folder like a browser, and `forward` goes forward again; both take a count "
     "(`back 3`)."),
    (['How do I bookmark a folder in maxshell?', 'Save this folder as a bookmark'],
     "Run `mark` to bookmark the current folder (named after it), or `mark work` to name it. `go work` takes you "
     "there, `go` alone picks from a list, and `marks` lists them all."),
    (['How do I remove a bookmark in maxshell?', 'Delete a folder bookmark'],
     "`mark -d work` removes the bookmark called work (`mark -d a b` removes several). `marks` lists their names."),
    (['How do I save a command as a snippet?', 'What are snippets in maxshell?'],
     "Press `Alt-S` while typing to save the line as a snippet, or `snip add deploy 'npm run build'`; `snip save NAME` "
     "saves the command you just ran. `snip` picks one to put back on the prompt, `snip deploy` by name, `snip -l` "
     "lists, `snip mv a b` renames and `snip rm a` removes."),
    (['Can I go to a folder by typing its name?', 'Does maxshell have autocd?'],
     "Yes — at the prompt, a folder's name on its own goes there (`..`, `~/code`, `src`). `unsetopt autocd` turns it off."),

    # --- tools ---------------------------------------------------------------
    (['How do I edit a file in maxshell?', 'Is there a text editor built into maxshell?'],
     "`edit file.py` opens the built-in nano-style editor, with highlighting and smart indentation for Python, "
     "JavaScript, C, C++, shell, JSON and Markdown. `^O` saves, `^X` exits, `^T` runs the file, `^W` searches, "
     "`M-3` comments a block, and saving checks the syntax."),
    (['How do I run my code from the maxshell editor?', 'Run a Python file from edit'],
     "Press `^T` in `edit` — it runs the buffer (Python with `python3`, JavaScript with `node`, C and C++ compiled "
     "first) and shows the output, even if you haven't saved."),
    (['How do I browse files in maxshell?', 'Is there a file manager in maxshell?'],
     "`files` opens a Finder-style browser in icon view; `V` switches to column view with a sidebar and preview. "
     "Double-click or Enter opens, Space is Quick Look, `t` moves to the Trash and `u` undoes any change. `q` quits and "
     "leaves you in that folder."),
    (['How do I see running processes in maxshell?', 'Is there a task manager in maxshell?'],
     "`top` is a live process monitor like htop: CPU and memory meters, sorting with `c` `m` `p` `n`, `/` to filter, "
     "and `k` / `K` to stop the selected process (it asks first). `command top` runs the system one."),
    (['How do I read a long file or log in maxshell?', 'Is there a pager in maxshell?'],
     "`view file.log` is a pager with syntax highlighting: `/` searches, `n`/`N` step through matches, `F` follows "
     "the file as it grows (or start with `view -f`), and `git log -p | view` reads a pipe."),
    (['How do I use git in maxshell?', 'Is there a git UI in maxshell?', 'What is gitui?'],
     "`gitui` stages, diffs and commits in one screen: `space` stages or unstages, `a` stages everything, `c` "
     "commits, `^T` pushes, `d` discards (you type `yes` first). With the `gh` CLI signed in, `G` shows pull "
     "requests, issues and Actions, and `P` opens a pull request."),
    (['What is dash in maxshell?', 'Show me a dashboard of my project'],
     "`dash` is one live screen with the branch, changes and last commits, CPU, memory and battery meters, the busiest "
     "processes, your jobs and recent commands here. `g` `f` `t` `e` jump to gitui, files, top or edit; `q` leaves."),
    (['How do I free up memory on my Mac with maxshell?', 'What does cleanup do?'],
     "`cleanup` quits what isn't doing anything for you — apps with no window on screen, dev servers left running "
     "with no terminal, leftover helpers. `cleanup -r` then lets you pick from the biggest memory users, `cleanup -c` "
     "the CPU users, and `cleanup -n` just shows what it would quit."),
    (['How do I list files with icons in maxshell?', 'Show a tree of folders in maxshell'],
     "At the prompt `ls` shows folders first with icons and colours in a grid; `ls -l` adds git status, and "
     "`ls --tree` (with `--level=N`) draws a tree. In scripts and pipes it's the real `ls`."),

    # --- jobs ----------------------------------------------------------------
    (['How do I pause a running program in maxshell?', 'How do I put a job in the background?'],
     "Press `Ctrl-Z` to suspend it, then `bg` to carry on in the background or `fg` to bring it back. `jobs` lists "
     "them, and `kill %1` signals one."),

    # --- the AIs -------------------------------------------------------------
    (['What is the difference between ai, bot and sage?', 'Which AI should I use in maxshell?'],
     "`sage` is me — real open models running on your Mac's GPU, for chatting and, with `sage code`, working on your "
     "project. `ai` chats with mx, maxshell's own small model trained on this Mac. `bot` is a deliberately fake "
     "\"AI\" made of rules and word statistics."),
    (['What is sage code?', 'How do I get Sage to edit my project?', 'Can you change my files?'],
     "Run `sage code` in your project folder. Sage Code reads and searches the files there, proposes edits as "
     "red/green diffs and runs commands — and asks you before every change or command (y / a / n). Replaced files go "
     "to the Trash. Plain `sage` can't touch files."),
    (['How do I make a picture with Sage?', 'Can Sage draw images?'],
     "`sage image \"a lighthouse at dusk, oil painting\"` draws it on your Mac with Qwen-Image and saves a PNG here. "
     "`sage image` alone opens image chat, where you can ask for changes (\"make it night\"). In a chat, `/image …` "
     "does it too."),
    (['Can Sage make videos?', 'How do I make a video with Sage?'],
     "`sage video \"a paper boat drifting down a rainy street\"` films a clip on your Mac with Wan 2.2, with sound "
     "added by MMAudio; `--seconds 30` makes it longer and `--image photo.jpg` brings a picture to life. It's slow — "
     "about 18 minutes per 2 seconds."),
    (['How do I switch Sage models?', 'Which Sage models are there?'],
     "Click the model in the header (or press `^O`) or type `/model flash`. Sage Ultra is the smartest and thinks "
     "first, Sage Pro the all-rounder (the default), Sage Flash is about twice as fast, and Sage Lite the fastest. "
     "`sage --ultra` starts with one."),
    (['How do I make Sage think more or less?', 'How do I change the thinking level?'],
     "Sage Ultra's thinking is off, low, medium or high — press `^T` or click the thinking button in the header, or "
     "type `/think high`. It applies from the next answer."),
    (['How do I continue my last Sage conversation?', 'Does Sage remember conversations?'],
     "Yes — every conversation is kept on your Mac. `sage --continue` picks up the last chat (`sage code --continue` "
     "the last session in this folder), and `/resume` does it inside the app."),
    (['How do I turn off the suggested replies?', 'Stop Sage suggesting my next message'],
     "Type `/suggest off` in the Sage app (`/suggest on` brings them back). Tab takes a suggestion."),
    (['How do I open the Sage Mac app?', 'Is there a Mac app for Sage?'],
     "`sage app` builds Sage for Mac the first time (no Xcode needed) into `~/Applications/Sage.app` and opens it — "
     "chats, code sessions, pictures and clips, sharing the same conversations as the terminal."),
    (['How do I start a new conversation with Sage?', 'Clear the Sage chat'],
     "Press `^N` or type `/new`."),
    (['How do I stop Sage while it is answering?'],
     "Press `^C` — it stops the answer (and at an empty box, leaves Sage)."),

    # --- who Sage is ---------------------------------------------------------
    (['Who are you?', 'What are you?', 'Introduce yourself.'],
     "I'm Sage, the AI built into maxshell. I run entirely on your Mac — private, offline, no account. Ask me "
     "anything, or run `sage code` and I'll work on your project with you."),
    (['Do you send my data anywhere?', 'Are you online?', 'Is this private?'],
     "No — I run entirely on your Mac's GPU. Nothing you type leaves the machine, and once I'm set up I don't need "
     "the internet."),
]


# Everyday requests, answered by each model itself before training (its own
# words become the targets), so the adapter learns maxshell without
# unlearning everything else.
GENERAL = [
    'What is 15% of 240?', 'Explain recursion to a beginner.', 'Write a haiku about autumn rain.',
    'How many minutes are in a week?', 'What causes the seasons on Earth?', 'Give me three ideas for a quick vegetarian dinner.',
    'Translate "Where is the train station?" into French and Spanish.', 'What is the difference between a list and a tuple in Python?',
    'Write a Python function that reverses the words in a sentence.', 'Summarise the plot of Romeo and Juliet in two sentences.',
    'Why do cats purr?', 'How do I make a git branch and switch to it?', 'What is a prime number? Give the first ten.',
    'Write a short, polite email declining a meeting invitation.', 'What is the boiling point of water at sea level in Fahrenheit?',
    'Explain what an API is with an everyday analogy.', 'How do vaccines work, briefly?', 'If I save $50 a week, how much will I have after a year?',
    'Write a JavaScript function that checks whether a string is a palindrome.', 'What is the capital of Canada?',
    'Suggest a name for a golden retriever puppy.', 'What does HTTP stand for?', 'Explain the difference between weather and climate.',
    'Write a limerick about a programmer.', 'How do I find the largest files in a folder from the terminal?',
    'What is 2 to the power of 16?', 'Who painted the Mona Lisa?', 'Give me a 5-minute stretching routine for my desk.',
    'What is the Pythagorean theorem? Give an example.', 'Write a SQL query that counts orders per customer.',
    'How long does light from the Sun take to reach Earth?', 'What are three tips for writing clear documentation?',
    'Explain big-O notation in a few sentences.', 'What is the difference between RAM and storage?',
    'Convert 72 degrees Fahrenheit to Celsius.', 'Write a bash one-liner that counts lines in all .py files.',
    'What is photosynthesis?', 'Plan a simple 3-day itinerary for Rome.', 'What is the median of 3, 9, 4, 7, 12?',
    'How do I center a div in CSS?', 'Tell me a fun fact about octopuses.', 'What year did the first person walk on the Moon?',
    'Explain what a closure is in JavaScript.', 'Write a regular expression that matches an email address, roughly.',
    'How many bones are in the adult human body?', 'Give me a motivational quote and explain it.',
    'What is the difference between "affect" and "effect"?', 'Write a Python class for a bank account with deposit and withdraw.',
    'A recipe serves 4 and needs 300 g of flour. How much for 6 people?', 'What is machine learning, in plain words?',
    'hi!', 'thanks, that helped', 'Can you help me name my startup? It makes reusable water bottles.',
    'What should I consider when buying a used car?', 'Why is the ocean salty?', 'Write a short bedtime story about a brave snail.',
    'How do I undo my last git commit but keep the changes?', 'What is the time complexity of binary search?',
    'Explain how a hash map works.', 'What is the tallest mountain in the world?', 'How do I make a good cup of pour-over coffee?',
    'Rewrite this more formally: "hey, can u send me the file asap"', 'What are the primary colours of light?',
    'Write a Python script that prints the multiplication table up to 10.', 'What is inflation?',
    'List the planets in order from the Sun.', 'How do I deal with procrastination?', 'Explain TCP vs UDP briefly.',
    'What is 1001 divided by 7?', 'Write a function in Swift that returns the nth Fibonacci number.',
]
