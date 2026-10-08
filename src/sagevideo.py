#!/usr/bin/env python3
"""sage video's side of Wan (mlx-video), run with the video model's own Python.

  sagevideo.py [--prompt-file F | --prompt P] <mlx-video's wan_2 flags>
      makes a clip. Three changes to mlx-video's generate:
        - the prompt can come from a file (Sage writes it while the job waits);
        - the 11 GB T5 text encoder is loaded as stored, in bfloat16 —
          mlx-video upcasts it to float32, 23 GB, which on a 24 GB Mac swaps
          for minutes (and once tripped the GPU watchdog);
        - the VAE decoder runs in bfloat16, not float32: a quarter faster;
        - the MP4 is re-encoded (H.264, yuv420p, faststart) so QuickTime
          plays it.
  sagevideo.py --segments N … --num-frames F
      a long clip: N segments of F frames, each starting from the last frame
      of the one before (Wan TI2V continues from a picture), joined into one
      MP4. Memory stays that of one segment, so a clip can be any length;
      it just takes N times as long. Prints "segment i/N" as it goes.
  sagevideo.py --setup DIR
      downloads and builds the model in DIR/turbo: Wan 2.2 TI2V-5B Turbo, a
      4-step, no-guidance distill (about 10x fewer passes than the base
      model), quantized to 4 bits, with the base model's T5 and VAE.
"""

import os
import shutil
import subprocess
import sys

TURBO = ('Kijai/WanVideo_comfy', 'Wan22-Turbo/Wan2_2-TI2V-5B-Turbo_fp16.safetensors')
PARTS = ('SceneWorks/wan2.2-ti2v-5b-mlx', ['q4/t5_encoder.safetensors', 'q4/vae.safetensors', 'q4/tokenizer.json', 'q4/config.json'])


def load_t5_encoder(model_path, config):
    import mlx.core as mx
    from mlx_video.models.wan_2.text_encoder import T5Encoder

    encoder = T5Encoder(
        vocab_size=config.t5_vocab_size, dim=config.t5_dim, dim_attn=config.t5_dim_attn,
        dim_ffn=config.t5_dim_ffn, num_heads=config.t5_num_heads, num_layers=config.t5_num_layers,
        num_buckets=config.t5_num_buckets, shared_pos=False,
    )
    encoder.load_weights(list(mx.load(str(model_path)).items()))
    mx.eval(encoder.parameters())
    return encoder


def load_vae_decoder(model_path, config=None):
    """The Wan 2.2 VAE decoder in bfloat16: mlx-video runs it in float32,
    which on this GPU is the slowest part of a clip."""
    import mlx.core as mx
    from mlx_video.models.wan_2.vae22 import Wan22VAEDecoder

    class Decoder(Wan22VAEDecoder):
        def __call__(self, z, *a, **kw):
            return super().__call__(z.astype(mx.bfloat16), *a, **kw).astype(mx.float32)

        def decode_tiled(self, z, *a, **kw):
            return super().decode_tiled(z.astype(mx.bfloat16), *a, **kw).astype(mx.float32)

    vae = Decoder(z_dim=48)
    vae.load_weights([(k, v.astype(mx.bfloat16)) for k, v in mx.load(str(model_path)).items()], strict=False)
    mx.eval(vae.parameters())
    return vae


def reencode(path):
    """A copy QuickTime is happy with, in place of what imageio wrote."""
    try:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 — keep the clip as it is
        return
    tmp = path + '.tmp.mp4'
    r = subprocess.run([ffmpeg, '-loglevel', 'error', '-y', '-i', path, '-c:v', 'libx264', '-profile:v', 'high',
                        '-pix_fmt', 'yuv420p', '-crf', '18', '-tag:v', 'avc1', '-movflags', '+faststart', tmp])
    if r.returncode == 0 and os.path.getsize(tmp) > 0:
        os.replace(tmp, path)
    elif os.path.exists(tmp):
        os.remove(tmp)


def ffmpeg_exe():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def take(args, flag, default=None):
    """Removes flag and its value from args; returns the value."""
    if flag not in args:
        return default
    i = args.index(flag)
    value = args[i + 1]
    del args[i:i + 2]
    return value


def generate(args):
    import tempfile

    import mlx_video.models.wan_2.generate as wan

    if '--prompt-file' in args:
        i = args.index('--prompt-file')
        with open(args[i + 1], encoding='utf-8') as f:
            args[i:i + 2] = ['--prompt', f.read().strip()]
    wan.load_t5_encoder = load_t5_encoder
    wan.load_vae_decoder = load_vae_decoder
    segments = int(take(args, '--segments', '1'))
    out = take(args, '--output-path', 'output.mp4')
    image = take(args, '--image')
    seed = int(take(args, '--seed', '-1'))
    if segments == 1:
        sys.argv = ['sage-video'] + args + ['--output-path', out, '--seed', str(seed)] + (['--image', image] if image else [])
        wan.main()
        if os.path.exists(out):
            reencode(out)
        return
    ffmpeg = ffmpeg_exe()
    work = tempfile.mkdtemp(prefix='sage-video-')
    parts = []
    for n in range(segments):
        print(f'segment {n + 1}/{segments}', flush=True)
        part = os.path.join(work, f'part{n}.mp4')
        start = ['--image', image] if image else []
        sys.argv = ['sage-video'] + args + ['--output-path', part, '--seed', str(seed + n if seed >= 0 else -1)] + start
        wan.main()
        if not os.path.exists(part):
            sys.exit(f'segment {n + 1} wasn\'t made')
        parts.append(part)
        # the next segment starts from this one's last frame
        image = os.path.join(work, f'last{n}.png')
        subprocess.run([ffmpeg, '-loglevel', 'error', '-y', '-sseof', '-0.1', '-i', part, '-update', '1', '-frames:v', '1', image], check=True)
    # Join them; each segment after the first begins with the frame the one
    # before ended on, so that frame is dropped.
    inputs, chains = [], []
    for n, part in enumerate(parts):
        inputs += ['-i', part]
        chains.append(f'[{n}:v]{"trim=start_frame=1," if n else ""}setpts=PTS-STARTPTS[v{n}]')
    graph = ';'.join(chains) + ';' + ''.join(f'[v{n}]' for n in range(len(parts))) + f'concat=n={len(parts)}:v=1:a=0[out]'
    subprocess.run([ffmpeg, '-loglevel', 'error', '-y', *inputs, '-filter_complex', graph, '-map', '[out]', '-r', '24', '-c:v', 'libx264',
                    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '18', '-tag:v', 'avc1', '-movflags', '+faststart', out], check=True)
    shutil.rmtree(work, ignore_errors=True)
    print(f'joined {segments} segments into {out}', flush=True)


def setup(root):
    from huggingface_hub import hf_hub_download, snapshot_download

    parts = os.path.join(root, 'download')
    print('Downloading the text encoder and VAE (14 GB)…', flush=True)
    snapshot_download(PARTS[0], allow_patterns=PARTS[1], local_dir=parts)
    print('Downloading Wan 2.2 TI2V-5B Turbo (10 GB)…', flush=True)
    src = hf_hub_download(TURBO[0], TURBO[1], local_dir=parts)
    from transformers import AutoTokenizer
    AutoTokenizer.from_pretrained('google/umt5-xxl')  # cached for generate
    print('Converting it for MLX, 4-bit…', flush=True)
    convert(src, os.path.join(parts, 'q4'), os.path.join(root, 'turbo'), move=True)
    shutil.rmtree(parts)  # our own downloads: the fp16 source isn't needed now
    print('done', flush=True)


def convert(src, parts, out, move=False):
    """The Turbo transformer (fp16, Wan's own key names) → a 4-bit mlx-video
    model in out, with the T5, VAE and tokenizer from parts (moved, or
    copied)."""
    import json

    import mlx.core as mx
    import mlx.nn as nn
    from mlx.utils import tree_flatten
    from mlx_video.models.wan_2.config import WanModelConfig
    from mlx_video.models.wan_2.convert import _quantize_predicate, sanitize_wan_transformer_weights
    from mlx_video.models.wan_2.wan_2 import WanModel

    with open(os.path.join(parts, 'config.json'), encoding='utf-8') as f:
        cfg = json.load(f)
    cfg.pop('quantization', None)
    config = WanModelConfig(**{k: v for k, v in cfg.items() if k in WanModelConfig.__dataclass_fields__})
    weights = {k.removeprefix('model.diffusion_model.'): v for k, v in mx.load(src).items()}
    weights = {k: v.astype(mx.bfloat16) for k, v in sanitize_wan_transformer_weights(weights).items()}
    model = WanModel(config)
    model.load_weights(list(weights.items()), strict=False)  # freqs is built, not stored
    mx.eval(model.parameters())
    del weights
    nn.quantize(model, group_size=64, bits=4, class_predicate=_quantize_predicate)
    os.makedirs(out, exist_ok=True)
    mx.save_safetensors(os.path.join(out, 'model.part.safetensors'), dict(tree_flatten(model.parameters())))
    os.replace(os.path.join(out, 'model.part.safetensors'), os.path.join(out, 'model.safetensors'))
    cfg['quantization'] = {'group_size': 64, 'bits': 4}
    with open(os.path.join(out, 'config.json'), 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)
    for name in ['t5_encoder.safetensors', 'vae.safetensors', 'tokenizer.json']:
        (os.replace if move else shutil.copyfile)(os.path.join(parts, name), os.path.join(out, name))


if __name__ == '__main__':
    if sys.argv[1:2] == ['--setup']:
        setup(sys.argv[2])
    else:
        generate(sys.argv[1:])
