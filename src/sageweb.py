"""Sage on the web: web_search (DuckDuckGo, through ddgr — brew install ddgr)
and open_page, offered to the model only while the Mac is online.

MAXSHELL_SAGE_WEB=0 turns it off, =1 skips the online check (tests);
MAXSHELL_DDGR names the ddgr to run (tests swap in a fake)."""
import html
import html.parser
import json
import os
import re
import shutil
import socket
import subprocess
import time
import urllib.request

RESULTS = 5         # results a search returns
PAGE_CHARS = 5000   # of a page's text, at most
MAX_SEARCHES = 5    # in one answer; then it's told to answer with what it found
_checked = [0.0, False]


def ddgr():
    return os.environ.get('MAXSHELL_DDGR') or shutil.which('ddgr') or next(
        (p for p in ('/opt/homebrew/bin/ddgr', '/usr/local/bin/ddgr') if os.path.exists(p)), None)


def online():
    """Whether Sage can search now: ddgr is there and DuckDuckGo answers (checked
    at most every 30 s; offline, the connection fails at once)."""
    flag = os.environ.get('MAXSHELL_SAGE_WEB')
    if flag == '0' or not ddgr():
        return False
    if flag == '1':
        return True
    if time.time() - _checked[0] > 30:
        try:
            socket.create_connection(('duckduckgo.com', 443), timeout=1.5).close()
            _checked[1] = True
        except OSError:
            _checked[1] = False
        _checked[0] = time.time()
    return _checked[1]


def search(query):
    """The top results for query, as numbered text for the model."""
    query = ' '.join(str(query).split())
    if not query:
        return 'Give a search query.'
    try:
        r = subprocess.run([ddgr(), '--json', '--np', '-n', str(RESULTS), query], capture_output=True, text=True, timeout=20)
        if r.returncode != 0:
            raise OSError(r.stderr.strip())
        results = json.loads(r.stdout or '[]')
    except (subprocess.TimeoutExpired, ValueError, OSError):
        return 'The search didn’t work (no internet connection, or DuckDuckGo didn’t answer). Answer from what you know, and say so.'
    if not results:
        return f'No results for "{query}".'
    return '\n\n'.join(f"{i}. {r.get('title', '').strip()}\n{r.get('url', '')}\n{r.get('abstract', '').strip()}"
                       for i, r in enumerate(results[:RESULTS], 1))


class _Text(html.parser.HTMLParser):
    """A page's readable text: no scripts, styles, menus or forms."""
    SKIP = {'script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'form', 'aside', 'template', 'button'}
    BLOCK = {'p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'table', 'pre', 'blockquote'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip, self.title, self.in_title = [], 0, '', False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag == 'title':
            self.in_title = True
        elif tag in self.BLOCK:
            self.out.append('\n')

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag == 'title':
            self.in_title = False
        elif tag in self.BLOCK:
            self.out.append('\n')

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        elif not self.skip:
            self.out.append(data)


def page_text(source):
    """(title, text) of an HTML page."""
    p = _Text()
    p.feed(source)
    text = re.sub(r'[ \t\r\f\v]+', ' ', ''.join(p.out))
    text = re.sub(r'\n\s*\n+', '\n\n', re.sub(r' *\n *', '\n', text)).strip()
    return ' '.join(p.title.split()), text


def open_page(url):
    """The text of a web page (its start, if it's long)."""
    url = str(url).strip()
    if not re.match(r'https?://', url):
        return 'Give a full web address, starting with https://.'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Macintosh) Sage/1.0 (maxshell)',
                                                   'Accept': 'text/html,text/plain;q=0.9,*/*;q=0.5'})
        with urllib.request.urlopen(req, timeout=15) as r:
            kind = r.headers.get_content_type()
            raw = r.read(3_000_000)
            charset = r.headers.get_content_charset() or 'utf-8'
    except Exception as e:  # noqa: BLE001 — the model hears why
        return f"Couldn't open {url}: {getattr(e, 'reason', None) or e}"
    if kind not in ('text/html', 'text/plain', 'application/xhtml+xml', 'application/json'):
        return f'{url} is a {kind} file, not a page Sage can read.'
    source = raw.decode(charset, 'replace')
    title, text = page_text(source) if 'html' in kind else ('', source)
    if len(text) > PAGE_CHARS:
        text = text[:PAGE_CHARS].rsplit(' ', 1)[0] + ' …'
    return f'{title}\n{url}\n\n{text}' if title else f'{url}\n\n{text}'


def describe(name, args):
    """How the app shows a call: 'Search the web for “…”', 'Read example.com'."""
    if name == 'web_search':
        return f"Search the web for “{' '.join(str(args.get('query', '')).split())}”"
    host = re.sub(r'^https?://(www\.)?', '', str(args.get('url', ''))).split('/')[0]
    return f'Read {host or "a page"}'


def summary(name, result):
    """A short note on how a call went, for the app."""
    if name == 'web_search':
        n = len(re.findall(r'(?m)^\d+\. ', result))
        return f'{n} result{"" if n == 1 else "s"}' if n else 'nothing found' if result.startswith('No results') else 'failed'
    return 'failed' if result.startswith("Couldn't") or ' file, not a page' in result else 'read'


def tools(report=None):
    """The web tools for a chat: {name: fn(**args)}. report(name, args, state,
    detail) hears each call start ('running') and end ('ok' / 'fail')."""
    count = [0]

    def wrap(name, fn, arg):
        def run(**args):
            if name == 'web_search':
                count[0] += 1
                if count[0] > MAX_SEARCHES:
                    return 'That’s enough searching — answer now with what you found.'
            report and report(name, args, 'running', '')
            result = fn(args.get(arg, ''))
            detail = summary(name, result)
            report and report(name, args, 'fail' if detail == 'failed' else 'ok', detail)
            return result
        return run
    return {'web_search': wrap('web_search', search, 'query'), 'open_page': wrap('open_page', open_page, 'url')}


