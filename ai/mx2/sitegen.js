'use strict';

// Generates complete, valid websites for mx2's dataset: a business or person,
// the sections asked for, a colour scheme and layout — all as one
// self-contained index.html (HTML + CSS + a little JavaScript). The request
// text and the page always agree (a "green" request gets a green page, a
// "with pricing" request gets a pricing section).

// --- content ------------------------------------------------------------------

const KINDS = [
  { kind: 'bakery', names: ['Sunrise Bakery', 'Golden Crust', 'Flour & Honey', 'The Rolling Pin', 'Sweet Crumb'], tagline: ['Fresh bread and pastries, baked every morning.', 'Warm from the oven since 6 AM.', 'Handmade loaves, cakes and croissants.'],
    items: [['🥐', 'Croissants', 'Buttery, flaky and baked fresh daily.'], ['🍞', 'Sourdough', 'Slow-fermented for 24 hours for deep flavour.'], ['🎂', 'Custom cakes', 'Birthdays, weddings and everything in between.'], ['🍪', 'Cookies', 'Chocolate chip, oatmeal and seasonal specials.'], ['🥧', 'Pies', 'Apple, cherry and pumpkin in season.'], ['☕', 'Coffee', 'Locally roasted beans to go with your treat.']],
    menu: [['Croissant', '3.50'], ['Sourdough loaf', '7.00'], ['Cinnamon roll', '4.25'], ['Slice of cake', '5.00'], ['Latte', '4.50']], cta: 'Order online', about: 'We’re a family bakery that has been making bread by hand for over twenty years. Everything is baked on site with local flour and butter.' },
  { kind: 'coffee shop', names: ['Bean There', 'The Daily Grind', 'Brew Lab', 'Morning Ritual', 'Corner Cup'], tagline: ['Great coffee, good company.', 'Your neighbourhood coffee spot.', 'Small-batch roasts, brewed with care.'],
    items: [['☕', 'Espresso bar', 'Lattes, cappuccinos and flat whites made to order.'], ['🫘', 'Fresh beans', 'Roasted in house every week.'], ['🥯', 'Breakfast', 'Bagels, pastries and oatmeal until noon.'], ['💻', 'Free Wi-Fi', 'Plenty of seats and outlets to work from.'], ['🧋', 'Cold drinks', 'Cold brew, iced tea and smoothies.']],
    menu: [['Espresso', '3.00'], ['Latte', '4.75'], ['Cold brew', '4.50'], ['Chai', '4.25'], ['Bagel', '3.50']], cta: 'See the menu', about: 'We opened our doors to give the neighbourhood a friendly place to slow down. We roast our own beans and know most of our regulars by name.' },
  { kind: 'restaurant', names: ['La Piazza', 'The Green Fork', 'Harbor Grill', 'Spice Route', 'Maple & Thyme'], tagline: ['Seasonal food, made from scratch.', 'Good food, shared with good people.', 'A taste of home, every night of the week.'],
    items: [['🍝', 'Fresh pasta', 'Made by hand every morning.'], ['🥗', 'Seasonal plates', 'A menu that changes with what’s growing.'], ['🍷', 'Wine list', 'Carefully chosen bottles by the glass.'], ['🎉', 'Private events', 'Book the back room for parties of up to 40.'], ['🚗', 'Takeout', 'Order ahead and pick up on your way home.']],
    menu: [['Margherita pizza', '14.00'], ['Spaghetti carbonara', '16.50'], ['Caesar salad', '11.00'], ['Grilled salmon', '22.00'], ['Tiramisu', '8.00']], cta: 'Book a table', about: 'Our kitchen cooks with ingredients from farms within fifty miles. Come hungry, and leave room for dessert.' },
  { kind: 'photographer', names: ['Maya Chen Photography', 'Lens & Light', 'Wild Frame Studio', 'Golden Hour Photo', 'Riley Stone Photo'], tagline: ['Capturing the moments that matter.', 'Weddings, portraits and everything in between.', 'Natural light, real moments.'],
    items: [['💍', 'Weddings', 'Full-day coverage and a beautiful online gallery.'], ['👪', 'Family portraits', 'Relaxed sessions outdoors or at home.'], ['🏢', 'Business headshots', 'Clean, professional photos for your team.'], ['📸', 'Events', 'Parties, launches and celebrations.']],
    menu: [['Portrait session', '250'], ['Headshots (per person)', '120'], ['Half-day event', '600'], ['Wedding day', '2400']], cta: 'Book a session', about: 'I’ve been photographing people for ten years. My style is relaxed and natural — I’d rather capture a real laugh than a stiff pose.' },
  { kind: 'developer portfolio', names: ['Alex Rivera', 'Sam Okafor', 'Jordan Lee', 'Priya Nair', 'Leo Martins'], tagline: ['Web developer building fast, friendly websites.', 'Full-stack developer who loves clean code.', 'I build things for the web.'],
    items: [['💻', 'Web apps', 'Fast, accessible apps with modern JavaScript.'], ['📱', 'Responsive design', 'Sites that look great on every screen.'], ['⚡', 'Performance', 'Speed audits and fixes that make pages load in a blink.'], ['🔌', 'APIs', 'Back ends and integrations that just work.']],
    menu: [['Weather dashboard', 'JavaScript · API'], ['Recipe finder', 'React · Node'], ['Portfolio template', 'HTML · CSS'], ['Chat app', 'WebSockets']], cta: 'Get in touch', about: 'I’m a developer who enjoys turning ideas into simple, reliable websites. When I’m not coding, I’m hiking or reading sci-fi.' },
  { kind: 'gym', names: ['Iron Peak Fitness', 'Pulse Gym', 'Core Strength', 'Move Studio', 'Summit Fitness'], tagline: ['Stronger every day.', 'Train hard. Feel great.', 'A gym for every body.'],
    items: [['🏋️', 'Weights', 'Free weights, racks and machines for every level.'], ['🧘', 'Yoga & mobility', 'Classes to stretch, breathe and recover.'], ['🚴', 'Spin classes', 'High-energy rides with great music.'], ['🤝', 'Personal training', 'One-to-one coaching with a plan made for you.']],
    menu: [['Day pass', '15'], ['Monthly membership', '49'], ['Annual membership', '490'], ['Personal training session', '60']], cta: 'Start free trial', about: 'We’re a friendly gym where beginners and athletes train side by side. Our coaches are here to help, not to judge.' },
  { kind: 'dentist', names: ['Bright Smile Dental', 'Gentle Care Dentistry', 'Riverside Dental', 'Happy Teeth Clinic'], tagline: ['Gentle care for the whole family.', 'Healthy smiles start here.', 'Modern dentistry with a friendly touch.'],
    items: [['🦷', 'Check-ups', 'Regular exams and cleaning to keep teeth healthy.'], ['✨', 'Whitening', 'A brighter smile in a single visit.'], ['👶', 'Kids’ dentistry', 'Calm, fun visits for our youngest patients.'], ['🚨', 'Emergencies', 'Same-day appointments when you need them.']],
    menu: [['Check-up & clean', '90'], ['Whitening', '350'], ['Filling', 'from 120'], ['Emergency visit', '150']], cta: 'Book an appointment', about: 'Our team has cared for families in the area for over fifteen years. We take the time to explain every step, so there are no surprises.' },
  { kind: 'pet shelter', names: ['Happy Paws Rescue', 'Second Chance Shelter', 'Furever Home', 'Whiskers & Wags'], tagline: ['Every pet deserves a loving home.', 'Adopt, don’t shop.', 'Helping animals find their people.'],
    items: [['🐶', 'Adopt a dog', 'Meet dogs of every size looking for a home.'], ['🐱', 'Adopt a cat', 'Kittens, seniors and everyone in between.'], ['🤲', 'Volunteer', 'Walk dogs, socialise cats and help at events.'], ['💝', 'Donate', 'Every gift pays for food, vet care and shelter.']],
    menu: [['Dog adoption', '150'], ['Cat adoption', '90'], ['Sponsor a pet (monthly)', '20'], ['Volunteer orientation', 'free']], cta: 'Meet our animals', about: 'We’re a volunteer-run shelter that has found homes for over 3,000 animals. Every pet is vaccinated and microchipped before adoption.' },
  { kind: 'bookstore', names: ['Chapter & Verse', 'The Reading Nook', 'Paper Lantern Books', 'Next Page Bookshop'], tagline: ['Stories for every reader.', 'Your independent neighbourhood bookshop.', 'New books, old favourites, great recommendations.'],
    items: [['📚', 'New releases', 'The latest fiction and non-fiction every week.'], ['🧒', 'Kids’ corner', 'Picture books, story time and young adult reads.'], ['☕', 'Reading café', 'Coffee and a comfy chair to start your new book.'], ['🗓️', 'Book club', 'Monthly meetups to talk about what we’re reading.']],
    menu: [['Paperback', 'from 12'], ['Hardcover', 'from 25'], ['Gift card', 'any amount'], ['Book club membership', '10/month']], cta: 'Browse books', about: 'We’re an independent bookshop run by people who love reading. Tell us what you liked last and we’ll find your next favourite.' },
  { kind: 'yoga studio', names: ['Still Water Yoga', 'Breathe Studio', 'Lotus Flow', 'Sunlight Yoga'], tagline: ['Move, breathe, relax.', 'Yoga for every body and every level.', 'Find your balance.'],
    items: [['🧘', 'Beginner classes', 'Learn the basics in a calm, friendly class.'], ['🌊', 'Vinyasa flow', 'Flowing sequences that build strength.'], ['🌙', 'Restorative', 'Slow, gentle stretching to unwind.'], ['🧑‍🏫', 'Teacher training', 'A 200-hour course for future teachers.']],
    menu: [['Drop-in class', '18'], ['10-class pass', '150'], ['Unlimited monthly', '120'], ['Private session', '75']], cta: 'Try a class', about: 'Our studio is a quiet space to slow down. Every class offers options, so it works for you whether it’s your first time or your thousandth.' },
  { kind: 'plant shop', names: ['Leaf & Root', 'The Green Room', 'Sprout House', 'Fern & Co.'], tagline: ['Bring nature home.', 'Plants that make you happy.', 'Houseplants, pots and friendly advice.'],
    items: [['🪴', 'Houseplants', 'Easy-care favourites and rare finds.'], ['🌵', 'Succulents', 'Tiny plants that need almost no water.'], ['🏺', 'Pots & planters', 'Handmade ceramics in every size.'], ['🩺', 'Plant doctor', 'Bring in a sad plant and we’ll help it recover.']],
    menu: [['Monstera', '35'], ['Snake plant', '28'], ['Succulent trio', '18'], ['Ceramic pot', 'from 15']], cta: 'Shop plants', about: 'We started as a market stall and grew (like our plants). Every plant comes with care instructions and a promise of free advice.' },
  { kind: 'tutoring service', names: ['Bright Minds Tutoring', 'Study Buddy', 'Next Level Learning', 'A+ Tutors'], tagline: ['Confidence in every subject.', 'Tutoring that makes it click.', 'Helping students do their best.'],
    items: [['➗', 'Maths', 'From times tables to calculus.'], ['🔬', 'Science', 'Biology, chemistry and physics made clear.'], ['✍️', 'Writing', 'Essays, grammar and creative writing.'], ['📝', 'Test prep', 'Practice and strategies for exams.']],
    menu: [['One-hour session', '45'], ['Package of 10', '400'], ['Group class', '20'], ['Free first lesson', '0']], cta: 'Book a free lesson', about: 'Our tutors are teachers and graduates who love helping students understand, not just memorise.' },
  { kind: 'band', names: ['The Midnight Owls', 'Static Bloom', 'Paper Planes', 'Neon Coast'], tagline: ['New album out now.', 'Indie rock from the heart.', 'Catch us on tour this summer.'],
    items: [['🎵', 'Music', 'Stream our new album everywhere.'], ['🎤', 'Tour', 'Dates across the country this summer.'], ['👕', 'Merch', 'Shirts, vinyl and posters.'], ['📰', 'News', 'Behind the scenes from the studio.']],
    menu: [['Vinyl LP', '28'], ['Tour T-shirt', '25'], ['Poster', '15'], ['Concert ticket', 'from 30']], cta: 'Listen now', about: 'We’re four friends who started playing in a garage and never stopped. Our new album was recorded live in one room.' },
  { kind: 'travel agency', names: ['Wanderlust Travel', 'Horizon Trips', 'Compass Journeys', 'Blue Sky Travel'], tagline: ['Your next adventure starts here.', 'Trips planned around you.', 'See the world, stress-free.'],
    items: [['✈️', 'Flights & hotels', 'The best routes and stays for your budget.'], ['🏝️', 'Beach escapes', 'Sun, sand and total relaxation.'], ['🏔️', 'Adventure trips', 'Hiking, safaris and road trips.'], ['🧳', 'Custom plans', 'A trip designed just for you.']],
    menu: [['Weekend city break', 'from 399'], ['Beach week', 'from 1,199'], ['Safari adventure', 'from 2,899'], ['Custom planning', 'free']], cta: 'Plan my trip', about: 'We’ve been planning trips for over a decade. We handle the details so you can enjoy the journey.' },
  { kind: 'app landing page', names: ['TaskFlow', 'Pocketbudget', 'FocusTimer', 'Habitly', 'Notely'], tagline: ['The simplest way to get things done.', 'Take control of your money.', 'Build better habits, one day at a time.'],
    items: [['⚡', 'Fast', 'Opens instantly and works offline.'], ['🔒', 'Private', 'Your data stays on your device.'], ['🔄', 'Syncs everywhere', 'Phone, tablet and computer, always up to date.'], ['🎨', 'Beautiful', 'A clean design you’ll enjoy using.']],
    menu: [['Free', '0'], ['Pro', '4.99/month'], ['Team', '9.99/user'], ['Lifetime', '79']], cta: 'Download free', about: 'We built this app because we wanted something simple that just works. Thousands of people now use it every day.' },
  { kind: 'wedding', names: ['Emma & Noah', 'Sofia & Liam', 'Ava & Mateo', 'Olivia & James'], tagline: ['We’re getting married!', 'Join us for our big day.', 'Save the date.'],
    items: [['💒', 'Ceremony', '3 PM at the garden chapel.'], ['🥂', 'Reception', 'Dinner and dancing from 6 PM.'], ['🏨', 'Where to stay', 'Rooms held at the nearby hotel.'], ['🎁', 'Registry', 'Your presence is the best present!']],
    menu: [['Ceremony', '3:00 PM'], ['Cocktails', '5:00 PM'], ['Dinner', '6:30 PM'], ['Dancing', '8:00 PM']], cta: 'RSVP', about: 'We met at university and have been inseparable ever since. We can’t wait to celebrate with the people we love most.' },
  { kind: 'charity', names: ['Clean Water Now', 'Books for Kids', 'Green Streets', 'Meals on Wheels'], tagline: ['Small donations, big change.', 'Together we can make a difference.', 'Helping our community thrive.'],
    items: [['🤝', 'Volunteer', 'Give your time and meet great people.'], ['💚', 'Donate', 'Every dollar goes straight to our work.'], ['📣', 'Spread the word', 'Share our mission with your friends.'], ['📊', 'Our impact', 'See what your support has achieved.']],
    menu: [['Provides a meal', '5'], ['Buys a book', '10'], ['Plants a tree', '25'], ['Sponsors a month', '100']], cta: 'Donate now', about: 'We’re a small team with a big goal. Since we started, volunteers like you have helped thousands of people.' },
  { kind: 'bike shop', names: ['Spoke & Chain', 'Two Wheels', 'Pedal Power', 'Gear Up Cycles'], tagline: ['Ride more, worry less.', 'Bikes, repairs and good advice.', 'Your local bike experts.'],
    items: [['🚲', 'New bikes', 'City, road and mountain bikes for every rider.'], ['🔧', 'Repairs', 'Quick tune-ups and full services.'], ['🛡️', 'Gear', 'Helmets, lights and locks.'], ['🗺️', 'Group rides', 'Free rides every Saturday morning.']],
    menu: [['Basic tune-up', '60'], ['Full service', '150'], ['Flat tyre fix', '15'], ['Bike rental (day)', '35']], cta: 'Book a repair', about: 'We’re riders ourselves, and we treat every bike like our own. Most repairs are done the same day.' },
];

const PALETTES = [
  { name: 'blue', primary: '#2563eb', dark: '#1e40af', soft: '#eff6ff' },
  { name: 'green', primary: '#16a34a', dark: '#166534', soft: '#f0fdf4' },
  { name: 'purple', primary: '#7c3aed', dark: '#5b21b6', soft: '#f5f3ff' },
  { name: 'orange', primary: '#ea580c', dark: '#9a3412', soft: '#fff7ed' },
  { name: 'red', primary: '#dc2626', dark: '#991b1b', soft: '#fef2f2' },
  { name: 'pink', primary: '#db2777', dark: '#9d174d', soft: '#fdf2f8' },
  { name: 'teal', primary: '#0d9488', dark: '#115e59', soft: '#f0fdfa' },
  { name: 'brown', primary: '#92400e', dark: '#78350f', soft: '#fdf8f3' },
  { name: 'black', primary: '#111827', dark: '#000000', soft: '#f3f4f6' },
  { name: 'yellow', primary: '#ca8a04', dark: '#854d0e', soft: '#fefce8' },
];

const FONTS = [
  { name: 'modern', stack: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { name: 'classic', stack: "Georgia, 'Times New Roman', serif" },
  { name: 'rounded', stack: "'Trebuchet MS', 'Helvetica Neue', sans-serif" },
];

const SECTIONS = ['features', 'about', 'menu', 'testimonials', 'contact'];

const FIRST = ['Sarah', 'Tom', 'Aisha', 'Ben', 'Carmen', 'David', 'Elena', 'Kenji', 'Lucy', 'Marco', 'Nina', 'Omar'];
const QUOTES = ['Absolutely wonderful — I recommend them to everyone.', 'Friendly people and fantastic quality.', 'The best in town, hands down.', 'I keep coming back. Never disappointed!', 'They went above and beyond for us.', 'Five stars. Exactly what I was looking for.'];

// --- building the page ----------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function menuTitle(kind) {
  if (/portfolio/.test(kind)) return 'Projects';
  if (/wedding/.test(kind)) return 'Schedule';
  if (/charity/.test(kind)) return 'What your gift does';
  if (/restaurant|coffee|bakery/.test(kind)) return 'Menu';
  return 'Prices';
}

function priceText(kind, p) {
  if (/portfolio|wedding/.test(kind) || !/^\d|^from \d/.test(p)) return p;
  return p.startsWith('from ') ? `from $${p.slice(5)}` : `$${p}`;
}

// Builds one website from a spec: { profile, name, palette, font, dark,
// sections, heroStyle, rounded }.
function buildSite(spec) {
  const { profile: pr, name, palette: pal, font, dark, sections, heroStyle, rounded } = spec;
  const r = rounded ? '14px' : '4px';
  const bg = dark ? '#0f172a' : '#ffffff';
  const text = dark ? '#e2e8f0' : '#1f2937';
  const muted = dark ? '#94a3b8' : '#6b7280';
  const card = dark ? '#1e293b' : '#ffffff';
  const soft = dark ? '#111c33' : pal.soft;
  const tagline = spec.tagline;
  const navLinks = sections.filter((s) => s !== 'features').map((s) => (s === 'menu' ? ['menu', menuTitle(pr.kind)] : [s, s.charAt(0).toUpperCase() + s.slice(1)]));
  const items = spec.items;

  const css = `    :root {
      --primary: ${pal.primary};
      --primary-dark: ${pal.dark};
      --bg: ${bg};
      --soft: ${soft};
      --card: ${card};
      --text: ${text};
      --muted: ${muted};
      --radius: ${r};
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body { font-family: ${font.stack}; color: var(--text); background: var(--bg); line-height: 1.6; }
    a { color: inherit; text-decoration: none; }
    .container { width: 90%; max-width: 1100px; margin: 0 auto; }
    header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid ${dark ? '#1e293b' : '#e5e7eb'}; z-index: 10; }
    nav { display: flex; align-items: center; justify-content: space-between; height: 64px; }
    .logo { font-weight: 800; font-size: 1.3rem; color: var(--primary); }
    .links { display: flex; gap: 24px; list-style: none; }
    .links a:hover { color: var(--primary); }
    .menu-button { display: none; background: none; border: none; font-size: 1.6rem; color: var(--text); cursor: pointer; }
    .btn { display: inline-block; background: var(--primary); color: white; padding: 12px 24px; border-radius: var(--radius); font-weight: 600; }
    .btn:hover { background: var(--primary-dark); }
    .hero { padding: 96px 0; background: var(--soft); }
${heroStyle === 'split'
    ? `    .hero .container { display: grid; grid-template-columns: 1.2fr 1fr; gap: 40px; align-items: center; }
    .hero-art { font-size: 8rem; text-align: center; }`
    : '    .hero { text-align: center; }'}
    .hero h1 { font-size: 3rem; line-height: 1.1; margin-bottom: 16px; }
    .hero p { font-size: 1.2rem; color: var(--muted); margin-bottom: 28px; }
    section { padding: 72px 0; }
    h2 { font-size: 2rem; margin-bottom: 32px; text-align: center; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 24px; }
    .card { background: var(--card); padding: 28px; border-radius: var(--radius); ${dark ? 'border: 1px solid #334155;' : 'box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);'} }
    .card .icon { font-size: 2rem; margin-bottom: 12px; }
    .card h3 { margin-bottom: 8px; }
    .card p { color: var(--muted); }
${sections.includes('about') ? '    .about p { max-width: 700px; margin: 0 auto; text-align: center; font-size: 1.1rem; color: var(--muted); }\n' : ''}${sections.includes('menu') ? `    .menu-list { max-width: 600px; margin: 0 auto; list-style: none; }
    .menu-list li { display: flex; justify-content: space-between; padding: 14px 0; border-bottom: 1px dashed ${dark ? '#334155' : '#d1d5db'}; }
    .menu-list .price { font-weight: 700; color: var(--primary); }
` : ''}${sections.includes('testimonials') ? `    .quote { font-style: italic; }
    .quote cite { display: block; margin-top: 12px; font-style: normal; font-weight: 600; color: var(--text); }
` : ''}${sections.includes('contact') ? `    .contact { background: var(--soft); }
    form { max-width: 520px; margin: 0 auto; display: grid; gap: 12px; }
    input, textarea { width: 100%; padding: 12px; font: inherit; border: 1px solid ${dark ? '#334155' : '#d1d5db'}; border-radius: var(--radius); background: var(--card); color: var(--text); }
    form button { border: none; cursor: pointer; font: inherit; }
    .thanks { text-align: center; color: var(--primary); font-weight: 600; }
` : ''}    footer { padding: 32px 0; text-align: center; color: var(--muted); font-size: 0.9rem; }
    @media (max-width: 720px) {
      .menu-button { display: block; }
      .links { display: none; position: absolute; top: 64px; left: 0; right: 0; flex-direction: column; gap: 0; background: var(--bg); border-bottom: 1px solid ${dark ? '#1e293b' : '#e5e7eb'}; }
      .links.open { display: flex; }
      .links a { display: block; padding: 14px 5%; }
      .hero h1 { font-size: 2.2rem; }
${heroStyle === 'split' ? '      .hero .container { grid-template-columns: 1fr; }\n      .hero-art { font-size: 5rem; }\n' : ''}    }`;

  const hero = heroStyle === 'split'
    ? `    <section class="hero">
      <div class="container">
        <div>
          <h1>${esc(name)}</h1>
          <p>${esc(tagline)}</p>
          <a class="btn" href="#${sections.includes('contact') ? 'contact' : sections[0]}">${esc(pr.cta)}</a>
        </div>
        <div class="hero-art">${items[0][0]}</div>
      </div>
    </section>`
    : `    <section class="hero">
      <div class="container">
        <h1>${esc(name)}</h1>
        <p>${esc(tagline)}</p>
        <a class="btn" href="#${sections.includes('contact') ? 'contact' : sections[0]}">${esc(pr.cta)}</a>
      </div>
    </section>`;

  const parts = [];
  for (const s of sections) {
    if (s === 'features') {
      parts.push(`    <section id="features">
      <div class="container">
        <h2>${/portfolio/.test(pr.kind) ? 'What I do' : /wedding/.test(pr.kind) ? 'The day' : 'What we offer'}</h2>
        <div class="grid">
${items.map(([icon, title, desc]) => `          <div class="card">
            <div class="icon">${icon}</div>
            <h3>${esc(title)}</h3>
            <p>${esc(desc)}</p>
          </div>`).join('\n')}
        </div>
      </div>
    </section>`);
    } else if (s === 'about') {
      parts.push(`    <section id="about" class="about">
      <div class="container">
        <h2>${/portfolio|photographer/.test(pr.kind) ? 'About me' : /wedding/.test(pr.kind) ? 'Our story' : 'About us'}</h2>
        <p>${esc(pr.about)}</p>
      </div>
    </section>`);
    } else if (s === 'menu') {
      parts.push(`    <section id="menu">
      <div class="container">
        <h2>${menuTitle(pr.kind)}</h2>
        <ul class="menu-list">
${pr.menu.map(([item, price]) => `          <li><span>${esc(item)}</span><span class="price">${esc(priceText(pr.kind, price))}</span></li>`).join('\n')}
        </ul>
      </div>
    </section>`);
    } else if (s === 'testimonials') {
      parts.push(`    <section id="testimonials">
      <div class="container">
        <h2>What people say</h2>
        <div class="grid">
${spec.quotes.map(([q, who]) => `          <div class="card quote">
            <p>“${esc(q)}”</p>
            <cite>— ${esc(who)}</cite>
          </div>`).join('\n')}
        </div>
      </div>
    </section>`);
    } else if (s === 'contact') {
      parts.push(`    <section id="contact" class="contact">
      <div class="container">
        <h2>${/wedding/.test(pr.kind) ? 'RSVP' : 'Get in touch'}</h2>
        <form id="contact-form">
          <input name="name" placeholder="Your name" required>
          <input name="email" type="email" placeholder="Your email" required>
          <textarea name="message" rows="5" placeholder="${/wedding/.test(pr.kind) ? 'Will you join us? Any dietary needs?' : 'Your message'}" required></textarea>
          <button class="btn" type="submit">Send</button>
          <p class="thanks" id="thanks" hidden>Thanks! We’ll get back to you soon.</p>
        </form>
      </div>
    </section>`);
    }
  }

  const js = `    const menuButton = document.querySelector('.menu-button');
    const links = document.querySelector('.links');
    menuButton.addEventListener('click', () => links.classList.toggle('open'));
    links.addEventListener('click', () => links.classList.remove('open'));
${sections.includes('contact') ? `
    const form = document.getElementById('contact-form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      form.reset();
      document.getElementById('thanks').hidden = false;
    });
` : ''}
    document.getElementById('year').textContent = new Date().getFullYear();`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(name)}</title>
  <style>
${css}
  </style>
</head>
<body>
  <header>
    <nav class="container">
      <a class="logo" href="#">${esc(name)}</a>
      <button class="menu-button" aria-label="Menu">☰</button>
      <ul class="links">
${navLinks.map(([id, label]) => `        <li><a href="#${id}">${esc(label)}</a></li>`).join('\n')}
      </ul>
    </nav>
  </header>
  <main>
${hero}
${parts.join('\n')}
  </main>
  <footer>
    <p>© <span id="year"></span> ${esc(name)}. All rights reserved.</p>
  </footer>
  <script>
${js}
  </script>
</body>
</html>`;
}

// --- requests -----------------------------------------------------------------------

const REQUESTS = [
  (d) => `make a website for my ${d.kind}${d.named}`,
  (d) => `build a website for ${d.a}${d.named}`,
  (d) => `can you make me a website for my ${d.kind}${d.named}?`,
  (d) => `i need a website for my ${d.kind}${d.named}`,
  (d) => `code a landing page for ${d.a}${d.named}`,
  (d) => `write the html and css for ${d.a} website${d.named}`,
  (d) => `create a simple website for ${d.a}${d.named}`,
  (d) => `make ${d.a} website${d.named}`,
];

// One conversation: a request and a complete site that matches it.
function siteConversation(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const pr = pick(KINDS);
  const name = pick(pr.names);
  const palette = pick(PALETTES);
  const font = pick(FONTS);
  const dark = rand() < 0.25;
  const heroStyle = rand() < 0.5 ? 'split' : 'center';
  const rounded = rand() < 0.7;
  // Sections: features always; others at random, in a natural order.
  const asked = [];
  let sections = ['features', ...SECTIONS.slice(1).filter(() => rand() < 0.45)];
  if (rand() < 0.3) {
    const extra = pick(SECTIONS.slice(1));
    if (!sections.includes(extra)) sections.push(extra);
    asked.push(extra);
  }
  sections = SECTIONS.filter((s) => sections.includes(s));
  const items = [...pr.items].sort(() => rand() - 0.5).slice(0, 3);
  const quotes = [...QUOTES].sort(() => rand() - 0.5).slice(0, 2).map((q, i) => [q, `${FIRST[Math.floor(rand() * FIRST.length)]} ${String.fromCharCode(65 + ((i * 7 + name.length) % 26))}.`]);
  const tagline = pick(pr.tagline);

  // The request, mentioning whatever the page must honour.
  const bits = [];
  const an = (w) => (/^[aeiou]/.test(w) ? `an ${w}` : `a ${w}`);
  const colourAsked = rand() < 0.4;
  if (colourAsked) bits.push(pick([`in ${palette.name}`, `with ${an(palette.name)} colour scheme`, `make it ${palette.name}`, `use ${palette.name} as the main colour`]));
  if (dark) bits.push(pick(['dark theme', 'with a dark background', 'in dark mode']));
  for (const a of asked) {
    const label = a === 'menu' ? menuTitle(pr.kind).toLowerCase() : a;
    bits.push(pick([`with ${an(label)} section`, `include ${an(label)} ${a === 'menu' ? 'list' : 'section'}`]));
  }
  if (sections.includes('contact') && rand() < 0.3 && !asked.includes('contact')) bits.push('and a contact form');
  const named = rand() < 0.7 ? ` called ${name}` : '';
  let request = pick(REQUESTS)({ kind: pr.kind, a: an(pr.kind), named });
  if (bits.length) request += `, ${bits.join(', ')}`;

  const html = buildSite({ profile: pr, name, palette, font, dark, sections, heroStyle, rounded, items, quotes, tagline });
  const sectionNames = sections.map((s) => (s === 'menu' ? menuTitle(pr.kind).toLowerCase() : s)).join(', ');
  const intro = pick([
    `Here’s a complete website for ${name}. Save it as \`index.html\` and open it in your browser.`,
    `Here you go — a one-file website for ${name}. Save it as \`index.html\` and double-click it to open.`,
    `Sure! This is a full, responsive site for ${name} in a single file (\`index.html\`).`,
  ]);
  const notes = [
    `It has a sticky header, a hero with a “${pr.cta}” button, and sections for ${sectionNames}.`,
    `Colours are CSS variables at the top of the \`<style>\` (\`--primary\` is ${palette.name}), so you can restyle everything by changing a few lines.`,
    'On phones the links fold into a ☰ menu' + (sections.includes('contact') ? ', and the contact form shows a thank-you message (connect it to a service like Formspree to actually receive messages).' : '.'),
  ];
  return {
    request,
    reply: `${intro}\n\n\`\`\`html\n${html}\n\`\`\`\n\n${notes.join(' ')}`,
    html,
    spec: { kind: pr.kind, name, palette: palette.name, dark, sections },
  };
}

module.exports = { siteConversation, buildSite, KINDS, PALETTES };

if (require.main === module) {
  let s = 7;
  const rand = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const { validateHtml } = require('./validate');
  let bad = 0;
  for (let i = 0; i < 500; i++) {
    const c = siteConversation(rand);
    const problem = validateHtml(c.html);
    if (problem) { bad++; if (bad < 5) console.log('✗', c.request, problem); }
  }
  console.log(`500 sites generated, ${bad} invalid`);
  const one = siteConversation(rand);
  require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'mx2-sample-site.html'), one.html);
  console.log('sample request:', one.request);
  console.log('sample size:', one.html.length, 'chars');
}
