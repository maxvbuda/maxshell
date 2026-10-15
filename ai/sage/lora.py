"""Sage's LoRA adapters: teach a model maxshell (ai/sage/knowledge.py)
without changing what it already does well.

  ~/.maxshell/gemma/venv/bin/python ai/sage/lora.py pro [--iters 300] [--rank 8]

Tried on Sage Lite (2026-10-14): 36/70 on eval.py against 53/70 for the
prompt brief (MAXSHELL_BRIEF) alone, so no adapter ships. Kept to try again
with better data.

1. Each everyday request in knowledge.GENERAL is answered by the model
   itself, as it is now — those answers are kept as targets, so training
   pulls it toward maxshell's facts and nowhere else.
2. Every fact is asked in each of its wordings (plus a lower-case,
   "in maxshell" and "hey Sage" variant), with Sage's own system prompt on
   varied dates, in exactly the tokens the app sends (the chat class's own
   prefix and turns), and the loss is on the answer only.
3. LoRA on the last layers, then the adapter is saved into the model's
   folder (~/.maxshell/gemma/<model>/adapter), which src/sage.py loads for
   chats (not for sage code). Check it with eval.py --adapter before
   keeping it."""
import argparse
import datetime
import json
import os
import random
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import knowledge  # noqa: E402
from eval import MODELS  # noqa: E402


def variants(q, rng):
    out = [q]
    low = q[0].lower() + q[1:]
    out.append(low.rstrip('?') if rng.random() < 0.5 else low)
    if 'maxshell' not in q.lower() and rng.random() < 0.7:
        out.append(f'In maxshell, {low}')
    else:
        out.append(f'hey sage, {low}')
    return out


def dated(system, rng):
    """The system prompt on a random day, so the adapter doesn't learn one date."""
    day = datetime.datetime(2026, 1, 1) + datetime.timedelta(days=rng.randrange(730), minutes=rng.randrange(1440))
    when = f"It is {day:%A, %B} {day.day}, {day.year}, {day:%-I:%M %p}."
    return re.sub(r'It is [A-Z][a-z]+day, .*?[AP]M\.', when, system)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('model', choices=['pro', 'flash', 'lite', 'ultra'])
    p.add_argument('--iters', type=int, default=300)
    p.add_argument('--rank', type=int, default=8)
    p.add_argument('--layers', type=int, default=16)
    p.add_argument('--lr', type=float, default=1e-4)
    p.add_argument('--batch', type=int, default=2)
    p.add_argument('--out')
    args = p.parse_args()
    name, sub = MODELS[args.model]
    folder = os.path.expanduser('~/.maxshell/gemma/' + sub)
    os.environ['MAXSHELL_SAGE_NAME'] = name
    os.environ['MAXSHELL_GEMMA'] = folder
    os.environ['MAXSHELL_SAGE_EFFORT'] = 'off'
    sys.path.insert(0, os.path.join(HERE, '..', '..', 'src'))
    import sage
    sage.quiet()
    import mlx.core as mx
    import mlx.optimizers as optim
    from mlx_lm.tuner.trainer import TrainingArgs, train
    from mlx_lm.tuner.utils import linear_to_lora_layers
    engine = sage.Engine(sage.DIR)
    rng = random.Random(7)
    out = args.out or os.path.join(folder, 'adapter')
    os.makedirs(out, exist_ok=True)

    # 1. its own answers to everyday requests
    replay_file = os.path.join(out, 'replay.json')
    replay = json.load(open(replay_file)) if os.path.exists(replay_file) else {}
    for i, q in enumerate(knowledge.GENERAL):
        if q in replay:
            continue
        chat = engine.chat('chat', sage.system_prompt('chat'), None, sage.MAX_CALLS, 1024)
        chat.set_thinking('off')
        said = []
        mx.random.seed(i)
        chat.reply(q, said.append)
        replay[q] = ''.join(said).strip()
        print(f'replay {i + 1}/{len(knowledge.GENERAL)}', flush=True)
        json.dump(replay, open(replay_file, 'w'), indent=1)

    # 2. the examples, as the app's own tokens
    pairs = [(v, a) for qs, a in knowledge.FACTS for q in qs for v in variants(q, rng)]
    pairs += list(replay.items()) * 2
    rng.shuffle(pairs)
    cls = sage.CHATS.get(name, sage.GemmaChat)

    class Shell(cls):  # a chat's formatting, without a model or cache
        def __init__(self):
            self.e, self.mode, self.tok, self.level = engine, 'chat', engine.tok, 'off'

    fmt = Shell()
    data = []
    for q, a in pairs:
        system = dated(sage.system_prompt('chat'), rng)
        prompt = fmt.encode(fmt.prefix(system, None) + fmt.user_turn(q))
        whole = prompt + fmt.encode(a + fmt.END)
        data.append((whole, len(prompt)))
    valid = data[:max(8, len(data) // 20)]
    train_set = data[len(valid):]
    print(f'{len(train_set)} examples to train on, {len(valid)} to check; longest {max(len(t) for t, _ in data)} tokens', flush=True)

    # 3. train
    model = engine.model
    model.freeze()
    params = {'rank': args.rank, 'scale': 20.0, 'dropout': 0.05}
    linear_to_lora_layers(model, args.layers, params)
    began = time.time()
    train(model, optim.Adam(learning_rate=args.lr), train_set, valid,
          TrainingArgs(batch_size=args.batch, iters=args.iters, val_batches=-1, steps_per_report=20, steps_per_eval=100,
                       steps_per_save=args.iters, adapter_file=os.path.join(out, 'adapters.safetensors'), max_seq_length=1024,
                       grad_checkpoint=True))
    json.dump({'fine_tune_type': 'lora', 'num_layers': args.layers, 'lora_parameters': params,
               'model': name, 'iters': args.iters, 'lr': args.lr, 'examples': len(train_set)},
              open(os.path.join(out, 'adapter_config.json'), 'w'), indent=1)
    print(f'trained in {time.time() - began:.0f}s, peak {mx.get_peak_memory() / 1e9:.1f} GB → {out}', flush=True)


if __name__ == '__main__':
    main()
