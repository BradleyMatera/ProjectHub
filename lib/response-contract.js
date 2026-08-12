'use strict';

// Semantic Response Contract
//
// Before generation, produces a compact response contract that tells the
// model WHAT to include and HOW to shape its answer. This is generic and
// works for any bot — it uses the evidence and knowledge abstractly.
//
// The contract is NOT exposed to the user. It is translated into natural
// instructions for the model prompt.

const { classifyIntent } = require('./completeness-check');

/**
 * Build a semantic response contract from the question, evidence, and knowledge.
 *
 * @param {string} question - The user's question
 * @param {string} evidence - Compressed evidence text
 * @param {object} knowledge - The knowledge base (optional)
 * @param {string[]} history - Recent conversation turns (optional)
 * @returns {object} Response contract
 */
function buildResponseContract(question, evidence, knowledge, history = []) {
  const intent = classifyIntent(question);
  const q = (question || '').trim();
  const qLower = q.toLowerCase();
  const evText = (evidence || '').toLowerCase();

  // Extract active entities from the question
  const activeEntities = extractActiveEntities(q, knowledge, history);

  // Extract key facts from evidence that should be in the answer
  const keyFacts = extractKeyFacts(evidence, intent, activeEntities);

  // Determine the direct answer if possible
  const directAnswer = determineDirectAnswer(q, intent, evidence, knowledge);

  // Determine the response shape
  const responseShape = getResponseShape(intent);

  // Determine forbidden claims
  const forbiddenClaims = determineForbiddenClaims(intent, knowledge);

  // Build natural instructions for the model
  const naturalInstructions = buildNaturalInstructions(intent, directAnswer, keyFacts, activeEntities, responseShape, q);

  return {
    intent,
    activeEntities,
    directAnswer,
    keyFacts,
    responseShape,
    forbiddenClaims,
    naturalInstructions,
  };
}

/**
 * Extract active entities from the question and conversation context.
 */
function extractActiveEntities(question, knowledge, history) {
  const entities = [];

  // Extract capitalized phrases from the question
  const capMatches = question.match(/\b[A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*\b/g) || [];
  for (const cap of capMatches) {
    // Skip common English words
    if (isCommonWord(cap)) continue;
    entities.push(cap);
  }

  // Extract entities from recent history (last 3 turns)
  for (let i = Math.max(0, history.length - 3); i < history.length; i++) {
    const turnText = String(history[i]?.text || history[i]?.user || history[i]?.assistant || '');
    const turnCaps = turnText.match(/\b[A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*\b/g) || [];
    for (const cap of turnCaps) {
      if (isCommonWord(cap)) continue;
      if (!entities.some(e => e.toLowerCase() === cap.toLowerCase())) {
        entities.push(cap);
      }
    }
  }

  // Match entities against known projects/skills/companies if knowledge available
  if (knowledge) {
    const matched = [];
    for (const entity of entities) {
      const matched_entity = matchToKnowledge(entity, knowledge);
      if (matched_entity) {
        matched.push(matched_entity);
      } else {
        matched.push(entity);
      }
    }
    return matched;
  }

  return entities;
}

/**
 * Match an entity string to a known project, skill, or company.
 */
function matchToKnowledge(entity, knowledge) {
  const norm = entity.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Check projects
  if (Array.isArray(knowledge.projects)) {
    for (const proj of knowledge.projects) {
      const pNorm = (proj.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (pNorm.includes(norm) || norm.includes(pNorm)) {
        return proj.name;
      }
      if (Array.isArray(proj.aliases)) {
        for (const alias of proj.aliases) {
          const aNorm = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (aNorm.includes(norm) || norm.includes(aNorm)) {
            return proj.name;
          }
        }
      }
    }
  }

  // Check experience/companies
  if (Array.isArray(knowledge.experience)) {
    for (const exp of knowledge.experience) {
      const cNorm = (exp.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cNorm.includes(norm) || norm.includes(cNorm)) {
        return exp.company;
      }
    }
  }

  return entity;
}

/**
 * Extract key facts from the evidence that should be in the answer.
 * This is the core of the contract — it tells the model WHAT to say.
 */
function extractKeyFacts(evidence, intent, activeEntities) {
  const evText = evidence || '';
  if (!evText) return [];

  // Split evidence into lines/chunks
  const lines = evText.split('\n').filter(l => l.trim().length > 10);

  // Score each line by relevance to the intent and active entities
  const scored = lines.map(line => {
    let score = 0;
    const lineLower = line.toLowerCase();

    // Score by active entity mentions
    for (const entity of activeEntities) {
      const eNorm = entity.toLowerCase().replace(/[^a-z0-9]/g, '');
      const lineNorm = lineLower.replace(/[^a-z0-9]/g, '');
      if (lineNorm.includes(eNorm)) {
        score += 3;
      }
    }

    // Score by intent-relevant keywords
    const intentKeywords = getIntentKeywords(intent);
    for (const kw of intentKeywords) {
      if (lineLower.includes(kw)) {
        score += 2;
      }
    }

    // Score by fact density (lines with specific tech names, numbers, etc.)
    const techMatches = lineLower.match(/\b(?:javascript|typescript|react|node\.js|express|aws|lambda|dynamodb|s3|amplify|docker|github|html|css|webgpu|scout|projecthub|ciris|pokedex|voice.?ops)\b/g) || [];
    score += techMatches.length;

    // Penalize very long lines (they're often context, not key facts)
    if (line.length > 300) score -= 2;

    return { line, score };
  });

  // Sort by score and take top 3-5 facts
  scored.sort((a, b) => b.score - a.score);
  const topFacts = scored
    .filter(s => s.score > 0)
    .slice(0, 5)
    .map(s => s.line.trim());

  return topFacts;
}

/**
 * Get intent-relevant keywords for fact scoring.
 */
function getIntentKeywords(intent) {
  const keywordMap = {
    SKILL: ['experience', 'built', 'used', 'project', 'skill', 'tech'],
    ADVERSARIAL: ['not', 'no', 'intern', 'entry', 'never', 'did not'],
    COMPARISON: ['uses', 'tech', 'built', 'project', 'different'],
    JOB_FIT: ['experience', 'skill', 'role', 'fit', 'react', 'aws', 'node'],
    RECRUITER: ['experience', 'gap', 'weakness', 'strength', 'learning', 'entry'],
    PROJECT: ['built', 'uses', 'tech', 'description', 'project'],
    PROFILE: ['experience', 'skill', 'project', 'education', 'certification'],
    OPINION: ['project', 'interesting', 'complex', 'impressive', 'built'],
    YES_NO: ['yes', 'no', 'not', 'did', 'was', 'is'],
    FOLLOW_UP: ['uses', 'tech', 'built', 'project'],
    GENERAL: ['experience', 'project', 'skill', 'built'],
  };
  return keywordMap[intent] || keywordMap.GENERAL;
}

/**
 * Determine the direct answer if possible (YES/NO/MIXED/PROJECT_ONLY/etc.)
 */
function determineDirectAnswer(question, intent, evidence, knowledge) {
  const qLower = question.toLowerCase();

  // Adversarial questions — answer is usually NO
  if (intent === 'ADVERSARIAL') {
    // Check if the claim is in the evidence
    const claimEntity = question.match(/\b(?:he|she|they|bradley)\b.*?\b(?:was|is|has|have|did|worked|attended|managed|handled|built)\b\s+(?:a\s+|an\s+)?(.+)/i);
    if (claimEntity) {
      const claim = claimEntity[1].toLowerCase();
      // If the claim contains words not in evidence, it's likely false
      const evLower = (evidence || '').toLowerCase();
      const claimWords = claim.split(/\s+/).filter(w => w.length > 3);
      const supported = claimWords.some(w => evLower.includes(w));
      if (!supported) return 'NO';
    }
    return 'NO';
  }

  // Yes/No questions
  if (intent === 'YES_NO' || intent === 'SKILL') {
    const evLower = (evidence || '').toLowerCase();
    // Extract the key entity from the question
    const techMatch = question.match(/\b(?:know|use|used|familiar|experience with|skilled)\b.*?\b(?:in|with)\s+([A-Za-z][A-Za-z0-9+#.-]+)/i);
    if (techMatch) {
      const tech = techMatch[1].toLowerCase();
      if (evLower.includes(tech)) return 'YES';
      return 'NO';
    }
  }

  // Comparison — always MIXED
  if (intent === 'COMPARISON') return 'MIXED';

  // Opinion — no direct answer
  if (intent === 'OPINION') {
    // But for "what's he best at" or "what's the coolest part", we need specific evidence
    if (/\b(?:best\s+at|strongest|coolest|cool\s+part|most\s+interesting|most\s+impressive)\b/.test(qLower)) {
      return null; // No direct answer, but contract will require specific evidence
    }
    return null;
  }

  // Recruiter recommendation
  if (intent === 'RECRUITER') {
    if (/\b(?:why.*interview|worth|interview)\b/.test(qLower)) return 'YES';
    if (/\b(?:concern|weakness|gap|lack)\b/.test(qLower)) return 'MIXED';
  }

  return null;
}

/**
 * Get the response shape for an intent.
 */
function getResponseShape(intent) {
  const shapes = {
    SKILL: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'Answer yes or no first',
        'Name the specific project or experience that demonstrates the skill',
        'State the evidence level (project, internship, or professional)',
      ],
    },
    ADVERSARIAL: {
      minSentences: 1,
      maxSentences: 2,
      requirements: [
        'Start with No in a full sentence',
        'State what is actually true',
        'Do not repeat the false claim',
      ],
    },
    COMPARISON: {
      minSentences: 2,
      maxSentences: 4,
      requirements: [
        'Mention both entities by name',
        'State at least one meaningful difference',
        'Use specific tech or purpose details',
      ],
    },
    JOB_FIT: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'State whether he fits the role',
        'Name the specific skills that match',
        'Note any gaps if relevant',
      ],
    },
    RECRUITER: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'Answer the recruiter question directly',
        'Reference specific evidence about the candidate',
        'Do not give generic recruiter advice',
      ],
    },
    PROJECT: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'Describe what the project is',
        'Name specific technologies used',
        'Mention what it does or why it matters',
      ],
    },
    PROFILE: {
      minSentences: 2,
      maxSentences: 4,
      requirements: [
        'Summarize who the candidate is',
        'Name 2-3 key skills or technologies',
        'Mention their career level',
      ],
    },
    OPINION: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'State your opinion directly',
        'Give a specific reason grounded in evidence',
        'Name at least one specific project or technology from the facts',
        'Do not say "simple projects" or "basic technologies" — name the actual tech',
      ],
    },
    YES_NO: {
      minSentences: 1,
      maxSentences: 2,
      requirements: [
        'Answer yes or no first',
        'Add one supporting fact',
      ],
    },
    FOLLOW_UP: {
      minSentences: 1,
      maxSentences: 3,
      requirements: [
        'Answer the follow-up question directly',
        'Use context from the conversation',
        'Name specific details from evidence',
      ],
    },
    GENERAL: {
      minSentences: 1,
      maxSentences: 3,
      requirements: [
        'Answer the question directly',
        'Use specific evidence, not generic statements',
      ],
    },
  };
  return shapes[intent] || shapes.GENERAL;
}

/**
 * Determine forbidden claims based on intent and knowledge.
 */
function determineForbiddenClaims(intent, knowledge) {
  const forbidden = [];

  if (knowledge) {
    // If entry-level, forbid seniority claims
    const isEntryLevel = knowledge.summary?.whoIAm && /entry|junior|early/i.test(knowledge.summary.whoIAm);
    if (isEntryLevel) {
      forbidden.push('senior', 'expert', 'extensive experience', 'managed teams', 'leadership role');
    }
  }

  return forbidden;
}

/**
 * Build natural instructions for the model from the contract.
 * These are translated into normal English, never exposing internal syntax.
 */
function buildNaturalInstructions(intent, directAnswer, keyFacts, activeEntities, responseShape, question) {
  const instructions = [];

  // Direct answer guidance
  if (directAnswer === 'NO') {
    instructions.push('Start with "No" in a full sentence. Then state what is actually true.');
  } else if (directAnswer === 'YES') {
    instructions.push('Start with "Yes" and name the specific evidence.');
  } else if (directAnswer === 'MIXED') {
    instructions.push('Give a balanced answer with specific details from both sides.');
  }

  // Key facts to include
  if (keyFacts.length > 0) {
    const facts = keyFacts.slice(0, 3).join(' ');
    instructions.push(`Include these specific details: ${truncate(facts, 200)}`);
  }

  // Response shape requirements (translated to natural language)
  for (const req of responseShape.requirements) {
    instructions.push(req);
  }

  // Anti-generic instruction
  instructions.push('Do not give a generic answer. Use specific project names, technologies, and details from the facts.');

  return instructions.join('\n');
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

const COMMON_WORDS = new Set([
  'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'Is', 'Was', 'Are', 'Were',
  'Has', 'Have', 'Had', 'Do', 'Does', 'Did', 'Will', 'Would', 'Could', 'Should',
  'Can', 'May', 'Might', 'He', 'She', 'They', 'It', 'His', 'Her', 'Their', 'Its',
  'And', 'But', 'Or', 'So', 'If', 'As', 'In', 'On', 'At', 'To', 'For', 'Of',
  'With', 'By', 'From', 'About', 'What', 'When', 'Where', 'How', 'Why', 'Who',
  'Okay', 'So', 'Well', 'Now', 'Then', 'Here', 'There', 'Yes', 'No', 'Not',
  'Give', 'Tell', 'Explain', 'Describe', 'Compare', 'Which', 'What',
  'Project', 'Projects', 'ProjectHub', 'Scout',
]);

function isCommonWord(s) {
  return COMMON_WORDS.has(s) || COMMON_WORDS.has(s.split(/\s+/)[0]);
}

module.exports = {
  buildResponseContract,
  classifyIntent,
};
