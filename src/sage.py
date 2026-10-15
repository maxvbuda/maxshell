#!/usr/bin/env python3
"""Sage's engine, running on this Mac with Apple's MLX: Sage Ultra is
Alibaba's Qwen3.8-27B, thinking before it answers; Sage Pro and Flash are
Google's Gemma 4 (E4B, E2B); Sage Lite is Alibaba's Qwen3-1.7B in a chat and
Mistral's Ministral 3 3B in sage code. All 4-bit.
Run by maxshell's `sage`.

The model folder ($MAXSHELL_GEMMA, set up by `sage --setup` under
~/.maxshell/gemma) holds an mlx-lm model; $MAXSHELL_SAGE_NAME says which
(ULTRA, E4B, E2B, LITE or LITE-CODE), so the conversation is in its format.

  sage.py                      chat on the terminal (bye to leave)
  sage.py <question>           one answer
  sage.py --serve CMDS MODE    the engine behind sage's full-screen app: reads
                               JSON commands from the file CMDS as they're
                               appended, writes JSON events to stdout. MODE
                               is chat, or code (file tools, run by the app).
  sage.py --image-prompt REQ OUT   for sage image / sage video: reads
                               {prompt, edit, context, kind} from the JSON
                               file REQ, writes a detailed prompt to OUT.

Colours come from maxshell's theme in $MAXSHELL_SAGE_COLORS.
"""

import datetime
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import time

DIR = os.environ.get('MAXSHELL_GEMMA') or os.path.expanduser('~/.maxshell/gemma')
NAME = os.environ.get('MAXSHELL_SAGE_NAME') or 'E4B'
# Ultra is Qwen3.8-27B; Pro and Flash are Gemma 4 (E4B, E2B); Lite is
# Qwen3-1.7B in a chat and Ministral 3 3B in sage code.
LABEL = {'ULTRA': 'Ultra', 'E2B': 'Flash', 'LITE': 'Lite', 'LITE-CODE': 'Lite'}.get(NAME, 'Pro')
FLAG = {'ULTRA': ' --ultra', 'E2B': ' --flash', 'LITE': ' --lite', 'LITE-CODE': ' code --lite'}.get(NAME, '')
NEED_GB = {'ULTRA': 16, 'E4B': 5, 'E2B': 3, 'LITE': 1, 'LITE-CODE': 3}.get(NAME, 5)
NEED_FREE = {'ULTRA': 60, 'E4B': 30, 'E2B': 20, 'LITE': 10, 'LITE-CODE': 15}.get(NAME, 30)  # % of memory free before loading
# How much Sage Ultra thinks at first: off, low, medium or high (xhigh is high).
THINKING = {'xhigh': 'high'}.get(os.environ.get('MAXSHELL_SAGE_EFFORT', ''), os.environ.get('MAXSHELL_SAGE_EFFORT', ''))
THINKING = THINKING if THINKING in ('off', 'low', 'medium', 'high') else 'medium'
GEMMA_THINKING = THINKING if os.environ.get('MAXSHELL_SAGE_EFFORT') else 'medium'  # Gemma's default: see GemmaChat.level
MAKER = {'ULTRA': 'Alibaba', 'LITE': 'Alibaba', 'LITE-CODE': 'Mistral AI'}.get(NAME, 'Google')
COLORS = {'accent': '', 'accent2': '', 'muted': '', 'bold': '', 'reset': ''}
COLORS.update(json.loads(os.environ.get('MAXSHELL_SAGE_COLORS') or '{}'))
C = type('C', (), COLORS)
TAG = f"{C.accent}{C.bold}✦ sage ❯{C.reset} "
TAG_WIDTH = len('✦ sage ❯ ')
YOU = f"{C.accent2}{C.bold}you ❯{C.reset} "
MAX_TOKENS = 8192
CODE_TEMPERATURE = 0.3  # steadier code than Gemma's usual 1.0
CODING = re.compile(r'```|\b(code|coding|program|script|function|method|class|bug|error|exception|traceback|compile|'
                    r'regex|sql|python|javascript|typescript|java|swift|rust|golang|c\+\+|ruby|php|bash|shell|zsh|'
                    r'html|css|json|yaml|api|algorithm|implement|refactor|debug|unit tests?)\b', re.I)


STAMP = re.compile(r'It is [A-Z][a-z]+day, ')  # where a system prompt's time begins: only what's before it is shared


NEEDS_THOUGHT = re.compile(r'\d|\b(how (many|much|long|far|old)|calculate|compute|solve|equation|puzzle|riddle|logic(al)?|'
                           r'prove|probability|percent(age)?|average|sum|total|cost|price|faster|older|younger|taller|shorter|'
                           r'heavier|which (is|was) (more|less|bigger|smaller)|step by step|plan|compare|why)\b', re.I)


def needs_thought(question):
    """Whether a question is worth thinking about first: numbers, puzzles,
    comparisons, code — not small talk, facts or a quick rewrite."""
    return bool(NEEDS_THOUGHT.search(question) or CODING.search(question))


def is_coding(turns):
    """Whether the chat is about code: the question says so, or the last answer had some."""
    last = [text for who, text in turns if who == 'user'][-1:]
    said = [text for who, text in turns if who != 'user'][-1:]
    return bool(last and CODING.search(last[0])) or bool(said and '```' in said[0])


def _tool(name, description, required, **props):
    return {'type': 'function', 'function': {'name': name, 'description': description, 'parameters': {
        'type': 'object', 'required': required,
        'properties': {k: {'type': 'string', 'description': v} for k, v in props.items()}}}}


# Sage Code's tools, declared to Gemma in the system prompt; the app runs them
# (src/sagetools.js) and asks the user before any change.
CODE_TOOLS = [
    _tool('list_files', 'List the files and folders in a folder.', [], path='the folder; . is the project folder'),
    _tool('read_file', 'Read a text file.', ['path'], path='the file'),
    _tool('search_files', 'Find lines containing some text in the files under a folder.', ['text'],
          text='the text to look for', path='the folder to search; . by default'),
    _tool('write_file', 'Create a file, or replace a whole file. The user is asked first.', ['path', 'content'],
          path='the file', content='the whole new text of the file'),
    _tool('edit_file', 'Change part of a file: old_text, copied exactly from the file and found once there, '
          'becomes new_text. Read the file first. The user is asked first.', ['path', 'old_text', 'new_text'],
          path='the file', old_text='the exact text to replace', new_text='what replaces it'),
    _tool('run_command', 'Run a shell command in the project folder, as in a terminal, and get its output: make '
          'folders (mkdir -p), run tests or scripts, install packages, use git. It runs without input and stops '
          'after 2 minutes. The user is asked first.', ['command'], command='the command line, e.g. mkdir -p src/utils'),
]
QUOTE = '<|"|>'
CALL = re.compile(r'<\|tool_call>call:(\w+)\{(.*?)\}<tool_call\|>', re.S)
# Hidden too: Gemma's thinking.
HIDDEN = re.compile(r'<\|tool_call>.*?(<tool_call\|>|\Z)|<\|tool_response>.*?(<tool_response\|>|\Z)|<\|channel>.*?(<channel\|>|\Z)|'
                    r'<\|[^<>|\s]*>|<[^<>|\s]*\|>', re.S)
MAX_CALLS = 40  # tool calls in one answer


def visible(raw):
    """What of Gemma's raw output (special tokens kept) the user sees: no tool
    calls or responses, no special tokens."""
    return HIDDEN.sub('', raw)


def parse_call(raw):
    """The last complete tool call in raw output: (name, {arg: text}), or None."""
    calls = CALL.findall(raw)
    if not calls:
        return None
    name, body = calls[-1]
    args = dict(re.findall(r'(\w+):' + re.escape(QUOTE) + r'(.*?)' + re.escape(QUOTE), body, re.S))
    return name, args


def tool_response(name, result):
    """The text that answers a call, as the chat template writes it."""
    return f'<|tool_response>response:{name}{{result:{QUOTE}{result}{QUOTE}}}<tool_response|>'


IMAGE_PROMPT = (
    "You write prompts for an image model. Turn the user's request into one detailed prompt in English, 60 to 120 "
    "words. Keep every detail they gave exactly — the subjects, how many, colours, positions, any text — never drop, "
    "change or contradict one. Then make it concrete: what each subject looks like and where it is in the frame "
    "(left, right, foreground, background), the setting, the lighting and time of day, the camera angle and "
    "framing, and the style or medium (photo, oil painting, 3D render… — a photo if they didn't say). Only words "
    "to be written in the picture (a sign, a title, a label) go in double quotes, spelled exactly; describe "
    "everything else by how it looks — a clock at three o'clock has its hands at 3:00. Write it as plain "
    "description, not a list. "
    "Reply with the prompt only: no title, no preamble, no quotes around it, no markdown.")
VIDEO_PROMPT = (
    "You write prompts for a video model that makes a short clip; you're told how long. Turn the user's request into one detailed "
    "prompt in English, 60 to 120 words. Keep every detail they gave exactly — the subjects, how many, colours, "
    "positions, actions — never drop, change or contradict one. Then make it concrete: what each subject looks like "
    "and where it is, and above all what moves and how — one clear, continuous action that fills the clip's length, "
    "its speed and direction — plus the camera (static, slow push in, pan left, tracking shot…), the setting, the "
    "lighting and the style (cinematic live action if they didn't say). No cuts, no scene changes. Write it as "
    "plain description in the present tense, not a list. Reply with the prompt only: no title, no preamble, no "
    "quotes around it, no markdown.")
VIDEO_FROM_IMAGE_PROMPT = (
    "You write prompts for a video model that brings a still picture to life as a short clip; it sees the "
    "picture. Turn the user's request into one prompt in English, 30 to 80 words, about motion: what moves and "
    "how — one clear, continuous action, its speed and direction — and what the camera does (static if they didn't "
    "say). Keep everything in the picture as it is; don't describe a different scene. Reply with the prompt only: "
    "no title, no preamble, no quotes around it, no markdown.")
IMAGE_EDIT_PROMPT = (
    "You write instructions for an image editing model, which sees the picture but follows instructions literally. "
    "Turn the user's request into a precise instruction of one to three sentences in English: exactly what to "
    "change — which thing, where, its new colour, size, number or look — then what to keep: everything else "
    "unchanged, naming the main subjects, the composition, the style and the lighting where it helps. If the "
    "change is a whole new style or time of day, say so plainly. Only words to be written in the picture go in "
    "double quotes. "
    "Reply with the instruction only: no title, no preamble, no quotes around it, no markdown.")


# What Sage knows about maxshell, in its chat prompt (about 350 tokens, read
# once a conversation): on ai/sage/eval.py it took maxshell questions from
# 0-1 of 12 to 10-12, without hurting the rest. Keep it in step with the
# README when a command changes.
MAXSHELL_BRIEF = (
    'maxshell, in brief (for questions about it): a zsh-like shell written in Node.js. Config ~/.maxshellrc; '
    '~/.maxshell/bin is first on PATH. `theme` lists colour themes, `theme nord` switches (maxshell, dracula, '
    'nord, gruvbox, solarized, tokyo-night, sunset, mono). Keys at the prompt: → accepts the grey suggestion, Tab'
    ' opens the completion menu, Ctrl-R fuzzy history search, Ctrl-P command palette, Alt-H explains the line '
    "without running it (also `explain 'cmd'`), Alt-S saves it as a snippet, Alt-Enter new line. Folders: `j "
    'NAME` jumps to the most-visited match (`j -l` lists), `back` / `forward`, `mark [name]` bookmarks this '
    'folder, `go name` goes there, `marks` lists, `mark -d name` removes one; a folder name alone cds there. '
    "Snippets: `snip`, `snip add NAME 'cmd'`, `snip rm NAME`. Tools: `edit FILE` (nano-style editor; ^O save, ^X "
    'exit, ^T run), `files` (Finder-style browser), `view FILE` (pager), `top` (processes), `gitui` (git: space '
    "stages, c commits, ^T pushes), `dash` (dashboard), `cleanup` (quit what isn't needed), `abbr gco='git "
    "checkout'`. Jobs: Ctrl-Z, `bg`, `fg`, `jobs`. AIs: `sage` (you), `sage code` (edits the project, asking "
    'first), `sage image "…"`, `sage video "…"`, `sage app` (Mac app), `ai` (mx, a tiny model), `bot` (rules). '
    '`maxshell --update` updates, `maxshell --make-default` makes it the login shell.')


def system_prompt(mode):
    if mode == 'image':
        return IMAGE_PROMPT
    if mode == 'image-edit':
        return IMAGE_EDIT_PROMPT
    if mode == 'video':
        return VIDEO_PROMPT
    if mode == 'video-from-image':
        return VIDEO_FROM_IMAGE_PROMPT
    now = datetime.datetime.now()
    when = f"It is {now:%A, %B} {now.day}, {now.year}, {now:%-I:%M %p}."
    if mode == 'code':
        return (f"You are Sage Code, a coding agent inside maxshell, running entirely on the user's Mac. Your name is "
                f"Sage; don't call yourself by the model underneath. "
                f"Use your tools: look around with list_files, read_file and search_files before changing anything; "
                f"use edit_file for changes to existing files and write_file for new files. To make a folder, run "
                f"mkdir -p with run_command; use run_command too for running code and tests, installing packages "
                f"and git. Never delete files or folders. Keep edits small and "
                f"exact, and match the code's style. The user approves every change and may decline one — then "
                f"ask what they'd like instead. Never ask whether to go ahead or wait for a "
                f"go-ahead: once you know the change, call edit_file or write_file right away — the app shows the "
                f"user the change and asks them for you. Call one tool at a time and wait for its result — never say you did "
                f"something until a tool's result shows it worked. When you're done, say briefly what you changed. "
                f"{when} You work in the project folder {os.getcwd()}.")
    return (f"You are Sage, the AI assistant built into maxshell, a shell on the user's Mac. You run entirely on this "
            f"Mac — private, offline, no account. Your name is Sage: introduce yourself as Sage, not by the model "
            f"underneath, and don't bring it up; only if someone asks directly what model you're built on, say "
            f"you're based on an open model from {MAKER}. You're warm, sharp and "
            f"concise. Only write code when it's asked for or really helps; then make it complete and runnable, in "
            f"fenced blocks that name the language. Write math in LaTeX between $ signs. You can't save or change "
            f"files here; if asked to, show the text and suggest `sage code`, which can. " + MAXSHELL_BRIEF + ' ' + when)


def free_memory():
    try:
        return int(subprocess.run(['sysctl', '-n', 'kern.memorystatus_level'], capture_output=True, text=True).stdout)
    except Exception:
        return 100


class Printer:
    """Shows the reply as it comes. At a terminal its markdown is rendered by
    src/markdown.js (with maxshell's theme and syntax colours), which runs
    beside us: the reply goes in on its stdin, and it answers a NUL on stderr
    once a reply is on the screen."""

    def __init__(self, tty):
        self.proc = None
        node = os.environ.get('MAXSHELL_NODE') or shutil.which('node')
        if tty and node:
            script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'markdown.js')
            try:
                self.proc = subprocess.Popen([node, script, str(TAG_WIDTH)], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
            except OSError:
                pass

    def write(self, text):
        if self.proc:
            try:
                self.proc.stdin.write(text.replace('\0', '').encode())
                self.proc.stdin.flush()
                return
            except OSError:
                self.proc = None
        sys.stdout.write(text)
        sys.stdout.flush()

    def done(self):
        if not self.proc:
            return
        try:
            self.proc.stdin.write(b'\0')
            self.proc.stdin.flush()
            while self.proc.stderr.read(1) not in (b'\0', b''):
                pass
        except OSError:
            self.proc = None


# --- the engine: every model runs with MLX on the GPU ---------------------------
#
# Qwen-style tool calls (<tool_call> with JSON or XML inside, or a ```json block) are
# read by ultra_scan below; Gemma's and Mistral's by their chat classes.

ULTRA_SPECIAL = re.compile(r'<\|im_(start|end)\|>|<\|endoftext\|>')
TOOL_NAMES = {t['function']['name'] for t in CODE_TOOLS}


XML_FUNCTION = re.compile(r'<function=([\w.-]+)>(.*?)</function>', re.S)
XML_PARAM = re.compile(r'<parameter=([\w.-]+)>\n?(.*?)\n?</parameter>', re.S)


def _call(text):
    """(name, {arg: text}) if text is a tool call — JSON, or Qwen 3.5's XML
    (<function=name><parameter=arg>\ntext\n</parameter></function>) — else None."""
    m = XML_FUNCTION.fullmatch(text.strip())
    if m:
        return (m.group(1), dict(XML_PARAM.findall(m.group(2)))) if m.group(1) in TOOL_NAMES else None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get('name') not in TOOL_NAMES:
        return None
    args = data.get('arguments') or data.get('parameters') or {}
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            args = {}
    if not isinstance(args, dict):
        args = {}
    return data['name'], {k: v if isinstance(v, str) else json.dumps(v) for k, v in args.items()}


def ultra_scan(raw):
    """Reads Qwen's output for tool calls. It writes them as <tool_call>JSON
    </tool_call>, as its template asks — but often as a ```json block, or bare
    JSON on a line of its own. Returns (shown, calls, cut): the text the user
    sees, with calls taken out and anything that may still turn into one held
    back; the complete calls; and where the first call ends (None if none)."""
    out, calls, cut, i, n = [], [], None, 0, len(raw)
    line_start = lambda k: k == 0 or raw[k - 1] == '\n'  # noqa: E731
    while i < n:
        if raw.startswith('<tool_call>', i):
            j = raw.find('</tool_call>', i)
            if j < 0:
                break  # still coming
            c = _call(raw[i + len('<tool_call>'):j].strip())
            if c:
                calls.append(c)
                cut = j + len('</tool_call>') if cut is None else cut
            i = j + len('</tool_call>')
            continue
        if raw.startswith('`', i) and line_start(i):
            nl = raw.find('\n', i)
            if nl < 0:
                if re.match(r'^`{1,3}(j(s(on?)?)?)?[ \t]*$', raw[i:]):
                    break  # may be the start of a ```json block
            else:
                lang = re.match(r'```[ \t]*([\w+#.-]*)[ \t]*\n', raw[i:nl + 1])
                if lang and lang.group(1) not in ('', 'json'):
                    # code in another language: pass the whole block through
                    end = raw.find('\n```', nl)
                    if end < 0:
                        out.append(raw[i:])
                        break
                    after = end + 4
                    out.append(raw[i:after])
                    i = after
                    continue
                m = lang
                if m:
                    end = raw.find('\n```', nl)
                    if end < 0:
                        break  # held until the block closes
                    after = end + 4
                    if raw.startswith('\n', after):
                        after += 1
                    c = _call(raw[nl + 1:end].strip())
                    if c:
                        calls.append(c)
                        cut = after if cut is None else cut
                    else:
                        out.append(raw[i:after])
                    i = after
                    continue
        if raw[i] == '{' and line_start(i):
            try:
                obj, end = json.JSONDecoder().raw_decode(raw, i)
                c = _call(raw[i:end])
            except ValueError:
                c, end = None, None
            if c:
                calls.append(c)
                cut = end if cut is None else cut
                i = end
                continue
            if end is None and ('\n' not in raw[i:] or re.match(r'\{\s*"name"', raw[i:])):
                break  # may still become a call
        out.append(raw[i])
        i += 1
    return ULTRA_SPECIAL.sub('', ''.join(out)), calls, cut


def ultra_visible(raw):
    """What of Qwen's output the user sees: no tool calls or special tokens."""
    return ultra_scan(raw)[0]


def ultra_parse_calls(raw):
    """The tool calls in raw output: [(name, {arg: text})]."""
    return ultra_scan(raw)[1]


def ultra_tool_responses(results):
    """The user turn that answers a message's tool calls."""
    blocks = '\n'.join(f'<tool_response>\n{r}\n</tool_response>' for r in results)
    return f'<|im_start|>user\n{blocks}<|im_end|>\n<|im_start|>assistant\n'

class Engine:
    """The model, loaded once with mlx-lm; chat() starts a conversation in the
    model's own format."""

    def __init__(self, path, device=None):
        import mlx.core as mx
        from mlx_lm import load
        if device == 'cpu':
            mx.set_default_device(mx.cpu)
        self.mx = mx
        # Mistral's tokenizer splits words wrongly without its fixed pattern
        self.model, self.tok = load(path, tokenizer_config={'fix_mistral_regex': True} if NAME == 'LITE-CODE' else {})
        self.device = 'cpu' if device == 'cpu' else 'gpu'
        self.primes = {}  # system prompts read already → their caches

    def primed(self, head):
        """A KV cache that has read head — the part of a system prompt before
        the time, the same in every conversation — read once and copied after:
        Sage Ultra takes ~20 s to read it, the others a second or two."""
        import copy
        from mlx_lm.models.cache import make_prompt_cache
        if not head:
            return make_prompt_cache(self.model)
        key = tuple(head)
        if key not in self.primes:
            cache = make_prompt_cache(self.model)
            self.model(self.mx.array(head)[None], cache=cache)
            self.mx.eval([c.state for c in cache])
            self.primes[key] = cache
            while len(self.primes) > 4:  # chat and code, at a thinking level or two
                del self.primes[next(iter(self.primes))]
        return copy.deepcopy(self.primes[key])  # as mlx-lm's own prompt cache does: some caches write in place

    def chat(self, mode, system, tools=None, max_calls=40, max_tokens=8192):
        return CHATS.get(NAME, GemmaChat)(self, mode, system, tools, max_calls, max_tokens)


class MlxChat:
    """A conversation as tokens next to MLX's KV cache, so each turn reads only
    what's new. In ChatML (<|im_start|>…<|im_end|>), with Qwen's tool calls:
    <tool_call>{"name": …, "arguments": {…}}</tool_call>, stopping there, and
    the answers back in a user turn as <tool_response>…</tool_response>.
    Subclasses change the format."""
    END = '<|im_end|>'  # ends a turn
    SAMPLING = {'top_p': 0.8, 'top_k': 20}
    REPEAT = 1.05  # repetition penalty

    def __init__(self, engine, mode, system, tools, max_calls, max_tokens):
        from mlx_lm.models.cache import can_trim_prompt_cache
        self.e, self.mode, self.max_calls, self.max_tokens = engine, mode, max_calls, max_tokens
        self.system, self.tools = system, tools
        self.tok = engine.tok
        self.im_end = self.tok.convert_tokens_to_ids(self.END)
        self.turns = []
        self.think = None  # shows the thinking, if given
        self.generated = 0  # tokens written in the last answer…
        self.seconds = 0.0  # …and the time spent writing them (not waiting on tools)
        self.tokens = self.begin(self.prefix(system, tools))  # the whole conversation
        # Linear-attention layers (Qwen 3.5's) can't trim their cache back, so
        # the cache is remembered before each answer and wound back from there.
        self.trimmable = can_trim_prompt_cache(self.cache)
        self.feed(self.tokens[self.fed():])  # read the rest of the system prompt now
        self.mark()

    def split(self, prefix):
        """The system turn's tokens before the time, and from it."""
        at = STAMP.search(prefix)
        return (self.encode(prefix[:at.start()]), self.encode(prefix[at.start():])) if at else (self.encode(prefix), [])

    def begin(self, prefix):
        """The system turn's tokens, with self.cache started on a copy of one
        that has read them up to the time (Engine.primed)."""
        head, tail = self.split(prefix)
        self.cache = self.e.primed(head)
        return head + tail

    def prefix(self, system, tools):
        """The system turn (with the tools), in the model's chat template."""
        return self.tok.apply_chat_template([{'role': 'system', 'content': system}], tools=tools, tokenize=False)

    def set_thinking(self, level):
        """How much the model thinks: off, low, medium or high. Only Sage
        Ultra thinks; for the rest it does nothing."""

    def encode(self, text):
        return list(self.tok.encode(text, add_special_tokens=False))

    def fed(self):
        return next(c.offset for c in self.cache if hasattr(c, 'offset'))

    def feed(self, tokens):
        mx = self.e.mx
        if tokens:
            self.e.model(mx.array(tokens)[None], cache=self.cache)
            mx.eval([c.state for c in self.cache])

    def mark(self):
        """Remembers the cache as it is now (the linear layers' arrays never
        change in place, so a copy of the lists will do)."""
        from mlx_lm.models.cache import ArraysCache
        if not self.trimmable:
            self.saved = (self.fed(), [list(c.cache) if isinstance(c, ArraysCache) else None for c in self.cache])

    def rewind(self, n):
        """Makes the cache hold just the conversation's first n tokens."""
        from mlx_lm.models.cache import trim_prompt_cache
        extra = self.fed() - n
        if extra <= 0:
            return
        if self.trimmable:
            trim_prompt_cache(self.cache, extra)
            return
        at, states = self.saved
        for c, saved in zip(self.cache, states):
            if saved is None:
                c.trim(c.offset - at)
            else:
                c.cache = list(saved)
        self.feed(self.tokens[at:n])
        self.mark()

    def pending(self):
        """Conversation tokens the cache hasn't read; winds the cache back if
        it read past them (a token computed but never shown)."""
        if self.fed() > len(self.tokens):
            self.rewind(len(self.tokens))
        return self.tokens[self.fed():]

    def generate(self, text_after, show, stop, temperature, halt=None, limit=None, ban=()):
        """Adds text_after to the conversation and lets the model write; returns
        its raw output. halt() true stops it too; limit caps its length; the
        tokens in ban are never written."""
        from mlx_lm import stream_generate
        from mlx_lm.sample_utils import make_sampler, make_logits_processors
        new = self.encode(text_after)
        prompt = self.pending() + new
        self.tokens += new
        if not self.trimmable and len(prompt) > 1:
            self.feed(prompt[:-1])  # read it here, so the mark is just before the answer
            prompt = prompt[-1:]
            self.mark()
        sampler = make_sampler(temp=temperature, **self.SAMPLING)
        processors = make_logits_processors(repetition_penalty=self.REPEAT)
        first = self.not_first() if ban else []
        if ban:
            ids = [self.tok.convert_tokens_to_ids(t) for t in ban]
            step = [0]

            def banned(tokens, logits):
                logits[:, ids] = -float('inf')
                if not step[0] and first:
                    logits[:, first] = -float('inf')  # an answer, not an empty turn
                step[0] += 1
                return logits
            processors = [*processors, banned]
        raw, shown, thought, out, cut = '', 0, 0, [], None
        base = len(self.tokens)
        began = time.time()
        for r in stream_generate(self.e.model, self.tok, prompt, max_tokens=limit or self.max_tokens, prompt_cache=self.cache,
                                 sampler=sampler, logits_processors=processors):
            if r.finish_reason is None:
                out.append(r.token)
            elif r.finish_reason in ('stop', 'length'):
                out.append(r.token)
            raw += r.text
            seen, _, cut = self.scan(raw)
            if self.think:
                th = self.thought(raw)
                if len(th) > thought:
                    self.think(th[thought:])
                    thought = len(th)
            if len(seen) > shown:
                show(seen[shown:])
                shown = len(seen)
            if stop['hit'] or cut is not None or (halt and halt()):
                break  # a whole tool call: stop there, so it waits for the result
        self.seconds += time.time() - began
        self.generated += len(out)
        if cut is None:
            self.tokens += out
            return raw
        # Keep the conversation up to the end of the call: wind the cache back
        # and let the call's text be read again.
        raw = raw[:cut]
        self.rewind(base)
        self.tokens = self.tokens[:base] + self.encode(raw)
        return raw

    @staticmethod
    def scan(raw):
        return ultra_scan(raw)

    @staticmethod
    def thought(raw):
        """The thinking in raw output so far (shown apart from the answer)."""
        return ''

    def temperature(self):
        return 0.3 if self.mode == 'code' else 0.7

    def user_turn(self, question):
        return f'<|im_start|>user\n{question}<|im_end|>\n<|im_start|>assistant\n'

    SUGGEST = {
        'chat': 'Based on our conversation, what will I most likely say to you next? Write my next message, short, '
                'the way I would type it.',
        'code': 'Based on our conversation, what will I most likely ask you to do next in this project? Write my next '
                'message, short, the way I would type it.',
    }
    SUGGEST_START = 'My likely next message: "'  # its answer, begun for it: only the message is left to write

    def suggest(self, halt=None):
        """What the user will likely say next, written apart from the
        conversation — the cache is wound back after, as if it never
        happened. Stops as soon as halt() says a new command came. Returns ''
        if none."""
        if self.mode not in self.SUGGEST:
            return ''
        n0, kept = len(self.tokens), (self.generated, self.seconds, list(self.turns))
        self.feed(self.pending())
        self.mark()
        saved = getattr(self, 'saved', None)
        try:
            ask = self.user_turn(self.SUGGEST[self.mode])
            ask += ('' if ask.endswith(self.no_thought()) else self.no_thought()) + self.SUGGEST_START
            raw = self.generate(ask, lambda s: None, {'hit': False}, 0.7, halt, 40, self.NO_THOUGHT)
        finally:
            if saved is not None:
                self.saved = saved
            self.rewind(n0)
            self.tokens = self.tokens[:n0]
            self.generated, self.seconds, self.turns = kept
        if halt and halt():
            return ''
        return clean_suggestion(raw)

    NO_THOUGHT = ()  # tokens that would start thinking, not wanted in a suggestion

    def banned(self):
        """Tokens never written in an answer (Gemma's thinking, when it's off)."""
        return ()

    def not_first(self):
        """Token ids that may not start an answer when some are banned."""
        return []

    def no_thought(self):
        """What makes the answer skip thinking (most chats already do)."""
        return ''

    def past_turn(self, question, said):
        """An earlier exchange, as if it had just happened (for restore)."""
        return f'{self.user_turn(question)}{said}{self.END}\n'

    def restore(self, turns):
        """Picks up an earlier conversation: [[question, answer], …]. The
        cache reads it before the next answer."""
        for question, said in turns:
            self.tokens += self.encode(self.past_turn(question, said))
            self.turns += [('user', question), ('ai', said)]

    def answer(self, calls, results):
        """The text that gives the model its calls' results: Qwen hears them
        in a user turn."""
        self.close_turn()
        return ultra_tool_responses(results)

    def close_turn(self):
        if not self.tokens or self.tokens[-1] != self.im_end:
            self.tokens.append(self.im_end)
        self.tokens += self.encode('\n')

    def reply(self, question, show, tools=None, think=None):
        """Sage's answer, shown as it comes; and whether Ctrl-C stopped it.
        tools maps a tool's name to a function of its arguments; think, if
        given, is shown the model's thinking as it comes."""
        self.think = think
        self.turns.append(('user', question))
        self.generated, self.seconds = 0, 0.0
        stop = {'hit': False}
        temperature = self.temperature()
        text_after = self.user_turn(question)
        said = []
        for _ in range(self.max_calls + 1):
            old = signal.signal(signal.SIGINT, lambda *a: stop.update(hit=True))
            try:
                raw = self.generate(text_after, show, stop, temperature, ban=self.banned())
            finally:
                signal.signal(signal.SIGINT, old)
            shown, calls, _ = self.scan(raw)
            said.append(shown)
            calls = calls[:1] if not stop['hit'] else []  # one at a time: it sees each result
            if not calls:
                break
            results = []
            for name, args in calls:
                fn = (tools or {}).get(name)
                try:
                    results.append(fn(**args) if fn else f'There is no tool called {name}.')
                except Exception as e:  # noqa: BLE001 — Sage hears what went wrong
                    results.append(f'{name} failed: {e}')
                if stop['hit']:
                    break
            text_after = self.answer(calls, results)
            if stop['hit']:
                self.tokens += self.encode(text_after)
                break
        self.close_turn()
        self.turns.append(('ai', ''.join(said).strip()))
        return stop['hit']


class GemmaChat(MlxChat):
    """Gemma 4 (Sage Pro and Flash). Gemma's turns and sampling, and its tool
    calls: it writes <|tool_call>call:name{…}<tool_call|>, generation stops
    there, and the result goes back in the same turn, as Gemma's template
    does. Any thinking is hidden."""
    END = '<turn|>'
    SAMPLING = {'top_p': 0.95, 'top_k': 64}  # Google's settings, with temperature 1
    REPEAT = None

    @staticmethod
    def scan(raw):
        end = raw.find('<tool_call|>')
        call = parse_call(raw[:end + len('<tool_call|>')]) if end >= 0 else None
        return visible(raw), [call] if call else [], end + len('<tool_call|>') if call else None

    def answer(self, calls, results):
        return ''.join(tool_response(name, result) for (name, _), result in zip(calls, results))

    @staticmethod
    def thought(raw):
        return ''.join(m.group(1) if m.group(2) else held(m.group(1), '<channel|>')
                       for m in re.finditer(r'<\|channel>thought\n(.*?)(<channel\|>|\Z)', raw, re.S))  # once its label is whole

    def temperature(self):
        if self.mode.startswith(('image', 'video')):
            return 0.7
        return CODE_TEMPERATURE if self.mode == 'code' or is_coding(self.turns) else 1.0

    def user_turn(self, question):
        return f'<|turn>user\n{question}<turn|>\n<|turn>model\n'

    def past_turn(self, question, said):
        return f'<|turn>user\n{question}<turn|>\n<|turn>model\n{said}<turn|>\n'

    NO_THOUGHT = ('<|channel>',)

    def no_thought(self):
        return '<|channel>thought\n<channel|>'  # an empty thought

    # Gemma 4 (this 4-bit build) thinks before every answer, even with
    # thinking off in its template; taking away the token that starts a
    # thought stops it. Off never thinks (several times quicker, but sums
    # slip); low and medium (the default) think only when the question needs
    # it — sums, puzzles, code — and answer the rest straight away (4-5x
    # quicker, as right on ai/sage/eval.py); high always thinks (it has no
    # effort setting). Sage Code always thinks unless off.
    level = GEMMA_THINKING

    def set_thinking(self, level):
        if level in ('off', 'low', 'medium', 'high'):
            self.level = level

    def thinking_now(self):
        if self.level == 'off' or self.mode.startswith(('image', 'video')):
            return self.level != 'off'
        if self.level == 'high' or self.mode == 'code':
            return True
        question = next((text for who, text in reversed(self.turns) if who == 'user'), '')
        return needs_thought(question)

    def banned(self):
        if self.thinking_now():
            return ()
        return self.NO_THOUGHT + (() if self.tools else ('<|tool_call>',))  # it reaches for a call it hasn't got

    def not_first(self):
        # with its thinking taken away it sometimes ends the turn at once
        return [self.im_end, *self.tok.eos_token_ids] if not self.thinking_now() else []


THINK = re.compile(r'<think>.*?(</think>|\Z)\s*', re.S)


def held(text, end):
    """text without a start of end at its end — it may be the end tag coming."""
    for k in range(min(len(end) - 1, len(text)), 0, -1):
        if text.endswith(end[:k]):
            return text[:-k]
    return text


class QwenLiteChat(MlxChat):
    """Sage Lite in a chat: Qwen3-1.7B, ChatML, with thinking off (an empty
    <think></think>, as its template does): quick, and still right on sums."""
    SAMPLING = {'top_p': 0.9}
    REPEAT = None

    @staticmethod
    def scan(raw):
        return ULTRA_SPECIAL.sub('', THINK.sub('', raw)), [], None

    def temperature(self):
        return 0.7 if self.mode.startswith(('image', 'video')) else 0.3

    def user_turn(self, question):
        return super().user_turn(question) + '<think>\n\n</think>\n\n'


def clean_suggestion(text):
    """One short line the user could send, from the user turn the model
    wrote: up to the turn's end, no quotes, labels or markdown."""
    text = re.split(r'"|”|\[/INST\]|<\|im_end\|>|<turn\|>|</s>|<\|im_start\|>|<\|turn>', text)[0]  # up to its closing quote
    lines = [l.strip() for l in visible(text).split('\n') if l.strip()]
    if not lines:
        return ''
    line = re.sub(r'^(\*\*)?(you|user|me|next message|suggestion)(\*\*)?\s*:\s*', '', lines[0], flags=re.I)
    line = line.strip('*_`"“”\' ').strip()
    return line if 2 <= len(line) <= 120 else ''


class QwenUltraChat(MlxChat):
    """Sage Ultra: Qwen3.8-27B. ChatML, and it thinks before every answer
    (<think>…</think>, hidden; the app says "thinking" meanwhile) at the
    reasoning effort its template is given. Tool calls are XML in
    <tool_call> tags, read by ultra_scan; results come back in a user turn.
    On this Mac it writes ~4-6 tokens a second, so in a chat low and medium
    think only when the question needs it (as Pro does) and answer the rest
    straight after an empty thought; high, and Sage Code, always think."""
    SAMPLING = {'top_p': 0.95, 'top_k': 20}  # Qwen's settings for thinking
    REPEAT = None
    EFFORTS = {'low': 'low', 'medium': 'medium', 'high': 'xhigh'}  # the template's names
    NO_THINKING = '<think>\n\n</think>\n\n'  # an empty thought, as its template writes for thinking off

    def __init__(self, *args):
        self.level = THINKING
        self.now = self.level != 'off'  # whether this answer starts with a thought
        super().__init__(*args)
        self.max_tokens = max(self.max_tokens, 32768)  # room to think

    def prefix(self, system, tools):
        # its template wants a question to render; cut the system turn off one
        how = {'enable_thinking': False} if self.level == 'off' else {'reasoning_effort': self.EFFORTS[self.level]}
        whole = self.tok.apply_chat_template([{'role': 'system', 'content': system}, {'role': 'user', 'content': '?'}],
                                             tools=tools, tokenize=False, **how)
        return whole[:whole.index('<|im_start|>user')]

    def set_thinking(self, level):
        """The level is in the system prompt, so the conversation is kept and
        the cache starts over: the next answer reads it all again first."""
        if level not in ('off', *self.EFFORTS) or level == self.level:
            return
        head = sum(map(len, self.split(self.prefix(self.system, self.tools))))
        self.level = level
        self.tokens = self.begin(self.prefix(self.system, self.tools)) + self.tokens[head:]
        self.mark()

    def scan(self, raw):
        if not self.now:
            return ultra_scan(raw)
        end = raw.find('</think>')
        if end < 0:
            return '', [], None  # still thinking
        start = end + len('</think>')
        start += len(raw[start:]) - len(raw[start:].lstrip())
        shown, calls, cut = ultra_scan(raw[start:])
        return shown, calls, None if cut is None else start + cut

    def thought(self, raw):
        if not self.now:
            return ''
        end = raw.find('</think>')
        return (held(raw, '</think>') if end < 0 else raw[:end].rstrip()).lstrip()

    def temperature(self):
        if not self.now:
            return 0.7
        return 0.6 if self.mode == 'code' else 1.0  # Qwen's advice for thinking

    def suggest(self, halt=None):
        level, now, self.level = self.level, self.now, 'off'  # a quick line: no thinking
        try:
            return super().suggest(halt)
        finally:
            self.level, self.now = level, now

    def thinks_about(self, question):
        if self.level == 'off':
            return False
        return self.level == 'high' or self.mode != 'chat' or needs_thought(question)

    def start(self):
        return '<think>\n' if self.now else self.NO_THINKING

    def user_turn(self, question):
        self.now = self.thinks_about(question)
        return super().user_turn(question) + self.start()

    def past_turn(self, question, said):
        return f'{MlxChat.user_turn(self, question)}{self.NO_THINKING}{said}{self.END}\n'

    def answer(self, calls, results):
        return super().answer(calls, results) + self.start()


MISTRAL_CALL = re.compile(r'\[TOOL_CALLS\]([\w.-]+)\[ARGS\]')
MISTRAL_HIDDEN = re.compile(r'\[TOOL_CALLS\].*|</s>|<s>', re.S)


class MistralChat(MlxChat):
    """Sage Lite in sage code: Ministral 3 3B. [INST]…[/INST] turns; it calls
    a tool by writing [TOOL_CALLS]name[ARGS]{json} and ending its turn, and
    hears back in [TOOL_RESULTS]…[/TOOL_RESULTS], then goes on."""
    END = '</s>'
    SAMPLING = {'top_p': 0.95}
    REPEAT = None

    @staticmethod
    def scan(raw):
        m = MISTRAL_CALL.search(raw)
        if not m:
            return MISTRAL_HIDDEN.sub('', raw), [], None
        try:
            args, end = json.JSONDecoder().raw_decode(raw, m.end())
        except ValueError:
            return MISTRAL_HIDDEN.sub('', raw[:m.start()]), [], None  # still coming
        call = (m.group(1), {k: v if isinstance(v, str) else json.dumps(v) for k, v in args.items()}) if isinstance(args, dict) else None
        return MISTRAL_HIDDEN.sub('', raw[:m.start()]), [call] if call else [], end

    def temperature(self):
        return 0.7 if self.mode.startswith(('image', 'video')) else 0.15  # Mistral's advice

    def user_turn(self, question):
        return f'[INST]{question}[/INST]'


    def past_turn(self, question, said):
        return f'[INST]{question}[/INST]{said}</s>'

    def answer(self, calls, results):
        self.close_turn()
        return ''.join(f'[TOOL_RESULTS]{r}[/TOOL_RESULTS]' for r in results)

    def close_turn(self):
        if not self.tokens or self.tokens[-1] != self.im_end:
            self.tokens.append(self.im_end)


# Which conversation each model has; Gemma for the rest.
CHATS = {'ULTRA': QwenUltraChat, 'LITE': QwenLiteChat, 'LITE-CODE': MistralChat}



def problem():
    """Why the model can't start now, or None."""
    if not any(os.path.exists(os.path.join(DIR, f)) for f in ('model.safetensors', 'model.safetensors.index.json')):
        return f"Sage {LABEL} isn't set up — run: sage{FLAG} --setup"
    free = free_memory()
    if free < NEED_FREE:
        return (f'only {free}% of memory is free and Sage {LABEL} needs about {NEED_GB} GB — close something '
                f'(or pause training: ai --train stop) and try again')
    return None


def open_engine():
    """Loads the model once; returns new_chat(mode) and the device it runs on."""
    engine = Engine(DIR, os.environ.get('MAXSHELL_SAGE_DEVICE'))
    new_chat = lambda mode: engine.chat(mode, system_prompt(mode), CODE_TOOLS if mode == 'code' else None,  # noqa: E731
                                        MAX_CALLS, MAX_TOKENS)
    return new_chat, engine.device


def quiet():
    import warnings
    warnings.filterwarnings('ignore')
    os.environ.setdefault('TRANSFORMERS_VERBOSITY', 'error')


def serve(cmd_path, mode):
    """The engine for sage's app. Commands (one JSON object a line, appended to
    cmd_path): {"op": "ask", "text"}, {"op": "result", "text"} answering a
    tool event, {"op": "restore", "turns"}, {"op": "think", "level"},
    {"op": "suggest", "on"}, {"op": "cancel"} (a question not yet begun),
    {"op": "image-prompt", "id", "prompt", "edit",
    "context"} (/image: a detailed prompt, written apart from the
    conversation), {"op": "reset"}, {"op": "drop"}, {"op": "quit"}. Events on
    stdout: loading, ready, think {s}, text {s}, tool {name, args}, done
    {stopped, tokens, seconds}, suggest {text}, image-prompt {id, text,
    stopped}, error {text}. SIGINT stops an answer.

    Each command may name a conversation ("conv"; "main" if not), and the
    events about it carry it: the engine keeps several, each with its own
    memory, and answers them one at a time — so one can carry on while the
    app shows another (Sage for Mac)."""
    import collections

    def emit(**ev):
        sys.stdout.write(json.dumps(ev) + '\n')
        sys.stdout.flush()

    signal.signal(signal.SIGINT, lambda *a: None)  # only stops answers
    why = problem()
    if why:
        emit(ev='error', text=why)
        return 1
    emit(ev='loading', model=NAME)
    quiet()
    new_chat, device = open_engine()
    emit(ev='ready', model=NAME, device=device)
    parent = os.getppid()
    app = int(os.environ.get('MAXSHELL_SAGE_APP') or 0)  # the app's own pid: sh, our parent, outlives it

    def gone():
        if os.getppid() != parent:
            return True
        try:
            os.kill(app, 0) if app else None
        except ProcessLookupError:
            return True
        except PermissionError:
            pass
        return False

    cmds = open(cmd_path, encoding='utf-8')
    pending = ''
    later = collections.deque()  # commands for other conversations, while one waits on a tool

    def read_cmd():
        nonlocal pending
        while True:
            line = cmds.readline()
            pending += line
            if pending.endswith('\n'):
                cmd, pending = pending, ''
                return json.loads(cmd)
            if gone():  # the app quit (or crashed) without saying so
                return {'op': 'quit'}
            time.sleep(0.03)

    def next_cmd():
        return later.popleft() if later else read_cmd()

    def drain():
        """Reads the commands already sent, without waiting, into later."""
        nonlocal pending
        while os.fstat(cmds.fileno()).st_size > cmds.tell():
            pending += cmds.readline()
            if not pending.endswith('\n'):
                break
            later.append(json.loads(pending))
            pending = ''

    def cancelled(conv):
        """Whether a question still waiting was taken back ({"op": "cancel"})."""
        drain()
        for c in list(later):
            if c.get('op') == 'cancel' and c.get('conv', 'main') == conv:
                later.remove(c)
                return True
        return False

    def tools_for(conv):
        def tool(name):
            def run(**args):
                emit(ev='tool', conv=conv, name=name, args=args)
                while True:
                    cmd = read_cmd()
                    if cmd.get('op') == 'result' and cmd.get('conv', 'main') == conv:
                        return cmd.get('text', '')
                    if cmd.get('op') == 'quit':
                        sys.exit(0)
                    later.append(cmd)  # for after this answer
            return run
        return {t['function']['name']: tool(t['function']['name']) for t in CODE_TOOLS} if mode == 'code' else None

    thinking = THINKING
    suggesting = os.environ.get('MAXSHELL_SAGE_SUGGEST') != '0'
    new_chat(mode)  # reads the system prompt now, while the user types, for every chat to start from
    chats = {}      # conversation → its chat, the most recently used last
    forgotten = {}  # conversation → its turns, once its memory was let go
    MAX_CHATS = 4   # each keeps a KV cache in memory

    def chat_for(conv):
        if conv in chats:
            chats[conv] = chats.pop(conv)
            return chats[conv]
        while len(chats) >= MAX_CHATS:  # let the oldest go: its words are kept, read again if it comes back
            old_id = next(iter(chats))
            old = chats.pop(old_id)
            forgotten[old_id] = [[q, a] for (_, q), (_, a) in zip(old.turns[0::2], old.turns[1::2])]
        chat = new_chat(mode)
        chat.set_thinking(thinking)
        if conv in forgotten:
            chat.restore(forgotten.pop(conv))
        chats[conv] = chat
        return chat

    def new_command():
        """Whether a command is waiting (it stops a suggestion)."""
        try:
            return bool(later) or bool(pending) or os.fstat(cmds.fileno()).st_size > cmds.tell()
        except (OSError, ValueError):
            return False

    while True:
        cmd = next_cmd()
        op = cmd.get('op')
        conv = cmd.get('conv', 'main')
        if op == 'quit':
            return 0
        if op in ('reset', 'drop'):
            chats.pop(conv, None)
            forgotten.pop(conv, None)
            if op == 'reset':
                emit(ev='ready', conv=conv, model=NAME, device=device)
        elif op == 'restore':
            chat_for(conv).restore(cmd.get('turns') or [])
        elif op == 'think':
            thinking = cmd.get('level')
            chat_for(conv).set_thinking(thinking)
        elif op == 'image-prompt':
            text, stopped = write_image_prompt(new_chat, cmd)
            emit(ev='image-prompt', conv=conv, id=cmd.get('id'), text=text, stopped=stopped)
        elif op == 'ask':
            if cancelled(conv):  # stopped before its turn came
                emit(ev='done', conv=conv, stopped=True, tokens=0, seconds=0)
                continue
            chat = chat_for(conv)
            stopped = chat.reply(cmd.get('text', ''), lambda s: emit(ev='text', conv=conv, s=s), tools_for(conv),
                                 lambda s: emit(ev='think', conv=conv, s=s))
            emit(ev='done', conv=conv, stopped=stopped, tokens=chat.generated, seconds=round(chat.seconds, 2))
            if suggesting and not stopped:
                text = chat.suggest(new_command)
                if text:
                    emit(ev='suggest', conv=conv, text=text)
        elif op == 'suggest':
            suggesting = bool(cmd.get('on'))


def clean_prompt(text):
    """The prompt alone: no fences, labels or quotes around it."""
    text = re.sub(r'```\w*', '', text).strip()
    text = re.sub(r'^(\*\*)?(detailed |image |edit )?(prompt|instruction)s?:?(\*\*)?:?\s*', '', text, flags=re.I).strip()
    if len(text) > 1 and text[0] in '"“' and text[-1] in '"”':
        text = text[1:-1].strip()
    return re.sub(r'\s+', ' ', text)


def write_image_prompt(new_chat, req):
    """Sage's detailed prompt (or edit instruction) for a request {prompt,
    edit, context, kind: image | video}, written in a conversation of its
    own; and whether Ctrl-C stopped it. For a video, edit means it starts
    from a picture."""
    edit = bool(req.get('edit'))
    if req.get('kind') == 'video':
        chat = new_chat('video-from-image' if edit else 'video')
        ask = req.get('prompt', '')
        if req.get('context') and not edit:  # a new version of a clip: rewrite the whole prompt with the change
            ask = (f"The clip so far: {req['context']}\n\nThe change the user wants: {ask}\n\n"
                   f"Write the whole prompt for the new version, keeping everything they didn't ask to change.")
        if req.get('seconds'):
            ask += f"\n\n(The clip is {req['seconds']:g} seconds long.)"
        parts = []
        stopped = chat.reply(ask, parts.append)
        return clean_prompt(''.join(parts)), stopped
    chat = new_chat('image-edit' if edit else 'image')
    ask = req.get('prompt', '')
    if edit and req.get('context'):
        ask = f"The picture now shows: {req['context']}\n\nThe change the user wants: {ask}"
    elif edit:
        ask = f'The change the user wants: {ask}'
    parts = []
    stopped = chat.reply(ask, parts.append)
    return clean_prompt(''.join(parts)), stopped


def image_prompt(req_path, out_path):
    """sage image: Sage turns a request into the detailed prompt the image
    model draws from, then exits, so the two never share memory."""
    with open(req_path, encoding='utf-8') as f:
        req = json.load(f)
    why = problem()
    if why:
        sys.stderr.write(f'{why}\n')
        return 1
    quiet()
    new_chat, _ = open_engine()
    text, _ = write_image_prompt(new_chat, req)
    if not text:
        sys.stderr.write('Sage wrote nothing\n')
        return 1
    with open(out_path + '.part', 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(out_path + '.part', out_path)
    return 0


def main():
    args = sys.argv[1:]
    if args[:1] == ['--image-prompt']:
        return image_prompt(args[1], args[2])
    if args[:1] == ['--serve']:
        return serve(args[1], args[2] if len(args) > 2 else 'chat')
    why = problem()
    if why:
        sys.stderr.write(f'sage: {why}\n')
        return 1
    tty = sys.stdout.isatty()
    if tty:
        sys.stdout.write(f'{C.muted}waking Sage…{C.reset}')
        sys.stdout.flush()
    quiet()
    new_chat, _ = open_engine()
    chat = new_chat('chat')
    if tty:
        sys.stdout.write('\r\x1b[K')

    printer = Printer(tty)

    def answer(question):
        if tty:
            sys.stdout.write(TAG)
            sys.stdout.flush()
        stopped = chat.reply(question, printer.write)
        printer.done()
        sys.stdout.write(f"{C.reset}{f'{C.muted} (stopped){C.reset}' if stopped else ''}\n")
        sys.stdout.flush()

    if args:
        answer(' '.join(args))
        return 0
    sys.stdout.write(f'{C.muted}Sage {LABEL}, running on this Mac. It can be wrong — double-check anything important. '
                     f'Ctrl-C stops an answer; bye to leave.{C.reset}\n')
    while True:
        try:
            line = input(YOU)
        except (EOFError, KeyboardInterrupt):
            sys.stdout.write('\n')
            return 0
        if line.strip().lower().rstrip('.!') in ('bye', 'exit', 'quit', 'goodbye'):
            sys.stdout.write(f'{TAG}Bye! 👋\n')
            return 0
        if not line.strip():
            continue
        answer(line.strip())


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:  # Ctrl-C while loading
        sys.stdout.write(f'\r\x1b[K{C.reset}')
        sys.exit(130)
