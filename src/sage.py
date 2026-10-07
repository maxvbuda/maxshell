#!/usr/bin/env python3
"""Sage's engine: Sage Pro and Lite (Gemma 4 E4B / E2B, with transformers) and
Sage Ultra (Qwen2.5-Coder-7B, with MLX), running on this Mac. Run by
maxshell's `sage`.

The model folder (~/.maxshell/gemma/e4b or ~/.maxshell/gemma, or
$MAXSHELL_GEMMA) holds config.json, the tokenizer and model.safetensors (set
up by `sage --setup`). Only the text half of the model is loaded — not the
image and audio parts. Its FP8 weights become bfloat16 on the GPU, and the
per-layer embedding table stays on disk and is read a row at a time, so E4B
takes about 9 GB (E2B about 5) and can run next to mx training.

  sage.py                      chat on the terminal (bye to leave)
  sage.py <question>           one answer
  sage.py --serve CMDS MODE    the engine behind sage's full-screen app: reads
                               JSON commands from the file CMDS as they're
                               appended, writes JSON events to stdout. MODE
                               is chat, or code (file tools, run by the app).

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
ULTRA = NAME == 'ULTRA'  # Qwen2.5-Coder-7B on MLX (below), not Gemma
LABEL = {'E2B': 'Lite', 'ULTRA': 'Ultra'}.get(NAME, 'Pro')
FLAG = {'E2B': ' --lite', 'ULTRA': ' --ultra'}.get(NAME, '')
NEED_GB = {'E4B': 9, 'E2B': 5, 'ULTRA': 6}.get(NAME, 9)
NEED_FREE = {'E4B': 40, 'E2B': 25, 'ULTRA': 30}.get(NAME, 40)  # % of memory free before loading (training pauses below 15)
MAKER = 'Alibaba' if ULTRA else 'Google'
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
HIDDEN = re.compile(r'<\|tool_call>.*?(<tool_call\|>|$)|<\|tool_response>.*?(<tool_response\|>|$)|<\|[^<>|\s]*>|<[^<>|\s]*\|>', re.S)
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


def system_prompt(mode):
    now = datetime.datetime.now()
    when = f"It is {now:%A, %B} {now.day}, {now.year}, {now:%-I:%M %p}."
    if mode == 'code':
        return (f"You are Sage Code, a coding agent inside maxshell, running entirely on the user's Mac. Your name is "
                f"Sage; don't call yourself by the model underneath. {when} You work in the project folder {os.getcwd()}. "
                f"Use your tools: look around with list_files, read_file and search_files before changing anything; "
                f"use edit_file for changes to existing files and write_file for new files. To make a folder, run "
                f"mkdir -p with run_command; use run_command too for running code and tests, installing packages "
                f"and git. Never delete files or folders. Keep edits small and "
                f"exact, and match the code's style. The user approves every change and may decline one — then "
                f"ask what they'd like instead. Call one tool at a time and wait for its result — never say you did "
                f"something until a tool's result shows it worked. When you're done, say briefly what you changed.")
    return (f"You are Sage, the AI assistant built into maxshell, a shell on the user's Mac. You run entirely on this "
            f"Mac — private, offline, no account. Your name is Sage: introduce yourself as Sage, not by the model "
            f"underneath, and don't bring it up; only if someone asks directly what model you're built on, say "
            f"you're based on an open model from {MAKER}. {when} You're warm, sharp and "
            f"concise. Only write code when it's asked for or really helps; then make it complete and runnable, in "
            f"fenced blocks that name the language. Write math in LaTeX between $ signs. You can't save or change "
            f"files here; if asked to, show the text and suggest `sage code`, which can.")


def free_memory():
    try:
        return int(subprocess.run(['sysctl', '-n', 'kern.memorystatus_level'], capture_output=True, text=True).stdout)
    except Exception:
        return 100


def load():
    import numpy as np
    import torch
    from torch import nn
    from safetensors import safe_open
    from transformers import AutoTokenizer
    from transformers.models.gemma4.configuration_gemma4 import Gemma4TextConfig
    from transformers.models.gemma4.modeling_gemma4 import Gemma4ForCausalLM, Gemma4TextRotaryEmbedding

    device = os.environ.get('MAXSHELL_SAGE_DEVICE') or ('mps' if torch.backends.mps.is_available() else 'cpu')
    path = os.path.join(DIR, 'model.safetensors')
    with open(os.path.join(DIR, 'config.json')) as f:
        conf = json.load(f)
    cfg = Gemma4TextConfig(**conf['text_config'])
    cfg._attn_implementation = 'sdpa'
    with torch.device('meta'):
        model = Gemma4ForCausalLM(cfg)
    model.eval()

    with open(path, 'rb') as f:
        n = struct.unpack('<Q', f.read(8))[0]
        header = json.loads(f.read(n))
    base = 8 + n

    class DiskEmbedding(nn.Module):
        """A bfloat16 [vocab, dim] table in the file; rows are read as needed."""

        def __init__(self, info, scale):
            super().__init__()
            rows, dim = info['shape']
            self.table = np.memmap(path, dtype=np.int16, mode='r', offset=base + info['data_offsets'][0], shape=(rows, dim))
            self.scale = torch.tensor(scale, dtype=torch.bfloat16)

        def forward(self, ids):
            rows = np.ascontiguousarray(self.table[ids.reshape(-1).cpu().numpy()])
            out = torch.from_numpy(rows).view(torch.bfloat16).to(device) * self.scale.to(device)
            return out.reshape(*ids.shape, -1)

    inner = model.model
    ple = 'model.language_model.embed_tokens_per_layer.weight'
    inner.embed_tokens_per_layer = DiskEmbedding(header[ple], inner.embed_tokens_per_layer.scalar_embed_scale)

    def put(owner, name, value, param):
        mod = owner
        parts = name.split('.')
        for p in parts[:-1]:
            mod = getattr(mod, p)
        if param:
            setattr(mod, parts[-1], nn.Parameter(value, requires_grad=False))
        else:
            mod.register_buffer(parts[-1], value, persistent=name.endswith('layer_scalar'))

    with safe_open(path, framework='pt') as f:
        for name, _ in list(model.named_parameters()):
            if name == 'lm_head.weight':
                continue
            key = 'model.language_model.' + name[len('model.'):]
            t = f.get_tensor(key)
            if t.dtype == torch.float8_e4m3fn:
                t = (t.to(torch.float32) * f.get_tensor(key + '_scale').to(torch.float32)).to(torch.bfloat16)
            put(model, name, t.to(torch.bfloat16).to(device), True)
        for name, buf in list(model.named_buffers()):
            if not buf.is_meta:
                continue
            key = 'model.language_model.' + name[len('model.'):]
            if name.endswith('layer_scalar'):
                put(model, name, f.get_tensor(key).to(torch.bfloat16).to(device), False)
            elif name.endswith('embed_scale'):
                owner = model.get_submodule(name.rsplit('.', 1)[0])
                put(model, name, torch.tensor(owner.scalar_embed_scale).to(device), False)
    inner.rotary_emb = Gemma4TextRotaryEmbedding(cfg, device=device)
    model.lm_head.weight = inner.embed_tokens.weight
    left = [n for n, b in list(model.named_parameters()) + list(model.named_buffers()) if b.is_meta]
    if left:
        raise RuntimeError(f'not loaded: {left[:5]}')
    tok = AutoTokenizer.from_pretrained(DIR)
    with open(os.path.join(DIR, 'generation_config.json')) as f:
        gen = json.load(f)
    return model, tok, gen, device


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


class Chat:
    """The conversation as tokens, and the model's cache of all it has read,
    so each turn reads only the new message. (On the CPU, reading takes about
    0.1 s a token: re-reading the whole chat every turn left a follow-up to a
    long answer waiting minutes for its first word.)"""

    def __init__(self, model, tok, gen, device, mode='chat'):
        import torch
        from transformers import DynamicCache
        self.model, self.tok, self.gen, self.device, self.mode = model, tok, gen, device, mode
        self.turns = []
        self.generated = 0  # tokens written in the last answer…
        self.seconds = 0.0  # …and the time spent writing them (not waiting on tools)
        self.eos = gen['eos_token_id'] if isinstance(gen['eos_token_id'], list) else [gen['eos_token_id']]
        system = [{'role': 'system', 'content': system_prompt(mode)}]
        tools = CODE_TOOLS if mode == 'code' else None
        self.ids = self.encode(tok.apply_chat_template(system, tools=tools, tokenize=False))
        self.call_start = tok.convert_tokens_to_ids('<|tool_response>')
        self.cache = DynamicCache(config=model.config)
        with torch.no_grad():  # read the system prompt now, while "loading Gemma…" shows
            model(self.ids, past_key_values=self.cache, use_cache=True)

    def encode(self, text):
        import torch
        return torch.tensor([self.tok.encode(text, add_special_tokens=False)], device=self.device)

    def reply(self, question, show, tools=None):
        """Gemma's answer to the question, shown as it comes; and whether
        Ctrl-C stopped it. tools maps a tool's name to a function of its
        arguments that returns what to tell Gemma."""
        import torch
        from transformers import StoppingCriteria, StoppingCriteriaList, TextStreamer

        self.turns.append(('user', question))
        ids = torch.cat([self.ids, self.encode(f'<|turn>user\n{question}<turn|>\n<|turn>model\n')], dim=1)
        start = ids.shape[1]
        stop = {'hit': False}

        class Stop(StoppingCriteria):
            def __call__(self, input_ids, scores, **kw):
                return stop['hit']

        class Stream(TextStreamer):
            """Shows only what's visible: tool calls are held back."""
            raw, shown = '', 0

            def on_finalized_text(self, text, stream_end=False):
                self.raw += text
                seen = visible(self.raw)
                if len(seen) > self.shown:
                    show(seen[self.shown:])
                    self.shown = len(seen)

        gen = self.gen
        coding = self.mode == 'code' or is_coding(self.turns)
        temperature = CODE_TEMPERATURE if coding else gen.get('temperature', 1.0)
        self.generated = 0
        self.seconds = 0.0
        for _ in range(MAX_CALLS + 1):
            began = time.time()
            old = signal.signal(signal.SIGINT, lambda *a: stop.update(hit=True))
            try:
                with torch.no_grad():
                    out = self.model.generate(
                        ids, past_key_values=self.cache, max_new_tokens=MAX_TOKENS, do_sample=True, temperature=temperature,
                        top_k=gen.get('top_k', 64), top_p=gen.get('top_p', 0.95), eos_token_id=self.eos,
                        pad_token_id=gen.get('pad_token_id', 0), stopping_criteria=StoppingCriteriaList([Stop()]),
                        streamer=Stream(self.tok, skip_prompt=True, skip_special_tokens=False))
            finally:
                signal.signal(signal.SIGINT, old)
            # The cache holds all but the last token; an end token (not read)
            # is dropped.
            self.seconds += time.time() - began
            last = int(out[0, -1]) if out.shape[1] > ids.shape[1] else None
            self.generated += out.shape[1] - ids.shape[1]
            if last in self.eos:
                out = out[:, :-1]
            call = None
            if last == self.call_start and not stop['hit']:
                call = parse_call(self.tok.decode(out[0, ids.shape[1]:], skip_special_tokens=False))
            if not call:
                ids = out
                break
            # Gemma stopped to call a tool: run it, answer, and let it go on.
            name, args = call
            fn = (tools or {}).get(name)
            try:
                result = fn(**args) if fn else f'There is no tool called {name}.'
            except Exception as e:  # noqa: BLE001 — Gemma hears what went wrong
                result = f'{name} failed: {e}'
            if stop['hit']:
                ids = torch.cat([out, self.encode(tool_response(name, result))], dim=1)
                break
            ids = torch.cat([out, self.encode(tool_response(name, result))], dim=1)
        self.ids = torch.cat([ids, self.encode('<turn|>\n')], dim=1)
        answer = visible(self.tok.decode(ids[0, start:], skip_special_tokens=False)).strip()
        self.turns.append(('ai', answer))
        return stop['hit']


# --- Sage Ultra: Qwen2.5-Coder-7B-Instruct (4-bit, MLX) on the GPU ---------------
#
# The same Chat interface as Gemma's above. Qwen calls tools by writing
# <tool_call>{"name": …, "arguments": {…}}</tool_call> and stopping; the
# answers go back in a user turn as <tool_response>…</tool_response>, and it
# carries on. The conversation is kept as tokens next to MLX's KV cache, so
# each turn reads only what's new.

ULTRA_SPECIAL = re.compile(r'<\|im_(start|end)\|>|<\|endoftext\|>')
TOOL_NAMES = {t['function']['name'] for t in CODE_TOOLS}


def _call(text):
    """(name, {arg: text}) if text is a JSON tool call, else None."""
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


class UltraEngine:
    """The model, loaded once; chat() starts a conversation."""

    def __init__(self, path, device=None):
        import mlx.core as mx
        from mlx_lm import load
        if device == 'cpu':
            mx.set_default_device(mx.cpu)
        self.mx = mx
        self.model, self.tok = load(path)
        self.device = 'cpu' if device == 'cpu' else 'gpu'

    def chat(self, mode, system, tools=None, max_calls=40, max_tokens=8192):
        return UltraChat(self, mode, system, tools, max_calls, max_tokens)


class UltraChat:
    def __init__(self, engine, mode, system, tools, max_calls, max_tokens):
        from mlx_lm.models.cache import make_prompt_cache
        self.e, self.mode, self.max_calls, self.max_tokens = engine, mode, max_calls, max_tokens
        self.tok = engine.tok
        self.im_end = self.tok.convert_tokens_to_ids('<|im_end|>')
        self.turns = []
        self.generated = 0
        self.seconds = 0.0
        self.cache = make_prompt_cache(engine.model)
        prefix = self.tok.apply_chat_template([{'role': 'system', 'content': system}], tools=tools, tokenize=False)
        self.tokens = self.encode(prefix)  # the whole conversation
        mx = engine.mx
        engine.model(mx.array(self.tokens)[None], cache=self.cache)  # read the system prompt now
        mx.eval([c.state for c in self.cache])

    def encode(self, text):
        return list(self.tok.encode(text, add_special_tokens=False))

    def fed(self):
        return self.cache[0].offset

    def pending(self):
        """Conversation tokens the cache hasn't read; trims the cache if it read
        past them (a token computed but never shown)."""
        from mlx_lm.models.cache import trim_prompt_cache
        if self.fed() > len(self.tokens):
            trim_prompt_cache(self.cache, self.fed() - len(self.tokens))
        return self.tokens[self.fed():]

    def generate(self, text_after, show, stop, temperature):
        """Adds text_after to the conversation and lets Qwen write; returns
        its raw output."""
        from mlx_lm import stream_generate
        from mlx_lm.sample_utils import make_sampler, make_logits_processors
        new = self.encode(text_after)
        prompt = self.pending() + new
        self.tokens += new
        sampler = make_sampler(temp=temperature, top_p=0.8, top_k=20)
        processors = make_logits_processors(repetition_penalty=1.05)
        raw, shown, out, cut = '', 0, [], None
        base = len(self.tokens)
        began = time.time()
        for r in stream_generate(self.e.model, self.tok, prompt, max_tokens=self.max_tokens, prompt_cache=self.cache,
                                 sampler=sampler, logits_processors=processors):
            if r.finish_reason is None:
                out.append(r.token)
            elif r.finish_reason in ('stop', 'length'):
                out.append(r.token)
            raw += r.text
            seen, _, cut = ultra_scan(raw)
            if len(seen) > shown:
                show(seen[shown:])
                shown = len(seen)
            if stop['hit'] or cut is not None:
                break  # a whole tool call: stop there, so it waits for the result
        self.seconds += time.time() - began
        self.generated += len(out)
        if cut is None:
            self.tokens += out
            return raw
        # Keep the conversation up to the end of the call: trim the cache back
        # and let the call's text be read again (a few tokens).
        from mlx_lm.models.cache import trim_prompt_cache
        raw = raw[:cut]
        if self.fed() > base:
            trim_prompt_cache(self.cache, self.fed() - base)
        self.tokens = self.tokens[:base] + self.encode(raw)
        return raw

    def close_turn(self):
        if not self.tokens or self.tokens[-1] != self.im_end:
            self.tokens.append(self.im_end)
        self.tokens += self.encode('\n')

    def reply(self, question, show, tools=None):
        """Sage's answer, shown as it comes; and whether Ctrl-C stopped it.
        tools maps a tool's name to a function of its arguments."""
        self.turns.append(('user', question))
        self.generated, self.seconds = 0, 0.0
        stop = {'hit': False}
        temperature = 0.3 if self.mode == 'code' else 0.7
        text_after = f'<|im_start|>user\n{question}<|im_end|>\n<|im_start|>assistant\n'
        said = []
        for _ in range(self.max_calls + 1):
            old = signal.signal(signal.SIGINT, lambda *a: stop.update(hit=True))
            try:
                raw = self.generate(text_after, show, stop, temperature)
            finally:
                signal.signal(signal.SIGINT, old)
            shown, calls, _ = ultra_scan(raw)
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
            self.close_turn()
            text_after = ultra_tool_responses(results)
            if stop['hit']:
                self.tokens += self.encode(text_after)
                break
        self.close_turn()
        self.turns.append(('ai', ''.join(said).strip()))
        return stop['hit']


def problem():
    """Why the model can't start now, or None."""
    if not os.path.exists(os.path.join(DIR, 'model.safetensors')):
        return f"Sage {LABEL} isn't set up — run: sage{FLAG} --setup"
    free = free_memory()
    if free < NEED_FREE:
        return (f'only {free}% of memory is free and Sage {LABEL} needs about {NEED_GB} GB — close something '
                f'(or pause training: ai --train stop) and try again')
    return None


def open_engine():
    """Loads the model once; returns new_chat(mode) and the device it runs on."""
    if ULTRA:
        engine = UltraEngine(DIR, os.environ.get('MAXSHELL_SAGE_DEVICE'))
        new_chat = lambda mode: engine.chat(mode, system_prompt(mode), CODE_TOOLS if mode == 'code' else None,  # noqa: E731
                                            MAX_CALLS, MAX_TOKENS)
        return new_chat, engine.device
    model, tok, gen, device = load()
    return (lambda mode: Chat(model, tok, gen, device, mode)), device


def quiet():
    import warnings
    warnings.filterwarnings('ignore')
    os.environ.setdefault('TRANSFORMERS_VERBOSITY', 'error')


def serve(cmd_path, mode):
    """The engine for sage's app. Commands (one JSON object a line, appended to
    cmd_path): {"op": "ask", "text"}, {"op": "result", "text"} answering a
    tool event, {"op": "reset"}, {"op": "quit"}. Events on stdout: loading,
    ready, text {s}, tool {name, args}, done {stopped, tokens, seconds},
    error {text}. SIGINT stops an answer."""
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
    chat = new_chat(mode)
    emit(ev='ready', model=NAME, device=device)
    parent = os.getppid()
    cmds = open(cmd_path, encoding='utf-8')
    pending = ''

    def next_cmd():
        nonlocal pending
        while True:
            line = cmds.readline()
            pending += line
            if pending.endswith('\n'):
                cmd, pending = pending, ''
                return json.loads(cmd)
            if os.getppid() != parent:  # the app is gone
                return {'op': 'quit'}
            time.sleep(0.03)

    def tool(name):
        def run(**args):
            emit(ev='tool', name=name, args=args)
            while True:
                cmd = next_cmd()
                if cmd.get('op') == 'result':
                    return cmd.get('text', '')
                if cmd.get('op') == 'quit':
                    sys.exit(0)
        return run

    tools = {t['function']['name']: tool(t['function']['name']) for t in CODE_TOOLS} if mode == 'code' else None
    while True:
        cmd = next_cmd()
        op = cmd.get('op')
        if op == 'quit':
            return 0
        if op == 'reset':
            chat = new_chat(mode)
            emit(ev='ready', model=NAME, device=device)
        elif op == 'ask':
            stopped = chat.reply(cmd.get('text', ''), lambda s: emit(ev='text', s=s), tools)
            emit(ev='done', stopped=stopped, tokens=chat.generated, seconds=round(chat.seconds, 2))


def main():
    args = sys.argv[1:]
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
