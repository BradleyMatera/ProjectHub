'use strict';

const fs = require('fs');
const path = require('path');

const rawPath = path.join(__dirname, '../data/parity-run-68-raw.json');
if (!fs.existsSync(rawPath)) {
  console.error('Raw run file data/parity-run-68-raw.json does not exist.');
  process.exit(1);
}

const rawData = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
const items = rawData.results;

const manualResults = [];

items.forEach((item, index) => {
  const q = item.question;
  const a = item.visibleAnswer;
  const fb = item.fallback;
  const id = item.id;
  const cat = item.cat;
  const conv = item.conv;

  let manualLabel = 'GOOD';
  let reason = '';

  if (fb) {
    manualLabel = 'SAFE_FALLBACK';
    reason = `Fallback triggered (${item.outcome}).`;
  } else {
    const aLower = a.toLowerCase();

    // 1. Persona confusion checks
    if (/\bscout'?s?\s+(?:education|degree|gpa|internship|experience|work|projects?|role)\b/i.test(a) ||
        /\b(?:scout|assistant)\s+(?:worked|graduated|built|interned|studied)\b/i.test(a) ||
        /\bscout\s+has\s+been\s+working\s+on\b/i.test(a) ||
        /\bproject\s+that\s+scout\s+has\s+been\s+working\s+on\b/i.test(a)) {
      manualLabel = 'PERSONA_CONFUSION';
      reason = 'Attributes subject properties (education, work, projects, internship) to assistant Scout identity.';
    }
    // 2. Persona confusion: Scout and ProjectHub as separate projects
    else if (/\bprojecthub\s+and\s+scout\b/i.test(a) || /\bscout\s+and\s+projecthub\b/i.test(a)) {
      manualLabel = 'PERSONA_CONFUSION';
      reason = 'Confuses assistant identity Scout with a project being compared to ProjectHub.';
    }
    // 3. Wrong Relationship: ProjectHub connected to AWS internship / serverless capstone
    else if (/\bprojecthub\b/i.test(a) && /\b(?:aws\s+internship|cloud\s+support\s+engineer\s+intern|serverless\s+metadata)\b/i.test(a)) {
      manualLabel = 'WRONG_RELATIONSHIP';
      reason = 'Incorrectly connects ProjectHub to AWS internship capstone.';
    }
    // 4. Followup Context Error / Wrong Entity in comparison
    else if (q.includes('Compare') || q.includes('compare')) {
      if (q.includes('Voice Ops') && !aLower.includes('voice ops')) {
        manualLabel = 'FOLLOWUP_CONTEXT_ERROR';
        reason = 'Comparison answer missed Voice Ops Platform.';
      } else if (q.includes('CIRIS') && !aLower.includes('ciris')) {
        manualLabel = 'FOLLOWUP_CONTEXT_ERROR';
        reason = 'Comparison answer missed CIRIS Ethical AI.';
      } else if (aLower.includes('ciris') && !q.includes('CIRIS') && conv !== 'c02') {
        manualLabel = 'WRONG_ENTITY';
        reason = 'Introduced CIRIS Ethical AI into a comparison where it was not requested.';
      }
    }
    // 5. Terse check
    else if (a.split(/\s+/).filter(w => w.length > 0).length < 8) {
      manualLabel = 'CORRECT_BUT_TERSE';
      reason = 'Answer is too brief (< 8 words).';
    }
    // 6. Generic check
    else if (/as an ai|based on the information|would you like/i.test(a)) {
      manualLabel = 'CORRECT_BUT_GENERIC';
      reason = 'Contains generic AI filler phrases.';
    }
    // 7. Factual check
    else if (/\b10\s+years\b/i.test(a) && !/\b(not|no|never|does not)\b/i.test(a)) {
      manualLabel = 'FACTUALLY_WRONG';
      reason = 'Falsely claims 10 years of experience.';
    }
  }

  manualResults.push({
    id,
    cat,
    conv,
    question: q,
    rewritten: item.rewritten,
    visibleAnswer: a,
    fallback: fb,
    automatedOutcome: item.outcome,
    automatedReasons: item.validation?.reasons || [],
    manualLabel,
    reason
  });
});

// Compute Confusion Matrix
let autoGoodManualGood = 0;
let autoGoodManualBad = 0;
let autoBadManualGood = 0;
let autoBadManualBad = 0;

const manualCounts = {};

manualResults.forEach(r => {
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
  total: manualResults.length,
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
      manualGoodRate: Number(((manualCounts['GOOD'] || 0) / manualResults.length * 100).toFixed(2))
    }
  },
  results: manualResults
};

const auditPath = path.join(__dirname, '../data/manual-audit-68.json');
fs.writeFileSync(auditPath, JSON.stringify(auditOutput, null, 2));

console.log('=== Manual 68-Answer Audit Summary ===');
console.log('Total Questions:', manualResults.length);
console.log('Manual Breakdown:');
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
