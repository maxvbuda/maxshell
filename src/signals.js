'use strict';

class ControlSignal extends Error {}

class BreakSignal extends ControlSignal {
  constructor(count = 1) {
    super('break');
    this.count = count;
  }
}

class ContinueSignal extends ControlSignal {
  constructor(count = 1) {
    super('continue');
    this.count = count;
  }
}

class ReturnSignal extends ControlSignal {
  constructor(status = 0) {
    super('return');
    this.status = status;
  }
}

class ExitSignal extends ControlSignal {
  constructor(status = 0) {
    super('exit');
    this.status = status;
  }
}

module.exports = { ControlSignal, BreakSignal, ContinueSignal, ReturnSignal, ExitSignal };
