'use strict';

const fs = require('fs');

const files = ['data/eval-stability-1.json', 'data/eval-stability-2.json', 'data/eval-stability-3.json'];

console.log('=== STABILITY RUNS SUMMARY ===\n');

for (let i = 0; i < files.length; i++) {
  const raw = JSON.parse(fs.readFileSync(files[i], 'utf8'));
  const total = raw.results.length;
  const accepted = raw.results.filter(r => r.outcome === 'accepted').length;
  const repaired = raw.results.filter(r => r.outcome === 'repaired' || r.outcome === 'completeness_repaired').length;
  const fallback = raw.results.filter(r => r.fallback).length;
  const goodConversational = accepted + repaired;
  const goodRate = (goodConversational / total * 100).toFixed(2);
  const fallbackRate = (fallback / total * 100).toFixed(2);

  // Check for any factual or persona validation errors in events
  let wrongFacts = 0;
  let wrongRels = 0;
  let personaErrors = 0;
  let overclaims = 0;

  for (const res of raw.results) {
    const events = res.events || [];
    for (const e of events) {
      if (e.type === 'lite_validation') {
        const reasons = e.reasons || [];
        for (const r of reasons) {
          if (r.includes('unsupported_relationship')) wrongRels++;
          if (r.includes('persona_confusion')) personaErrors++;
          if (r.includes('overclaim')) overclaims++;
          if (r.includes('fabricated_entity')) wrongFacts++;
        }
      }
    }
  }

  console.log(`Run ${i + 1} (${files[i]}):`);
  console.log(`  Good Conversational: ${goodConversational} / ${total} (${goodRate}%) [Accepted: ${accepted}, Repaired: ${repaired}]`);
  console.log(`  Safe Fallback: ${fallback} / ${total} (${fallbackRate}%)`);
  console.log(`  Validation Violations (Caught & Repaired/Blocked): Rels: ${wrongRels}, Persona: ${personaErrors}, Overclaims: ${overclaims}, Fabricated: ${wrongFacts}\n`);
}
