"""Sage Image Lite's warm worker: FLUX.2 [klein] 4B, loaded once.

Starting mflux for every picture costs more than drawing it: Python and
mflux import, 4.6 GB of weights load, and the first step compiles. This
keeps the model in one background process and hands it pictures over a
Unix socket, so each one after the first is just the drawing itself.

  sageflux.py --model DIR --prompt-file F --width W --height H --steps N
              --seed S --output OUT [--image-paths P …]
      draw (or, with --image-paths, edit) one picture — the same flags as
      mflux-generate-flux2(-edit). Starts the worker if it isn't running,
      prints mflux-style "i/n [" progress to stderr, exits 0 once OUT is saved.
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

    def model_for(model_dir, edit):
        key = (model_dir, edit)
        if loaded["key"] != key:
            loaded["model"] = None  # one at a time: drawing and editing don't share memory
            mx.clear_cache()
            if edit:
                from mflux.models.flux2.variants import Flux2KleinEdit as cls
            else:
                from mflux.models.flux2.variants import Flux2Klein as cls
            m = cls(model_path=model_dir)
            for tok in m.tokenizers.values():
                tok.padding = "longest"
            loaded.update(key=key, model=m)
        return loaded["model"]

    try:
        while True:
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                return
            conn.settimeout(None)
            try:
                handle(conn, model_for, mx)
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


def handle(conn, model_for, mx):
    f = conn.makefile("rwb", buffering=0)
    req = json.loads(f.readline())

    def send(**ev):
        try:
            f.write((json.dumps(ev) + "\n").encode())
        except OSError as e:
            raise Gone() from e

    edit = bool(req.get("images"))
    model = model_for(req["model"], edit)
    total = req["steps"]

    class Progress:
        def call_in_loop(self, t, seed, prompt, latents, config, time_steps=None):
            mx.eval(latents)
            send(step=t + 1, total=total)

    progress = Progress()
    model.callbacks.in_loop.append(progress)
    try:
        send(step=0, total=total)
        kw = dict(seed=req["seed"], prompt=req["prompt"], num_inference_steps=total, width=req["width"], height=req["height"])
        if edit:
            kw["image_paths"] = req["images"]
        image = model.generate_image(**kw)
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
