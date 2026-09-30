# Checks src/mx2.js against PyTorch: prints the last-position logits for a
# fixed token sequence from the checkpoint (with the same int8 rounding as
# the export). Compare with:
#   node -e "const {Model2}=require('./src/mx2');const m=new Model2('models/mx2.bin');
#     const t=Array.from({length:300},(_,i)=>(i*37+11)%8000);const l=m.feed(t);console.log([...l.slice(0,8)])"
# after exporting the same checkpoint (python3 ai/mx2/train.py --export).
#   python3 ai/mx2/parity.py 300
import sys, json, torch
sys.path.insert(0, 'ai')
import importlib.util
spec = importlib.util.spec_from_file_location('mx2train', 'ai/mx2/train.py'); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
MX2 = mod.MX2
ck = torch.load('ai/mx2/data/ckpt.pt', map_location='cpu')
c = ck['config']
m = MX2(c['vocab'], c['ctx'], c['d'], c['layers'], c['heads'])
sd = ck['model']
for k, t in sd.items():
    if t.dim() == 2:
        s = t.abs().amax(dim=1).clamp(min=1e-8) / 127.0
        sd[k] = torch.round(t / s[:, None]).clamp(-127, 127) * s[:, None]
m.load_state_dict(sd); m.eval()
toks = [(i * 37 + 11) % 8000 for i in range(int(sys.argv[1]))]
with torch.no_grad():
    lg = m(torch.tensor([toks]))[0, -1]
print(json.dumps({'top': lg.topk(5).indices.tolist(), 'vals': lg[:8].tolist(), 'max': lg.max().item()}))
