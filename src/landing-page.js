// The public website, served at GET / by this same Render service. One
// self-contained HTML document: no framework, no JavaScript, no external
// fonts or trackers, so it loads in a single request and nothing about a visitor is
// sent to a third party.
//
// Every claim on this page has to stay true to how Nosh actually works and
// to the privacy policy (src/privacy-policy.js) - if either changes, update
// the copy here too. Prices in the example chat are illustrative and are
// labelled as such; Nosh must never present made-up Swiggy data as real.

const DEFAULT_GREETING = "Hi Nosh";

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

// whatsappNumber: digits only, with country code (the wa.me format).
export function buildLandingPageHtml({ whatsappNumber, year = new Date().getFullYear() }) {
  const chatUrl = escapeHtml(`https://wa.me/${whatsappNumber}?text=${encodeURIComponent(DEFAULT_GREETING)}`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nosh - Order food by chatting on WhatsApp</title>
<meta name="description" content="Tell Nosh what you feel like eating. It finds it on Swiggy, builds your cart and places the order, right inside WhatsApp.">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#061a15" media="(prefers-color-scheme: dark)">
<meta property="og:title" content="Nosh - Food, ordered in a chat">
<meta property="og:description" content="Order from Swiggy by chatting on WhatsApp. No app to install.">
<meta property="og:type" content="website">
<link rel="icon" type="image/png" href="/nosh-mark.png">
<link rel="apple-touch-icon" href="/nosh-mark.png">
<style>
  /* Brand colours sampled from the Nosh logo: deep green and lime. The chat
     mock-up uses WhatsApp's own chat colours (--wa-*). */
  :root {
    --brand: #0b3028;
    --lime: #caf743;
    --bg: #ffffff;
    --bg-alt: #f4f6f1;
    --card: #ffffff;
    --text: #0b3028;
    --muted: #5d6f69;
    --line: rgba(11, 48, 40, 0.1);
    --accent: #0b3028;
    --accent-text: #ffffff;
    --accent-hover: #124538;
    --link: #17705a;
    --nav: rgba(255, 255, 255, 0.72);
    --badge-bg: #0b3028;
    --badge-text: #caf743;
    --dark-bg: #0b3028;
    --dark-text: #f4f6f1;
    --dark-muted: #a9bdb5;
    --dark-card: #123c32;
    --shadow: 0 20px 60px rgba(11, 48, 40, 0.16);
    --wa-chat: #efeae2;
    --wa-bar: #f0f2f5;
    --wa-in: #ffffff;
    --wa-out: #d9fdd3;
    --wa-text: #111b21;
    --wa-meta: #667781;
    --wa-action: #008069;
    --wa-tick: #53bdeb;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #061a15;
      --bg-alt: #0a251f;
      --card: #0f3229;
      --text: #f4f6f1;
      --muted: #a9bdb5;
      --line: rgba(244, 246, 241, 0.12);
      --accent: #caf743;
      --accent-text: #0b3028;
      --accent-hover: #d6fa6b;
      --link: #caf743;
      --nav: rgba(6, 26, 21, 0.72);
      --badge-bg: #caf743;
      --badge-text: #0b3028;
      --dark-bg: #0b3028;
      --dark-card: #123c32;
      --shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      --wa-chat: #0b141a;
      --wa-bar: #202c33;
      --wa-in: #202c33;
      --wa-out: #005c4b;
      --wa-text: #e9edef;
      --wa-meta: #8696a0;
      --wa-action: #53bdeb;
    }
  }

  *, *::before, *::after { box-sizing: border-box; }

  html { scroll-behavior: smooth; scroll-padding-top: 64px; -webkit-text-size-adjust: 100%; }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 17px;
    line-height: 1.47;
    letter-spacing: -0.022em;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible, .button:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; border-radius: 8px; }

  .wrap { width: min(1040px, 100% - 44px); margin-inline: auto; }

  /* Navigation */
  .nav {
    position: sticky; top: 0; z-index: 10;
    background: var(--nav);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    backdrop-filter: saturate(180%) blur(20px);
    border-bottom: 1px solid var(--line);
  }
  .nav .wrap { display: flex; align-items: center; justify-content: space-between; height: 52px; }
  .brand { display: inline-flex; align-items: center; gap: 9px; font-family: ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; color: var(--text); }
  .brand img { width: 28px; height: 28px; border-radius: 22%; display: block; }
  .brand:hover { text-decoration: none; }
  .nav-links { display: flex; align-items: center; gap: 28px; font-size: 12px; letter-spacing: -0.01em; }
  .nav-links a { color: var(--text); opacity: 0.8; }
  .nav-links a:hover { opacity: 1; text-decoration: none; }
  @media (max-width: 640px) { .nav-links a:not(.button) { display: none; } }

  /* Buttons */
  .button {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--accent); color: var(--accent-text);
    padding: 12px 22px; border-radius: 980px;
    font-size: 17px; font-weight: 400; letter-spacing: -0.022em;
    transition: background 0.2s ease, transform 0.2s ease;
  }
  .button:hover { background: var(--accent-hover); text-decoration: none; }
  .button:active { transform: scale(0.98); }
  .button.small { padding: 6px 14px; font-size: 12px; opacity: 1; color: var(--accent-text); }
  .button svg { width: 18px; height: 18px; fill: currentColor; flex: none; }
  .text-link { font-size: 19px; }
  .text-link::after { content: " \\203A"; }

  /* Type */
  h1, h2, h3 { margin: 0; font-weight: 600; }
  h1 { font-size: clamp(44px, 8vw, 88px); line-height: 1.04; letter-spacing: -0.035em; }
  h2 { font-size: clamp(32px, 5.4vw, 56px); line-height: 1.07; letter-spacing: -0.03em; }
  h3 { font-size: 24px; line-height: 1.17; letter-spacing: -0.02em; }
  .eyebrow { font-size: 19px; font-weight: 600; color: var(--muted); margin: 0 0 10px; letter-spacing: -0.02em; }
  .lead { font-size: clamp(19px, 2.3vw, 24px); line-height: 1.38; color: var(--muted); max-width: 640px; margin: 20px auto 0; letter-spacing: -0.015em; }
  p { margin: 0; }

  section { padding: clamp(72px, 11vw, 136px) 0; }
  .center { text-align: center; }
  .alt { background: var(--bg-alt); }

  /* Hero */
  .hero { padding-top: clamp(64px, 9vw, 112px); padding-bottom: 0; text-align: center; overflow: hidden; }
  .hero-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 18px 28px; margin-top: 32px; }

  /* Phone: a WhatsApp chat, in WhatsApp's colours */
  .phone {
    width: min(390px, 100%); margin: clamp(48px, 7vw, 80px) auto 0;
    background: var(--wa-chat); color: var(--wa-text);
    border: 8px solid var(--brand); border-bottom: 0;
    border-radius: 46px 46px 0 0; overflow: hidden;
    box-shadow: var(--shadow); text-align: left;
  }
  .phone-bar { display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px; background: var(--wa-bar); }
  .avatar { width: 36px; height: 36px; border-radius: 50%; display: block; object-fit: cover; }
  .phone-name { font-size: 16px; font-weight: 600; line-height: 1.2; }
  .phone-status { font-size: 12px; color: var(--wa-meta); }
  .chat { display: flex; flex-direction: column; gap: 6px; padding: 16px 12px 6px; font-size: 14.5px; line-height: 1.35; letter-spacing: -0.005em; }
  .msg { position: relative; max-width: 82%; padding: 7px 10px 8px; border-radius: 9px; box-shadow: 0 1px 0.5px rgba(11, 20, 26, 0.13); }
  .msg.in { background: var(--wa-in); align-self: flex-start; border-top-left-radius: 0; }
  .msg.out { background: var(--wa-out); align-self: flex-end; border-top-right-radius: 0; }
  .meta { float: right; margin: 6px 0 -3px 12px; font-size: 11px; color: var(--wa-meta); white-space: nowrap; }
  .meta .ticks { color: var(--wa-tick); margin-left: 3px; letter-spacing: -0.2em; }
  .replies { display: flex; flex-direction: column; gap: 3px; width: 82%; align-self: flex-start; margin-top: -3px; }
  .reply { background: var(--wa-in); color: var(--wa-action); text-align: center; padding: 9px 10px; border-radius: 9px; font-size: 14.5px; box-shadow: 0 1px 0.5px rgba(11, 20, 26, 0.13); }
  .caption { font-size: 12px; color: var(--wa-meta); text-align: center; padding: 14px 18px 30px; }

  /* Steps */
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 56px; counter-reset: step; }
  .step { background: var(--card); border-radius: 28px; padding: 32px 28px; counter-increment: step; }
  .step::before { content: counter(step); display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--badge-bg); color: var(--badge-text); font-weight: 700; margin-bottom: 20px; }
  .step p, .card p { color: var(--muted); margin-top: 10px; }

  /* Feature grid */
  .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 20px; margin-top: 56px; }
  .card { background: var(--bg-alt); border-radius: 28px; padding: 36px 32px; grid-column: span 2; }
  .card.wide { grid-column: span 4; }
  .card.half { grid-column: span 3; }
  .card .big { font-size: clamp(28px, 3.6vw, 40px); line-height: 1.1; font-weight: 600; letter-spacing: -0.03em; }
  .langs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
  .lang { background: var(--card); border-radius: 980px; padding: 7px 14px; font-size: 15px; }

  /* Ease */
  .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 56px; }
  .fact .num { color: var(--link); font-size: clamp(56px, 9vw, 96px); font-weight: 600; letter-spacing: -0.04em; line-height: 1; }
  .fact p { color: var(--muted); margin-top: 12px; font-size: 19px; }

  /* Dark sections */
  .dark { background: var(--dark-bg); color: var(--dark-text); }
  .dark .eyebrow, .dark .lead { color: var(--dark-muted); }
  .dark a { color: var(--lime); }
  .dark h2 em, h1 em, h2 em { font-style: normal; }
  .dark h2 em { color: var(--lime); }
  .list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-top: 56px; text-align: left; }
  .item { background: var(--dark-card); border-radius: 28px; padding: 32px 28px; }
  .item p { color: var(--dark-muted); margin-top: 10px; }
  .light .item { background: var(--card); }
  .light .item p { color: var(--muted); }
  .after { margin-top: 44px; }

  /* Footer */
  footer { background: var(--bg-alt); color: var(--muted); font-size: 12px; line-height: 1.5; letter-spacing: -0.01em; padding: 28px 0 40px; }
  footer p + p { margin-top: 8px; }
  .foot-row { display: flex; flex-wrap: wrap; gap: 8px 24px; justify-content: space-between; border-top: 1px solid var(--line); margin-top: 18px; padding-top: 16px; }
  .foot-links { display: flex; flex-wrap: wrap; gap: 8px 22px; }
  footer a { color: var(--text); opacity: 0.85; }

  @media (max-width: 820px) {
    .steps, .facts, .list { grid-template-columns: 1fr; }
    .card, .card.wide, .card.half { grid-column: span 6; }
  }

  /* Scroll reveal, in CSS only. Content is visible by default; browsers
     that support scroll-driven animations fade each block in as it enters
     the screen. No script, so nothing can leave a section hidden. */
  @keyframes rise { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: none; } }
  @supports (animation-timeline: view()) {
    @media (prefers-reduced-motion: no-preference) {
      .reveal { animation: rise linear both; animation-timeline: view(); animation-range: entry 0% entry 90%; }
    }
  }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
</style>
</head>
<body>

<header class="nav">
  <div class="wrap">
    <a class="brand" href="#top" aria-label="Nosh home"><img src="/nosh-mark.png" alt="" width="28" height="28">nosh</a>
    <nav class="nav-links" aria-label="Sections">
      <a href="#features">Features</a>
      <a href="#ease">Ease of use</a>
      <a href="#privacy">Privacy</a>
      <a href="#security">Security</a>
      <a class="button small" href="${chatUrl}" target="_blank" rel="noopener">Order now</a>
    </nav>
  </div>
</header>

<main id="top">

<section class="hero">
  <div class="wrap">
    <h1>Food, ordered<br>in a chat.</h1>
    <p class="lead">Tell Nosh what you feel like. It finds it on Swiggy, builds your cart and places the order, right inside WhatsApp.</p>
    <div class="hero-actions">
      <a class="button" href="${chatUrl}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3C6.5 3 2 6.9 2 11.800c0 2.400 1.100 4.600 2.900 6.200L4 21.500l4.300-1.700c1.200.4 2.400.6 3.700.6 5.500 0 10-3.900 10-8.600S17.500 3 12 3z"/></svg>
        Message Nosh on WhatsApp
      </a>
      <a class="text-link" href="#how">See how it works</a>
    </div>

    <div class="phone" role="img" aria-label="Example WhatsApp conversation with Nosh: a request for vegetarian food, a recommendation with buttons, and the item added to the cart.">
      <div class="phone-bar">
        <img class="avatar" src="/nosh-mark.png" alt="" width="36" height="36">
        <div>
          <div class="phone-name">Nosh</div>
          <div class="phone-status">online</div>
        </div>
      </div>
      <div class="chat">
        <div class="msg out">Kuch tasty veg khana hai<span class="meta">8:41 pm<span class="ticks">✓✓</span></span></div>
        <div class="msg in">Masala Dosa from Idli Dosa Corner. ₹149, ⭐ 4.5, 20–25 mins. Add kar doon?<span class="meta">8:41 pm</span></div>
        <div class="replies"><span class="reply">Add kar do</span><span class="reply">Kuch aur</span><span class="reply">Cuisine chuno</span></div>
        <div class="msg out">Add kar do<span class="meta">8:42 pm<span class="ticks">✓✓</span></span></div>
        <div class="msg in">Masala Dosa cart mein add ho gaya. Total ₹196.<span class="meta">8:42 pm</span></div>
        <div class="replies"><span class="reply">Checkout</span><span class="reply">Cart dekhein</span><span class="reply">Coupons</span></div>
      </div>
      <p class="caption">Example conversation. Real prices, ratings and delivery times come from Swiggy.</p>
    </div>
  </div>
</section>

<section id="how" class="alt center">
  <div class="wrap">
    <p class="eyebrow reveal">How it works</p>
    <h2 class="reveal">Three steps to dinner.</h2>
    <div class="steps">
      <div class="step reveal">
        <h3>Say hi.</h3>
        <p>Message Nosh on WhatsApp and connect your Swiggy account once, on Swiggy's own sign-in page.</p>
      </div>
      <div class="step reveal">
        <h3>Tap what you want.</h3>
        <p>Take a recommendation, browse a cuisine, or type any dish. Every reply comes with buttons.</p>
      </div>
      <div class="step reveal">
        <h3>Confirm. Done.</h3>
        <p>See the items and the final total, then confirm. Your order goes to Swiggy and arrives as usual.</p>
      </div>
    </div>
  </div>
</section>

<section id="features" class="center">
  <div class="wrap">
    <p class="eyebrow reveal">Features</p>
    <h2 class="reveal">Everything you need.<br>Nothing to learn.</h2>
    <div class="grid" style="text-align:left">
      <div class="card wide reveal">
        <p class="big">Tap, don't type.</p>
        <p>Addresses, dishes, coupons and checkout are all buttons. Typing is only for when you want something specific.</p>
      </div>
      <div class="card reveal">
        <h3>Speaks your language.</h3>
        <p>Write the way you talk. Nosh replies the same way.</p>
        <div class="langs"><span class="lang">English</span><span class="lang">हिन्दी</span><span class="lang">Hinglish</span><span class="lang">ਪੰਜਾਬੀ</span></div>
      </div>
      <div class="card reveal">
        <h3>Knows what you like.</h3>
        <p>Recommendations start from your own order history, and suggest something you haven't tried.</p>
      </div>
      <div class="card reveal">
        <h3>Veg means veg.</h3>
        <p>Ask for vegetarian and Nosh only suggests dishes Swiggy marks as veg.</p>
      </div>
      <div class="card reveal">
        <h3>Coupons, found for you.</h3>
        <p>Nosh looks for a coupon that works on your cart and applies it when you say yes.</p>
      </div>
      <div class="card half reveal">
        <h3>Your usual, again.</h3>
        <p>Reorder what you get most often without searching for it.</p>
      </div>
      <div class="card half reveal">
        <h3>Real prices. Always.</h3>
        <p>Every price, rating and delivery time comes straight from Swiggy. Nosh never guesses.</p>
      </div>
    </div>
  </div>
</section>

<section id="ease" class="alt center">
  <div class="wrap">
    <p class="eyebrow reveal">Ease of use</p>
    <h2 class="reveal">No app. No sign-up.<br>Just a chat you already have.</h2>
    <p class="lead reveal">If you can send a WhatsApp message, you can order with Nosh.</p>
    <div class="facts">
      <div class="fact reveal"><div class="num">0</div><p>apps to install</p></div>
      <div class="fact reveal"><div class="num">1</div><p>chat for everything</p></div>
      <div class="fact reveal"><div class="num">4</div><p>languages understood</p></div>
    </div>
  </div>
</section>

<section id="privacy" class="dark center">
  <div class="wrap">
    <p class="eyebrow reveal">Privacy</p>
    <h2 class="reveal">Your data is yours.<br><em>Nosh keeps it that way.</em></h2>
    <div class="list">
      <div class="item reveal">
        <h3>No passwords. Ever.</h3>
        <p>You sign in on Swiggy's own page. Nosh never sees or asks for your Swiggy password or OTP.</p>
      </div>
      <div class="item reveal">
        <h3>Used, not kept.</h3>
        <p>Your addresses, cart and orders are fetched from Swiggy for each request and are not stored by Nosh.</p>
      </div>
      <div class="item reveal">
        <h3>Never sold. Never used for ads.</h3>
        <p>Your data is not sold, not used for advertising or profiling, and not used to train AI models.</p>
      </div>
      <div class="item reveal">
        <h3>Deleted on a schedule.</h3>
        <p>Chat logs kept for troubleshooting are encrypted and deleted automatically 14 days after your last message.</p>
      </div>
    </div>
    <p class="after reveal"><a class="text-link" href="/privacy-policy">Read the Privacy Policy</a></p>
  </div>
</section>

<section id="security" class="alt center light">
  <div class="wrap">
    <p class="eyebrow reveal">Security</p>
    <h2 class="reveal">Nothing is ordered<br>until you say so.</h2>
    <div class="list">
      <div class="item reveal">
        <h3>You confirm every order.</h3>
        <p>Nosh shows the items and the final total first. An order is placed only after you reply YES, or tap twice to confirm.</p>
      </div>
      <div class="item reveal">
        <h3>The AI can't place orders.</h3>
        <p>The assistant suggests and searches. Placing an order is handled by separate code that only your confirmation can trigger.</p>
      </div>
      <div class="item reveal">
        <h3>Encrypted at rest.</h3>
        <p>Your Swiggy connection is stored with AES-256 encryption, under a scrambled version of your number.</p>
      </div>
      <div class="item reveal">
        <h3>No accidental repeats.</h3>
        <p>Old buttons expire, and a double tap places one order, not two.</p>
      </div>
    </div>
  </div>
</section>

<section class="center">
  <div class="wrap">
    <h2 class="reveal">Hungry? Say hi.</h2>
    <p class="lead reveal">Your next meal is one message away.</p>
    <div class="hero-actions reveal">
      <a class="button" href="${chatUrl}" target="_blank" rel="noopener">Message Nosh on WhatsApp</a>
    </div>
  </div>
</section>

</main>

<footer>
  <div class="wrap">
    <p>Nosh currently supports Cash on Delivery and orders up to ₹1,000. Restaurant availability, prices and delivery times are provided by Swiggy and depend on your address.</p>
    <p>Nosh is an independent service. Orders are placed through your own Swiggy account. Swiggy and WhatsApp are trademarks of their respective owners.</p>
    <div class="foot-row">
      <span>Copyright © ${year} Nosh Labs. All rights reserved.</span>
      <span class="foot-links">
        <a href="/privacy-policy">Privacy Policy</a>
        <a href="https://nosh.statuspage.io/" target="_blank" rel="noopener">System Status</a>
        <a href="mailto:noshdev@arysha.app">Contact</a>
      </span>
    </div>
  </div>
</footer>

</body>
</html>
`;
}
