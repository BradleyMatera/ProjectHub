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
  { q: 'Can he eventually learn to be a leader in Rust?', needle: 'Rust is not' },
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

// 4. Runtime source check: the chat endpoint should not author replies itself
const hasForbiddenProse =
  /res\.json\(\{[\s\S]{0,200}?reply\s*:/.test(server) &&
  !/reply:\s*agentResult\.reply/.test(server);
// This is a weak heuristic; the real guard is the prose-regression test suite.
if (hasForbiddenProse) fail('server-gemini.js appears to build a reply inline (heuristic)');
else ok('server-gemini.js does not appear to author reply prose inline');

// 5. Live endpoint probe (optional)
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
