'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Parser } = require('./parser');
const { KEYWORDS } = require('./lexer');

// Prefer zsh (macOS's default interactive shell) for running real
// commands; fall back to /bin/sh where zsh isn't installed (e.g. Linux).
const SHELL_PATH = fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';

const HELP_TEXT = `maxshell — a terminal with its own scripting language (MaxScript)

Built-ins:
  print <expr>              Print a value
  let x = <expr>             Declare or reassign a variable
  fn f(a, b) do ... end      Define a function
  if <cond> do ... end       Conditional (else / else if supported)
  while <cond> do ... end    Loop
  for x in <arr> do ... end  Loop over an array (or a string's characters)
  break / continue           Exit or skip to the next loop iteration
  return <expr>              Return from a function
  [1, 2, 3]                  Array literal; index with arr[0]
  cd <path>                  Change the working directory (.., ~, relative, absolute)
  pwd                        Print the working directory
  which <name>               Show what a name refers to (keyword, function, variable, or command)
  alias [name [= "value"]]   Define, show, or list command aliases
  env [NAME [= value]]       Show, set, or list environment variables
  history                    Show real commands run this session
  help                       Show this message
  exit                       Quit maxshell

Builtin functions: len, upper, lower, abs, min, max, sqrt, range, split,
join, str, num — e.g. print len("hi"), for x in range(5) do ... end.

Anything else you type — ls, git status, ./script.sh, etc. — runs as a
real system command, exactly like a normal terminal. Prefix a line with
"!" to force shell execution if it would otherwise look like MaxScript.`;

class Environment {
  constructor(parent = null) {
    this.vars = new Map();
    this.parent = parent;
  }

  define(name, value) {
    this.vars.set(name, value);
  }

  set(name, value) {
    let env = this;
    while (env) {
      if (env.vars.has(name)) {
        env.vars.set(name, value);
        return;
      }
      env = env.parent;
    }
    // Implicit declaration on assignment to an unknown name.
    this.define(name, value);
  }

  get(name) {
    let env = this;
    while (env) {
      if (env.vars.has(name)) return env.vars.get(name);
      env = env.parent;
    }
    throw new Error(`Undefined variable '${name}'`);
  }
}

class MaxFunction {
  constructor(decl, closure) {
    this.decl = decl;
    this.closure = closure;
  }

  call(interp, args) {
    const env = new Environment(this.closure);
    this.decl.params.forEach((p, i) => env.define(p, args[i]));
    try {
      interp.execBlock(this.decl.body, env);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    return null;
  }
}

class NativeFunction {
  constructor(name, fn) {
    this.name = name;
    this.fn = fn;
  }

  call(interp, args) {
    return this.fn(...args);
  }
}

class ReturnSignal {
  constructor(value) {
    this.value = value;
  }
}

class BreakSignal extends Error {
  constructor() {
    super("'break' used outside of a loop");
  }
}

class ContinueSignal extends Error {
  constructor() {
    super("'continue' used outside of a loop");
  }
}

function truthy(v) {
  return v !== false && v !== null && v !== undefined && v !== 0 && v !== '';
}

function stringify(v) {
  if (v === null || v === undefined) return 'nil';
  if (v instanceof MaxFunction || v instanceof NativeFunction) return '<fn>';
  if (Array.isArray(v)) return `[${v.map(stringify).join(', ')}]`;
  return String(v);
}

const BUILTIN_FUNCTIONS = {
  len: (x) => {
    if (typeof x === 'string' || Array.isArray(x)) return x.length;
    throw new Error('len() expects a string or array');
  },
  upper: (s) => String(s).toUpperCase(),
  lower: (s) => String(s).toLowerCase(),
  abs: (n) => Math.abs(n),
  min: (...ns) => Math.min(...ns),
  max: (...ns) => Math.max(...ns),
  sqrt: (n) => Math.sqrt(n),
  range: (a, b) => {
    const [start, end] = b === undefined ? [0, a] : [a, b];
    const out = [];
    for (let i = start; i < end; i++) out.push(i);
    return out;
  },
  split: (s, sep) => String(s).split(sep === undefined ? ' ' : sep),
  join: (arr, sep) => {
    if (!Array.isArray(arr)) throw new Error('join() expects an array');
    return arr.join(sep === undefined ? '' : sep);
  },
  str: (v) => stringify(v),
  num: (v) => Number(v),
};

class Interpreter {
  constructor({ output = (s) => process.stdout.write(s + '\n') } = {}) {
    this.globals = new Environment();
    this.output = output;
    this.cwd = process.cwd();
    this.aliases = new Map();
    this.shellHistory = [];
    for (const [name, fn] of Object.entries(BUILTIN_FUNCTIONS)) {
      this.globals.define(name, new NativeFunction(name, fn));
    }
  }

  run(source) {
    const program = new Parser(source).parseProgram();
    return this.execBlock(program.body, this.globals);
  }

  execBlock(statements, env) {
    let result = null;
    for (const stmt of statements) {
      result = this.execStatement(stmt, env);
    }
    return result;
  }

  execStatement(stmt, env) {
    switch (stmt.type) {
      case 'ShellExec': {
        const command = this.expandAlias(stmt.command);
        this.shellHistory.push(command);
        try {
          const out = execSync(command, { cwd: this.cwd, encoding: 'utf8', shell: SHELL_PATH });
          if (out) this.output(out.replace(/\n$/, ''));
        } catch (e) {
          if (e.stdout) this.output(String(e.stdout).replace(/\n$/, ''));
          if (e.stderr) this.output(String(e.stderr).replace(/\n$/, ''));
          if (!e.stdout && !e.stderr) this.output(`error: ${e.message}`);
        }
        return null;
      }
      case 'LetDecl': {
        // `let` updates the variable in whichever scope already declared
        // it (so reassigning a loop counter inside a `while` body works),
        // and only creates a fresh binding when the name is unknown.
        const value = this.evaluate(stmt.value, env);
        env.set(stmt.name, value);
        return null;
      }
      case 'Print': {
        this.output(stringify(this.evaluate(stmt.value, env)));
        return null;
      }
      case 'Return': {
        throw new ReturnSignal(stmt.value ? this.evaluate(stmt.value, env) : null);
      }
      case 'If': {
        if (truthy(this.evaluate(stmt.test, env))) {
          this.execBlock(stmt.consequent, new Environment(env));
        } else if (stmt.alternate.length) {
          this.execBlock(stmt.alternate, new Environment(env));
        }
        return null;
      }
      case 'While': {
        while (truthy(this.evaluate(stmt.test, env))) {
          try {
            this.execBlock(stmt.body, new Environment(env));
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return null;
      }
      case 'ForIn': {
        const iterable = this.evaluate(stmt.iterable, env);
        let items;
        if (Array.isArray(iterable)) items = iterable;
        else if (typeof iterable === 'string') items = iterable.split('');
        else throw new Error("'for ... in' requires an array or string");
        for (const item of items) {
          const loopEnv = new Environment(env);
          loopEnv.define(stmt.varName, item);
          try {
            this.execBlock(stmt.body, loopEnv);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return null;
      }
      case 'Break': {
        throw new BreakSignal();
      }
      case 'Continue': {
        throw new ContinueSignal();
      }
      case 'FnDecl': {
        env.define(stmt.name, new MaxFunction(stmt, env));
        return null;
      }
      case 'Cd': {
        let target = stmt.target || process.env.HOME;
        if ((target[0] === '"' && target[target.length - 1] === '"') ||
            (target[0] === "'" && target[target.length - 1] === "'")) {
          target = target.slice(1, -1);
        }
        if (target === '~') target = process.env.HOME;
        else if (target.startsWith('~/')) target = path.join(process.env.HOME, target.slice(2));
        this.cwd = path.resolve(this.cwd, target);
        return null;
      }
      case 'Pwd': {
        this.output(this.cwd);
        return null;
      }
      case 'Exit': {
        process.exit(0);
        return null;
      }
      case 'Help': {
        this.output(HELP_TEXT);
        return null;
      }
      case 'History': {
        if (!this.shellHistory.length) {
          this.output('(no commands run yet)');
        } else {
          this.shellHistory.forEach((cmd, i) => this.output(`${i + 1}  ${cmd}`));
        }
        return null;
      }
      case 'Which': {
        this.output(this.describeWhich(stmt.name));
        return null;
      }
      case 'Alias': {
        if (stmt.name === null) {
          const entries = [...this.aliases.entries()];
          if (!entries.length) this.output('(no aliases defined)');
          else entries.forEach(([k, v]) => this.output(`${k}='${v}'`));
          return null;
        }
        if (stmt.value === undefined) {
          const v = this.aliases.get(stmt.name);
          this.output(v !== undefined ? `${stmt.name}='${v}'` : `${stmt.name}: not aliased`);
          return null;
        }
        this.aliases.set(stmt.name, String(this.evaluate(stmt.value, env)));
        return null;
      }
      case 'Env': {
        if (stmt.name === null) {
          Object.keys(process.env).sort().forEach((k) => this.output(`${k}=${process.env[k]}`));
          return null;
        }
        if (stmt.value === undefined) {
          this.output(stmt.name in process.env ? `${stmt.name}=${process.env[stmt.name]}` : `${stmt.name} is not set`);
          return null;
        }
        process.env[stmt.name] = String(this.evaluate(stmt.value, env));
        return null;
      }
      case 'ExprStatement': {
        return this.evaluate(stmt.expr, env);
      }
      default:
        throw new Error(`Unknown statement type ${stmt.type}`);
    }
  }

  evaluate(node, env) {
    switch (node.type) {
      case 'NumberLit': return node.value;
      case 'StringLit': return node.value;
      case 'BoolLit': return node.value;
      case 'Identifier': return env.get(node.name);
      case 'Unary': {
        const v = this.evaluate(node.argument, env);
        if (node.op === '-') return -v;
        if (node.op === 'not') return !truthy(v);
        break;
      }
      case 'Logical': {
        const left = this.evaluate(node.left, env);
        if (node.op === 'and') return truthy(left) ? this.evaluate(node.right, env) : left;
        return truthy(left) ? left : this.evaluate(node.right, env);
      }
      case 'Binary': {
        const l = this.evaluate(node.left, env);
        const r = this.evaluate(node.right, env);
        switch (node.op) {
          case '+': return (typeof l === 'string' || typeof r === 'string') ? String(l) + String(r) : l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': return l / r;
          case '%': return l % r;
          case '==': return l === r;
          case '!=': return l !== r;
          case '<': return l < r;
          case '>': return l > r;
          case '<=': return l <= r;
          case '>=': return l >= r;
          default: throw new Error(`Unknown operator ${node.op}`);
        }
      }
      case 'Call': {
        const callee = this.evaluate(node.callee, env);
        const args = node.args.map((a) => this.evaluate(a, env));
        if (!(callee instanceof MaxFunction || callee instanceof NativeFunction)) {
          throw new Error('Attempted to call a non-function value');
        }
        return callee.call(this, args);
      }
      case 'ArrayLit': {
        return node.elements.map((e) => this.evaluate(e, env));
      }
      case 'Index': {
        const obj = this.evaluate(node.object, env);
        const idx = this.evaluate(node.index, env);
        if (!Array.isArray(obj) && typeof obj !== 'string') {
          throw new Error('Cannot index a value that is not an array or string');
        }
        return obj[idx];
      }
      default:
        throw new Error(`Unknown expression type ${node.type}`);
    }
  }

  // Expands the leading word of a shell command if it matches a defined
  // alias, the same way an interactive shell would.
  expandAlias(command) {
    const match = command.match(/^(\S+)/);
    if (!match || !this.aliases.has(match[1])) return command;
    return this.aliases.get(match[1]) + command.slice(match[1].length);
  }

  describeWhich(name) {
    if (!name) return 'usage: which <name>';
    if (KEYWORDS.has(name)) return `${name}: maxshell keyword`;
    if (this.aliases.has(name)) return `${name}: aliased to '${this.aliases.get(name)}'`;
    try {
      const val = this.globals.get(name);
      if (val instanceof MaxFunction) return `${name}: function`;
      if (val instanceof NativeFunction) return `${name}: builtin function`;
      return `${name}: variable = ${stringify(val)}`;
    } catch {
      // Not a keyword, alias, or known MaxScript name — fall through to
      // asking the real shell where the command lives.
    }
    try {
      const out = execSync(`which ${name}`, { cwd: this.cwd, encoding: 'utf8', shell: SHELL_PATH }).trim();
      return out || `${name}: not found`;
    } catch {
      return `${name}: not found`;
    }
  }
}

module.exports = { Interpreter, Environment, MaxFunction, NativeFunction };
