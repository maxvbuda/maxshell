#!/usr/bin/env python3
"""aig: chat with Gemma 4 (E2B or E4B) on this Mac. Run by maxshell's `aig`.

The model folder (~/.maxshell/gemma, or $MAXSHELL_GEMMA) holds config.json,
the tokenizer and model.safetensors (set up by `aig --setup`). Only the text
half of the model is loaded — not the image and audio parts. Its FP8
weights become bfloat16 on the GPU, and the 4.7 GB per-layer embedding
table stays on disk and is read a row at a time, so E2B takes about 5 GB
(E4B about 9) and can run next to mx training.

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
NAME = os.environ.get('MAXSHELL_AIG_NAME') or 'E2B'
NEED_GB = 9 if NAME == 'E4B' else 5
NEED_FREE = 40 if NAME == 'E4B' else 25  # % of memory free before loading (training pauses below 15)
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


class Chat:
    """The conversation as tokens, and the model's cache of all it has read,
    so each turn reads only the new message. (On the CPU, reading takes about
    0.1 s a token: re-reading the whole chat every turn left a follow-up to a
    long answer waiting minutes for its first word.)"""

    def __init__(self, model, tok, gen, device):
        import torch
        from transformers import DynamicCache
        self.model, self.tok, self.gen, self.device = model, tok, gen, device
        self.turns = []
        self.eos = gen['eos_token_id'] if isinstance(gen['eos_token_id'], list) else [gen['eos_token_id']]
        self.end_turn = tok.convert_tokens_to_ids('<turn|>')
        now = datetime.datetime.now()
        system = (f"You are Gemma, running on the user's Mac inside maxshell, a zsh-like shell. "
                  f"It is {now:%A, %B} {now.day}, {now.year}, {now:%-I:%M %p}. Be helpful and concise. "
                  f"Only write code when it's asked for or really helps; then make it complete and runnable, "
                  f"in fenced blocks that name the language. Write math in LaTeX between $ signs.")
        self.ids = self.encode(tok.apply_chat_template([{'role': 'system', 'content': system}], tokenize=False))
        self.cache = DynamicCache(config=model.config)
        with torch.no_grad():  # read the system prompt now, while "loading Gemma…" shows
            model(self.ids, past_key_values=self.cache, use_cache=True)

    def encode(self, text):
        import torch
        return torch.tensor([self.tok.encode(text, add_special_tokens=False)], device=self.device)

    def reply(self, question, show):
        """Gemma's answer to the question, shown as it comes; and whether
        Ctrl-C stopped it."""
        import torch
        from transformers import StoppingCriteria, StoppingCriteriaList, TextStreamer

        self.turns.append(('user', question))
        ids = torch.cat([self.ids, self.encode(f'<|turn>user\n{question}<turn|>\n<|turn>model\n')], dim=1)
        stop = {'hit': False}

        class Stop(StoppingCriteria):
            def __call__(self, input_ids, scores, **kw):
                return stop['hit']

        class Stream(TextStreamer):
            def on_finalized_text(self, text, stream_end=False):
                show(text)

        text = []
        old = signal.signal(signal.SIGINT, lambda *a: stop.update(hit=True))
        try:
            with torch.no_grad():
                gen = self.gen
                temperature = CODE_TEMPERATURE if is_coding(self.turns) else gen.get('temperature', 1.0)
                out = self.model.generate(
                    ids, past_key_values=self.cache, max_new_tokens=MAX_TOKENS, do_sample=True, temperature=temperature,
                    top_k=gen.get('top_k', 64), top_p=gen.get('top_p', 0.95), eos_token_id=self.eos,
                    pad_token_id=gen.get('pad_token_id', 0), stopping_criteria=StoppingCriteriaList([Stop()]),
                    streamer=Stream(self.tok, skip_prompt=True, skip_special_tokens=True))
        finally:
            signal.signal(signal.SIGINT, old)
        # The cache holds all but the last token. An end token is dropped (it
        # wasn't read) and the turn closed the way the chat template does.
        if out.shape[1] > ids.shape[1] and int(out[0, -1]) in self.eos:
            out = out[:, :-1]
        self.ids = torch.cat([out, self.encode('<turn|>\n')], dim=1)
        answer = self.tok.decode(out[0, ids.shape[1]:], skip_special_tokens=True).strip()
        self.turns.append(('ai', answer))
        return stop['hit']


def main():
    args = sys.argv[1:]
    if not os.path.exists(os.path.join(DIR, 'model.safetensors')):
        sys.stderr.write(f"aig: no Gemma model in {DIR} — run: aig{' --e4b' if NAME == 'E4B' else ''} --setup\n")
        return 1
    free = free_memory()
    if free < NEED_FREE:
        sys.stderr.write(f'aig: only {free}% of memory is free and Gemma 4 ({NAME}) needs about {NEED_GB} GB — close something '
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
    chat = Chat(model, tok, gen, device)
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
    sys.stdout.write(f'{C.muted}Gemma 4 ({NAME}), running on this Mac. It can be wrong — double-check anything important. '
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
