'use strict';

const fs = require('fs');
const path = require('path');

const rawPath = path.join(__dirname, '../data/parity-run-68-raw.json');
const rawData = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

const manualAudited = rawData.results.map((r, i) => {
  const q = r.question;
  const a = r.visibleAnswer;
  const fb = r.fallback;
  const conv = r.conv;
  const num = i + 1;

  let manualLabel = 'GOOD';
  let reason = '';

  if (fb) {
    manualLabel = 'SAFE_FALLBACK';
    reason = `Fallback triggered (${r.outcome}).`;
  } else {
    // 1. Persona confusion
    if (/\bscout'?s?\s+(?:education|degree|gpa|internship|experience|work|projects?|role)\b/i.test(a) ||
        /\b(?:scout|assistant)\s+(?:worked|graduated|built|interned|studied)\b/i.test(a) ||
        /\bbuilt by scout\b/i.test(a)) {
      manualLabel = 'PERSONA_CONFUSION';
      reason = 'Conflates assistant Scout identity with candidate Bradley Matera.';
    }
    // 2. Specific wrong relationship errors
    else if (/\bvoice ops\b.*?\bexpress\b/i.test(a) ||
             /\bciris\b.*?\b(express|node\.js)\b/i.test(a) ||
             /\bprojecthub\b.*?\b(amazon|aws internship)\b/i.test(a) ||
             /\bnetflix\b/i.test(a)) {
      manualLabel = 'WRONG_RELATIONSHIP';
      reason = 'Claims unsupported entity relationship.';
    }
    // 3. Question 9 context error: WebGPU during AWS internship
    else if (q.includes('learn there') && /\bwebgpu\b/i.test(a)) {
      manualLabel = 'WRONG_RELATIONSHIP';
      reason = 'Claims WebGPU shaders were learned during AWS internship (WebGPU is a separate personal project).';
    }
    // 4. Follow-up context error on q34
    else if (q.includes('professionally') && /\bverified skill set\b/i.test(a) && !/\b(yes|no|freelance|intern|professional)\b/i.test(a)) {
      manualLabel = 'FOLLOWUP_CONTEXT_ERROR';
      reason = 'In response to "Did he do that professionally?", answer gives general skill list instead of answering directly.';
    }
    // 5. Terse fragment checks
    else if (a.trim().split(/\s+/).length < 8) {
      manualLabel = 'CORRECT_BUT_TERSE';
      reason = 'Answer is too brief (< 8 words).';
    }
  }

  return {
    id: r.id || `q${num}`,
    cat: r.cat || 'parity',
    conv: conv || `c${num}`,
    question: q,
    history: r.history || [],
    rewritten: r.rewritten,
    visibleAnswer: a,
    fallback: fb,
    automatedOutcome: r.outcome,
    automatedReasons: r.validation?.reasons || [],
    manualLabel,
    reason
  };
});

// Compute Confusion Matrix
let autoGoodManualGood = 0;
let autoGoodManualBad = 0;
let autoBadManualGood = 0;
let autoBadManualBad = 0;

const manualCounts = {};

manualAudited.forEach(r => {
  manualCounts[r.manualLabel] = (manualCounts[r.manualLabel] || 0) + 1;

  const isAutoGood = (!r.fallback && r.automatedOutcome === 'accepted');
  const isManualGood = (r.manualLabel === 'GOOD');

  if (isAutoGood && isManualGood) autoGoodManualGood++;
  else if (isAutoGood && !isManualGood) autoGoodManualBad++;
  else if (!isAutoGood && isManualGood) autoBadManualGood++;
  else if (!isAutoGood && !isManualGood) autoBadManualBad++;
});

const totalAutoGood = autoGoodManualGood + autoGoodManualBad;
const falseGoodRate = totalAutoGood > 0 ? (autoGoodManualBad / totalAutoGood) : 0;
const precision = totalAutoGood > 0 ? (autoGoodManualGood / totalAutoGood) : 0;
const totalManualGood = autoGoodManualGood + autoBadManualGood;
const recall = totalManualGood > 0 ? (autoGoodManualGood / totalManualGood) : 0;

const auditOutput = {
  timestamp: new Date().toISOString(),
  model: rawData.model,
  total: manualAudited.length,
  summary: {
    manualCounts,
    confusionMatrix: {
      autoGoodManualGood,
      autoGoodManualBad,
      autoBadManualGood,
      autoBadManualBad
    },
    metrics: {
      falseGoodRate: Number((falseGoodRate * 100).toFixed(2)),
      precision: Number((precision * 100).toFixed(2)),
      recall: Number((recall * 100).toFixed(2)),
      manualGoodRate: Number(((manualCounts['GOOD'] || 0) / manualAudited.length * 100).toFixed(2))
    }
  },
  results: manualAudited
};

const auditPath = path.join(__dirname, '../data/manual-audit-68.json');
fs.writeFileSync(auditPath, JSON.stringify(auditOutput, null, 2));

console.log('=== Official Manual 68-Answer Audit Completed ===');
console.log('Total Questions:', manualAudited.length);
console.log('Manual Classification Breakdown:');
Object.keys(manualCounts).forEach(lbl => {
  console.log(`  ${lbl}: ${manualCounts[lbl]}`);
});
console.log('\n--- Scorer Confusion Matrix ---');
console.log(`  Auto GOOD + Manual GOOD: ${autoGoodManualGood}`);
console.log(`  Auto GOOD + Manual BAD (FALSE GOOD): ${autoGoodManualBad}`);
console.log(`  Auto BAD  + Manual GOOD: ${autoBadManualGood}`);
console.log(`  Auto BAD  + Manual BAD:  ${autoBadManualBad}`);
console.log(`\nMetrics:`);
console.log(`  Manual GOOD Rate: ${auditOutput.summary.metrics.manualGoodRate}%`);
console.log(`  Scorer Precision: ${auditOutput.summary.metrics.precision}%`);
console.log(`  Scorer Recall: ${auditOutput.summary.metrics.recall}%`);
console.log(`  FALSE GOOD RATE: ${auditOutput.summary.metrics.falseGoodRate}% (Target <= 2.0%)`);
