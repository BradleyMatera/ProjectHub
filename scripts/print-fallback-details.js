'use strict';

const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('data/parity-run-68-raw.json', 'utf8'));

console.log('=== DETAILED FALLBACK AUDIT (ALL 27 ITEMS) ===\n');

let count = 0;
for (const r of raw.results) {
  if (r.fallback) {
    count++;
    console.log(`Item #${count} (ID: ${r.id}, Conv: ${r.conv}):`);
    console.log(`  Question: "${r.question}"`);
    console.log(`  Outcome: ${r.outcome}`);
    const events = r.events || [];
    const genEvent = events.find(e => e.type === 'lite_generate_ok');
    const repairEvent = events.find(e => e.type === 'lite_repair_result');
    const advEvent = events.find(e => e.type === 'lite_adversarial_confirmation' || e.type === 'lite_forbidden_claim');

    console.log(`  Raw First Gen: "${genEvent?.rawAnswer || ''}"`);
    if (advEvent) console.log(`  Adversarial Blocked: ${advEvent.type}`);
    if (r.validation) {
      console.log(`  Initial Validation Reasons:`, r.validation.reasons);
    }
    if (repairEvent) {
      console.log(`  Repair Attempt Raw: "${repairEvent.rawAnswer || ''}"`);
      console.log(`  Repair Validation Reasons:`, repairEvent.reasons);
    }
    console.log('--------------------------------------------------\n');
  }
}
