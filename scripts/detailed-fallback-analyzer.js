'use strict';

const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('data/parity-run-68-raw.json', 'utf8'));

console.log('=== DETAILED CATEGORIZATION OF ALL FALLBACKS ===\n');

const fallbacks = raw.results.filter(r => r.fallback);
console.log(`Total Fallbacks: ${fallbacks.length}\n`);

const categories = {
  OVERCLAIM_LANGUAGE: [],       // "extensive experience", "expertise"
  TERSE_FIRST_GEN: [],          // First gen was "No." or "Yes." or too short
  FABRICATED_ENTITY: [],        // Model hallucinated entity (Prometheus, Grafana, DSA, Udemy)
  VALIDATOR_FALSE_REJECTION: [],// Legitimate answer rejected by validator (e.g. number_not_grounded or not_relevant)
  REPAIR_FAILURE: [],           // Model repair made it worse or didn't fix overclaim
  ADVERSARIAL_BLOCKED: []       // Adversarial confirmation check blocked false confirmation
};

for (const r of fallbacks) {
  const events = r.events || [];
  const genEvent = events.find(e => e.type === 'lite_generate_ok');
  const advEvent = events.find(e => e.type === 'lite_adversarial_confirmation' || e.type === 'lite_forbidden_claim');
  const valEvent = events.find(e => e.type === 'lite_validation');
  const repEvent = events.find(e => e.type === 'lite_repair_result');

  const rawAns = genEvent?.rawAnswer || '';
  const valReasons = valEvent?.reasons || [];
  const repReasons = repEvent?.reasons || [];

  let cat = 'OTHER';

  if (advEvent) {
    cat = 'ADVERSARIAL_BLOCKED';
  } else if (rawAns.length < 15) {
    cat = 'TERSE_FIRST_GEN';
  } else if (valReasons.some(rs => rs.includes('overclaim'))) {
    cat = 'OVERCLAIM_LANGUAGE';
  } else if (valReasons.some(rs => rs.includes('fabricated_entity'))) {
    cat = 'FABRICATED_ENTITY';
  } else if (valReasons.some(rs => rs.includes('not_relevant') || rs.includes('number_not_grounded') || rs.includes('insufficient_content_overlap'))) {
    cat = 'VALIDATOR_FALSE_REJECTION';
  } else if (repEvent && repReasons.length > 0) {
    cat = 'REPAIR_FAILURE';
  }

  categories[cat] = categories[cat] || [];
  categories[cat].push({
    id: r.id,
    q: r.question,
    rawAns: rawAns.slice(0, 80),
    valReasons,
    repReasons
  });
}

for (const [catName, items] of Object.entries(categories)) {
  console.log(`=== ${catName} (${items.length} items) ===`);
  for (const it of items) {
    console.log(`  [${it.id}] Q: "${it.q}"`);
    console.log(`       Raw: "${it.rawAns}"`);
    console.log(`       Val Reasons: ${it.valReasons.join(', ')}`);
    if (it.repReasons.length) console.log(`       Rep Reasons: ${it.repReasons.join(', ')}`);
  }
  console.log('\n');
}
