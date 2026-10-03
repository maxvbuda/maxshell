'use strict';

// Terminal games in Python for mx4's training data. Each is played by
// pyCheck: run with a long script of typed moves on stdin, it must finish
// cleanly (exit 0, no traceback) and print what a finished game prints.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GAMES = [
  {
    kind: 'guess', names: ['a number guessing game', 'guess the number', 'a guessing game'],
    code: (v) => `import random


def play():
    secret = random.randint(1, ${v.max})
    tries = 0
    print("I'm thinking of a number from 1 to ${v.max}.")
    while True:
        text = input("Your guess: ")
        if not text.isdigit():
            print("Please type a whole number.")
            continue
        guess = int(text)
        tries += 1
        if guess < secret:
            print("Higher!")
        elif guess > secret:
            print("Lower!")
        else:
            print(f"Yes! It was {secret}. You got it in {tries} tries.")
            return


play()`,
    vary: (r) => ({ max: r.pick([10, 50, 100]) }),
    stdin: (v) => ['abc', ...Array.from({ length: v.max }, (_, i) => String(i + 1))].join('\n'),
    expect: /You got it in/,
    notes: (v) => ['Run it with `python3 guess.py`.', `\`random.randint(1, ${v.max})\` picks the secret number (both ends included). The \`while True\` loop keeps asking until the guess is right, and \`isdigit()\` makes sure the input is a number before \`int()\` converts it.`],
  },
  {
    kind: 'rps', names: ['rock paper scissors', 'a rock paper scissors game'],
    code: (v) => `import random

MOVES = ["rock", "paper", "scissors"]
BEATS = {"rock": "scissors", "paper": "rock", "scissors": "paper"}


def play(rounds=${v.rounds}):
    you = computer = 0
    for round_number in range(1, rounds + 1):
        move = input(f"Round {round_number} - rock, paper or scissors? ").strip().lower()
        while move not in MOVES:
            move = input("Please type rock, paper or scissors: ").strip().lower()
        theirs = random.choice(MOVES)
        print(f"The computer chose {theirs}.")
        if move == theirs:
            print("It's a tie!")
        elif BEATS[move] == theirs:
            you += 1
            print("You win this round!")
        else:
            computer += 1
            print("The computer wins this round.")
    print(f"Final score - you {you}, computer {computer}.")


play()`,
    vary: (r) => ({ rounds: r.pick([3, 5]) }),
    stdin: () => ['banana', 'rock', 'paper', 'scissors', 'rock', 'paper', 'scissors'].join('\n'),
    expect: /Final score/,
    notes: () => ['Run it with `python3 rps.py`.', '`BEATS` says what each move defeats, so one lookup decides the round. `random.choice` picks the computer’s move, and the inner `while` loop asks again until you type a real move.'],
  },
  {
    kind: 'hangman', names: ['hangman', 'a hangman game', 'a word guessing game'],
    code: (v) => `import random

WORDS = ${JSON.stringify(v.words).replace(/,/g, ', ')}


def play(lives=${v.lives}):
    word = random.choice(WORDS)
    guessed = set()
    while lives > 0:
        shown = " ".join(letter if letter in guessed else "_" for letter in word)
        print(f"\\n{shown}   lives: {lives}")
        if "_" not in shown:
            print("You got it! The word was", word)
            return
        letter = input("Guess a letter: ").strip().lower()
        if len(letter) != 1 or not letter.isalpha():
            print("Type a single letter.")
        elif letter in guessed:
            print("You already guessed that.")
        else:
            guessed.add(letter)
            if letter not in word:
                lives -= 1
                print("Nope!")
    print("Out of lives! The word was", word)


play()`,
    vary: (r) => ({ words: r.pick([['python', 'computer', 'keyboard', 'monitor', 'program'], ['elephant', 'giraffe', 'penguin', 'dolphin', 'kangaroo'], ['pizza', 'banana', 'pancake', 'sandwich', 'noodles']]), lives: r.pick([6, 8]) }),
    stdin: () => ['12', 'e', 'e', ...'aoiunrtslcdpmhgbfywkvxzjq'].join('\n'),
    expect: /The word was/,
    notes: () => ['Run it with `python3 hangman.py`.', 'The guessed letters are kept in a `set`. Each turn the word is shown with blanks for letters not guessed yet; a wrong letter costs a life, and when no blanks are left you’ve won.'],
  },
  {
    kind: 'tictactoe', names: ['tic tac toe', 'tic-tac-toe', 'noughts and crosses'],
    code: () => `LINES = [(0, 1, 2), (3, 4, 5), (6, 7, 8), (0, 3, 6), (1, 4, 7), (2, 5, 8), (0, 4, 8), (2, 4, 6)]


def show(board):
    for row in range(3):
        print(" " + " | ".join(board[row * 3:row * 3 + 3]))
        if row < 2:
            print("---+---+---")


def winner(board):
    for a, b, c in LINES:
        if board[a] == board[b] == board[c] and board[a] in "XO":
            return board[a]
    return None


def play():
    board = [str(i + 1) for i in range(9)]
    player = "X"
    for _ in range(9):
        show(board)
        while True:
            choice = input(f"{player}, pick a square (1-9): ").strip()
            if choice.isdigit() and 1 <= int(choice) <= 9 and board[int(choice) - 1] not in "XO":
                break
            print("That square isn't free.")
        board[int(choice) - 1] = player
        if winner(board):
            show(board)
            print(f"{player} wins!")
            return
        player = "O" if player == "X" else "X"
    show(board)
    print("It's a draw!")


play()`,
    vary: () => ({}),
    stdin: () => ['0', '1', '1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n'),
    expect: /wins!|draw/,
    notes: () => ['Run it with `python3 tictactoe.py` — two players take turns at the same keyboard.', 'The board is a list of 9 squares showing their numbers until someone takes them. `LINES` lists the 8 winning lines, and `winner()` checks each one after every move.'],
  },
  {
    kind: 'dice', names: ['a dice game', 'a dice rolling game', 'a game of pig'],
    code: (v) => `import random

TARGET = ${v.target}


def turn(name):
    total = 0
    while True:
        roll = random.randint(1, 6)
        print(f"{name} rolled a {roll}.")
        if roll == 1:
            print("A 1! No points this turn.")
            return 0
        total += roll
        if input(f"Turn total {total}. Roll again? (y/n) ").strip().lower() != "y":
            return total


def play():
    scores = {"You": 0, "Computer": 0}
    while True:
        scores["You"] += turn("You")
        print(f"Scores: {scores}")
        if scores["You"] >= TARGET:
            print("You win!")
            return
        # The computer stops once it has 15 points in a turn.
        total = 0
        while total < 15:
            roll = random.randint(1, 6)
            if roll == 1:
                total = 0
                break
            total += roll
        scores["Computer"] += total
        print(f"The computer scored {total}. Scores: {scores}")
        if scores["Computer"] >= TARGET:
            print("The computer wins!")
            return


play()`,
    vary: (r) => ({ target: r.pick([30, 50]) }),
    stdin: () => Array.from({ length: 400 }, (_, i) => (i % 3 === 2 ? 'n' : 'y')).join('\n'),
    expect: /wins?!/,
    notes: () => ['Run it with `python3 dice.py`. This is the dice game Pig: roll as often as you like, but a 1 wipes out that turn’s points.', '`turn()` keeps rolling while you answer y. The computer’s strategy is simple: keep rolling until it has 15 points in a turn.'],
  },
  {
    kind: 'quiz', names: ['a quiz game', 'a trivia quiz', 'a quiz'],
    code: (v) => `QUESTIONS = [
${v.qs.map(([q, a]) => `    (${JSON.stringify(q)}, ${JSON.stringify(a)}),`).join('\n')}
]


def play():
    score = 0
    for question, answer in QUESTIONS:
        reply = input(question + " ").strip().lower()
        if reply == answer.lower():
            print("Correct!")
            score += 1
        else:
            print(f"Not quite - it's {answer}.")
    print(f"You scored {score} out of {len(QUESTIONS)}.")


play()`,
    vary: (r) => ({ qs: r.pick([[['What is the capital of France?', 'Paris'], ['How many legs does a spider have?', '8'], ['What planet is known as the Red Planet?', 'Mars'], ['What is 7 x 8?', '56']], [['What gas do plants take in?', 'carbon dioxide'], ['What is the largest ocean?', 'Pacific'], ['How many days are in a leap year?', '366']], [['What does HTML stand for?', 'HyperText Markup Language'], ['Which language runs in web browsers?', 'JavaScript'], ['What symbol starts a comment in Python?', '#']]]) }),
    stdin: (v) => v.qs.map(([, a], i) => (i % 2 ? 'wrong' : a)).join('\n'),
    expect: /You scored/,
    notes: () => ['Run it with `python3 quiz.py`.', 'The questions live in a list of (question, answer) pairs, so adding more is just adding lines. Answers are compared in lower case, so capital letters don’t matter.'],
  },
];

const ASKS = [
  (g) => `make ${g} in python`, (g) => `write ${g} in python`, (g) => `can you code ${g} in python?`, (g) => `python code for ${g}`,
  (g) => `make a terminal ${g.replace(/^(a|an) /, '')} game in python`, (g) => `how do i make ${g} in python`, (g) => `i want to make ${g} using python`,
  (g) => `make ${g} that runs in the terminal`, (g) => `write a python program for ${g}`,
];

function pyGameConversation(rand) {
  const r = { pick: (l) => l[Math.floor(rand() * l.length)], chance: (p) => rand() < p };
  const g = r.pick(GAMES);
  const v = g.vary(r);
  const code = g.code(v);
  const request = r.pick(ASKS)(r.pick(g.names));
  const intro = r.pick(['Here’s a version you can play in the terminal:', 'Sure! In Python:', 'Here you go:', 'This one runs in the terminal:']);
  const reply = `${intro}\n\n\`\`\`python\n${code}\n\`\`\`\n\n${g.notes(v).join('\n\n')}`;
  return { request, reply, code, stdin: g.stdin(v), expect: g.expect, kind: g.kind };
}

function pyCheck(code, stdin, expect) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx4py-'));
  try {
    const file = path.join(dir, 'game.py');
    fs.writeFileSync(file, `${code}\n`);
    const r = spawnSync('python3', [file], { input: stdin, encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) return `exit ${r.status}: ${(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`;
    if (expect && !expect.test(r.stdout)) return `didn't finish (no ${expect})`;
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  let seed = 4;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let bad = 0;
  const n = Number(process.argv[2]) || 60;
  for (let i = 0; i < n; i++) {
    const c = pyGameConversation(rand);
    const problem = pyCheck(c.code, c.stdin, c.expect);
    if (problem) { bad++; console.log(`✗ ${c.kind}: ${problem}`); }
  }
  console.log(`${n} python games played, ${bad} failed`);
}

module.exports = { pyGameConversation, pyCheck };
