'use strict';

// What `bot` knows: jokes, facts, riddles, trivia, quotes and more.

const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs. 🐛',
  'There are 10 kinds of people: those who understand binary and those who don’t.',
  'I would tell you a UDP joke, but you might not get it.',
  'A SQL query walks into a bar, walks up to two tables and asks: “Can I join you?”',
  'How many programmers does it take to change a light bulb? None — that’s a hardware problem.',
  'Why did the developer go broke? Because he used up all his cache. 💸',
  'I told my computer I needed a break, and it said “no problem — I’ll go to sleep.”',
  'Why do Java developers wear glasses? Because they don’t C#.',
  'What’s a computer’s favourite snack? Microchips. 🍟',
  'Why was the math book sad? It had too many problems.',
  'I’m reading a book about anti-gravity. It’s impossible to put down.',
  'Why don’t skeletons fight each other? They don’t have the guts. 💀',
  'What do you call a fake noodle? An impasta. 🍝',
  'Why did the scarecrow win an award? He was outstanding in his field. 🌾',
  'Parallel lines have so much in common. It’s a shame they’ll never meet.',
  'Why did the function break up with the loop? It felt like it was going in circles.',
  'What did the router say to the doctor? “It hurts when IP.”',
  'Why was the JavaScript developer sad? Because he didn’t Node how to Express himself.',
  'Debugging: being the detective in a crime movie where you are also the murderer. 🔍',
  'I tried to write a joke about recursion. I tried to write a joke about recursion.',
  'Why did the computer show up late to work? It had a hard drive. 🚗',
  'Knock knock. Race condition. Who’s there?',
  'What do you call 8 hobbits? A hobbyte.',
  'Why did the cookie go to the doctor? Because it felt crummy. 🍪',
  'My shell and I have a lot in common. We both crash when you ask too much of us.',
];

const FACTS = [
  'The first computer “bug” was a real moth, found stuck in a Harvard Mark II relay in 1947. 🦋',
  'The first 1 GB hard drive (1980) weighed about 250 kg and cost $40,000.',
  'Octopuses have three hearts and blue blood. 🐙',
  'Honey never spoils — edible honey has been found in 3,000-year-old Egyptian tombs. 🍯',
  'A day on Venus is longer than a year on Venus.',
  'Bananas are berries, but strawberries aren’t. 🍌',
  'The Unix time counter will overflow 32 bits on 19 January 2038.',
  'The word “robot” comes from the Czech “robota”, meaning forced labour. 🤖',
  'The @ sign was in use for centuries before email — merchants used it for “at the rate of”.',
  'There are more possible chess games than atoms in the observable universe. ♟️',
  'Sharks existed before trees did. 🦈',
  'The first website ever made is still online: info.cern.ch.',
  'Your brain uses about 20% of your body’s energy while being about 2% of its weight. 🧠',
  'A group of flamingos is called a “flamboyance”. 🦩',
  'The original name of the Bash shell stands for “Bourne Again SHell” — a pun on Stephen Bourne’s sh.',
  'Wombat poop is cube-shaped. 🟫',
  'The QWERTY keyboard layout was designed in the 1870s for typewriters.',
  'Light from the Sun takes about 8 minutes and 20 seconds to reach Earth. ☀️',
];

const QUOTES = [
  '“Talk is cheap. Show me the code.” — Linus Torvalds',
  '“First, solve the problem. Then, write the code.” — John Johnson',
  '“Simplicity is prerequisite for reliability.” — Edsger Dijkstra',
  '“It always seems impossible until it’s done.” — Nelson Mandela',
  '“The best way to predict the future is to invent it.” — Alan Kay',
  '“Make it work, make it right, make it fast.” — Kent Beck',
  '“Done is better than perfect.”',
  '“You miss 100% of the shots you don’t take.” — Wayne Gretzky',
  '“Programs must be written for people to read, and only incidentally for machines to execute.” — Harold Abelson',
];

const ADVICE = [
  'Take a short break and drink some water. Future you will say thanks. 💧',
  'Break the big task into the smallest next step, and just do that one.',
  'Commit your work early and often. 🙂',
  'If you’ve been stuck for 20 minutes, explain the problem out loud — even to me.',
  'Sleep on it. A lot of bugs fix themselves overnight (because you do).',
  'Write the test first; it tells you when you’re done.',
];

const COMPLIMENTS = [
  'You ask great questions. 🌟',
  'Your code is probably cleaner than you think.',
  'You have excellent taste in shells. 😎',
  'You’re the kind of person who reads error messages. That’s rare and beautiful.',
  'Honestly? Top-tier human. 10/10.',
];

// Riddles: the answer is accepted if any keyword appears in the guess.
const RIDDLES = [
  { q: 'What has keys but can’t open locks?', a: 'A keyboard (or a piano). 🎹', keys: ['keyboard', 'piano'] },
  { q: 'What gets wetter the more it dries?', a: 'A towel.', keys: ['towel'] },
  { q: 'What has a head and a tail but no body?', a: 'A coin. 🪙', keys: ['coin'] },
  { q: 'What can you catch but not throw?', a: 'A cold. 🤧', keys: ['cold'] },
  { q: 'The more you take, the more you leave behind. What are they?', a: 'Footsteps. 👣', keys: ['footstep', 'step'] },
  { q: 'What has hands but can’t clap?', a: 'A clock. ⏰', keys: ['clock', 'watch'] },
  { q: 'What goes up but never comes down?', a: 'Your age. 🎂', keys: ['age'] },
  { q: 'What has many teeth but can’t bite?', a: 'A comb.', keys: ['comb', 'zipper', 'saw'] },
  { q: 'I speak without a mouth and hear without ears. What am I?', a: 'An echo.', keys: ['echo'] },
  { q: 'What has one eye but can’t see?', a: 'A needle. 🪡', keys: ['needle', 'storm', 'hurricane'] },
];

// Trivia: `a` is the right option's letter.
const TRIVIA = [
  { q: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Mercury'], a: 'b' },
  { q: 'What does CPU stand for?', options: ['Central Processing Unit', 'Computer Personal Unit', 'Central Program Utility', 'Core Power Unit'], a: 'a' },
  { q: 'How many bits are in a byte?', options: ['4', '8', '16', '32'], a: 'b' },
  { q: 'What is the largest ocean on Earth?', options: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], a: 'd' },
  { q: 'Who wrote “Romeo and Juliet”?', options: ['Charles Dickens', 'Jane Austen', 'William Shakespeare', 'Mark Twain'], a: 'c' },
  { q: 'What is H₂O better known as?', options: ['Salt', 'Water', 'Hydrogen', 'Oxygen'], a: 'b' },
  { q: 'Which language runs in every web browser?', options: ['Python', 'C', 'JavaScript', 'Rust'], a: 'c' },
  { q: 'What is the square root of 144?', options: ['12', '14', '16', '10'], a: 'a' },
  { q: 'Which animal is the fastest on land?', options: ['Lion', 'Cheetah', 'Horse', 'Greyhound'], a: 'b' },
  { q: 'In what year did the first iPhone come out?', options: ['2005', '2007', '2009', '2010'], a: 'b' },
  { q: 'What does “git commit” do?', options: ['Uploads to GitHub', 'Deletes a branch', 'Records staged changes', 'Downloads a repo'], a: 'c' },
  { q: 'How many continents are there?', options: ['5', '6', '7', '8'], a: 'c' },
];

const WOULD_YOU_RATHER = [
  'Would you rather be able to fly, or be invisible?',
  'Would you rather never use a keyboard again, or never use a mouse again?',
  'Would you rather have unlimited pizza or unlimited tacos?',
  'Would you rather code only in Python or only in JavaScript for the rest of your life?',
  'Would you rather talk to animals or speak every human language?',
  'Would you rather live in space or under the sea?',
];

const EIGHT_BALL = [
  'It is certain. ✅', 'Without a doubt.', 'Yes — definitely.', 'Most likely.', 'Signs point to yes.',
  'Ask again later. 🔮', 'Cannot predict now.', 'Better not tell you now…',
  'Don’t count on it.', 'My sources say no.', 'Very doubtful. ❌',
];

module.exports = {
  JOKES, FACTS, QUOTES, ADVICE, COMPLIMENTS, RIDDLES, TRIVIA, WOULD_YOU_RATHER, EIGHT_BALL,
};
