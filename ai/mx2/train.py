#!/usr/bin/env python3
"""Trains maxshell's larger on-device models (mx2, mx3) on this Mac.

    python3 ai/mx2/train.py --bench                 # measure speed for a few sizes
    python3 ai/mx2/train.py --name mx3 --init CKPT  # train (resumes automatically)
    python3 ai/mx2/train.py --name mx3 --export     # write models/mx3.bin from the latest checkpoint

Each model's data lives in ai/<name>/data (chat.jsonl, tokenizer.json,
checkpoints, train.log). Conversation turns are [who, text] with who
user/ai/sys; an ai turn with a third element false is context only (not
trained) — that's how mx3's self-check examples show a wrong answer and
train only the "no".

Architecture (same building blocks as Llama/Gemma, much smaller): token
embedding tied to the output, pre-norm transformer blocks with RMSNorm,
rotary position embeddings (RoPE), multi-head causal attention and a SwiGLU
feed-forward layer, no bias terms. Byte-level BPE tokenizer trained on the
corpus. Loss only on the AI's words.

Checkpoints (model + optimizer + step + data position) are written every
15 minutes to ai/mx2/data/ckpt.pt; a restarted run carries on from there.
"""
import argparse
import json
import math
import os
import random
import struct
import sys
import time

import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(HERE, 'data')
NAME = 'mx2'
MODELS = os.environ.get('MX2_EXPORT_DIR') or os.path.join(ROOT, 'models')
sys.path.insert(0, os.path.dirname(HERE))
from train import BPE, SPECIALS  # noqa: E402  (mx's tokenizer code, reused)


# --- data --------------------------------------------------------------------------

def load_convs():
    return [json.loads(l) for l in open(os.path.join(DATA, 'chat.jsonl'))]


def get_tokenizer(convs, vocab):
    path = os.path.join(DATA, 'tokenizer.json')
    if os.path.exists(path):
        t = json.load(open(path))
        return BPE(t['merges'], t['vocab_size'])
    t0 = time.time()
    sample = random.Random(1).sample(convs, min(len(convs), 60000))
    texts = [t[1] for c in sample for t in c['turns']] + [c['sys'] for c in sample[:2000]]
    tok = BPE.train(texts, vocab)
    json.dump({'merges': tok.merges, 'vocab_size': tok.vocab_size}, open(path, 'w'))
    print(f'tokenizer: {vocab} tokens, trained in {time.time() - t0:.0f}s', flush=True)
    return tok


def encode_all(tok, convs, ctx):
    """Every conversation as (ids, mask). Ones longer than the context are
    left out, so the model only ever learns complete answers (whole sites)."""
    S = tok.special
    ids_all, mask_all, starts = [], [], []
    dropped = 0
    for c in convs:
        ids = [S['<|doc|>'], S['<|sys|>']] + tok.encode(c['sys']) + [S['<|end|>']]
        mask = [0] * len(ids)
        for turn in c['turns']:
            who, text = turn[0], turn[1]
            learn = who == 'ai' and (len(turn) < 3 or turn[2])
            body = tok.encode(text) + [S['<|end|>']]
            ids += [S['<|user|>'] if who == 'user' else S['<|sys|>'] if who == 'sys' else S['<|ai|>']] + body
            mask += [0] + ([1] * len(body) if learn else [0] * len(body))
        if len(ids) > ctx + 1:
            dropped += 1
            continue
        starts.append(len(ids_all))
        ids_all += ids
        mask_all += mask
    if dropped:
        print(f'  left out {dropped} conversations longer than {ctx} tokens', flush=True)
    return torch.tensor(ids_all, dtype=torch.int32), torch.tensor(mask_all, dtype=torch.uint8), torch.tensor(starts)


# --- model ---------------------------------------------------------------------------

class RMSNorm(nn.Module):
    def __init__(self, d, eps=1e-5):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(d))

    def forward(self, x):
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps) * self.weight


def rope_tables(ctx, head_dim, base=10000.0):
    inv = 1.0 / (base ** (torch.arange(0, head_dim, 2).float() / head_dim))
    t = torch.arange(ctx).float()
    freqs = torch.outer(t, inv)  # (ctx, head_dim/2)
    return freqs.cos(), freqs.sin()


def apply_rope(x, cos, sin):
    # x: (B, H, T, D); rotate pairs (even, odd).
    x1, x2 = x[..., 0::2], x[..., 1::2]
    y1 = x1 * cos - x2 * sin
    y2 = x1 * sin + x2 * cos
    return torch.stack((y1, y2), dim=-1).flatten(-2)


class Block(nn.Module):
    def __init__(self, d, heads, hidden):
        super().__init__()
        self.heads = heads
        self.norm1 = RMSNorm(d)
        self.wq = nn.Linear(d, d, bias=False)
        self.wk = nn.Linear(d, d, bias=False)
        self.wv = nn.Linear(d, d, bias=False)
        self.wo = nn.Linear(d, d, bias=False)
        self.norm2 = RMSNorm(d)
        self.w1 = nn.Linear(d, hidden, bias=False)  # gate
        self.w3 = nn.Linear(d, hidden, bias=False)  # up
        self.w2 = nn.Linear(hidden, d, bias=False)  # down

    def forward(self, x, cos, sin):
        B, T, C = x.shape
        h = self.norm1(x)
        q = self.wq(h).view(B, T, self.heads, -1).transpose(1, 2)
        k = self.wk(h).view(B, T, self.heads, -1).transpose(1, 2)
        v = self.wv(h).view(B, T, self.heads, -1).transpose(1, 2)
        q, k = apply_rope(q, cos, sin), apply_rope(k, cos, sin)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        x = x + self.wo(y.transpose(1, 2).reshape(B, T, C))
        h = self.norm2(x)
        return x + self.w2(F.silu(self.w1(h)) * self.w3(h))


class MX2(nn.Module):
    def __init__(self, vocab, ctx, d, layers, heads):
        super().__init__()
        hidden = int(8 * d / 3 / 64 + 0.999) * 64
        self.config = dict(arch='mx2', vocab=vocab, ctx=ctx, d=d, layers=layers, heads=heads, hidden=hidden)
        self.emb = nn.Embedding(vocab, d)
        self.blocks = nn.ModuleList([Block(d, heads, hidden) for _ in range(layers)])
        self.norm = RMSNorm(d)
        cos, sin = rope_tables(ctx, d // heads)
        self.register_buffer('cos', cos, persistent=False)
        self.register_buffer('sin', sin, persistent=False)
        for n, p in self.named_parameters():
            if p.dim() == 2:
                std = 0.02 / math.sqrt(2 * layers) if n.endswith(('wo.weight', 'w2.weight')) else 0.02
                nn.init.normal_(p, std=std)

    def forward(self, idx):
        T = idx.shape[1]
        x = self.emb(idx)
        cos, sin = self.cos[:T], self.sin[:T]
        for b in self.blocks:
            x = b(x, cos, sin)
        return self.norm(x) @ self.emb.weight.T


# --- export (int8 per row, like mx) -----------------------------------------------------

def export(model, tok, meta):
    os.makedirs(MODELS, exist_ok=True)
    sd = {k: v.detach().float().cpu() for k, v in model.state_dict().items()}
    tensors, blobs, offset = [], [], 0

    def add(name, data, dtype, shape):
        nonlocal offset
        pad = (-offset) % 4
        if pad:
            blobs.append(b'\0' * pad)
            offset += pad
        tensors.append({'name': name, 'dtype': dtype, 'shape': list(shape), 'offset': offset})
        blobs.append(data)
        offset += len(data)

    for name, t in sd.items():
        if t.dim() == 2:
            scale = t.abs().amax(dim=1).clamp(min=1e-8) / 127.0
            q = torch.round(t / scale[:, None]).clamp(-127, 127).to(torch.int8)
            add(name, q.numpy().tobytes(), 'i8', t.shape)
            add(name + '.scale', scale.numpy().astype('float32').tobytes(), 'f32', scale.shape)
        else:
            add(name, t.numpy().astype('float32').tobytes(), 'f32', t.shape)
    header = json.dumps({'config': model.config, 'tensors': tensors, 'meta': meta}).encode()
    path = os.path.join(MODELS, f'{NAME}.bin')
    with open(path, 'wb') as f:
        f.write(b'MXAI')
        f.write(struct.pack('<I', len(header)))
        f.write(header)
        f.write(b'\0' * ((-(8 + len(header))) % 4))
        for b in blobs:
            f.write(b)
    from train import SPLIT
    json.dump({'merges': tok.merges, 'vocab_size': tok.vocab_size, 'specials': tok.special, 'split': SPLIT.pattern},
              open(os.path.join(MODELS, f'{NAME}-tokenizer.json'), 'w'))
    print(f'exported {os.path.getsize(path) / 1e6:.1f} MB → models/{NAME}.bin', flush=True)


# --- training ----------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--d', type=int, default=512)
    ap.add_argument('--layers', type=int, default=12)
    ap.add_argument('--heads', type=int, default=8)
    ap.add_argument('--ctx', type=int, default=2048)
    ap.add_argument('--vocab', type=int, default=8192)
    ap.add_argument('--batch', type=int, default=8, help='sequences per micro-batch in phase 1')
    ap.add_argument('--accum', type=int, default=4, help='micro-batches per step in phase 1')
    ap.add_argument('--short', type=int, default=512, help='context length in phase 1')
    ap.add_argument('--phase1', type=int, default=4000, help='steps at the short context; the rest use --ctx')
    ap.add_argument('--steps', type=int, default=5500)
    ap.add_argument('--lr', type=float, default=6e-4)
    ap.add_argument('--warmup', type=int, default=500)
    ap.add_argument('--bench', action='store_true')
    ap.add_argument('--export', action='store_true')
    ap.add_argument('--name', default='mx2', help='which model: data in ai/<name>/data, exported as models/<name>.bin')
    ap.add_argument('--init', help='start from this checkpoint\'s weights (fresh optimizer and schedule)')
    args = ap.parse_args()
    global DATA, NAME
    NAME = args.name
    if NAME != 'mx2':
        DATA = os.path.join(os.path.dirname(HERE), NAME, 'data')

    device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    torch.manual_seed(67)
    random.seed(67)

    if args.bench:
        for d, layers, heads in [(384, 8, 6), (512, 12, 8), (640, 12, 10), (768, 12, 12)]:
            m = MX2(args.vocab, args.ctx, d, layers, heads).to(device)
            opt = torch.optim.AdamW(m.parameters(), lr=1e-4)
            x = torch.randint(0, args.vocab, (args.batch, args.ctx), device=device)
            for i in range(6):
                if i == 2:
                    torch.mps.synchronize()
                    t0 = time.time()
                loss = F.cross_entropy(m(x).view(-1, args.vocab), x.view(-1))
                opt.zero_grad()
                loss.backward()
                opt.step()
            torch.mps.synchronize()
            per = (time.time() - t0) / 4
            n = sum(p.numel() for p in m.parameters())
            tok_s = args.batch * args.ctx / per
            print(f'd={d} layers={layers}: {n / 1e6:.1f}M params, {per:.2f}s/batch, {tok_s:,.0f} tokens/s, '
                  f'{tok_s * 86400 / 1e6:,.0f}M tokens/day, {torch.mps.driver_allocated_memory() / 1e9:.1f} GB', flush=True)
            del m, opt, x, loss
            torch.mps.empty_cache()
        return

    convs = load_convs()
    tok = get_tokenizer(convs, args.vocab)
    ckpt_path = os.path.join(DATA, 'ckpt.pt')

    if args.export:
        ck = torch.load(ckpt_path, map_location='cpu')
        c = ck['config']
        model = MX2(c['vocab'], c['ctx'], c['d'], c['layers'], c['heads'])
        model.load_state_dict(ck['model'])
        export(model, tok, {'params': sum(p.numel() for p in model.parameters()), 'steps': ck['step'],
                            'val_loss': ck.get('val'), 'trained': time.strftime('%Y-%m-%d'), 'device': device})
        return

    random.Random(3).shuffle(convs)
    n_val = 1000
    t0 = time.time()
    train_ids, train_mask, train_starts = encode_all(tok, convs[n_val:], args.ctx)
    val_ids, val_mask, val_starts = encode_all(tok, convs[:n_val], args.ctx)
    print(f'run: --steps {args.steps} --batch {args.batch}x{args.accum} --lr {args.lr}', flush=True)
    print(f'{len(train_ids) / 1e6:.1f}M training tokens ({time.time() - t0:.0f}s to encode), '
          f'{train_mask.float().mean().item() * 100:.0f}% of them answers', flush=True)

    model = MX2(args.vocab, args.ctx, args.d, args.layers, args.heads).to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f'model: {n_params / 1e6:.2f}M parameters', flush=True)
    decay = [p for p in model.parameters() if p.dim() == 2]
    other = [p for p in model.parameters() if p.dim() < 2]
    opt = torch.optim.AdamW([{'params': decay, 'weight_decay': 0.1}, {'params': other, 'weight_decay': 0}],
                            lr=args.lr, betas=(0.9, 0.95), eps=1e-8)
    step = 0
    if os.path.exists(ckpt_path):
        ck = torch.load(ckpt_path, map_location=device)
        model.load_state_dict(ck['model'])
        opt.load_state_dict(ck['opt'])
        step = ck['step']
        print(f'resumed from step {step}', flush=True)
    elif args.init:
        model.load_state_dict(torch.load(args.init, map_location=device)['model'])
        print(f'starting from the weights in {os.path.relpath(args.init, ROOT)}', flush=True)

    def lr_at(s):
        if s < args.warmup:
            return args.lr * (s + 1) / args.warmup
        p = min(1.0, (s - args.warmup) / max(1, args.steps - args.warmup))
        return args.lr * (0.05 + 0.95 * 0.5 * (1 + math.cos(math.pi * p)))

    # Phase 1: short windows, many at once (fast). Phase 2: full-length
    # windows one at a time, so long answers like whole websites are learned.
    def phase(s):
        if s < args.phase1:
            return args.short, args.batch, args.accum
        return args.ctx, 1, args.batch * args.accum * args.short // args.ctx

    def batch(ids, mask, starts, n, ctx):
        s = starts[torch.randint(len(starts), (n,))].clamp(max=len(ids) - ctx - 1)
        x = torch.stack([ids[i:i + ctx] for i in s]).long()
        y = torch.stack([ids[i + 1:i + 1 + ctx] for i in s]).long()
        m = torch.stack([mask[i + 1:i + 1 + ctx] for i in s]).float()
        return x.to(device), y.to(device), m.to(device)

    def loss_of(x, y, m):
        logits = model(x)
        l = F.cross_entropy(logits.view(-1, logits.size(-1)), y.view(-1), reduction='none')
        return (l * m.view(-1)).sum() / m.sum().clamp(min=1)

    @torch.no_grad()
    def evaluate():
        model.eval()
        ctx, n, _ = phase(step)
        v = sum(loss_of(*batch(val_ids, val_mask, val_starts, n, ctx)).item() for _ in range(8)) / 8
        model.train()
        return v

    def sample(prompt, max_new=120):
        S = tok.special
        ids = [S['<|doc|>'], S['<|sys|>']] + tok.encode('date: Tuesday, September 29, 2026 · time: 10:15 AM') + [S['<|end|>'], S['<|user|>']] + tok.encode(prompt) + [S['<|end|>'], S['<|ai|>']]
        x = torch.tensor([ids], device=device)
        model.eval()
        with torch.no_grad():
            for _ in range(max_new):
                logits = model(x[:, -args.ctx:])[:, -1, :] / 0.7
                v, _ = torch.topk(logits, 40)
                logits[logits < v[:, [-1]]] = -float('inf')
                nxt = torch.multinomial(F.softmax(logits, dim=-1), 1)
                if nxt.item() == S['<|end|>']:
                    break
                x = torch.cat([x, nxt], dim=1)
        model.train()
        out = [i for i in x[0, len(ids):].tolist() if i < 256 + len(tok.merges)]
        return tok.decode(out).replace('\n', '⏎')[:160]

    def save(val=None):
        tmp = ckpt_path + '.tmp'
        torch.save({'model': model.state_dict(), 'opt': opt.state_dict(), 'step': step, 'config': model.config, 'val': val}, tmp)
        os.replace(tmp, ckpt_path)

    import signal
    save_now = {'flag': False, 'stop': False}

    def on_sleep(signum, frame):
        save_now['flag'] = True

    def on_stop(signum, frame):
        save_now['flag'] = True
        save_now['stop'] = True

    signal.signal(signal.SIGUSR1, on_sleep)
    signal.signal(signal.SIGTERM, on_stop)

    t0 = time.time()
    last_save = time.time()
    start_step = step
    while step < args.steps:
        for g in opt.param_groups:
            g['lr'] = lr_at(step)
        opt.zero_grad(set_to_none=True)
        total = 0.0
        ctx, n, accum = phase(step)
        if step == args.phase1:
            print(f'phase 2: {ctx}-token context', flush=True)
        for _ in range(accum):
            loss = loss_of(*batch(train_ids, train_mask, train_starts, n, ctx)) / accum
            loss.backward()
            total += loss.item()
            if save_now['flag']:
                break
        if save_now['flag']:
            # The Mac is about to sleep (or we're being stopped): keep the
            # last completed step, save, and carry on (or leave) after.
            opt.zero_grad(set_to_none=True)
            save()
            last_save = time.time()
            save_now['flag'] = False
            print(f'  saved at step {step}', flush=True)
            open(os.path.join(DATA, 'saved.ack'), 'w').write(str(step))
            if save_now['stop']:
                print('stopped; will resume from here', flush=True)
                return
            continue
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        step += 1
        if step % 50 == 0 or step == 1:
            el = (time.time() - t0) / 60
            rate = el / max(1, step - start_step)
            print(f'step {step:6d}  loss {total:.3f}  lr {lr_at(step):.2e}  {el:.1f} min  (~{rate * (args.steps - step) / 60:.1f} h left)', flush=True)
            if step % 500 == 0:
                open(os.path.join(DATA, 'progress.json'), 'w').write(json.dumps({'step': step, 'steps': args.steps, 'phase1': args.phase1}))
        if step % 1000 == 0 or step == args.steps:
            v = evaluate()
            print(f'  validation loss {v:.3f}', flush=True)
            for p in ['hi! who are you?', 'make a website for my bakery', 'reverse a string in python', 'what is photosynthesis', 'how do i center a div', 'how do i take a screenshot']:
                print(f'    {p!r:36} → {sample(p)!r}', flush=True)
            save(v)
            last_save = time.time()
        elif time.time() - last_save > 15 * 60:
            save()
            last_save = time.time()
    v = evaluate()
    save(v)
    export(model, tok, {'params': n_params, 'steps': step, 'val_loss': round(v, 4), 'trained': time.strftime('%Y-%m-%d'),
                        'device': device, 'tokens': len(train_ids)})
    open(os.path.join(DATA, 'done'), 'w').write(time.strftime('%Y-%m-%d %H:%M'))
    print(f'done — exported models/{NAME}.bin', flush=True)


if __name__ == '__main__':
    main()
