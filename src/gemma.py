#!/usr/bin/env python3
"""aig: chat with Gemma 4 (E2B) on this Mac. Run by maxshell's `aig`.

The model folder (~/.maxshell/gemma, or $MAXSHELL_GEMMA) holds config.json,
the tokenizer and model.safetensors (set up by `aig --setup`). Only the text
half of the model is loaded — not the image and audio parts. Its FP8
weights become bfloat16 on the GPU, and the 4.7 GB per-layer embedding
table stays on disk and is read a row at a time, so it takes about 5 GB and
can run next to mx training.

  aig                 chat (bye to leave; Ctrl-C stops an answer)
  aig <question>      one answer

Colours come from maxshell's theme in $MAXSHELL_AIG_COLORS.
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

DIR = os.environ.get('MAXSHELL_GEMMA') or os.path.expanduser('~/.maxshell/gemma')
NEED_FREE = 25  # % of memory free before loading (training pauses below 15)
COLORS = {'accent': '', 'accent2': '', 'muted': '', 'bold': '', 'reset': ''}
COLORS.update(json.loads(os.environ.get('MAXSHELL_AIG_COLORS') or '{}'))
C = type('C', (), COLORS)
TAG = f"{C.accent}{C.bold}✦ gemma ❯{C.reset} "
TAG_WIDTH = len('✦ gemma ❯ ')
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

    device = os.environ.get('MAXSHELL_AIG_DEVICE') or ('mps' if torch.backends.mps.is_available() else 'cpu')
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


def reply(model, tok, gen, device, turns, show):
    import torch
    from transformers import StoppingCriteria, StoppingCriteriaList, TextStreamer

    now = datetime.datetime.now()
    system = (f"You are Gemma, running on the user's Mac inside maxshell, a zsh-like shell. "
              f"It is {now:%A, %B} {now.day}, {now.year}, {now:%-I:%M %p}. Be helpful and concise. "
              f"Write complete, runnable code in fenced blocks that name the language.")
    messages = [{'role': 'system', 'content': system}] + [{'role': 'user' if who == 'user' else 'assistant', 'content': text} for who, text in turns]
    ids = tok.apply_chat_template(messages, add_generation_prompt=True, return_tensors='pt', return_dict=True)['input_ids'].to(device)

    stop = {'hit': False}

    class Stop(StoppingCriteria):
        def __call__(self, input_ids, scores, **kw):
            return stop['hit']

    class Stream(TextStreamer):
        def on_finalized_text(self, text, stream_end=False):
            show(text)

    old = signal.signal(signal.SIGINT, lambda *a: stop.update(hit=True))
    try:
        with torch.no_grad():
            temperature = CODE_TEMPERATURE if is_coding(turns) else gen.get('temperature', 1.0)
            model.generate(ids, max_new_tokens=MAX_TOKENS, do_sample=True, temperature=temperature,
                           top_k=gen.get('top_k', 64), top_p=gen.get('top_p', 0.95), eos_token_id=gen['eos_token_id'],
                           pad_token_id=gen.get('pad_token_id', 0), stopping_criteria=StoppingCriteriaList([Stop()]),
                           streamer=Stream(tok, skip_prompt=True, skip_special_tokens=True))
    finally:
        signal.signal(signal.SIGINT, old)
    return stop['hit']


def main():
    args = sys.argv[1:]
    if not os.path.exists(os.path.join(DIR, 'model.safetensors')):
        sys.stderr.write(f'aig: no Gemma model in {DIR} — run: aig --setup\n')
        return 1
    free = free_memory()
    if free < NEED_FREE:
        sys.stderr.write(f'aig: only {free}% of memory is free and Gemma needs about 5 GB — close something '
                         f'(or pause training: ai --train stop) and try again.\n')
        return 1
    tty = sys.stdout.isatty()
    if tty:
        sys.stdout.write(f'{C.muted}loading Gemma…{C.reset}')
        sys.stdout.flush()
    import warnings
    warnings.filterwarnings('ignore')
    os.environ.setdefault('TRANSFORMERS_VERBOSITY', 'error')
    model, tok, gen, device = load()
    if tty:
        sys.stdout.write('\r\x1b[K')

    printer = Printer(tty)

    def answer(turns):
        if tty:
            sys.stdout.write(TAG)
            sys.stdout.flush()
        text = []
        stopped = reply(model, tok, gen, device, turns, lambda s: (text.append(s), printer.write(s)))
        printer.done()
        sys.stdout.write(f"{C.reset}{f'{C.muted} (stopped){C.reset}' if stopped else ''}\n")
        sys.stdout.flush()
        return ''.join(text).strip()

    if args:
        answer([('user', ' '.join(args))])
        return 0
    sys.stdout.write(f'{C.muted}Gemma 4 (E2B), running on this Mac. It can be wrong — double-check anything important. '
                     f'Ctrl-C stops an answer; bye to leave.{C.reset}\n')
    turns = []
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
        turns.append(('user', line.strip()))
        turns.append(('ai', answer(turns)))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:  # Ctrl-C while loading
        sys.stdout.write(f'\r\x1b[K{C.reset}')
        sys.exit(130)
