'use strict';

// Conversations for mx4 that can only be answered by paying attention:
// details you mention come back later, questions are about the list or
// numbers you just gave, made-up names get an honest "I don't know", vague
// requests get a question back, and news gets a reply about *that* news.
// The details are drawn at random (and some names are invented on the
// spot), so no reply can be recited — it has to come from the chat.
//
//   node ai/mx4/chatgen.js [n]   prints n examples

const SYL = ['ka', 'lo', 'mi', 'zor', 'ven', 'tal', 'bri', 'qu', 'ral', 'nex', 'dov', 'shi', 'pel', 'gor', 'ith', 'yan', 'fel', 'cro', 'mun', 'bex'];
const NAMES = ['Max', 'Ada', 'Sam', 'Priya', 'Leo', 'Zoe', 'Omar', 'Mia', 'Kofi', 'Lucas', 'Aisha', 'Noah', 'Elena', 'Jin', 'Freya', 'Mateo', 'Hana', 'Tom', 'Lily', 'Ravi', 'Sofia', 'Ben', 'Nadia', 'Arjun', 'Grace', 'Ivy', 'Ezra', 'Chloe', 'Yusuf', 'Maya'];
const PETS = [['dog', '🐶'], ['cat', '🐱'], ['hamster', '🐹'], ['rabbit', '🐰'], ['parrot', '🦜'], ['goldfish', '🐠'], ['turtle', '🐢'], ['guinea pig', '🐹'], ['lizard', '🦎'], ['puppy', '🐶'], ['kitten', '🐱']];
const PET_NAMES = ['Biscuit', 'Luna', 'Mochi', 'Pepper', 'Ziggy', 'Noodle', 'Captain', 'Waffles', 'Olive', 'Rocket', 'Pickle', 'Daisy', 'Bruno', 'Sushi', 'Pixel', 'Maple', 'Taco', 'Nugget'];
const FOODS = ['pizza', 'sushi', 'tacos', 'pasta', 'curry', 'ramen', 'pancakes', 'burgers', 'dumplings', 'lasagna', 'falafel', 'mac and cheese', 'chocolate cake', 'pho', 'paella'];
const COLOURS = ['blue', 'green', 'purple', 'red', 'orange', 'yellow', 'teal', 'pink', 'black', 'silver'];
const PLACES = ['Japan', 'Italy', 'Mexico', 'Canada', 'Kenya', 'Iceland', 'Peru', 'Spain', 'Australia', 'Egypt', 'Norway', 'Vietnam', 'Brazil', 'Greece', 'Portugal'];
const CITIES = ['London', 'Toronto', 'Chicago', 'Sydney', 'Berlin', 'Austin', 'Seattle', 'Mumbai', 'Lagos', 'Dublin', 'Denver', 'Boston', 'Madrid', 'Seoul'];
const HOBBIES = ['playing guitar', 'drawing', 'coding', 'skateboarding', 'baking', 'chess', 'swimming', 'photography', 'gardening', 'reading', 'football', 'piano', 'running', 'knitting'];
const SUBJECTS = ['maths', 'science', 'history', 'art', 'English', 'music', 'geography', 'computer science', 'Spanish', 'PE'];
const RELATIVES = ['sister', 'brother', 'cousin', 'best friend', 'mum', 'dad', 'grandma', 'uncle', 'aunt'];
const ITEMS = ['eggs', 'milk', 'bread', 'apples', 'rice', 'cheese', 'bananas', 'pasta', 'butter', 'carrots', 'onions', 'yogurt', 'coffee', 'tomatoes', 'honey'];
const WORDS = ['banana', 'keyboard', 'rocket', 'umbrella', 'dragon', 'pencil', 'galaxy', 'window', 'turtle', 'blanket', 'mountain', 'puzzle', 'lantern', 'violin'];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function rng(rand) {
  const pick = (l) => l[Math.floor(rand() * l.length)];
  return { pick, chance: (p) => rand() < p, int: (a, b) => a + Math.floor(rand() * (b - a + 1)), shuffle: (l) => { const a = [...l]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; } };
}

// An invented word, never the same twice in a row.
function nonce(r, parts = 2) {
  let w = '';
  for (let i = 0; i < parts; i++) w += r.pick(SYL);
  return w;
}

// --- remembering what you said --------------------------------------------------------

function facts(r) {
  const name = r.pick(NAMES);
  const [pet, emoji] = r.pick(PETS);
  const petName = r.chance(0.3) ? cap(nonce(r)) : r.pick(PET_NAMES);
  const relative = r.pick(RELATIVES);
  const relName = r.pick(NAMES.filter((n) => n !== name));
  const age = r.int(9, 45);
  return [
    { key: 'pet', say: [`i have a ${pet} called ${petName}`, `my ${pet}'s name is ${petName}`, `we just got a ${pet}, her name is ${petName}`, `i've got a ${pet} named ${petName}`],
      ack: [`Aww, ${petName} sounds lovely! ${emoji}`, `${petName} is a great name for a ${pet}! ${emoji}`, `A ${pet} called ${petName} — love it. ${emoji}`],
      ask: [`what's my ${pet} called?`, `do you remember my ${pet}'s name?`, `what did i say my ${pet} is called`, `what's the name of my pet?`],
      answer: [`Your ${pet} is called ${petName}. ${emoji}`, `${petName}! Your ${pet}. ${emoji}`, `You told me your ${pet} is ${petName}.`] },
    { key: 'food', v: r.pick(FOODS), say: (v) => [`my favourite food is ${v}`, `i love ${v}`, `${v} is the best food ever`, `i could eat ${v} every day`],
      ack: (v) => [`${cap(v)} is a great choice! 😋`, `Good taste — ${v} is delicious.`, `Mmm, ${v}! 😋`],
      ask: ['what is my favourite food?', 'what food did i say i love?', 'remind me what my favourite food is', 'do you remember what i like to eat?'],
      answer: (v) => [`You said your favourite food is ${v}. 😋`, `${cap(v)}! You told me you love it.`] },
    { key: 'colour', v: r.pick(COLOURS), say: (v) => [`my favourite colour is ${v}`, `i really like the colour ${v}`, `${v} is my favourite colour`],
      ack: (v) => [`${cap(v)} is a great colour!`, `Nice — ${v}! 🎨`],
      ask: ['what is my favourite colour?', 'what colour did i say i like?', 'do you remember my favourite colour'],
      answer: (v) => [`Your favourite colour is ${v}.`, `${cap(v)}! 🎨`] },
    { key: 'city', v: r.pick(CITIES), say: (v) => [`i live in ${v}`, `i'm from ${v}`, `i'm based in ${v}`],
      ack: (v) => [`${v} — nice! What's it like there?`, `Oh cool, ${v}!`],
      ask: ['where do i live?', 'what city did i say i live in?', 'do you remember where i’m from?'],
      answer: (v) => [`You live in ${v}.`, `You said you’re from ${v}.`] },
    { key: 'hobby', v: r.pick(HOBBIES), say: (v) => [`i've been really into ${v} lately`, `my hobby is ${v}`, `i spend most of my free time on ${v}`],
      ack: (v) => [`${cap(v)} is a great hobby! How long have you been doing it?`, `Nice — ${v} is so much fun.`],
      ask: ['what hobby did i mention?', 'what do i like doing at the weekend?', 'what did i say my hobby was?'],
      answer: (v) => [`You said you’re into ${v}.`, `${cap(v)}!`] },
    { key: 'age', v: age, say: (v) => [`i'm ${v} years old`, `i'm ${v}`, `i just turned ${v}`],
      ack: (v) => [`${v} — nice! 🎂`, `Got it, ${v}.`],
      ask: ['how old am i?', 'how old did i say i was?', 'what age did i tell you?'],
      answer: (v) => [`You said you’re ${v}.`, `${v}!`] },
    { key: 'relative', say: [`my ${relative}'s name is ${relName}`, `i have a ${relative} called ${relName}`, `${relName} is my ${relative}`],
      ack: [`Nice to hear about ${relName}! 😊`, `Got it — your ${relative} is ${relName}.`],
      ask: [`what's my ${relative}'s name?`, `do you remember my ${relative}'s name?`, `who did i say my ${relative} is?`],
      answer: [`Your ${relative} is ${relName}.`, `${relName}! Your ${relative}.`] },
    { key: 'subject', v: r.pick(SUBJECTS), say: (v) => [`my favourite subject at school is ${v}`, `i'm best at ${v}`, `i love ${v} class`],
      ack: (v) => [`${cap(v)} is a great subject!`, `Nice — ${v}! Want help with anything in it?`],
      ask: ['what is my favourite subject?', 'what subject did i say i like?'],
      answer: (v) => [`${cap(v)} — you said it’s your favourite.`, `You told me you love ${v}.`] },
  ].map((f) => {
    const fill = (x) => (typeof x === 'function' ? x(f.v) : x);
    return { key: f.key, say: fill(f.say), ack: fill(f.ack), ask: f.ask, answer: fill(f.answer) };
  });
}

const FILLER = [
  ['how are you?', ['I’m doing well, thanks! How about you?', 'Pretty good! What’s up?']],
  ['tell me a joke', ['Why do programmers prefer dark mode? Because light attracts bugs. 🐛', 'I told my computer I needed a break — it went to sleep. 😴']],
  ['what is 12 times 3', ['36.']],
  ['what is the capital of france', ['Paris.']],
  ['thanks', ['You’re welcome! 😊']],
  ['i’m bored', ['Want to play a game, learn something new, or build something?']],
  ['what can you do?', ['I can write code and simple games, explain things, answer questions, and chat.']],
];

function memoryChat(r) {
  const all = r.shuffle(facts(r));
  const told = all.slice(0, r.int(1, 3));
  const turns = [];
  for (const f of told) {
    turns.push(['user', r.pick(f.say)], ['ai', r.pick(f.ack)]);
    if (r.chance(0.5)) { const [q, a] = r.pick(FILLER); turns.push(['user', q], ['ai', r.pick(a)]); }
  }
  // Ask about something said — or something never said.
  if (r.chance(0.8)) {
    const f = r.pick(told);
    turns.push(['user', r.pick(f.ask)], ['ai', r.pick(f.answer)]);
  } else {
    const f = r.pick(all.slice(3));
    turns.push(['user', r.pick(f.ask)], ['ai', r.pick(['You haven’t told me that yet! What is it?', 'I don’t know — you haven’t mentioned it. Tell me?', 'Hmm, you didn’t say. What is it?'])]);
  }
  return turns;
}

// --- questions about what you just gave ------------------------------------------------

function contextChat(r) {
  const kind = r.int(0, 9);
  if (kind === 0) {
    const items = r.shuffle(ITEMS).slice(0, r.int(3, 6));
    const i = r.int(0, items.length - 1);
    const nth = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][i];
    return [['user', `${r.pick(['my shopping list is', 'i need to buy', 'here is my list:'])} ${items.join(', ')}. what's the ${nth} thing on it?`], ['ai', `The ${nth} thing is ${items[i]}.`]];
  }
  if (kind === 1) {
    const items = r.shuffle(ITEMS).slice(0, r.int(3, 7));
    return [['user', `${r.pick(['how many things are on this list:', 'count these:', 'how many items is this?'])} ${items.join(', ')}`], ['ai', `${items.length} — ${items.join(', ')}.`]];
  }
  if (kind === 2) {
    const names = r.shuffle(NAMES).slice(0, r.int(3, 6));
    return [['user', `${r.pick(['sort these names alphabetically:', 'put these in alphabetical order:', 'alphabetise:'])} ${names.join(', ')}`], ['ai', [...names].sort().join(', ')]];
  }
  if (kind === 3) {
    const a = r.int(2, 30); const b = r.int(2, 30);
    const [x, y] = r.shuffle(['apples', 'oranges', 'pears', 'cookies', 'marbles', 'stickers']).slice(0, 2);
    return [['user', `i have ${a} ${x} and ${b} ${y}. how many is that altogether?`], ['ai', `${a} + ${b} = ${a + b}, so ${a + b} altogether.`]];
  }
  if (kind === 4) {
    const a = r.int(5, 60); const b = r.int(1, a);
    const thing = r.pick(['sweets', 'pages', 'dollars', 'stickers', 'cards']);
    return [['user', `i had ${a} ${thing} and gave away ${b}. how many do i have left?`], ['ai', `${a} − ${b} = ${b === a ? 0 : a - b}, so you have ${a - b} left.`]];
  }
  if (kind === 5) {
    const w = r.pick(WORDS);
    return [['user', `${r.pick(['how many letters are in', 'how many letters does this word have:', 'count the letters in'])} "${w}"?`], ['ai', `"${w}" has ${w.length} letters.`]];
  }
  if (kind === 6) {
    const w = r.pick(WORDS);
    return [['user', `${r.pick(['spell', 'what is', 'write'])} "${w}" backwards`], ['ai', `"${[...w].reverse().join('')}"`]];
  }
  if (kind === 7) {
    const a = r.int(1, 999); let b = r.int(1, 999); if (b === a) b++;
    return [['user', `${r.pick(['which is bigger,', 'what is larger:', 'which number is bigger:'])} ${a} or ${b}?`], ['ai', `${Math.max(a, b)} is bigger.`]];
  }
  if (kind === 8) {
    const words = r.shuffle(WORDS).slice(0, r.int(3, 5));
    const sentence = `the ${words.join(' and the ')}`;
    return [['user', `what is the last word in this sentence: "${sentence}"`], ['ai', `"${words[words.length - 1]}".`]];
  }
  const nums = Array.from({ length: r.int(3, 6) }, () => r.int(1, 50));
  const op = r.pick(['biggest', 'smallest', 'total']);
  const v = op === 'biggest' ? Math.max(...nums) : op === 'smallest' ? Math.min(...nums) : nums.reduce((a, b) => a + b, 0);
  return [['user', `${op === 'total' ? 'add these up' : `what's the ${op} number here`}: ${nums.join(', ')}`], ['ai', op === 'total' ? `${nums.join(' + ')} = ${v}` : `${v}.`]];
}

// --- honesty about things it doesn't know ------------------------------------------------

function unknownChat(r) {
  const thing = cap(nonce(r, r.int(2, 3)));
  const person = `${cap(nonce(r))} ${cap(nonce(r, 3))}`;
  const kinds = [
    [`who is ${person}?`, `I don’t know who ${person} is — I haven’t heard of them. If they’re someone you know, tell me about them!`],
    [`what is the capital of ${thing}?`, `I don’t know a place called ${thing}. It might be somewhere I wasn’t taught about, or it might not exist.`],
    [`what does ${thing.toLowerCase()} mean?`, `I don’t know the word “${thing.toLowerCase()}”. Where did you see it? I can try to help from the context.`],
    [`tell me about the ${thing} programming language`, `I don’t know a programming language called ${thing}. I know Python, JavaScript, HTML, CSS, C and a few others — want to try one of those?`],
    [`how tall is mount ${thing}?`, `I don’t know of a Mount ${thing}, so I can’t say how tall it is — I’d rather not guess.`],
    [`when was ${person} born?`, `I don’t know who ${person} is, so I can’t tell you when they were born.`],
    [`what's the weather in ${r.pick(CITIES)} right now?`, 'I can’t check the weather — I run on this Mac with no internet. A weather app or website will know.'],
    [`what's the latest news about ${r.pick(['the election', 'the football', 'the stock market', 'space missions', 'the new iPhone'])}?`, 'I don’t have news — I can’t go online, and I only know what I was trained on.'],
  ];
  const [q, a] = r.pick(kinds);
  return [['user', q], ['ai', a]];
}

// --- vague requests get a question back --------------------------------------------------

function vagueChat(r) {
  const vague = [
    ['fix it', ['What would you like me to fix? Paste the code or describe the problem and I’ll take a look.']],
    ['make it better', ['Make what better? Show me the code or text you mean and tell me what you’d like improved.']],
    ['can you help me', ['Of course! What do you need help with?', 'Sure — what are you working on?']],
    ['do the thing', ['Which thing? 😄 Tell me what you’d like me to do.']],
    ['it doesn’t work', ['What doesn’t work? Paste the code and any error message, and tell me what you expected to happen.']],
    ['write code', ['Happy to! What should the code do, and in which language?']],
    ['make a website', ['Sure! What’s it for? Tell me the name and what kind of site — a bakery, a portfolio, a club — and I’ll build it.']],
    ['explain it', ['Explain what? Tell me the topic or paste the code and I’ll walk you through it.']],
    ['what about the other one', ['Which other one? I’m not sure what you mean — can you say a bit more?']],
  ];
  const [q, a] = r.pick(vague);
  return [['user', q], ['ai', r.pick(a)]];
}

// --- news gets a reply about that news ---------------------------------------------------

function newsChat(r) {
  const [pet] = r.pick(PETS);
  const petName = r.pick(PET_NAMES);
  const place = r.pick(PLACES);
  const subject = r.pick(SUBJECTS);
  const hobby = r.pick(HOBBIES);
  const name = r.pick(NAMES);
  const kinds = [
    [`i just got a ${pet} called ${petName}!`, `Congratulations! ${petName} is a great name. How old is your new ${pet}?`],
    [`i'm going to ${place} next week`, `Exciting! Have an amazing trip to ${place}. ✈️ Is it your first time there?`],
    [`i failed my ${subject} test`, `I’m sorry — that’s really frustrating. One test doesn’t define you, though. Want help going over the ${subject} topics that were hard?`],
    [`i got an A in ${subject}!`, `Well done! 🎉 All that work on ${subject} paid off.`],
    [`it's my birthday today`, 'Happy birthday! 🎂 I hope you have a brilliant day. Doing anything fun?'],
    [`i've started ${hobby}`, `That’s great — ${hobby} is a lot of fun. How are you finding it so far?`],
    [`my friend ${name} is moving away`, `Oh no, that’s hard. You can still stay close to ${name} with calls and messages — and visits!`],
    [`i finished my first ${r.pick(['python', 'javascript', 'website', 'game'])} project`, 'That’s a big milestone — congratulations! 🎉 What does it do?'],
  ];
  const [q, a] = r.pick(kinds);
  const turns = [['user', q], ['ai', a]];
  // Sometimes the chat carries on about it.
  if (r.chance(0.3) && /trip/.test(a)) turns.push(['user', r.pick(['yes first time!', 'no, i went before']), ['ai', `Then I hope it’s a great one! Tell me how ${place} was when you’re back.`]]);
  return turns.filter((t) => typeof t[0] === 'string');
}

// --- correcting it -----------------------------------------------------------------------

function correctionChat(r) {
  const right = r.pick(NAMES);
  const wrong = r.pick(NAMES.filter((n) => n !== right));
  return [['user', `hi, i'm ${right}`], ['ai', `Hi ${right}! 👋 What can I do for you?`], ['user', 'what is my name?'], ['ai', `You’re ${right}.`],
    ['user', `actually call me ${wrong}`], ['ai', `Sure — I’ll call you ${wrong} from now on.`], ['user', 'what is my name now?'], ['ai', `${wrong}.`]];
}

const MAKERS = [[memoryChat, 4], [contextChat, 4], [unknownChat, 2], [vagueChat, 1], [newsChat, 2], [correctionChat, 1]];

function chatConversation(rand) {
  const r = rng(rand);
  const total = MAKERS.reduce((a, [, w]) => a + w, 0);
  let x = rand() * total;
  for (const [make, w] of MAKERS) { x -= w; if (x <= 0) return make(r); }
  return memoryChat(r);
}

if (require.main === module) {
  let seed = 2;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < (Number(process.argv[2]) || 8); i++) {
    console.log(chatConversation(rand).map(([w, t]) => `${w === 'user' ? 'you' : ' ai'}: ${t}`).join('\n'), '\n');
  }
}

module.exports = { chatConversation };
