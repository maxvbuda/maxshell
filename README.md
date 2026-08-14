# maxshell

A terminal, but its scripting language isn't bash and isn't JavaScript either.
maxshell is a Node.js program that hosts a small language of its own —
**MaxScript** — with variables, functions, `if`/`while`, and a `!` escape hatch
that drops straight into a real system shell (pipes and all) when you actually
need one.

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

### Escaping to a real shell

Any line starting with `!` is sent verbatim to `/bin/sh`, so pipes,
redirects, and every normal system command work exactly as in a regular
terminal:

```
!ls -la | grep ".js"
!echo $HOME
```

### Built-ins

| Command       | Behavior                                   |
|---------------|---------------------------------------------|
| `print <expr>`| Print a value                                |
| `let x = ...` | Declare or reassign a variable               |
| `fn f(a,b) do ... end` | Define a function                  |
| `if / else if / else / end` | Conditionals                  |
| `while <cond> do ... end` | Loop                             |
| `return <expr>` | Return from a function                     |
| `cd <path>`   | Change maxshell's working directory          |
| `pwd`         | Print the working directory                  |
| `exit`        | Quit                                         |
| `!<command>`  | Run `<command>` in the real system shell     |

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
