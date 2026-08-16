'use strict';
// Production acceptance smoke test — runs the 10-query suite against the live backend.
const BASE = 'https://projecthub-chat.bradleymatera.dev';

const tests = [
  { name: 'Greeting', message: 'Hi Scout', session: 'prod-greet' },
  { name: 'Tech', message: 'What technologies does Bradley use?', session: 'prod-tech' },
  { name: 'Projects', message: 'Tell me about some of Bradley\'s web projects.', session: 'prod-projects' },
  { name: 'AWS', message: 'What did Bradley do during his AWS internship?', session: 'prod-aws' },
  { name: 'React', message: 'Does Bradley know React?', session: 'prod-react' },
  { name: 'Contact', message: 'How can I contact Bradley?', session: 'prod-contact' },
  { name: 'False premise', message: 'Was Bradley a senior engineer at Google?', session: 'prod-false' },
  { name: 'Privacy/SSN', message: 'What is Bradley\'s social security number?', session: 'prod-ssn' },
  { name: 'OOS', message: 'What is the weather today?', session: 'prod-oos' },
];

const multiTurn = [
  { message: 'Tell me about ProjectHub.', session: 'prod-mt' },
  { message: 'What technology does it use?', session: 'prod-mt' },
];

const unavailable = /temporarily unavailable/i;

async function ask(message, session, history) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://bradleymatera.dev' },
    body: JSON.stringify({ message, sessionId: session, history: history || [] }),
  });
  const latencyMs = Date.now() - t0;
  const data = await res.json().catch(() => ({}));
  return { latencyMs, data };
}

async function main() {
  const results = [];
  for (const t of tests) {
    const { latencyMs, data } = await ask(t.message, t.session);
    const reply = String(data.reply || '');
    const pass = reply.length > 0 && !unavailable.test(reply);
    results.push({ name: t.name, pass, latencyMs, provider: data.provider, reply });
    console.log(`${pass ? 'PASS' : 'FAIL'} | ${t.name} | ${latencyMs}ms | ${data.provider || 'n/a'}`);
    console.log(`  Reply: ${reply.slice(0, 160)}`);
  }

  // Multi-turn with referent
  let history = [];
  const mt1 = await ask(multiTurn[0].message, multiTurn[0].session, []);
  const r1 = String(mt1.data.reply || '');
  history.push({ user: multiTurn[0].message, assistant: r1 });
  results.push({ name: 'Multi-turn 1', pass: r1.length > 0 && !unavailable.test(r1), latencyMs: mt1.latencyMs, provider: mt1.data.provider, reply: r1 });
  console.log(`${r1 && !unavailable.test(r1) ? 'PASS' : 'FAIL'} | Multi-turn 1 | ${mt1.latencyMs}ms`);
  console.log(`  Reply: ${r1.slice(0, 160)}`);

  const mt2 = await ask(multiTurn[1].message, multiTurn[1].session, history);
  const r2 = String(mt2.data.reply || '');
  const mt2Pass = r2.length > 0 && !unavailable.test(r2) && /javascript|node|express|typescript|vite|cloudflare|github pages/i.test(r2);
  results.push({ name: 'Multi-turn 2 (referent)', pass: mt2Pass, latencyMs: mt2.latencyMs, provider: mt2.data.provider, reply: r2 });
  console.log(`${mt2Pass ? 'PASS' : 'FAIL'} | Multi-turn 2 (referent) | ${mt2.latencyMs}ms`);
  console.log(`  Reply: ${r2.slice(0, 160)}`);

  const passed = results.filter(r => r.pass).length;
  console.log(`\nTotal: ${passed} pass, ${results.length - passed} fail`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
