#!/usr/bin/env python3
"""Sage's sound: MMAudio (video-to-audio, by Ho Kei Cheng et al.) watches a
clip and makes the sound that goes with it — footsteps when feet land, rain,
engines, a dog's bark — run with PyTorch on the Mac's GPU, in its own Python
(~/.maxshell/gemma/audio; MMAudio needs numpy < 2.1, so Python 3.12).

  sageaudio.py --setup
      downloads the model (large_44k_v2) into the current folder.
  sageaudio.py [--dir MODELS] VIDEO OUT [--prompt P] [--seed N] [--steps N]
      writes OUT: VIDEO with a soundtrack. MMAudio is trained on 8-second
      clips, so a longer video gets its sound 8 seconds at a time, the
      pieces crossfaded; the picture is copied, not re-encoded. VIDEO and
      OUT may be the same file. Prints "sound i/N" as it goes. MODELS is
      the model's folder (default: the current one).

MMAudio's weights are CC-BY-NC 4.0: non-commercial use only.
"""

import os
import shutil
import subprocess
import sys
import tempfile

VARIANT = 'large_44k_v2'
PIECE = 8.0  # seconds: what MMAudio is trained on
FADE = 0.25  # seconds of crossfade between pieces


def ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def duration(video):
    import av
    with av.open(video) as c:
        s = c.streams.video[0]
        if s.duration and s.time_base:
            return float(s.duration * s.time_base)
        return float(c.duration) / 1e6


def setup():
    from mmaudio.eval_utils import all_model_cfg
    all_model_cfg[VARIANT].download_if_needed()  # checks each file's MD5
    with open('ready', 'w', encoding='utf-8') as f:  # what sage video looks for
        f.write(VARIANT + '\n')
    print('done', flush=True)


def soundtrack(video, out, prompt='', seed=42, steps=25):
    import torch
    from mmaudio.eval_utils import all_model_cfg, generate, load_video
    from mmaudio.model.flow_matching import FlowMatching
    from mmaudio.model.networks import get_my_mmaudio
    from mmaudio.model.utils.features_utils import FeaturesUtils

    model = all_model_cfg[VARIANT]
    model.download_if_needed()
    seq = model.seq_cfg
    device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    dtype = torch.bfloat16
    net = get_my_mmaudio(model.model_name).to(device, dtype).eval()
    net.load_weights(torch.load(model.model_path, map_location=device, weights_only=True))
    features = FeaturesUtils(tod_vae_ckpt=model.vae_path, synchformer_ckpt=model.synchformer_ckpt, enable_conditions=True,
                             mode=model.mode, bigvgan_vocoder_ckpt=model.bigvgan_16k_path, need_vae_encoder=False)
    features = features.to(device, dtype).eval()
    rng = torch.Generator(device=device)
    rng.manual_seed(seed)
    fm = FlowMatching(min_sigma=0, inference_mode='euler', num_steps=steps)

    total = duration(video)
    count = max(1, int(-(-total // PIECE)))  # ceil
    length = total / count  # equal pieces, each up to PIECE seconds
    work = tempfile.mkdtemp(prefix='sage-audio-')
    sound = None
    rate = seq.sampling_rate
    try:
        for n in range(count):
            print(f'sound {n + 1}/{count}', flush=True)
            start = n * length
            # each piece overlaps the next by FADE, for the crossfade
            span = min(length + (FADE if n < count - 1 else 0), total - start)
            piece = os.path.join(work, f'piece{n}.mp4')
            subprocess.run([ffmpeg(), '-loglevel', 'error', '-y', '-ss', f'{start:.3f}', '-i', video, '-t', f'{span:.3f}',
                            '-an', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', piece], check=True)
            info = load_video(piece, span)
            seq.duration = info.duration_sec
            net.update_seq_lengths(seq.latent_seq_len, seq.clip_seq_len, seq.sync_seq_len)
            with torch.inference_mode():
                audio = generate(info.clip_frames.unsqueeze(0), info.sync_frames.unsqueeze(0), [prompt],
                                 negative_text=[''], feature_utils=features, net=net, fm=fm, rng=rng,
                                 cfg_strength=4.5).float().cpu()[0]
            if sound is None:
                sound = audio
            else:
                fade = min(int(FADE * rate), sound.shape[-1], audio.shape[-1])
                ramp = torch.linspace(0, 1, fade)
                mixed = sound[..., -fade:] * (1 - ramp) + audio[..., :fade] * ramp
                sound = torch.cat([sound[..., :-fade], mixed, audio[..., fade:]], dim=-1)
        wav = os.path.join(work, 'sound.wav')
        import soundfile
        soundfile.write(wav, sound.numpy().T, rate)
        tmp = out + '.part.mp4'
        subprocess.run([ffmpeg(), '-loglevel', 'error', '-y', '-i', video, '-i', wav, '-map', '0:v:0', '-map', '1:a:0',
                        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tmp], check=True)
        os.replace(tmp, out)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print(f'added sound to {out}', flush=True)


def main():
    args = sys.argv[1:]
    if args[:1] == ['--setup']:
        return setup()
    opts = {'prompt': '', 'seed': 42, 'steps': 25}
    models = None
    rest = []
    i = 0
    while i < len(args):
        if args[i] == '--dir':
            models = args[i + 1]
            i += 2
        elif args[i] in ('--prompt', '--seed', '--steps'):
            key = args[i][2:]
            opts[key] = args[i + 1] if key == 'prompt' else int(args[i + 1])
            i += 2
        else:
            rest.append(args[i])
            i += 1
    if len(rest) != 2:
        sys.exit('usage: sageaudio.py VIDEO OUT [--prompt P] [--seed N] [--steps N]')
    video, out = (os.path.abspath(p) for p in rest)
    if models:
        os.chdir(models)  # MMAudio finds its weights relative to here
    soundtrack(video, out, **opts)


if __name__ == '__main__':
    main()
