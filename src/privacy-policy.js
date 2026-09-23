// Served at GET /privacy-policy. This is the public policy required by
// Meta's WhatsApp Business Platform app review before the app can be
// published. Swiggy-originated data (orders, addresses, cart contents)
// obtained via Swiggy MCP must NOT be described as usable for training,
// profiling, or any secondary purpose without fresh, separate consent and a
// signed Data Processing Agreement - see the "No analytics, advertising, or
// model training" rule in the Swiggy Builders Club data-and-compliance docs.
// Do not add an AI-training clause to this page without re-checking that
// rule and confirming with Swiggy.
export const PRIVACY_POLICY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nosh Privacy Policy</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 2rem 1.25rem 4rem; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.6rem; }
  h2 { font-size: 1.15rem; margin-top: 2rem; }
  p, li { font-size: 0.97rem; }
  .updated { color: #555; font-size: 0.9rem; margin-bottom: 2rem; }
  a { color: #0b5fff; }
</style>
</head>
<body>
<h1>Nosh Privacy Policy</h1>
<p class="updated">Last updated: 23 September 2026</p>

<p>Nosh Labs ("Nosh", "we", "us") operates Nosh, a WhatsApp-based conversational
assistant that helps you search for restaurants, build a cart, and place
food orders on Swiggy. This policy explains what data we handle when you
message Nosh on WhatsApp and how we handle it.</p>

<h2>1. Data we collect</h2>
<ul>
  <li><strong>WhatsApp data.</strong> Your WhatsApp phone number and the text of
  messages you send to Nosh, received via the WhatsApp Business Platform.</li>
  <li><strong>Swiggy account data.</strong> Once you connect your Swiggy account
  (via Swiggy's own sign-in), Nosh can read information needed to act on your
  requests: saved addresses, restaurant and menu search results, your cart,
  and order status. This data comes from Swiggy and is subject to Swiggy's
  own privacy policy in addition to this one.</li>
</ul>

<h2>2. How we use data</h2>
<ul>
  <li>To understand what you're asking for and carry out the requests you
  make in the conversation - searching restaurants, updating your cart,
  applying coupons, and placing orders you explicitly confirm.</li>
  <li>Message text, and the Swiggy data needed to answer it, is sent to
  third-party AI services we use to interpret your requests, translate
  between languages, and write replies (see "Third parties" below).</li>
  <li><strong>Troubleshooting.</strong> We keep a short-lived, encrypted log
  of your messages to Nosh and Nosh's replies, so that if you report
  something went wrong, we can look at what actually happened in that
  conversation and fix it. This log is only ever reviewed to investigate a
  specific reported problem, not browsed or monitored routinely.</li>
  <li>We do not use your WhatsApp messages or your Swiggy account data to
  train AI models, for advertising, or for any purpose other than carrying
  out your request in the conversation or troubleshooting it, as described
  above.</li>
</ul>

<h2>3. Third parties we share data with</h2>
<ul>
  <li><strong>Meta / WhatsApp</strong> - to send and receive your messages, under
  the WhatsApp Business Platform.</li>
  <li><strong>Swiggy</strong> - to search restaurants, manage your cart, and place
  orders you request. Swiggy is the data fiduciary for your Swiggy account
  data; Nosh only accesses what's needed to act on your request, and Swiggy's
  own terms prohibit us from using that data for training, profiling, or any
  purpose beyond fulfilling it.</li>
  <li><strong>Alibaba Cloud (Qwen)</strong> - the AI model that interprets
  your request, decides what to look up on Swiggy, and writes Nosh's replies.
  To do that it receives the text of your messages and the Swiggy data
  needed for the current request, such as restaurant and menu results, your
  cart, and the labels of your saved addresses.</li>
  <li><strong>Sarvam AI</strong> - translates messages you write in Hindi or
  Hinglish into English for the model above, and translates Nosh's replies
  back into your language. It receives only the text being translated, which
  can include restaurant names, dishes, and prices from Nosh's replies.</li>
</ul>
<p>We do not sell your data, and we do not share it with any other third
party.</p>

<h2>4. Data retention</h2>
<ul>
  <li>Data obtained from Swiggy (addresses, cart contents, order details) is
  used only for the current request and is not stored by Nosh beyond what's
  needed to complete an in-progress conversation or order.</li>
  <li>We keep a Swiggy connection token so you don't have to reconnect your
  account every time you message us. You can disconnect your Swiggy account
  at any time through Swiggy; doing so removes Nosh's access to your Swiggy
  data.</li>
  <li>The troubleshooting log described above is kept for 14 days after your
  most recent message to Nosh, then automatically and permanently deleted.
  An active conversation's log is retained on a rolling basis (14 days from
  your last message, not your first) for as long as you keep messaging us.</li>
</ul>

<h2>5. Your rights</h2>
<p>For requests about your Swiggy account data (access, correction,
deletion), please contact Swiggy directly through the Swiggy app, since
Swiggy is the data fiduciary for that data. For anything related to your
conversation with Nosh on WhatsApp, or general questions about this policy,
contact us using the details below.</p>

<h2>6. Security</h2>
<p>Data in transit between Nosh, WhatsApp, Swiggy, and our AI processors is
encrypted. Access to stored connection tokens and the troubleshooting log
described above is limited to what Nosh's service needs to operate, and
both are encrypted at rest, with your phone number stored only in
irreversibly hashed form, never as plain text.</p>

<h2>7. Children's privacy</h2>
<p>Nosh is not directed at, and we do not knowingly collect data from,
children under 18.</p>

<h2>8. Changes to this policy</h2>
<p>We may update this policy from time to time. Material changes will be
reflected by updating the "Last updated" date above.</p>

<h2>9. Contact us</h2>
<p>For privacy questions, requests, or grievances related to Nosh, contact
us at <a href="mailto:noshdev@arysha.app">noshdev@arysha.app</a>.</p>

</body>
</html>
`;
