# maxshell

A terminal, but its scripting language isn't bash and isn't JavaScript either.
maxshell is a Node.js program that behaves like an ordinary terminal —
`ls`, `git status`, `cd ..`, `./script.sh` all just run — but also hosts a
small language of its own, **MaxScript**, for variables, functions, and
control flow (`if`/`while`) when you want more than one-off commands.

A line is treated as MaxScript only if it starts with a MaxScript keyword
(`let`, `fn`, `if`, `while`, `for`, `break`, `continue`, `print`, `return`,
`cd`, `pwd`, `which`, `alias`, `env`, `history`, `help`, `exit`) or is a
call to a function you defined (`greet("world")`). Everything else is run
exactly as you'd expect from a normal shell.

## Install / run

```sh
npm install -g .        # exposes the `maxshell` command
# or, without installing:
node bin/maxshell.js
```

## Usage

Start a REPL:

```sh
maxshell
```

Run a script:

```sh
maxshell examples/demo.msh
```

## The language (MaxScript)

```
let name = "World"
print "Hello, " + name

fn greet(person) do
  print "Hi there, " + person + "!"
end

greet("maxshell")

fn fib(n) do
  if n < 2 do
    return n
  end
  return fib(n - 1) + fib(n - 2)
end

let i = 0
while i < 10 do
  print fib(i)
  let i = i + 1
end

if i > 5 do
  print "big"
else if i > 0 do
  print "medium"
else
  print "small"
end
```

Blocks are opened with `do` and closed with `end` — no braces, no
significant indentation. `let` both declares and reassigns.

### Arrays and loops

```
let nums = [1, 2, 3, 4, 5]
print nums[0]
print len(nums)

for n in nums do
  if n == 3 do
    continue
  end
  if n == 5 do
    break
  end
  print n
end

for i in range(3) do
  print i
end
```

### Built-in functions

`len`, `upper`, `lower`, `abs`, `min`, `max`, `sqrt`, `range`, `split`,
`join`, `str`, `num` — called like any function: `print upper("hi")`.

### Running real commands

Just type them — no prefix needed:

```
ls -la | grep ".js"
git status
echo $HOME
```

These run through `zsh` (falling back to `/bin/sh` if zsh isn't installed), so pipes, redirects, and everything else work
exactly as in a regular terminal. Prefixing a line with `!` runs it as a
command too; it's only needed to force shell execution for a line that
would otherwise look like MaxScript (e.g. a line that happens to start
with a MaxScript keyword).

### Built-ins

| Command       | Behavior                                   |
|---------------|---------------------------------------------|
| `print <expr>`| Print a value                                |
| `let x = ...` | Declare or reassign a variable               |
| `fn f(a,b) do ... end` | Define a function                  |
| `if / else if / else / end` | Conditionals                  |
| `while <cond> do ... end` | Loop                             |
| `for x in <arr> do ... end` | Loop over an array (or a string's characters) |
| `break` / `continue` | Exit or skip to the next loop iteration |
| `return <expr>` | Return from a function                     |
| `[1, 2, 3]`, `arr[i]` | Array literal and indexing           |
| `cd <path>`   | Change maxshell's working directory (`..`, `~`, relative or absolute paths all work) |
| `pwd`         | Print the working directory                  |
| `which <name>` | Show what a name refers to — keyword, function, variable, alias, or real command |
| `alias name = "value"` | Define a command alias; `alias name` shows it, `alias` alone lists all |
| `env NAME = <expr>` | Set an environment variable for subsequent commands; `env NAME` shows it, `env` alone lists all |
| `history`     | Show real commands run so far this session   |
| `help`        | Show maxshell's own built-in command list    |
| `exit`        | Quit                                         |
| `<anything else>` | Run as a real system command (e.g. `ls -la`, `git status`) |
| `!<command>`  | Force `<command>` to run as a real system command |

## Project layout

```
bin/maxshell.js     CLI entry point / REPL
src/lexer.js        Tokenizer for MaxScript
src/parser.js        Recursive-descent parser producing an AST
src/interpreter.js  Tree-walking interpreter
examples/demo.msh   Sample script
```

## License

MIT
