#!/usr/bin/env python3
"""Trains mx, maxshell's on-device chat model, on this Mac.

    python3 ai/train.py                 # tokenizer + training + export
    python3 ai/train.py --steps 200     # a quick smoke run

Needs PyTorch (uses the Apple GPU via MPS when available). The result is
written to models/: mx.bin (int8 weights) and mx-tokenizer.json, which
src/ai.js loads with no dependencies.

Architecture: a small GPT — token + learned position embeddings, pre-norm
transformer blocks (multi-head causal self-attention, GELU MLP), final
LayerNorm, output tied to the token embedding. Tokenizer: byte-level BPE.
"""
import argparse
import json
import math
import os
import random
import re
import struct
import time
from collections import Counter, defaultdict

import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(HERE, 'data')
MODELS = os.path.join(ROOT, 'models')

SPECIALS = ['<|sys|>', '<|user|>', '<|ai|>', '<|end|>', '<|doc|>']
# Pre-tokenizer: must match src/ai.js exactly (ASCII classes only, so the
# regex behaves the same in Python and JavaScript).
SPLIT = re.compile(r"'(?:[sdmt]|ll|ve|re)| ?[A-Za-z]+| ?[0-9]{1,3}| ?[^\sA-Za-z0-9]+|\s+(?!\S)|\s+")


# --- tokenizer ------------------------------------------------------------------

class BPE:
    def __init__(self, merges, vocab_size):
        self.merges = [tuple(m) for m in merges]
        self.ranks = {m: i for i, m in enumerate(self.merges)}
        self.vocab_size = vocab_size
        self.special = {s: vocab_size - len(SPECIALS) + i for i, s in enumerate(SPECIALS)}
        self.cache = {}

    @staticmethod
    def train(texts, vocab_size):
        n_merges = vocab_size - 256 - len(SPECIALS)
        counts = Counter()
        for t in texts:
            for chunk in SPLIT.findall(t):
                counts[chunk.encode('utf-8')] += 1
        words = [list(w) for w in counts]
        freqs = list(counts.values())
        pairs = Counter()
        where = defaultdict(set)
        for i, w in enumerate(words):
            for a, b in zip(w, w[1:]):
                pairs[(a, b)] += freqs[i]
                where[(a, b)].add(i)
        merges = []
        for k in range(n_merges):
            if not pairs:
                break
            best = max(pairs, key=lambda p: (pairs[p], -p[0], -p[1]))
            if pairs[best] < 2:
                break
            new = 256 + k
            merges.append(best)
            for i in list(where[best]):
                w = words[i]
                f = freqs[i]
                for a, b in zip(w, w[1:]):
                    pairs[(a, b)] -= f
                    if pairs[(a, b)] <= 0:
                        del pairs[(a, b)]
                j = 0
                out = []
                while j < len(w):
                    if j + 1 < len(w) and (w[j], w[j + 1]) == best:
                        out.append(new)
                        j += 2
                    else:
                        out.append(w[j])
                        j += 1
                words[i] = out
                for a, b in zip(out, out[1:]):
                    pairs[(a, b)] += f
                    where[(a, b)].add(i)
            where.pop(best, None)
            if k % 250 == 0:
                print(f'  merge {k}/{n_merges}')
        return BPE(merges, vocab_size)

    def encode_chunk(self, chunk):
        hit = self.cache.get(chunk)
        if hit is not None:
            return hit
        ids = list(chunk.encode('utf-8'))
        while len(ids) > 1:
            best = None
            for i, p in enumerate(zip(ids, ids[1:])):
                r = self.ranks.get(p)
                if r is not None and (best is None or r < best[0]):
                    best = (r, i)
            if best is None:
                break
            r, i = best
            ids = ids[:i] + [256 + r] + ids[i + 2:]
        self.cache[chunk] = ids
        return ids

    def encode(self, text):
        out = []
        for chunk in SPLIT.findall(text):
            out.extend(self.encode_chunk(chunk))
        return out

    def decode(self, ids):
        table = {i: bytes([i]) for i in range(256)}
        for k, (a, b) in enumerate(self.merges):
            table[256 + k] = table[a] + table[b]
        return b''.join(table.get(i, b'') for i in ids).decode('utf-8', errors='replace')


def conversation_tokens(tok, conv):
    """Tokens for one conversation and a mask: 1 where the model should
    learn to predict (the AI's words and the end of its turn)."""
    S = tok.special
    ids = [S['<|doc|>'], S['<|sys|>']] + tok.encode(conv['sys']) + [S['<|end|>']]
    mask = [0] * len(ids)
    for who, text in conv['turns']:
        head = [S['<|user|>'] if who == 'user' else S['<|ai|>']]
        body = tok.encode(text) + [S['<|end|>']]
        ids += head + body
        mask += [0] + ([1] * len(body) if who == 'ai' else [0] * len(body))
    return ids, mask


# --- model ------------------------------------------------------------------------

class Block(nn.Module):
    def __init__(self, d, heads, dropout):
        super().__init__()
        self.heads = heads
        self.ln1 = nn.LayerNorm(d)
        self.qkv = nn.Linear(d, 3 * d)
        self.proj = nn.Linear(d, d)
        self.ln2 = nn.LayerNorm(d)
        self.fc = nn.Linear(d, 4 * d)
        self.out = nn.Linear(4 * d, d)
        self.drop = nn.Dropout(dropout)

    def forward(self, x):
        B, T, C = x.shape
        q, k, v = self.qkv(self.ln1(x)).split(C, dim=2)
        q = q.view(B, T, self.heads, C // self.heads).transpose(1, 2)
        k = k.view(B, T, self.heads, C // self.heads).transpose(1, 2)
        v = v.view(B, T, self.heads, C // self.heads).transpose(1, 2)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True, dropout_p=self.drop.p if self.training else 0)
        y = y.transpose(1, 2).contiguous().view(B, T, C)
        x = x + self.drop(self.proj(y))
        x = x + self.drop(self.out(F.gelu(self.fc(self.ln2(x)), approximate='tanh')))
        return x


class GPT(nn.Module):
    def __init__(self, vocab, ctx, d, layers, heads, dropout=0.05):
        super().__init__()
        self.config = dict(vocab=vocab, ctx=ctx, d=d, layers=layers, heads=heads)
        self.wte = nn.Embedding(vocab, d)
        self.wpe = nn.Embedding(ctx, d)
        self.blocks = nn.ModuleList([Block(d, heads, dropout) for _ in range(layers)])
        self.ln_f = nn.LayerNorm(d)
        self.drop = nn.Dropout(dropout)
        self.apply(self._init)
        for b in self.blocks:
            nn.init.normal_(b.proj.weight, std=0.02 / math.sqrt(2 * layers))
            nn.init.normal_(b.out.weight, std=0.02 / math.sqrt(2 * layers))

    @staticmethod
    def _init(m):
        if isinstance(m, nn.Linear):
            nn.init.normal_(m.weight, std=0.02)
            nn.init.zeros_(m.bias)
        elif isinstance(m, nn.Embedding):
            nn.init.normal_(m.weight, std=0.02)

    def forward(self, idx):
        B, T = idx.shape
        x = self.drop(self.wte(idx) + self.wpe(torch.arange(T, device=idx.device)))
        for b in self.blocks:
            x = b(x)
        return self.ln_f(x) @ self.wte.weight.T

    @torch.no_grad()
    def generate(self, ids, max_new, stop, temperature=0.7, top_k=40):
        for _ in range(max_new):
            logits = self(ids[:, -self.config['ctx']:])[:, -1, :] / temperature
            v, _ = torch.topk(logits, top_k)
            logits[logits < v[:, [-1]]] = -float('inf')
            nxt = torch.multinomial(F.softmax(logits, dim=-1), 1)
            ids = torch.cat([ids, nxt], dim=1)
            if nxt.item() == stop:
                break
        return ids


# --- export -------------------------------------------------------------------------

def export(model, tok, path_bin, path_tok, meta):
    """int8 weights with one float scale per row for matrices; float32 for
    LayerNorms and biases. Layout: 'MXAI', u32 header size, JSON header,
    then the tensors, each 4-byte aligned."""
    sd = {k: v.detach().float().cpu() for k, v in model.state_dict().items()}
    tensors = []
    blobs = []
    offset = 0

    def add(name, arr_bytes, dtype, shape, extra=None):
        nonlocal offset
        pad = (-offset) % 4
        if pad:
            blobs.append(b'\0' * pad)
            offset += pad
        entry = {'name': name, 'dtype': dtype, 'shape': list(shape), 'offset': offset}
        if extra:
            entry.update(extra)
        tensors.append(entry)
        blobs.append(arr_bytes)
        offset += len(arr_bytes)

    for name, t in sd.items():
        if t.dim() == 2 and 'ln' not in name:
            scale = t.abs().amax(dim=1).clamp(min=1e-8) / 127.0
            q = torch.round(t / scale[:, None]).clamp(-127, 127).to(torch.int8)
            add(name, q.numpy().tobytes(), 'i8', t.shape)
            add(name + '.scale', scale.numpy().astype('float32').tobytes(), 'f32', scale.shape)
        else:
            add(name, t.numpy().astype('float32').tobytes(), 'f32', t.shape)
    header = json.dumps({'config': model.config, 'tensors': tensors, 'meta': meta}).encode('utf-8')
    with open(path_bin, 'wb') as f:
        f.write(b'MXAI')
        f.write(struct.pack('<I', len(header)))
        f.write(header)
        pad = (-(8 + len(header))) % 4
        f.write(b'\0' * pad)
        for b in blobs:
            f.write(b)
    with open(path_tok, 'w') as f:
        json.dump({'merges': tok.merges, 'vocab_size': tok.vocab_size, 'specials': tok.special,
                   'split': SPLIT.pattern}, f)
    print(f'exported {os.path.getsize(path_bin) / 1e6:.1f} MB → {os.path.relpath(path_bin, ROOT)}')


# --- training -------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--steps', type=int, default=5000)
    ap.add_argument('--batch', type=int, default=32)
    ap.add_argument('--ctx', type=int, default=256)
    ap.add_argument('--d', type=int, default=384)
    ap.add_argument('--layers', type=int, default=8)
    ap.add_argument('--heads', type=int, default=6)
    ap.add_argument('--vocab', type=int, default=2048)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--seed', type=int, default=67)
    ap.add_argument('--resume', action='store_true', help='continue from ai/data/checkpoint.pt')
    ap.add_argument('--warmup', type=int, default=200)
    args = ap.parse_args()
    random.seed(args.seed)
    torch.manual_seed(args.seed)

    device = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'
    convs = [json.loads(l) for l in open(os.path.join(DATA, 'dataset.jsonl'))]
    random.shuffle(convs)
    n_val = max(200, len(convs) // 100)
    val_convs, train_convs = convs[:n_val], convs[n_val:]
    print(f'{len(train_convs)} training conversations, {len(val_convs)} held out · device {device}')

    tok_path = os.path.join(DATA, 'tokenizer.json')
    if os.path.exists(tok_path):
        t = json.load(open(tok_path))
        tok = BPE(t['merges'], t['vocab_size'])
        print('tokenizer: loaded')
    else:
        t0 = time.time()
        texts = [c['sys'] for c in train_convs[:40000]] + [x for c in train_convs for _, x in c['turns']]
        tok = BPE.train(texts, args.vocab)
        json.dump({'merges': tok.merges, 'vocab_size': tok.vocab_size}, open(tok_path, 'w'))
        print(f'tokenizer: trained in {time.time() - t0:.0f}s')

    def pack(cs):
        ids, mask, starts = [], [], []
        for c in cs:
            a, m = conversation_tokens(tok, c)
            starts.append(len(ids))
            ids += a
            mask += m
        return torch.tensor(ids, dtype=torch.long), torch.tensor(mask, dtype=torch.float), torch.tensor(starts)

    t0 = time.time()
    train_ids, train_mask, train_starts = pack(train_convs)
    val_ids, val_mask, val_starts = pack(val_convs)
    print(f'{len(train_ids) / 1e6:.1f}M training tokens ({time.time() - t0:.0f}s to encode), '
          f'{train_mask.mean().item() * 100:.0f}% of them answers')

    def batch(ids, mask, starts, n):
        # Windows start at the beginning of a conversation.
        s = starts[torch.randint(len(starts), (n,))].clamp(max=len(ids) - args.ctx - 1)
        x = torch.stack([ids[i:i + args.ctx] for i in s])
        y = torch.stack([ids[i + 1:i + 1 + args.ctx] for i in s])
        m = torch.stack([mask[i + 1:i + 1 + args.ctx] for i in s])
        return x.to(device), y.to(device), m.to(device)

    model = GPT(args.vocab, args.ctx, args.d, args.layers, args.heads).to(device)
    if args.resume:
        model.load_state_dict(torch.load(os.path.join(DATA, 'checkpoint.pt'), map_location=device))
        print('resumed from ai/data/checkpoint.pt')
    n_params = sum(p.numel() for p in model.parameters())
    print(f'model: {n_params / 1e6:.2f}M parameters')
    decay = [p for n, p in model.named_parameters() if p.dim() == 2]
    no_decay = [p for n, p in model.named_parameters() if p.dim() < 2]
    opt = torch.optim.AdamW([{'params': decay, 'weight_decay': 0.1}, {'params': no_decay, 'weight_decay': 0}],
                            lr=args.lr, betas=(0.9, 0.95))

    def lr_at(step):
        warm = args.warmup
        if step < warm:
            return args.lr * (step + 1) / warm
        p = (step - warm) / max(1, args.steps - warm)
        return args.lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * p)))

    def loss_of(x, y, m):
        logits = model(x)
        l = F.cross_entropy(logits.view(-1, logits.size(-1)), y.view(-1), reduction='none')
        return (l * m.view(-1)).sum() / m.sum().clamp(min=1)

    @torch.no_grad()
    def evaluate():
        model.eval()
        losses = [loss_of(*batch(val_ids, val_mask, val_starts, args.batch)).item() for _ in range(10)]
        model.train()
        return sum(losses) / len(losses)

    def sample(prompt, name='Max'):
        S = tok.special
        conv = {'sys': f'date: Tuesday, September 29, 2026 · time: 10:15 AM · user: {name}', 'turns': [['user', prompt]]}
        ids, _ = conversation_tokens(tok, conv)
        ids = ids + [S['<|ai|>']]
        model.eval()
        out = model.generate(torch.tensor([ids], device=device), 80, S['<|end|>'])[0].tolist()
        model.train()
        return tok.decode([i for i in out[len(ids):] if i < 256 + len(tok.merges)])

    t0 = time.time()
    for step in range(args.steps):
        for g in opt.param_groups:
            g['lr'] = lr_at(step)
        loss = loss_of(*batch(train_ids, train_mask, train_starts, args.batch))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        if step % 100 == 0 or step == args.steps - 1:
            el = time.time() - t0
            print(f'step {step:5d}  loss {loss.item():.3f}  lr {lr_at(step):.2e}  {el / 60:.1f} min'
                  f'  (~{el / (step + 1) * (args.steps - step - 1) / 60:.0f} min left)', flush=True)
        if step % 1000 == 0 and step or step == args.steps - 1:
            print(f'  validation loss {evaluate():.3f}')
            for p in ['hi!', 'what time is it', 'what day is it', 'what is 7 + 5', 'tell me a joke', 'what does grep do', 'how do i undo', 'what is the capital of japan']:
                print(f'    {p!r:36} → {sample(p)!r}')
            torch.save(model.state_dict(), os.path.join(DATA, 'checkpoint.pt'))

    os.makedirs(MODELS, exist_ok=True)
    meta = {'params': n_params, 'steps': args.steps, 'val_loss': round(evaluate(), 4),
            'trained': time.strftime('%Y-%m-%d'), 'device': device, 'tokens': len(train_ids)}
    export(model, tok, os.path.join(MODELS, 'mx.bin'), os.path.join(MODELS, 'mx-tokenizer.json'), meta)


def parity():
    """Prints the exported model's logits for a fixed prompt, dequantized
    exactly as src/ai.js does, so the JavaScript forward pass can be
    checked against PyTorch."""
    t = json.load(open(os.path.join(MODELS, 'mx-tokenizer.json')))
    tok = BPE(t['merges'], t['vocab_size'])
    raw = open(os.path.join(MODELS, 'mx.bin'), 'rb').read()
    n = struct.unpack('<I', raw[4:8])[0]
    header = json.loads(raw[8:8 + n])
    base = 8 + n + ((-(8 + n)) % 4)
    import numpy as np
    arrays = {}
    for e in header['tensors']:
        count = int(np.prod(e['shape']))
        dt = np.int8 if e['dtype'] == 'i8' else np.float32
        arrays[e['name']] = np.frombuffer(raw, dtype=dt, count=count, offset=base + e['offset']).reshape(e['shape'])
    sd = {}
    for k, v in arrays.items():
        if k.endswith('.scale'):
            continue
        sd[k] = torch.tensor(v.astype(np.float32) * arrays[k + '.scale'][:, None] if (k + '.scale') in arrays else v.copy())
    c = header['config']
    model = GPT(c['vocab'], c['ctx'], c['d'], c['layers'], c['heads'])
    model.load_state_dict(sd)
    model.eval()
    S = tok.special
    ids = [S['<|doc|>'], S['<|sys|>']] + tok.encode('date: Tuesday, September 29, 2026 · time: 10:15 AM · user: Max') + [S['<|end|>'], S['<|user|>']] + tok.encode('hi! what does grep do? 🙂') + [S['<|end|>'], S['<|ai|>']]
    with torch.no_grad():
        logits = model(torch.tensor([ids]))[0, -1]
    print(json.dumps({'ids': ids, 'logits': logits.tolist()}))


def export_checkpoint(out_dir):
    """Exports ai/data/checkpoint.pt (saved every 1000 steps) to out_dir —
    to try a run while it's still training, or to keep the last good
    checkpoint of one that was stopped. The step and validation loss come
    from the training log."""
    t = json.load(open(os.path.join(DATA, 'tokenizer.json')))
    tok = BPE(t['merges'], t['vocab_size'])
    sd = torch.load(os.path.join(DATA, 'checkpoint.pt'), map_location='cpu')
    d = sd['wte.weight'].shape[1]
    layers = len({k.split('.')[1] for k in sd if k.startswith('blocks.')})
    model = GPT(sd['wte.weight'].shape[0], sd['wpe.weight'].shape[0], d, layers, d // 64)
    model.load_state_dict(sd)
    steps, val = None, None
    try:
        log = open(os.path.join(DATA, 'train.log')).read()
        vals = re.findall(r'^step\s+(\d+)[^\n]*\n\s+validation loss ([\d.]+)', log, re.M)
        if vals:
            steps, val = int(vals[-1][0]), float(vals[-1][1])
    except OSError:
        pass
    meta = {'params': sum(p.numel() for p in model.parameters()), 'steps': steps, 'val_loss': val,
            'trained': time.strftime('%Y-%m-%d', time.localtime(os.path.getmtime(os.path.join(DATA, 'checkpoint.pt')))),
            'device': 'mps', 'checkpoint': True}
    os.makedirs(out_dir, exist_ok=True)
    export(model, tok, os.path.join(out_dir, 'mx.bin'), os.path.join(out_dir, 'mx-tokenizer.json'), meta)


if __name__ == '__main__':
    import sys
    if '--parity' in sys.argv:
        parity()
    elif '--export-checkpoint' in sys.argv:
        export_checkpoint(sys.argv[sys.argv.index('--export-checkpoint') + 1])
    else:
        main()
