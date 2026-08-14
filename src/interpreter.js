'use strict';

const fs = require('fs');
const { execSync } = require('child_process');
const { Parser } = require('./parser');

// Prefer zsh (macOS's default interactive shell) for running real
// commands; fall back to /bin/sh where zsh isn't installed (e.g. Linux).
const SHELL_PATH = fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';

const HELP_TEXT = `maxshell — a terminal with its own scripting language (MaxScript)

Built-ins:
  print <expr>            Print a value
  let x = <expr>           Declare or reassign a variable
  fn f(a, b) do ... end    Define a function
  if <cond> do ... end     Conditional (else / else if supported)
  while <cond> do ... end  Loop
  return <expr>            Return from a function
  cd <path>                Change the working directory (.., ~, relative, absolute)
  pwd                      Print the working directory
  help                     Show this message
  exit                     Quit maxshell

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

class ReturnSignal {
  constructor(value) {
    this.value = value;
  }
}

function truthy(v) {
  return v !== false && v !== null && v !== undefined && v !== 0 && v !== '';
}

function stringify(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'function' || v instanceof MaxFunction) return '<fn>';
  return String(v);
}

class Interpreter {
  constructor({ output = (s) => process.stdout.write(s + '\n') } = {}) {
    this.globals = new Environment();
    this.output = output;
    this.cwd = process.cwd();
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
        try {
          const out = execSync(stmt.command, { cwd: this.cwd, encoding: 'utf8', shell: SHELL_PATH });
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
          this.execBlock(stmt.body, new Environment(env));
        }
        return null;
      }
      case 'FnDecl': {
        env.define(stmt.name, new MaxFunction(stmt, env));
        return null;
      }
      case 'Cd': {
        const path = require('path');
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
        if (!(callee instanceof MaxFunction)) {
          throw new Error('Attempted to call a non-function value');
        }
        return callee.call(this, args);
      }
      default:
        throw new Error(`Unknown expression type ${node.type}`);
    }
  }
}

module.exports = { Interpreter, Environment, MaxFunction };
