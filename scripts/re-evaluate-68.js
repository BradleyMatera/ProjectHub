'use strict';

const fs = require('fs');
const path = require('path');
const { validateAnswer } = require('../lib/grounding-validator');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const knowledge = require('../data/recruiter-knowledge.json');
const graph = buildRelationshipGraph(knowledge);

const manualPath = path.join(__dirname, '../data/manual-audit-68.json');
const manualData = JSON.parse(fs.readFileSync(manualPath, 'utf8'));

let autoGoodManualGood = 0;
let autoGoodManualBad = 0;
let autoBadManualGood = 0;
let autoBadManualBad = 0;

const reEvaluatedResults = [];

manualData.results.forEach(r => {
  const visibleAnswer = r.visibleAnswer;
  const question = r.question;
  const history = r.history || [];

  let newOutcome = r.automatedOutcome;
  let newReasons = r.automatedReasons;

  if (!r.fallback && visibleAnswer) {
    const val = validateAnswer(visibleAnswer, JSON.stringify(knowledge), question, knowledge, history, graph);
    if (!val.valid) {
      newOutcome = 'rejected';
      newReasons = val.reasons;
    } else {
      newOutcome = 'accepted';
      newReasons = [];
    }
  }

  const words = visibleAnswer.trim().split(/\s+/).filter(w => w.length > 0);
  const isTerse = words.length < 8;
  const isAutoGood = (!r.fallback && newOutcome === 'accepted' && !isTerse);
  const isManualGood = (r.manualLabel === 'GOOD');

  if (isAutoGood && isManualGood) autoGoodManualGood++;
  else if (isAutoGood && !isManualGood) autoGoodManualBad++;
  else if (!isAutoGood && isManualGood) autoBadManualGood++;
  else if (!isAutoGood && !isManualGood) autoBadManualBad++;

  reEvaluatedResults.push({
    ...r,
    newOutcome,
    newReasons
  });
});

const totalAutoGood = autoGoodManualGood + autoGoodManualBad;
const falseGoodRate = totalAutoGood > 0 ? (autoGoodManualBad / totalAutoGood) : 0;
const precision = totalAutoGood > 0 ? (autoGoodManualGood / totalAutoGood) : 0;
const totalManualGood = autoGoodManualGood + autoBadManualGood;
const recall = totalManualGood > 0 ? (autoGoodManualGood / totalManualGood) : 0;

console.log('=== Scorer V2 Re-Evaluation Results ===');
console.log(`Auto GOOD + Manual GOOD: ${autoGoodManualGood}`);
console.log(`Auto GOOD + Manual BAD (FALSE GOOD): ${autoGoodManualBad}`);
console.log(`Auto BAD  + Manual GOOD: ${autoBadManualGood}`);
console.log(`Auto BAD  + Manual BAD:  ${autoBadManualBad}`);
console.log(`\nMetrics:`);
console.log(`  Scorer Precision: ${(precision * 100).toFixed(2)}%`);
console.log(`  Scorer Recall: ${(recall * 100).toFixed(2)}%`);
console.log(`  FALSE GOOD RATE: ${(falseGoodRate * 100).toFixed(2)}% (Target <= 2.0%)`);
