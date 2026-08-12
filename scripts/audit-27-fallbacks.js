'use strict';

/**
 * Fallback Audit Harness — analyzes every fallback in the 68-question run
 * to identify root causes and classify harness-preventable vs model-capacity limits.
 */

const fs = require('fs');
const path = require('path');
const { validateAnswer } = require('../lib/grounding-validator');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const knowledge = require('../data/recruiter-knowledge.json');
const graph = buildRelationshipGraph(knowledge);

const rawPath = path.join(__dirname, '../data/parity-run-68-raw.json');
const rawData = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

console.log('=== AUDITING ALL FALLBACKS IN 68-QUESTION RUN ===\n');

const fallbacks = [];
let fallbackCount = 0;

for (const r of rawData.results) {
  if (r.fallback) {
    fallbackCount++;
    const reasons = (r.validation && r.validation.reasons) || [];
    let rootCause = 'UNKNOWN';
    let preventable = 'HARNESS_PREVENTABLE';

    if (reasons.some(rs => rs.startsWith('unsupported_relationship:'))) {
      rootCause = 'WRONG_RELATIONSHIP';
      preventable = 'REPAIRABLE';
    } else if (reasons.some(rs => rs.startsWith('fabricated_entity:'))) {
      rootCause = 'HALLUCINATED_ENTITY';
      preventable = 'REPAIRABLE';
    } else if (reasons.some(rs => rs.startsWith('expanded_overclaim:'))) {
      rootCause = 'OVERCLAIM';
      preventable = 'HARNESS_PREVENTABLE';
    } else if (reasons.some(rs => rs.startsWith('persona_confusion:'))) {
      rootCause = 'PERSONA';
      preventable = 'HARNESS_PREVENTABLE';
    } else if (reasons.some(rs => rs.startsWith('incomplete:terse') || rs.startsWith('completeness_check:terse'))) {
      rootCause = 'TOO_TERSE';
      preventable = 'HARNESS_PREVENTABLE';
    } else if (reasons.some(rs => rs.startsWith('not_relevant_to_question:'))) {
      rootCause = 'VALIDATOR_FALSE_REJECTION';
      preventable = 'HARNESS_PREVENTABLE';
    } else if (reasons.some(rs => rs.startsWith('number_not_grounded:'))) {
      rootCause = 'VALIDATOR_FALSE_REJECTION';
      preventable = 'HARNESS_PREVENTABLE';
    } else if (r.outcome === 'repaired') {
      rootCause = 'REPAIR_FAILED';
      preventable = 'REPAIRABLE';
    } else {
      rootCause = 'BAD_RESPONSE_PLAN';
      preventable = 'HARNESS_PREVENTABLE';
    }

    fallbacks.push({
      id: r.id,
      conv: r.conv,
      question: r.question,
      rewritten: r.rewritten,
      history: r.history || [],
      visibleAnswer: r.visibleAnswer,
      reasons,
      rootCause,
      preventable
    });

    console.log(`[#${fallbackCount}] ID: ${r.id} | Q: "${r.question}"`);
    console.log(`     Reasons: ${reasons.join(', ') || 'None'}`);
    console.log(`     Root Cause: ${rootCause} | Preventable: ${preventable}`);
    console.log(`     Answer Snippet: ${(r.visibleAnswer || '').slice(0, 100)}...\n`);
  }
}

console.log(`=== SUMMARY OF ${fallbacks.length} FALLBACKS ===\n`);

const causeCounts = {};
const typeCounts = {};

for (const f of fallbacks) {
  causeCounts[f.rootCause] = (causeCounts[f.rootCause] || 0) + 1;
  typeCounts[f.preventable] = (typeCounts[f.preventable] || 0) + 1;
}

console.log('Root Cause Breakdown:');
console.table(causeCounts);

console.log('\nPreventability Classification:');
console.table(typeCounts);
