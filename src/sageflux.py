"""Sage Image Flash's and Lite's warm worker: the model, loaded once.

--engine flux is Flash, FLUX.2 [klein] 4B through mflux on MLX; --engine lcm
is Lite, DreamShaper 7 LCM through diffusers on PyTorch's Metal backend
(img2img for an edit: it redraws from the words, starting from the picture).
One model is kept at a time.

Starting mflux for every picture costs more than drawing it: Python and
mflux import, 4.6 GB of weights load, and the first step compiles. This
keeps the model in one background process and hands it pictures over a
Unix socket, so each one after the first is just the drawing itself.

  sageflux.py --engine flux|lcm --model DIR --prompt-file F --width W --height H --steps N
              --seed S --output OUT [--image-paths P …]
              [--draw-size WxH --upscaler FILE]
      draw (or, with --image-paths, edit) one picture — the same flags as
      mflux-generate-flux2(-edit). Starts the worker if it isn't running,
      prints mflux-style "i/n [" progress to stderr, exits 0 once OUT is saved.
      With --draw-size it draws that small, then upscales to W×H with
      Real-ESRGAN's compact x4 model (FILE: its MLX weights) — the steps are
      what take the time, and they grow with the pixels.
  sageflux.py --serve
      the worker itself (started by the above). Leaves after
      $MAXSHELL_FLUX_IDLE seconds (300) with nothing to do, freeing the memory.

The prompt isn't padded to 512 tokens as mflux does (the transformer then
attends over only the real ones): about a quarter less time per step, with
pictures that look the same. If the client goes away (^C, the app's stop),
the next step notices and the picture is abandoned.
"""

import json
import os
import socket
import subprocess
import sys
import time

IDLE = float(os.environ.get("MAXSHELL_FLUX_IDLE", "300"))


def cache_dir():
    d = os.environ.get("MAXSHELL_CACHE") or os.path.join(os.path.expanduser("~"), ".cache", "maxshell")
    os.makedirs(d, exist_ok=True)
    return d


SOCK = os.path.join(cache_dir(), "sageflux.sock")
LOG = os.path.join(cache_dir(), "sageflux.log")


class Gone(Exception):
    """The client hung up: stop drawing."""


# --- the upscaler -------------------------------------------------------------------

def upscale(weights, image, size):
    """Real-ESRGAN general x4v3 (SRVGGNetCompact: a conv, 32 conv+PReLU, a conv
    to 48 channels, pixel shuffle ×4, plus the input enlarged), then Lanczos
    to `size`. weights: its tensors, already in MLX's layout (fp16)."""
    import mlx.core as mx
    import numpy as np
    from PIL import Image

    x = mx.array(np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0)[None].astype(mx.float16)

    def conv(h, i):
        return mx.conv2d(h, weights[f"body.{i}.weight"], padding=1) + weights[f"body.{i}.bias"]

    def prelu(h, i):
        return mx.maximum(h, 0) + weights[f"body.{i}.weight"] * mx.minimum(h, 0)

    h = prelu(conv(x, 0), 1)
    for i in range(2, 66, 2):
        h = prelu(conv(h, i), i + 1)
    h = conv(h, 66)
    n, H, W, _ = h.shape
    h = h.reshape(n, H, W, 3, 4, 4).transpose(0, 1, 4, 2, 5, 3).reshape(n, H * 4, W * 4, 3)
    out = mx.clip(h + mx.repeat(mx.repeat(x, 4, axis=1), 4, axis=2), 0, 1)
    big = Image.fromarray(np.array((out[0].astype(mx.float32) * 255 + 0.5).astype(mx.uint8)))
    return big.resize(size, Image.LANCZOS)


# --- the worker -----------------------------------------------------------------

def serve():
    import mlx.core as mx

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        srv.bind(SOCK)
    except OSError:
        # Another worker may have it; a dead one leaves only the file.
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(SOCK)
            return  # alive: let it serve
        except OSError:
            os.unlink(SOCK)
            srv.bind(SOCK)
        finally:
            probe.close()
    srv.listen(8)
    srv.settimeout(IDLE)
    loaded = {"key": None, "model": None}
    upscalers = {}

    def upscaler(path):
        if path not in upscalers:
            upscalers[path] = mx.load(path)
        return upscalers[path]

    def model_for(engine, model_dir, edit):
        key = (engine, model_dir)
        if loaded["key"] != key:
            loaded["model"] = None  # one model at a time
            mx.clear_cache()
            if engine == "lcm":
                loaded.update(key=key, model=lcm_models(model_dir))
            else:
                from mflux.models.flux2.variants import Flux2Klein
                draw = Flux2Klein(model_path=model_dir)
                for tok in draw.tokenizers.values():
                    tok.padding = "longest"
                loaded.update(key=key, model={"draw": draw, "edit": flux_edit(draw)})
        return loaded["model"]["edit" if edit else "draw"]

    try:
        while True:
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                return
            conn.settimeout(None)
            try:
                handle(conn, model_for, upscaler, mx)
            except Exception as e:  # noqa: BLE001 — one bad picture mustn't end the worker
                print(f"{time.strftime('%H:%M:%S')} {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            finally:
                conn.close()
                mx.clear_cache()
    finally:
        srv.close()
        try:
            os.unlink(SOCK)
        except OSError:
            pass


def small_copy(path, size):
    """The picture being edited, at the size it's drawn at: a bigger one costs more each step."""
    import tempfile
    from PIL import Image

    out = os.path.join(tempfile.mkdtemp(prefix="sageflux-"), "reference.png")
    Image.open(path).convert("RGB").resize(size, Image.LANCZOS).save(out)
    return out


def flux_edit(draw):
    """FLUX.2's edit pipeline on the drawing model's own weights: no second copy, no reload."""
    import mlx.nn as nn
    from mflux.models.flux2.variants import Flux2KleinEdit

    edit = Flux2KleinEdit.__new__(Flux2KleinEdit)
    nn.Module.__init__(edit)
    for k in ("vae", "transformer", "text_encoder"):
        setattr(edit, k, getattr(draw, k))
    for k in ("tokenizers", "model_config", "callbacks", "tiling_config", "bits"):
        setattr(edit, k, getattr(draw, k))
    edit.prompt_cache = {}
    return edit


class LCM:
    """DreamShaper 7 LCM, drawing or (img2img) changing a picture, sharing one set of weights."""

    def __init__(self, pipe, strength=None):
        self.pipe, self.strength = pipe, strength
        self.callbacks = type("R", (), {"in_loop": []})()

    def generate_image(self, seed, prompt, num_inference_steps, width, height, image_paths=None):
        import torch
        from PIL import Image

        def step(pipe, i, t, kw):
            for cb in self.callbacks.in_loop:
                cb.call_in_loop(i, seed, prompt, None, None)
            return kw

        kw = dict(prompt=prompt, num_inference_steps=num_inference_steps, guidance_scale=8.0,
                  generator=torch.Generator("cpu").manual_seed(seed), callback_on_step_end=step)
        if image_paths:
            kw.update(image=Image.open(image_paths[0]).convert("RGB").resize((width, height), Image.LANCZOS), strength=self.strength)
        else:
            kw.update(width=width, height=height)
        image = self.pipe(**kw).images[0]
        return type("G", (), {"image": image, "save": lambda self, path, overwrite=True: image.save(path)})()


def lcm_models(model_dir):
    import torch
    from diffusers import LatentConsistencyModelImg2ImgPipeline, LatentConsistencyModelPipeline

    draw = LatentConsistencyModelPipeline.from_pretrained(model_dir, torch_dtype=torch.float16, safety_checker=None,
                                                           requires_safety_checker=False).to("mps")
    draw.set_progress_bar_config(disable=True)
    edit = LatentConsistencyModelImg2ImgPipeline(**{k: v for k, v in draw.components.items()
                                                    if k in LatentConsistencyModelImg2ImgPipeline._get_signature_keys(LatentConsistencyModelImg2ImgPipeline)[0]})
    edit.set_progress_bar_config(disable=True)
    return {"draw": LCM(draw), "edit": LCM(edit, strength=0.6)}


def handle(conn, model_for, upscaler, mx):
    f = conn.makefile("rwb", buffering=0)
    req = json.loads(f.readline())

    def send(**ev):
        try:
            f.write((json.dumps(ev) + "\n").encode())
        except OSError as e:
            raise Gone() from e

    edit = bool(req.get("images"))
    model = model_for(req.get("engine", "flux"), req["model"], edit)
    total = req["steps"]

    class Progress:
        def call_in_loop(self, t, seed, prompt, latents, config, time_steps=None):
            if latents is not None:
                mx.eval(latents)
            send(step=t + 1, total=total)

    progress = Progress()
    model.callbacks.in_loop.append(progress)
    try:
        send(step=0, total=total)
        small = req.get("draw_size") and req.get("upscaler")
        w, h = (int(v) for v in req["draw_size"].split("x")) if small else (req["width"], req["height"])
        kw = dict(seed=req["seed"], prompt=req["prompt"], num_inference_steps=total, width=w, height=h)
        if edit:
            kw["image_paths"] = [small_copy(p, (w, h)) for p in req["images"]] if small else req["images"]
        image = model.generate_image(**kw)
        if small:
            upscale(upscaler(req["upscaler"]), image.image, (req["width"], req["height"])).save(req["output"])
        else:
            image.save(path=req["output"], overwrite=True)
        send(done=True)
    except Gone:
        print(f"{time.strftime('%H:%M:%S')} stopped: the client left", file=sys.stderr, flush=True)
    except Exception as e:  # noqa: BLE001
        try:
            send(error=f"{type(e).__name__}: {e}")
        except Gone:
            pass
    finally:
        model.callbacks.in_loop.remove(progress)


# --- the client -------------------------------------------------------------------

def connect(wait):
    deadline = time.time() + wait
    while True:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.connect(SOCK)
            return s
        except OSError:
            s.close()
            if time.time() >= deadline:
                return None
            time.sleep(0.2)


def start_worker():
    log = open(LOG, "a")
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "--serve"], stdin=subprocess.DEVNULL,
                     stdout=log, stderr=log, start_new_session=True, close_fds=True)


def parse(argv):
    o = {"images": []}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--image-paths":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                o["images"].append(os.path.abspath(argv[i]))
                i += 1
            continue
        if a in ("--vae-tiling", "--low-ram"):
            i += 1
            continue
        val = argv[i + 1] if i + 1 < len(argv) else None
        key = a.lstrip("-").replace("-", "_")
        o[key] = val
        i += 2
    if "prompt_file" in o:
        with open(o.pop("prompt_file")) as fh:
            o["prompt"] = fh.read().strip()
    for k in ("width", "height", "steps", "seed"):
        o[k] = int(o[k])
    o["model"] = os.path.abspath(o["model"])
    if o.get("upscaler"):
        o["upscaler"] = os.path.abspath(o["upscaler"])
    o["output"] = os.path.abspath(o["output"])
    return o


def draw(argv):
    req = parse(argv)
    s = connect(0)
    if s is None:
        print("starting Sage Image Lite…", file=sys.stderr, flush=True)
        start_worker()
        s = connect(120)
        if s is None:
            print(f"Error: Sage Image Lite's worker didn't start (see {LOG})", file=sys.stderr)
            return 1
    f = s.makefile("rwb", buffering=0)
    f.write((json.dumps(req) + "\n").encode())
    began = time.time()
    for line in f:
        ev = json.loads(line)
        if "step" in ev:
            n, total = ev["step"], ev["total"]
            pct = int(100 * n / total) if total else 0
            print(f"\r{pct:3d}%| {n}/{total} [{time.time() - began:.0f}s]", end="", file=sys.stderr, flush=True)
        elif ev.get("done"):
            print(file=sys.stderr)
            return 0 if os.path.exists(req["output"]) else 1
        elif "error" in ev:
            print(f"\nError: {ev['error']}", file=sys.stderr)
            return 1
    print("\nError: Sage Image Lite's worker stopped", file=sys.stderr)
    return 1


def main():
    if sys.argv[1:2] == ["--serve"]:
        serve()
        return 0
    return draw(sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
