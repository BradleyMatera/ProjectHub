'use strict';

/**
 * Guarded Scout follow-up patch for c87cdcc strict-live failures.
 * Deterministic validation rejects bad semantic shapes; generative paths still author prose.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function editFile(relPath, transform) {
  const fullPath = path.join(ROOT, relPath);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const normalized = raw.replace(/\r\n/g, '\n');
  const updated = transform(normalized);
  if (updated === normalized) throw new Error(`${relPath}: patch produced no change`);
  fs.writeFileSync(fullPath, updated.replace(/\n/g, eol), 'utf8');
  console.log(`patched ${relPath}`);
}

function replaceOnce(text, oldText, newText, label) {
  const first = text.indexOf(oldText);
  if (first === -1) throw new Error(`${label}: expected source block not found`);
  if (text.indexOf(oldText, first + oldText.length) !== -1) throw new Error(`${label}: expected exactly one source block`);
  return text.slice(0, first) + newText + text.slice(first + oldText.length);
}

editFile('lib/grounding-validator.js', text => {
  text = replaceOnce(text,
`function cleanText(value, max) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, max);
}`,
`function cleanText(value, max) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, max);
}

function learningOrAdjacentTexts(knowledge) {
  const items = knowledge?.skills?.learningOrAdjacent;
  if (!Array.isArray(items)) return [];
  return items.flatMap(item => {
    if (typeof item === 'string') return [item];
    if (!item || typeof item !== 'object') return [];
    return [item.label, item.name, item.skill, item.title, item.summary, item.description, item.detail]
      .filter(Boolean).map(String);
  });
}

function hasExplicitCurrentProgressEvidence(knowledge) {
  const explicitCurrent = /\\b(?:currently|actively|presently|ongoing|in\\s+progress|working\\s+on\\s+now|working\\s+on\\s+currently)\\b/i;
  return learningOrAdjacentTexts(knowledge).some(item => explicitCurrent.test(item));
}`,
'add structured learning/progress helpers');

  text = replaceOnce(text,
`  // Build the authoritative known-technology set from structured knowledge.
  // When a knowledge object is provided, a tech is only supported if it appears
  // here — this prevents a full-KB source string (e.g., from unit tests) from
  // making any mentioned technology look grounded.`,
`  // Negative-assessment/current-progress semantic guard. Deterministic code
  // rejects invalid semantic shapes; generative repair still authors the reply.
  if (responseContract?.subIntent === 'NEGATIVE_ASSESSMENT' && responseContract?.factState === 'UNKNOWN') {
    const rankedWeakness = /\\b(?:his|her|their|the\\s+candidate(?:'s)?|the\\s+subject(?:'s)?|[a-z][a-z'-]+(?:\\s+[a-z][a-z'-]+)?'s)\\s+(?:(?:biggest|main|primary|greatest|worst|honest)\\s+){0,3}weakness(?:es)?\\s+(?:is|are)\\b/i;
    const boundedWeakness = /\\bweakness(?:es)?\\s+(?:is|are)\\s+(?:unknown|unclear|not\\s+(?:verified|documented|established|known))\\b/i;
    if (rankedWeakness.test(text) && !boundedWeakness.test(text)) {
      return { valid: false, reasons: ['negative_assessment_ranked_weakness'], verdict: 'overclaim', cleaned: text };
    }

    const asksCurrentProgress = /\\b(?:working\\s+on|work\\s+on|address(?:ing)?|improv(?:e|ing)|develop(?:ing)?|progress)\\b/i.test(question);
    if (asksCurrentProgress) {
      const boundedUnknown = /\\b(?:unknown|unclear|not\\s+clear|not\\s+(?:verified|documented|established|known)|no\\s+(?:verified|public|current)\\s+(?:evidence|record|information)|cannot\\s+verify|can't\\s+verify|does\\s+not\\s+establish|doesn't\\s+establish)\\b/i.test(text);
      const explicitProgressClaim = /\\b(?:is|currently|actively|presently|has\\s+been)\\s+(?:actively\\s+)?(?:working|seeking|learning|studying|taking|attending|practicing|training|developing|addressing|improving)\\b/i.test(text);
      const progressSupported = hasExplicitCurrentProgressEvidence(knowledge);
      if (explicitProgressClaim && !progressSupported) return { valid: false, reasons: ['current_progress_unverified'], verdict: 'overclaim', cleaned: text };
      if (!boundedUnknown && !explicitProgressClaim) return { valid: false, reasons: ['current_progress_not_answered'], verdict: 'unsupported', cleaned: text };
    }
  }

  // Build the authoritative known-technology set from structured knowledge.
  // When a knowledge object is provided, a tech is only supported if it appears
  // here — this prevents a full-KB source string (e.g., from unit tests) from
  // making any mentioned technology look grounded.`,
'add negative/current-progress validation guard');
  return text;
});

editFile('lib/lite-agent.js', text => replaceOnce(text,
`  persona_confusion: 'You spoke as the subject (first person). You are Scout, the assistant. Use "he/his" not "I/my" when talking about the subject.'`,
`  persona_confusion: 'You spoke as the subject (first person). You are Scout, the assistant. Use "he/his" not "I/my" when talking about the subject.',
  negative_assessment_ranked_weakness: 'Do not call a learning or gap area the candidate\\'s weakness and do not rank a biggest/main/primary weakness. The contract says the personal weakness is UNKNOWN. State that no personal weakness is verified, then separately name a documented learning/gap area only if useful.',
  current_progress_unverified: 'You claimed current activity that the structured facts do not establish. Remove the active/current claim. State that current progress is unknown or not verified, while keeping the previously discussed learning/gap area attached to the candidate.',
  current_progress_not_answered: 'Answer whether current progress is known. If the structured facts do not explicitly establish current work, say current progress is unknown or not verified. Do not replace the answer with transferable skills.'`,
'add semantic repair hints'));

editFile('lib/acceptance-scorer.js', text => {
  text = replaceOnce(text,
`    const learningSubphrases = learningNorms.flatMap(subphrases);
    const boundarySubphrases = boundaryItems.flatMap(b => subphrases(normalizeText(b)));
    const allItems = [...new Set([...learningSubphrases, ...boundarySubphrases])];
    const normalizedReply = normalizeText(reply);

    const hasResolution = allItems.some(item => normalizedReply.includes(item)) ||
                          /\\b(?:no public evidence|not documented|unknown|not listed|public evidence does not|does not indicate)\\b/i.test(reply);`,
`    const learningSubphrases = learningNorms.flatMap(subphrases);
    const boundarySubphrases = boundaryItems.flatMap(b => subphrases(normalizeText(b)));
    const allItems = [...new Set([...learningSubphrases, ...boundarySubphrases])];
    const normalizedReply = normalizeText(reply);

    // Use tenant-derived semantic token overlap instead of exact-only substrings.
    const referentStopwords = new Set(['about','area','areas','candidate','current','direct','documented','evidence','experience','gap','gaps','knowledge','learning','limited','public','skill','skills','weakness','weaknesses','with','work']);
    const referentTokens = value => normalizeText(value).split(/\\s+/)
      .map(token => token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token)
      .filter(token => token.length >= 3 && !referentStopwords.has(token));
    const conceptTexts = [...new Set([...learningNorms, ...boundaryItems.map(normalizeText)].filter(Boolean))];
    const concepts = conceptTexts.map(value => [...new Set(referentTokens(value))]).filter(tokens => tokens.length > 0);
    const tokenFrequency = new Map();
    for (const tokens of concepts) for (const token of tokens) tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
    const replyTokens = new Set(referentTokens(normalizedReply));
    const semanticResolution = concepts.some(tokens => {
      const overlap = tokens.filter(token => replyTokens.has(token));
      return overlap.length >= 2 || overlap.some(token => tokenFrequency.get(token) === 1);
    });

    const hasResolution = allItems.some(item => normalizedReply.includes(item)) || semanticResolution ||
                          /\\b(?:no public evidence|not documented|unknown|unclear|not listed|public evidence does not|does not indicate)\\b/i.test(reply);`,
'replace brittle plural referent matching');

  text = replaceOnce(text,
`      const boundedUnknown = /\\b(?:unknown|not\\s+(?:verified|documented|established|known)|no\\s+(?:verified|public|current)\\s+(?:evidence|record|information)|cannot\\s+verify|can't\\s+verify)\\b/i.test(reply);
      const explicitProgress = /\\b(?:is|currently|actively|has\\s+been)\\s+(?:working|learning|studying|practicing|training|developing|addressing|improving)\\b/i.test(reply);
      const sourceShowsProgress = learningTexts.some(item => /\\b(?:currently|actively|working\\s+on|learning|studying|taking\\s+(?:a\\s+)?course|practicing|training|developing|improving)\\b/i.test(item));`,
`      const boundedUnknown = /\\b(?:unknown|unclear|not\\s+clear|not\\s+(?:verified|documented|established|known)|no\\s+(?:verified|public|current)\\s+(?:evidence|record|information)|cannot\\s+verify|can't\\s+verify|does\\s+not\\s+establish|doesn't\\s+establish)\\b/i.test(reply);
      const explicitProgress = /\\b(?:is|currently|actively|presently|has\\s+been)\\s+(?:actively\\s+)?(?:working|seeking|learning|studying|taking|attending|practicing|training|developing|addressing|improving)\\b/i.test(reply);
      // Historical course/learning text is not CURRENT-progress evidence.
      const sourceShowsProgress = learningTexts.some(item => /\\b(?:currently|actively|presently|ongoing|in\\s+progress|working\\s+on\\s+now|working\\s+on\\s+currently)\\b/i.test(item));`,
'tighten plural current-progress scoring');
  return text;
});

editFile('lib/recovery-contract.js', text => {
  text = replaceOnce(text,
`  // === NEGATIVE PERSONAL CLAIMS (bad at, weak at, worst at) ===
  if (/\\b(?:what\\s+.*\\s+bad\\s+at|what\\s+is\\s+.*\\s+worst\\s+at|what\\s+.*\\s+weak\\s+at|what\\s+.*\\s+not\\s+good\\s+at)\\b/i.test(q) ||
      /\\b(?:bad\\s+at|weak\\s+at|worst\\s+at)\\b/i.test(q)) {`,
`  // === CURRENT PROGRESS ON PREVIOUSLY DISCUSSED GAPS ===
  if (/\\b(?:working\\s+on|work\\s+on|address(?:ing)?|improv(?:e|ing)|progress)\\b[^?.!]{0,80}\\b(?:them|these|those|gaps?|areas?|weakness(?:es)?)\\b/i.test(q) ||
      /\\b(?:is|has)\\s+(?:he|she|they)\\s+(?:currently\\s+|actively\\s+)?(?:working|addressing|improving)\\b/i.test(q)) {
    const learningItems = knowledge && knowledge.skills && knowledge.skills.learningOrAdjacent;
    return {
      intent: 'CURRENT_PROGRESS', subIntent: 'NEGATIVE_ASSESSMENT', directAnswer: 'UNKNOWN', factState: 'UNKNOWN',
      keyFacts: [
        Array.isArray(learningItems) && learningItems.length > 0 ? rawFact('learning_adjacent', learningItems) : rawFact('learning_adjacent', 'not documented in evidence'),
        rawFact('current_progress', 'not explicitly established in verified evidence')
      ],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Answer the current-progress question directly. Do not infer active work from transferable skills, prior courses, or a learning-area label. Unless verified facts explicitly say the candidate is currently/actively working on the referenced areas, state that current progress is unknown or not verified. Keep referenced items labeled as learning/gap areas, not personal weaknesses.'
    };
  }

  // === NEGATIVE PERSONAL CLAIMS (bad at, weak at, worst/biggest weakness) ===
  if (/\\b(?:what\\s+.*\\s+bad\\s+at|what\\s+is\\s+.*\\s+worst\\s+at|what\\s+.*\\s+weak\\s+at|what\\s+.*\\s+not\\s+good\\s+at)\\b/i.test(q) ||
      /\\b(?:bad\\s+at|weak\\s+at|worst\\s+at|(?:biggest|main|primary|greatest|honest)\\s+(?:honest\\s+)?weakness|weakness(?:es)?)\\b/i.test(q)) {`,
'add current-progress recovery branch and broaden negative trigger');

  text = replaceOnce(text,
`      instructions: 'Do not answer with unsupported negative personal or psychological claims. State only that no documented weaknesses were found. If learning/adjacent skills are available, mention them as areas being developed.'`,
`      instructions: 'Do not answer with unsupported negative personal or psychological claims and do not rank a biggest/main/primary weakness. State that no personal weakness is verified or documented. If learning/adjacent items are available, mention them separately as documented learning/gap areas. Do not imply they are currently being developed unless current activity is explicitly verified.'`,
'tighten negative recovery instructions');
  return text;
});

editFile('test/acceptance-scorer.test.js', text => {
  const sentinel = "test('strict live follow-up: ranked weakness is rejected at runtime validation'";
  if (text.includes(sentinel)) throw new Error('follow-up tests already present');
  text = replaceOnce(text,
`const { buildResponseContract } = require('../lib/response-contract');`,
`const { buildResponseContract } = require('../lib/response-contract');
const { validateAnswer } = require('../lib/grounding-validator');`,
'import grounding validator');

  return text + `

// Strict-live follow-up regressions
test('strict live follow-up: ranked weakness is rejected at runtime validation', () => {
  const contract = { intent: 'NEGATIVE_ASSESSMENT', subIntent: 'NEGATIVE_ASSESSMENT', directAnswer: 'UNKNOWN', factState: 'UNKNOWN', policyMode: 'VERIFIED_FACT' };
  const verdict = validateAnswer("Bradley's biggest honest weakness is his lack of experience with data structures and algorithms (DSA).", JSON.stringify(knowledge), "What's his biggest honest weakness?", knowledge, [], null, 'VERIFIED_FACT', contract);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reasons.includes('negative_assessment_ranked_weakness'), JSON.stringify(verdict.reasons));
});

test('strict live follow-up: invented active gap work is rejected', () => {
  const synthetic = JSON.parse(JSON.stringify(knowledge));
  synthetic.skills = synthetic.skills || {};
  synthetic.skills.learningOrAdjacent = [{ label: 'ERP and business workflows', summary: 'Limited direct ERP implementation evidence.' }];
  const contract = { intent: 'NEGATIVE_ASSESSMENT', subIntent: 'NEGATIVE_ASSESSMENT', directAnswer: 'UNKNOWN', factState: 'UNKNOWN', policyMode: 'VERIFIED_FACT' };
  const verdict = validateAnswer('Bradley is actively seeking to address his ERP and business workflow gaps by taking courses and attending workshops.', JSON.stringify(synthetic), 'Is he working on them?', synthetic, [], null, 'VERIFIED_FACT', contract);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reasons.includes('current_progress_unverified'), JSON.stringify(verdict.reasons));
});

test('strict live follow-up: current-progress question must actually answer current status', () => {
  const synthetic = JSON.parse(JSON.stringify(knowledge));
  synthetic.skills = synthetic.skills || {};
  synthetic.skills.learningOrAdjacent = [{ label: 'ERP and business workflows', summary: 'Limited direct ERP implementation evidence.' }];
  const contract = { intent: 'NEGATIVE_ASSESSMENT', subIntent: 'NEGATIVE_ASSESSMENT', directAnswer: 'UNKNOWN', factState: 'UNKNOWN', policyMode: 'VERIFIED_FACT' };
  const verdict = validateAnswer('Bradley has project-management and scheduling experience that could help with ERP and business workflows.', JSON.stringify(synthetic), 'Is he working on them?', synthetic, [], null, 'VERIFIED_FACT', contract);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reasons.includes('current_progress_not_answered'), JSON.stringify(verdict.reasons));
});

test('PLURAL_REFERENT accepts equivalent ERP/business wording with bounded uncertainty', () => {
  const synthetic = JSON.parse(JSON.stringify(knowledge));
  synthetic.skills = synthetic.skills || {};
  synthetic.skills.learningOrAdjacent = [{ label: 'ERP and business workflow depth', summary: 'Limited direct ERP implementation and business operations evidence.' }];
  const result = makeResult('Current progress on the ERP systems and business workflows is unclear from the verified profile.', { intent: 'NEGATIVE_ASSESSMENT', subIntent: 'NEGATIVE_ASSESSMENT', factState: 'UNKNOWN', directAnswer: 'UNKNOWN' });
  const c = { id: 'memory-follow-up-b', message: 'Is he working on them?', semanticType: 'PLURAL_REFERENT', expect: {} };
  const score = scoreCase(c, result, { knowledge: synthetic });
  assert.equal(score.quality, QUALITY.GOOD, score.reason);
});

test('PLURAL_REFERENT rejects invented current work without temporal evidence', () => {
  const synthetic = JSON.parse(JSON.stringify(knowledge));
  synthetic.skills = synthetic.skills || {};
  synthetic.skills.learningOrAdjacent = [{ label: 'ERP and business workflow depth', summary: 'Limited direct ERP implementation and business operations evidence.' }];
  const result = makeResult('Bradley is actively seeking to address ERP systems and business workflows by taking courses and attending workshops.', { intent: 'NEGATIVE_ASSESSMENT', subIntent: 'NEGATIVE_ASSESSMENT', factState: 'UNKNOWN', directAnswer: 'UNKNOWN' });
  const c = { id: 'memory-follow-up-b', message: 'Is he working on them?', semanticType: 'PLURAL_REFERENT', expect: {} };
  const score = scoreCase(c, result, { knowledge: synthetic });
  assert.equal(score.quality, QUALITY.OVERCLAIM, score.reason);
});
`;
});

console.log('ChatGPT negative/memory semantic guard patch applied.');
