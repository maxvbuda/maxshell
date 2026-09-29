# mx — maxshell's on-device AI

`ai` in maxshell chats with **mx**, a small GPT-style language model trained
from scratch on a Mac, for maxshell. Everything here — the dataset, the
tokenizer, the architecture, the training loop — is made for it; nothing is
downloaded.

```
~ ❯ ai
you ❯ how do I pause a program?
✨ ai ❯ Press Ctrl-Z. Then `jobs` lists it, `fg` brings it back and `bg` keeps it running in the background.
```

## How it's built

| Part | What |
|---|---|
| Dataset | `make-dataset.js` — ~138k conversations (~8M tokens) generated on this Mac: bot's rule engine used as a teacher across thousands of phrasings (including multi-turn: a joke, "that's funny", "yes"), maxshell's README, every command's one-line description from the Mac's manual index (`apropos`), hand-written small talk, identity, general knowledge and arithmetic, and honest "I don't know" answers. Each conversation starts with a context line (date, time, your name) that the model learns to read. |
| Tokenizer | Byte-level BPE, 2,048 tokens (1,787 merges + 256 bytes + 5 specials: `<\|doc\|>` `<\|sys\|>` `<\|user\|>` `<\|ai\|>` `<\|end\|>`). |
| Model | GPT: 8 layers, 384 wide, 6 heads, 256-token context, learned positions, pre-LayerNorm, GELU MLP, output tied to the token embedding — **15M parameters**. |
| Training | `train.py` — PyTorch on the Apple GPU (MPS): AdamW, warmup + cosine, loss only on the AI's words, batches of 32 × 256 tokens. The shipped model is the step-3,000 checkpoint (validation loss 0.17) of a planned 5,000-step run on an M3. |
| On device | `models/mx.bin` — int8 weights with a scale per row (15 MB) — run by `src/ai.js` in plain JavaScript (no dependencies) with a key/value cache, ~10 ms per token, streaming. |

For scale: GPT-2 small has 124M parameters and was trained on 40 GB of web
text. mx is about an eighth of the size, trained on 30 MB, so it chats well
about what it was trained on (maxshell, your Mac's commands, small talk, simple
facts, the time and date, names you tell it) and makes things up outside
that — multiplication past the easy ones, what an obscure command does, poems.
It says so when asked.

## Retraining

```sh
node ai/make-dataset.js                        # → ai/data/dataset.jsonl (a few seconds)
caffeinate -i python3 ai/train.py              # → models/mx.bin, models/mx-tokenizer.json (~1 hour)
python3 ai/train.py --steps 200                # a quick smoke run
python3 ai/train.py --resume                   # carry on from ai/data/checkpoint.pt
python3 ai/train.py --export-checkpoint models # ship the latest checkpoint (saved every 1,000 steps)
python3 ai/train.py --parity                   # logits for a fixed prompt, to check src/ai.js
```

`caffeinate -i` keeps the Mac awake: if it sleeps, the GPU work crawls
(the first run went from ~0.7 s to minutes per step while the lid was shut).

Training needs Python 3 with PyTorch (`pip3 install torch`); maxshell itself
only needs the two files in `models/`. `ai/data/` (dataset, tokenizer cache,
checkpoints, log) is not committed.
