"""Sage's exam: the same questions and coding tasks for every model and
setting, run through the real engine (src/sage.py) and Sage Code's real tools,
so a change to a model, its sampling or its prompt is kept only if it scores
better here. Run it with Sage's Python:

  ~/.maxshell/gemma/venv/bin/python ai/sage/eval.py pro [chat|code] [options]

  --set temp=0.7 top_p=0.9 top_k=40 min_p=0.05 repeat=1.1   sampling
  --think off|low|medium|high      Sage Ultra's thinking
  --repeat N                       each question N times (seeds 0..N-1)
  --only NAME,…                    just these tasks
  --adapter DIR                    a LoRA adapter (ai/sage/lora.sh)
  --json FILE                      every answer and score, for comparing

Models: ultra, pro, flash, lite (lite's code tasks run Sage Lite's coding
model). It prints a line a task and a summary: score, seconds, tokens/s,
peak memory."""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', '..', 'src')
MODELS = {'ultra': ('ULTRA', 'ultra'), 'pro': ('E4B', 'pro'), 'flash': ('E2B', 'flash'), 'lite': ('LITE', 'lite'),
          'litecode': ('LITE-CODE', 'lite-code')}


# --- checks -----------------------------------------------------------------

def plain(text):
    """The answer without markdown, LaTeX spacing or thousands separators."""
    t = re.sub(r'\\[,!;:]|\{,\}', '', text)
    t = re.sub(r'(?<=\d)[,\u202f\u2009 ](?=\d{3}\b)', '', t)
    return t.replace('**', '').replace('$', '')


def number(n):
    return lambda a: re.search(rf'(?<![\d.]){re.escape(str(n))}(?![\d]|\.\d)', plain(a)) is not None


NUM = r'-?\d+(?:\.\d+)?'


def stated(n):
    """n is the answer it gives: a boxed or bold number, else the last
    number outside code."""
    def check(a):
        t = plain(re.sub(r'```.*?(```|\Z)', '', a, flags=re.S))
        t = re.sub(r'\^\{?\d+\}?|[²³]|\\text\{[^}]*\}', ' ', t)  # cm^2: not a number of the answer
        marked = re.findall(r'\\boxed\{([^}]*)\}', t) + re.findall(r'\*\*(.*?)\*\*', a)
        nums = [float(x) for m in marked for x in re.findall(NUM, plain(m))]
        if any(abs(x - float(n)) < 1e-6 for x in nums):
            return True
        same = lambda x: abs(float(x) - float(n)) < 1e-6  # noqa: E731
        first = re.findall(NUM, t.strip().split('\n')[0])  # "5 cents." then the working
        last = re.findall(NUM, t)
        return bool(first and same(first[0])) or bool(last and same(last[-1]))
    return check


def last_of(right, *wrong):
    """Of the words right and wrong, right is the last one said."""
    def check(a):
        found = re.findall(r'\b(' + '|'.join([right, *wrong]) + r')\b', a, re.I)
        return bool(found) and found[-1].lower() == right.lower()
    return check


def has(*words):
    return lambda a: all(re.search(w, a, re.I) for w in words)


def lacks(*words):
    return lambda a: not any(re.search(w, a, re.I) for w in words)


def both(*checks):
    return lambda a: all(c(a) for c in checks)


def words_at_most(n):
    return lambda a: 0 < len(re.findall(r"[\w'’-]+", a)) <= n


def bullets(n):
    return lambda a: len([l for l in a.splitlines() if re.match(r'\s*([-*•]|\d+[.)])\s+\S', l)]) == n


def only_json(keys):
    def check(a):
        t = re.sub(r'^```\w*\n|\n```$', '', a.strip())
        try:
            v = json.loads(t)
        except ValueError:
            return False
        return isinstance(v, dict) and set(v) == set(keys)
    return check


def python_passes(tests):
    """The answer's Python code block, run with tests appended."""
    def check(a):
        blocks = re.findall(r'```(?:python|py)?\n(.*?)```', a, re.S)
        if not blocks:
            return False
        def parses(b):
            try:
                compile(b, 'answer', 'exec')
                return True
            except SyntaxError:
                return False
        code = '\n\n'.join(b for b in blocks if parses(b)) + '\n\n' + tests  # the function and examples, not shown output
        try:
            return subprocess.run([sys.executable, '-c', code], capture_output=True, timeout=20).returncode == 0
        except subprocess.TimeoutExpired:
            return False
    return check


# --- the chat exam ----------------------------------------------------------
# (name, kind, turns, check): turns before the last are said first, and the
# check reads the answer to the last one.

CHAT = [
    # sums and reasoning
    ('trains', 'math', ['A train leaves at 9:40 and arrives at 13:05. A second train takes 25 minutes less. How many minutes does the second train take?'], stated(180)),
    ('discount', 'math', ['A jacket costs $80. It is discounted 25%, then a further 10% off the new price. What is the final price in dollars?'], stated(54)),
    ('apples', 'math', ['I had 3 dozen apples, gave away a third, ate 5 and bought 14 more. How many do I have?'], stated(33)),
    ('rect', 'math', ['A rectangle has perimeter 46 cm and its length is 5 cm more than its width. What is its area in square cm?'], stated(126)),
    ('mult', 'math', ['What is 347 × 286?'], stated(99242)),
    ('interest', 'math', ['$2,000 earns 5% interest a year, compounded yearly. How much is there after 3 years, to the cent?'], stated('2315.25')),
    ('primes', 'math', ['What is the sum of the prime numbers between 30 and 50?'], stated(199)),
    ('sheep', 'logic', ['A farmer has 17 sheep. All but 9 run away. How many sheep does he have left?'], stated(9)),
    ('siblings', 'logic', ['Sally has 3 brothers. Each of her brothers has 2 sisters. How many sisters does Sally have?'], stated(1)),
    ('order', 'logic', ['Ann is taller than Ben. Cara is shorter than Ben. Dan is taller than Ann. Who is the second shortest? Answer with the name.'], has(r'\bBen\b')),
    ('days', 'logic', ['If today is Thursday, what day of the week will it be 100 days from now?'], last_of('saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday')),
    ('bat', 'logic', ['A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How much does the ball cost, in cents?'], lambda a: stated(5)(a) or stated(0.05)(a)),
    # facts
    ('capital', 'facts', ['What is the capital of Australia?'], has('canberra')),
    ('element', 'facts', ['Which chemical element has the symbol W?'], has('tungsten')),
    ('planet', 'facts', ['Which planet in our solar system has the most moons known as of 2024?'], has('saturn')),
    ('author', 'facts', ['Who wrote "One Hundred Years of Solitude"?'], has('m[aá]rquez')),
    ('speed', 'facts', ['Roughly how fast does light travel in a vacuum, in km per second?'], has(r'299[,. ]?792|300[,. ]?000')),
    # doing what's asked
    ('one-word', 'follow', ['What colour is a ripe banana? Answer with one word only.'], both(words_at_most(2), has('yellow'))),
    ('three-bullets', 'follow', ['Give exactly three tips for sleeping better, as a bulleted list, nothing else.'], bullets(3)),
    ('json', 'follow', ['Reply with only a JSON object with the keys "city" and "country" for the Eiffel Tower. No code fence, no other text.'], both(only_json(['city', 'country']), has('paris'))),
    ('short', 'follow', ['In under 25 words: why is the sky blue?'], both(words_at_most(25), has('scatter'))),
    ('lowercase', 'follow', ['Write a one-sentence greeting to a friend, entirely in lowercase letters.'], lambda a: bool(a.strip()) and a == a.lower() and len(a) < 300),
    # who it is
    ('name', 'self', ['Who are you?'], both(has(r'\bSage\b'), lacks('gemma', 'qwen', 'mistral', 'ministral', 'llama'))),
    ('maker', 'self', ['What model are you built on?'], lacks('openai', 'chatgpt', 'anthropic', 'claude')),
    # remembering
    ('recall', 'memory', ['My name is Priya and my dog is called Biscuit.', 'I work as a nurse in Leeds.', "What's my dog's name and where do I work?"], has('biscuit', 'leeds')),
    ('correction', 'memory', ['Let me see. Add up 12, 15 and 9.', 'Sorry, I meant 12, 15 and 19.'], stated(46)),
    # code in a chat
    ('fizz', 'code', ['Write a Python function fizzbuzz(n) that returns a list of strings for 1..n: "Fizz" for multiples of 3, "Buzz" for 5, "FizzBuzz" for both, else the number as a string.'],
     python_passes('assert fizzbuzz(15)[-1] == "FizzBuzz" and fizzbuzz(5) == ["1","2","Fizz","4","Buzz"]')),
    ('anagram', 'code', ['Write a Python function is_anagram(a, b) that ignores case and spaces.'],
     python_passes('assert is_anagram("Dormitory", "dirty room") and not is_anagram("abc", "abd")')),
    ('roman', 'code', ['Write a Python function to_roman(n) for 1 to 3999.'],
     python_passes('assert to_roman(1994) == "MCMXCIV" and to_roman(3999) == "MMMCMXCIX" and to_roman(4) == "IV"')),
    # maxshell itself
    # maxshell itself (worded unlike anything in ai/sage/knowledge.py)
    ('bookmark', 'maxshell', ['I bookmarked a folder as proj with mark in maxshell. How do I get rid of that bookmark?'], has(r'mark -d proj')),
    ('jump', 'maxshell', ["What's the maxshell command to hop straight to my most-used folder called recipes?"], has(r'(?m)(^|`)j rec')),
    ('theme', 'maxshell', ['how can i switch maxshell to the dracula colours'], has(r'theme dracula')),
    ('explain', 'maxshell', ['In maxshell, how can I see what a command line would do without running it?'], has(r'alt-h|⌥h|`explain')),
    ('palette', 'maxshell', ['Which key opens the command palette in maxshell?'], has(r'ctrl[-+ ]?p\b|\^p|⌃p|control[-+ ]p')),
    ('gitui', 'maxshell', ["What's the name of maxshell's built-in git screen?"], has(r'gitui')),
]


# --- the coding exam --------------------------------------------------------
# (name, files, request, check command): Sage Code works in a fresh folder;
# the task passes if the check command exits 0 afterwards.

CODE = [
    ('fix-bug', {'calc.py': 'def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n',
                 'test_calc.py': 'from calc import add, mul\nassert add(2, 3) == 5\nassert mul(2, 3) == 6\nprint("ok")\n'},
     'The tests in test_calc.py fail. Find the bug and fix it.', 'python3 test_calc.py'),
    ('new-file', {'README.md': '# tools\n'},
     'Create slug.py with a function slugify(text) that lowercases, turns runs of non-letters/digits into single '
     'hyphens and trims hyphens from the ends. "Hello, World!" becomes "hello-world".',
     'python3 -c "from slug import slugify; assert slugify(\'Hello, World!\') == \'hello-world\'; '
     'assert slugify(\'  A--b  c \') == \'a-b-c\'"'),
    ('run-tests', {'stats.py': 'def mean(xs):\n    return sum(xs) / len(xs)\n\n\ndef median(xs):\n    xs = sorted(xs)\n    return xs[len(xs) // 2]\n',
                   'test_stats.py': 'from stats import mean, median\nassert mean([1, 2, 3]) == 2\nassert median([3, 1, 2]) == 2\n'
                                    'assert median([4, 1, 3, 2]) == 2.5\nprint("all passed")\n'},
     'Run test_stats.py and make it pass.', 'python3 test_stats.py'),
    ('rename', {'shapes.py': 'import math\n\n\ndef area(r):\n    return math.pi * r * r\n',
                'main.py': 'from shapes import area\n\nprint(round(area(2), 2))\n'},
     'Rename the function area to circle_area everywhere in this project.',
     'python3 main.py && grep -q "def circle_area" shapes.py && ! grep -qw "area(" main.py'),
    ('add-flag', {'greet.py': 'import sys\n\n\ndef main(argv):\n    name = argv[1] if len(argv) > 1 else "world"\n    print(f"hello {name}")\n\n\nif __name__ == "__main__":\n    main(sys.argv)\n'},
     'Add a --shout option to greet.py that prints the greeting in capitals. `python3 greet.py --shout bob` should print HELLO BOB.',
     'test "$(python3 greet.py --shout bob)" = "HELLO BOB" && test "$(python3 greet.py ann)" = "hello ann"'),
    ('folder', {'notes.txt': 'todo\n'},
     'Make a folder src/utils and put a file math_utils.py in it with a function clamp(x, lo, hi).',
     'cd src/utils && python3 -c "from math_utils import clamp; assert clamp(5, 0, 3) == 3 and clamp(-1, 0, 3) == 0 and clamp(2, 0, 3) == 2"'),
]


# --- running ----------------------------------------------------------------

def load(model, args):
    name, sub = MODELS[model]
    os.environ['MAXSHELL_SAGE_NAME'] = name
    os.environ['MAXSHELL_GEMMA'] = args.dir or os.path.expanduser('~/.maxshell/gemma/' + sub)
    os.environ['MAXSHELL_SAGE_EFFORT'] = args.think
    sys.path.insert(0, SRC)
    import sage
    sage.quiet()
    s = dict(kv.split('=', 1) for kv in args.set)
    cls = sage.CHATS.get(name, sage.GemmaChat)
    if any(k in s for k in ('top_p', 'top_k', 'min_p')):
        cls.SAMPLING = {**cls.SAMPLING, **{k: (int if k == 'top_k' else float)(v) for k, v in s.items() if k in ('top_p', 'top_k', 'min_p')}}
    if 'repeat' in s:
        cls.REPEAT = float(s['repeat']) or None
    if 'temp' in s:
        cls.temperature = lambda self: float(s['temp'])
    if args.system:  # a whole new chat prompt to try: {when} and {maker} are filled in
        base0 = sage.system_prompt
        text = open(args.system).read().strip()

        def system_prompt(mode):
            if mode != 'chat':
                return base0(mode)
            when = re.search(r'It is [^.]*?[AP]M\.', base0('chat')).group(0)
            return text.replace('{when}', when).replace('{maker}', sage.MAKER)
        sage.system_prompt = system_prompt
    if args.append:
        base = sage.system_prompt
        sage.system_prompt = lambda mode: base(mode) + ' ' + args.append
    engine = sage.Engine(sage.DIR)
    if args.adapter:
        from mlx_lm.tuner.utils import load_adapters
        load_adapters(engine.model, args.adapter)
    return sage, engine


def ask_chat(sage, engine, turns):
    chat = engine.chat('chat', sage.system_prompt('chat'), None, sage.MAX_CALLS, sage.MAX_TOKENS)
    chat.set_thinking(os.environ['MAXSHELL_SAGE_EFFORT'])
    out = []
    tokens = 0
    for t in turns:
        out = []
        chat.reply(t, out.append)
        tokens += chat.generated
    return ''.join(out).strip(), tokens, chat


def do_code(sage, engine, files, request, check):
    root = tempfile.mkdtemp(prefix='sage-eval-')
    trash = tempfile.mkdtemp(prefix='sage-eval-trash-')
    for f, text in files.items():
        with open(os.path.join(root, f), 'w') as fh:
            fh.write(text)
    calls = []

    def tool(name):
        def run(**a):
            calls.append(name)
            r = subprocess.run(['node', os.path.join(HERE, 'tool.js'), root, name, json.dumps(a)], capture_output=True, text=True,
                               env={**os.environ, 'MAXSHELL_TRASH': trash}, timeout=150)
            return r.stdout
        return run
    here = os.getcwd()
    os.chdir(root)
    try:
        chat = engine.chat('code', sage.system_prompt('code'), sage.CODE_TOOLS, sage.MAX_CALLS, sage.MAX_TOKENS)
        chat.set_thinking(os.environ['MAXSHELL_SAGE_EFFORT'])
        out = []
        chat.reply(request, out.append, {n: tool(n) for n in
                                         ('list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_command')})
    finally:
        os.chdir(here)
    ok = subprocess.run(['/bin/sh', '-c', check], cwd=root, capture_output=True, timeout=60).returncode == 0
    shutil.rmtree(root, ignore_errors=True)
    shutil.rmtree(trash, ignore_errors=True)
    return ok, ''.join(out).strip(), chat.generated, calls


def main():
    p = argparse.ArgumentParser()
    p.add_argument('model', choices=['ultra', 'pro', 'flash', 'lite'])
    p.add_argument('part', nargs='?', default='both', choices=['chat', 'code', 'both'])
    p.add_argument('--set', nargs='*', default=[])
    p.add_argument('--think', default='medium')
    p.add_argument('--repeat', type=int, default=1)
    p.add_argument('--only', default='')
    p.add_argument('--append', default='')
    p.add_argument('--system', help='a file with a chat system prompt to try instead')
    p.add_argument('--adapter')
    p.add_argument('--dir', help="another build of the model to try (a folder like ~/.maxshell/gemma/<model>)")
    p.add_argument('--json')
    p.add_argument('--rescore', action='store_true', help='score the answers in --json again, without a model')
    args = p.parse_args()
    if args.rescore:
        checks = {t[0]: t[3] for t in CHAT}
        rs = json.load(open(args.json))
        for r in rs:
            if r['part'] == 'chat' and r['name'] in checks:
                r['ok'] = bool(checks[r['name']](r['answer']))
        for part in ('chat', 'code'):
            x = [r for r in rs if r['part'] == part]
            if x:
                print(f"{args.model} {part}: {sum(r['ok'] for r in x)}/{len(x)}  failed: {' '.join(sorted(set(r['name'] for r in x if not r['ok'])))}")
        return
    only = set(filter(None, args.only.split(',')))
    results = []
    parts = ['chat', 'code'] if args.part == 'both' else [args.part]
    for part in parts:
        model = 'litecode' if args.model == 'lite' and part == 'code' else args.model
        sage, engine = load(model, args)
        mx = engine.mx
        mx.reset_peak_memory()
        tasks = CHAT if part == 'chat' else CODE
        for task in tasks:
            if only and task[0] not in only and (len(task) < 2 or task[1] not in only):
                continue
            for seed in range(args.repeat):
                mx.random.seed(seed)
                began = time.time()
                if part == 'chat':
                    name, kind, turns, check = task
                    answer, tokens, chat = ask_chat(sage, engine, turns)
                    ok, calls = bool(check(answer)), []
                    seconds = chat.seconds
                else:
                    name, files, request, check = task
                    kind = 'agent'
                    ok, answer, tokens, calls = do_code(sage, engine, files, request, check)
                    seconds = time.time() - began
                took = time.time() - began
                results.append({'part': part, 'name': name, 'kind': kind, 'seed': seed, 'ok': ok, 'answer': answer,
                                'tokens': tokens, 'seconds': took, 'gen_seconds': seconds, 'calls': calls})
                line = answer.replace('\n', ' ⏎ ')[:110]
                if args.json:  # as it goes, so a crash keeps what was done
                    with open(args.json, 'w') as fh:
                        json.dump(results, fh, indent=1)
                print(f"{'✓' if ok else '✗'} {part:4} {name:14} {took:6.1f}s {tokens:5}t  {' '.join(calls)[:60] if calls else line}", flush=True)
        r = [x for x in results if x['part'] == part]
        rates = sorted(x['tokens'] / x['gen_seconds'] for x in r if x['part'] == 'chat' and x['gen_seconds'] and x['tokens'] > 20)
        tps = rates[len(rates) // 2] if rates else 0  # the median: a Mac that naps mid-run doesn't skew it
        print(f"== {args.model} {part}: {sum(x['ok'] for x in r)}/{len(r)}  "
              f"median {sorted(x['seconds'] for x in r)[len(r) // 2]:.1f}s a task  {tps:.1f} tok/s  peak {mx.get_peak_memory() / 1e9:.1f} GB", flush=True)
        del engine
        import gc
        gc.collect()
        mx.clear_cache()
        for k in [k for k in sys.modules if k == 'sage']:
            del sys.modules[k]
    if args.json:
        with open(args.json, 'w') as fh:
            json.dump(results, fh, indent=1)


if __name__ == '__main__':
    main()
