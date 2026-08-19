#!/usr/bin/env node
// break-it.js — quick adversarial checks you can run after changes.
// This does NOT start a server; it exercises the deterministic layers.
// To break the live backend, pass --url https://dev.projecthub-chat.bradleymatera.dev

const fs = require('fs');
const path = require('path');

let failed = 0;
function fail(msg) {
  console.error('❌ BROKEN:', msg);
  failed++;
}
function ok(msg) {
  console.log('✅', msg);
}

const repoRoot = path.resolve(__dirname, '..');
process.chdir(repoRoot);

const knowledge = require('../data/recruiter-knowledge.json');
const knowledgeAccess = require('../lib/knowledge-access');
const { buildConversationState, resolveReferent } = require('../lib/conversation-resolver');
const sessionState = require('../lib/session-state');

// 1. No hardcoded Ollama provider labels in final response objects
const liteAgent = fs.readFileSync(path.join(repoRoot, 'lib', 'lite-agent.js'), 'utf8');
const server = fs.readFileSync(path.join(repoRoot, 'server-gemini.js'), 'utf8');

if (/provider:\s*['"]ollama-lite['"]/.test(liteAgent)) fail('lib/lite-agent.js still has hardcoded provider: "ollama-lite"');
else ok('lib/lite-agent.js has no hardcoded "ollama-lite" provider labels');

if (/provider:\s*['"]ollama-recovery['"]/.test(server)) fail('server-gemini.js still has hardcoded provider: "ollama-recovery"');
else ok('server-gemini.js has no hardcoded "ollama-recovery" provider labels');

// 2. New direct answers are findable
const directCases = [
  { q: 'What school did Bradley attend?', needle: 'Full Sail University' },
  { q: 'What technologies does Bradley use?', needle: 'JavaScript' },
  { q: 'Tell me about some of Bradley web projects', needle: 'ProjectHub' },
  { q: 'Tell me about ProjectHub', needle: 'vanilla JavaScript' },
  { q: 'What did Bradley do at AWS?', needle: 'internship' },
  { q: 'Did Bradley work at Microsoft?', needle: 'no verified record' },
  { q: 'Does Bradley know Kubernetes?', needle: 'not one of Bradley' },
  { q: 'Does Bradley have a Kubernetes certification?', needle: 'does not have' },
  { q: 'Does Bradley know React?', needle: 'Yes, Bradley knows React' },
];

for (const { q, needle } of directCases) {
  const direct = knowledgeAccess.findDirectAnswer ? knowledgeAccess.findDirectAnswer(knowledge, q) : null;
  if (!direct) {
    fail(`No direct answer found for "${q}"`);
    continue;
  }
  const reply = direct.answer || direct.reply;
  if (reply.toLowerCase().includes(needle.toLowerCase()) || new RegExp(needle, 'i').test(reply)) {
    ok(`Direct answer for "${q}" includes expected content`);
  } else {
    fail(`Direct answer for "${q}" missing expected content "${needle}". Got: "${reply.slice(0, 120)}..."`);
  }
}

// 3. Open-world / closed-world sanity
const subjectName = (knowledge?.identity?.name || knowledgeAccess.getSubjectNamePattern?.(knowledge));
if (subjectName === 'Bradley Matera' || (typeof subjectName === 'string' && /Bradley Matera/i.test(subjectName))) ok('Bradley identity is preserved in KB');
else fail(`Unexpected subject name: ${subjectName}`);

const techs = knowledgeAccess.getKnownTechnologies(knowledge);
for (const bad of ['rust', 'kubernetes', 'azure', 'gcp']) {
  if (techs.includes(bad)) fail(`KB falsely lists "${bad}" as a known technology`);
}
ok('No Rust/Kubernetes/Azure/GCP in known technologies (closed-world skills check)');

const companies = knowledgeAccess.getKnownCompanies(knowledge);
for (const bad of ['microsoft', 'google']) {
  if (companies.some(c => new RegExp('\\b' + bad + '\\b', 'i').test(c))) fail(`KB falsely lists "${bad}" as a known company`);
}
// AWS is part of Amazon, so "amazon" itself is not necessarily a false claim.
// Only flag it if there is no AWS/Amazon Web Services entry.
const hasAws = companies.some(c => /\baws\b|amazon web services/i.test(c));
if (!hasAws && companies.some(c => /\bamazon\b/i.test(c))) fail('KB lists "amazon" as a known company without AWS context');
ok('No Microsoft/Google falsely listed as known companies');

// 4. Multi-turn referent, memory, CIRIS, and identity sanity
(function() {
  const referentCases = [
    { name: 'ProjectHub -> it', history: [{ user: 'Tell me about ProjectHub', assistant: 'ProjectHub is an AI chatbot widget built with vanilla JavaScript.' }], q: 'What did he use in it?', expected: 'ProjectHub' },
    { name: 'Rust -> it', history: [{ user: 'Can Bradley become good at Rust?', assistant: 'Rust is not in his documented skills.' }], q: 'Could he become a leader in it?', expected: 'Rust' },
    { name: 'Bradley -> he', history: [{ user: 'What about Bradley?', assistant: 'Bradley is a junior developer.' }], q: 'Does he know React?', expected: 'Bradley' },
    { name: 'Helm Group -> there', history: [{ user: 'What happened with Helm Group?', assistant: 'He accepted a role there.' }], q: 'What happened there?', expected: 'Helm' },
    { name: 'CIRIS -> it', history: [{ user: 'What is CIRIS Ethical AI?', assistant: 'CIRIS Ethical AI is a project about ethical AI tooling.' }], q: 'What tech did it use?', expected: 'CIRIS' },
  ];
  for (const tc of referentCases) {
    const convState = buildConversationState(tc.history, knowledge);
    const res = resolveReferent(tc.q, convState, knowledge);
    const rewritten = (res.rewrittenQuery || '').toLowerCase();
    const entity = (res.entity || '').toLowerCase();
    const expected = tc.expected.toLowerCase();
    if (res.resolved && (entity.includes(expected) || rewritten.includes(expected))) {
      ok(`Referent resolution: ${tc.name} -> ${res.entity}`);
    } else {
      fail(`Referent resolution: ${tc.name} expected ${tc.expected}, got ${JSON.stringify(res)}`);
    }
  }

  // Session memory: userName committed before generation should persist.
  const sid = 'break-it-memory-' + Date.now();
  sessionState.applyControlIntent(sid, 'Hi, my name is Casey', knowledge, 'GREETING');
  const s1 = sessionState.getState(sid);
  if (s1?.userName?.toLowerCase() === 'casey') ok('Session state captured userName Casey');
  else fail(`Session state did not capture userName: ${JSON.stringify(s1?.userName)}`);

  sessionState.applyControlIntent(sid, 'What is my name?', knowledge, 'USER_PROFILE_QUERY');
  const s2 = sessionState.getState(sid);
  if (s2?.userName?.toLowerCase() === 'casey') ok('Session state preserved userName across turns');
  else fail(`Session state lost userName: ${JSON.stringify(s2?.userName)}`);

  // CIRIS identity guard: a follow-up about CIRIS should resolve 'it' to CIRIS and 'he' to Bradley.
  const cirisHistory = [{ user: 'What is CIRIS Ethical AI?', assistant: 'CIRIS Ethical AI is a project about ethical AI tooling.' }];
  const cirisState = buildConversationState(cirisHistory, knowledge);
  const cirisRes = resolveReferent('What did he build it with?', cirisState, knowledge);
  const cirisRewritten = (cirisRes.rewrittenQuery || '').toLowerCase();
  if ((cirisRes.entity || '').toLowerCase().includes('ciris') && cirisRewritten.includes('bradley') && cirisRewritten.includes('ciris')) {
    ok('CIRIS referent resolved correctly (Bradley subject, CIRIS object)');
  } else {
    fail(`CIRIS referent failed: ${JSON.stringify(cirisRes)}`);
  }

  // Identity guard: no summary-style direct answer for "Who is Bradley?".
  const summaryDirect = knowledgeAccess.findDirectAnswer(knowledge, 'Who is Bradley Matera?');
  if (summaryDirect) fail('Direct answer table still has a summary-style "Who is Bradley" entry');
  else ok('No summary-style "Who is Bradley" direct answer (frozen table)');
})();

// 5. Runtime source check: the chat endpoint should not author replies itself
const hasForbiddenProse =
  /res\.json\(\{[\s\S]{0,200}?reply\s*:/.test(server) &&
  !/reply:\s*(?:agentResult\.reply|INFERENCE_UNAVAILABLE_REPLY)/.test(server);
// This is a weak heuristic; the real guard is the prose-regression test suite.
if (hasForbiddenProse) fail('server-gemini.js appears to build a reply inline (heuristic)');
else ok('server-gemini.js does not appear to author reply prose inline');

// 6. Live endpoint probe (optional)
const urlArg = process.argv.find(a => a.startsWith('--url='))?.split('=')[1] || process.env.SCOUT_BREAKIT_URL;
(async () => {
  if (urlArg) {
    console.log('\nProbing live endpoint:', urlArg);
    const cases = [
      { q: 'Does Bradley know Rust?', want: /not.*documented|does not know/i },
      { q: 'Did Bradley work at Microsoft?', want: /no verified record|not.*documented|no evidence/i },
      { q: 'What is Bradley\'s GPA?', want: /3\.64/ },
      { q: 'What school did Bradley attend?', want: /Full Sail/i },
    ];
    for (const { q, want } of cases) {
      try {
        const res = await fetch(`${urlArg}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: q, sessionId: 'break-it-' + Date.now() })
        });
        const data = await res.json();
        if (!data.reply) {
          fail(`Live "${q}" returned no reply: ${data.error || JSON.stringify(data).slice(0, 80)}`);
        } else if (want.test(data.reply)) {
          ok(`Live "${q}" matched expected pattern`);
        } else {
          fail(`Live "${q}" reply did not match. Got: "${data.reply.slice(0, 120)}..."`);
        }
      } catch (e) {
        fail(`Live "${q}" threw: ${e.message}`);
      }
    }
  }

  console.log(`\n${failed === 0 ? 'All break-it checks passed.' : `${failed} break(s) found.`}`);
  process.exit(failed ? 1 : 0);
})();
