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
  const keyFacts = extractKeyFacts(evidence, intent, activeEntities, knowledge);

  // Determine the direct answer if possible
  const directAnswer = determineDirectAnswer(q, intent, evidence, knowledge);

  // Determine required entities that MUST be named in the answer
  const requiredEntities = determineRequiredEntities(q, intent, activeEntities, knowledge);

  // Determine evidence strength (PROJECT, INTERNSHIP, CERTIFICATION, etc.)
  const evidenceStrength = determineEvidenceStrength(intent, evidence, knowledge);

  // Determine boundary (important limitation to mention if relevant)
  const boundary = determineBoundary(intent, q, evidence, knowledge);

  // Determine the response shape
  const responseShape = getResponseShape(intent);

  // Determine forbidden claims
  const forbiddenClaims = determineForbiddenClaims(intent, knowledge);

  // Build natural instructions for the model
  const naturalInstructions = buildNaturalInstructions(
    intent, directAnswer, keyFacts, activeEntities, responseShape, q,
    requiredEntities, evidenceStrength, boundary
  );

  return {
    intent,
    activeEntities,
    directAnswer,
    keyFacts,
    requiredEntities,
    evidenceStrength,
    boundary,
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
 * Uses knowledge entities (not hardcoded tech names) for scoring.
 */
function extractKeyFacts(evidence, intent, activeEntities, knowledge) {
  const evText = evidence || '';
  if (!evText) return [];

  // Split evidence into lines/chunks
  const lines = evText.split('\n').filter(l => l.trim().length > 10);

  // Build a set of knowledge entities for fact-density scoring (generic, not hardcoded)
  const knowledgeEntities = new Set();
  if (knowledge) {
    if (Array.isArray(knowledge.projects)) {
      for (const p of knowledge.projects) {
        if (p.name) knowledgeEntities.add(p.name.toLowerCase());
        if (Array.isArray(p.tech)) p.tech.forEach(t => knowledgeEntities.add(t.toLowerCase()));
      }
    }
    if (Array.isArray(knowledge.skills)) {
      for (const s of knowledge.skills) {
        const name = typeof s === 'string' ? s : (s.name || '');
        if (name) knowledgeEntities.add(name.toLowerCase());
      }
    }
    if (Array.isArray(knowledge.experience)) {
      for (const e of knowledge.experience) {
        if (e.company) knowledgeEntities.add(e.company.toLowerCase());
        if (e.role) knowledgeEntities.add(e.role.toLowerCase());
      }
    }
  }

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

    // Score by fact density — count knowledge entity mentions (generic)
    for (const ent of knowledgeEntities) {
      if (ent.length >= 3 && lineLower.includes(ent)) {
        score += 1;
      }
    }

    // Penalize very long lines (they're often context, not key facts)
    if (line.length > 300) score -= 2;

    return { line, score };
  });

  // Sort by score and take top 3 facts (keep it focused — 1-3 high-value facts)
  scored.sort((a, b) => b.score - a.score);
  const topFacts = scored
    .filter(s => s.score > 0)
    .slice(0, 3)
    .map(s => s.line.trim());

  return topFacts;
}

/**
 * Determine required entities that MUST be named in the answer.
 * These are entities from the question or conversation that the answer must reference.
 */
function determineRequiredEntities(question, intent, activeEntities, knowledge) {
  const required = [];
  const qLower = question.toLowerCase();

  // For comparison questions, both entities must be named
  if (intent === 'COMPARISON') {
    const compareMatch = question.match(/\b(?:compare|versus|vs\.?)\b\s+(.+?)\s+(?:and|to|with|vs\.?)\s+(.+)/i);
    if (compareMatch) {
      const e1 = matchToKnowledge(compareMatch[1].trim().split(/[,.\s]/)[0], knowledge);
      const e2 = matchToKnowledge(compareMatch[2].trim().split(/[,.\s]/)[0], knowledge);
      if (e1) required.push(e1);
      if (e2) required.push(e2);
    }
    // "Which project is the most complex?" — needs at least 2 project names from context
    if (/\bwhich\s+(?:project|one)\b/i.test(question) && activeEntities.length >= 2) {
      required.push(activeEntities[0], activeEntities[1]);
    }
  }

  // For project questions, the project entity must be named
  if (intent === 'PROJECT' && activeEntities.length > 0) {
    required.push(activeEntities[0]);
  }

  // For skill questions, the skill must be named
  if (intent === 'SKILL') {
    const skillMatch = question.match(/\b(?:know|use|used|familiar|experience with|skilled|done with)\b.*?\b(?:in|with)\s+([A-Za-z][A-Za-z0-9+#.-]+)/i);
    if (skillMatch) {
      required.push(skillMatch[1]);
    }
  }

  // For job-fit questions, the required skills from the question must be named
  if (intent === 'JOB_FIT') {
    const roleMatch = question.match(/(?:requiring|require|needs?|must have)\s+(.+?)(?:\?|$)/i);
    if (roleMatch) {
      const skills = roleMatch[1].split(/\s+and\s+|\s*,\s*/).map(s => s.trim());
      for (const s of skills) {
        if (s.length > 2) required.push(s);
      }
    }
  }

  // Deduplicate
  return [...new Set(required)];
}

/**
 * Determine evidence strength from the evidence text.
 * Returns: PROJECT, INTERNSHIP, CERTIFICATION, PROFESSIONAL, or null
 */
function determineEvidenceStrength(intent, evidence, knowledge) {
  const evLower = (evidence || '').toLowerCase();
  if (!evLower) return null;

  // Check INTERNSHIP first (most specific for entry-level candidates)
  if (/\b(?:internship|intern|capstone)\b/i.test(evLower)) return 'INTERNSHIP';
  // Check CERTIFICATION
  if (/\b(?:certification|certified|certificate)\b/i.test(evLower)) return 'CERTIFICATION';
  // Check PROJECT (built, personal project, portfolio)
  if (/\b(?:project|built|personal project|portfolio)\b/i.test(evLower)) return 'PROJECT';
  // Check PROFESSIONAL — but only if not negated
  if (/\b(?:professional|production|employed)\b/i.test(evLower) &&
      !/\b(?:no|not|without|lacking?)\s+(?:professional|production)\b/i.test(evLower)) {
    return 'PROFESSIONAL';
  }
  return null;
}

/**
 * Determine boundary — important limitation to mention if relevant.
 * Uses knowledge base, not hardcoded facts.
 */
function determineBoundary(intent, question, evidence, knowledge) {
  if (!knowledge) return null;
  const qLower = question.toLowerCase();

  // Check if the question is about production/professional experience
  if (/production|professional|senior|expert|years of experience/i.test(qLower)) {
    // Check if the candidate is entry-level
    const whoIAm = knowledge.summary?.whoIAm || '';
    if (/entry|junior|early/i.test(whoIAm)) {
      return 'entry-level — experience is internship and project-based, not production';
    }
  }

  // For job-fit questions, check if there are gaps
  if (intent === 'JOB_FIT') {
    const evLower = (evidence || '').toLowerCase();
    // If the evidence doesn't mention the required skill, note the gap
    const roleMatch = question.match(/(?:requiring|require|needs?)\s+(.+?)(?:\?|$)/i);
    if (roleMatch) {
      const required = roleMatch[1].toLowerCase();
      const requiredSkills = required.split(/\s+and\s+|\s*,\s*/);
      const gaps = requiredSkills.filter(s => !evLower.includes(s.trim()));
      if (gaps.length > 0) {
        return `no verified evidence for: ${gaps.join(', ')}`;
      }
    }
  }

  // For recruiter recommendation, note the career level
  if (intent === 'RECRUITER' && /interview|worth|hiring/i.test(qLower)) {
    const whoIAm = knowledge.summary?.whoIAm || '';
    if (/entry|junior|early/i.test(whoIAm)) {
      return 'entry-level candidate with internship and project experience';
    }
  }

  return null;
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
 * Determine the direct answer if possible (YES/NO/MIXED/PARTIAL_FIT/NOT_FIT/etc.)
 * The harness determines polarity from evidence — the model should not decide.
 */
function determineDirectAnswer(question, intent, evidence, knowledge) {
  const qLower = question.toLowerCase();
  const evLower = (evidence || '').toLowerCase();

  // Adversarial questions — answer is usually NO (claim is false)
  if (intent === 'ADVERSARIAL') {
    // Check if the claim is negated in the question itself
    // "There is no evidence he attended MIT, right?" — answer is YES (confirming no evidence)
    if (/\b(?:no\s+evidence|not\b|never\b|didn'?t\b|did not\b|no\s+mention|isn'?t\b|is not\b|wasn'?t\b|was not\b|doesn'?t\b|does not\b|haven'?t\b|have not\b|hasn'?t\b|has not\b)\b/i.test(question) &&
        /\b(?:right|correct|true)\b/.test(question)) {
      return 'YES'; // Confirming the negation
    }
    // "He was not a senior engineer, was he?" — answer is YES (confirming he wasn't)
    if (/\bwas he\b/.test(question) && /\bnot\b/.test(question)) {
      return 'YES'; // Confirming the negation
    }
    // Standard adversarial: "He was X, right?" — check if X is in evidence
    const claimEntity = question.match(/\b(?:he|she|they|bradley)\b.*?\b(?:was|is|has|have|did|worked|attended|managed|handled|built)\b\s+(?:a\s+|an\s+)?(.+)/i);
    if (claimEntity) {
      const claim = claimEntity[1].toLowerCase();
      const claimWords = claim.split(/\s+/).filter(w => w.length > 3);
      const supported = claimWords.some(w => evLower.includes(w));
      if (!supported) return 'NO';
    }
    return 'NO';
  }

  // Skill questions — check if the skill is in evidence
  if (intent === 'SKILL') {
    // "Does he know React?" / "Does he know X?" — direct object without preposition
    const directMatch = question.match(/\b(?:know|use|used|familiar with|experience with|skilled (?:in|with)|done with)\s+([A-Za-z][A-Za-z0-9+#.-]+)/i);
    if (directMatch) {
      const tech = directMatch[1].toLowerCase();
      // Check if the tech appears in evidence (not negated)
      const techPattern = new RegExp(`\\b${tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (techPattern.test(evLower)) return 'YES';
      return 'NO';
    }
    // "What has he done with X?" — not a yes/no, but needs evidence
    return null;
  }

  // Yes/No questions — check evidence for the key entity
  if (intent === 'YES_NO') {
    // "Was that real production work?" — check if evidence mentions production
    if (/production|professional/i.test(qLower)) {
      if (/internship|intern|capstone|training|project/i.test(evLower) &&
          !/production|professional work|employed/i.test(evLower)) {
        return 'NO'; // It was internship/project, not production
      }
    }
    // "Does that count as real cloud experience?" — if evidence has cloud work, YES
    if (/count as|real.*experience/i.test(qLower)) {
      if (/aws|lambda|dynamodb|s3|cloud|serverless/i.test(evLower)) {
        return 'YES';
      }
    }
    // "Did he do that professionally?" — check if evidence mentions professional work
    if (/professionally/i.test(qLower)) {
      if (/internship|intern|project|personal/i.test(evLower) &&
          !/professional|production|employed/i.test(evLower)) {
        return 'NO';
      }
    }
    return null;
  }

  // Comparison — always MIXED (both sides have trade-offs)
  if (intent === 'COMPARISON') return 'MIXED';

  // Job fit — determine FIT / PARTIAL_FIT / NOT_FIT from evidence
  if (intent === 'JOB_FIT') {
    const roleMatch = question.match(/(?:requiring|require|needs?)\s+(.+?)(?:\?|$)/i);
    if (roleMatch) {
      const required = roleMatch[1].toLowerCase();
      const requiredSkills = required.split(/\s+and\s+|\s*,\s*/).map(s => s.trim());
      // Check each skill — only count as match if NOT negated in evidence
      const matches = [];
      const gaps = [];
      for (const skill of requiredSkills) {
        if (skill.length < 2) continue;
        const skillPattern = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (skillPattern.test(evLower)) {
          // Check if the mention is negated (e.g., "No Kubernetes evidence")
          const negPattern = new RegExp(`(?:no|not|without|missing|lack(?:s|ing)?)\\s+[^.]*${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
          if (negPattern.test(evLower)) {
            gaps.push(skill);
          } else {
            matches.push(skill);
          }
        } else {
          gaps.push(skill);
        }
      }
      if (matches.length === requiredSkills.length) return 'FIT';
      if (matches.length > 0) return 'PARTIAL_FIT';
      return 'NOT_FIT';
    }
    // "What kind of role fits him best?" — not a fit judgment
    return null;
  }

  // Recruiter — determine YES/MIXED/NO from evidence
  if (intent === 'RECRUITER') {
    // "Is he worth interviewing?" / "Why would I interview him?"
    if (/\b(?:worth|interview|why.*interview)\b/.test(qLower)) {
      // If there's any positive evidence, recommend interviewing
      if (evLower.length > 50) return 'YES';
      return 'MIXED';
    }
    // "What concerns would you have?" — MIXED (honest about limitations)
    if (/\b(?:concern|weakness|gap|lack)\b/.test(qLower)) return 'MIXED';
    // "What should I ask him about?" — no polarity, just evidence
    // "Give me the quick version" — no polarity
    return null;
  }

  // Opinion — no direct answer (model expresses preference with evidence)
  if (intent === 'OPINION') {
    return null;
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
function buildNaturalInstructions(intent, directAnswer, keyFacts, activeEntities, responseShape, question,
  requiredEntities, evidenceStrength, boundary) {
  const instructions = [];

  // Direct answer / polarity guidance
  if (directAnswer === 'NO') {
    instructions.push('Start with "No" in a full sentence. Then state what is actually true.');
  } else if (directAnswer === 'YES') {
    instructions.push('Start with "Yes" and name the specific evidence.');
  } else if (directAnswer === 'MIXED') {
    instructions.push('Give a balanced answer with specific details from both sides.');
  } else if (directAnswer === 'FIT') {
    instructions.push('State that he fits the role. Name the specific matching skills and evidence.');
  } else if (directAnswer === 'PARTIAL_FIT') {
    instructions.push('State that he partially fits. Name matching skills AND note the gaps.');
  } else if (directAnswer === 'NOT_FIT') {
    instructions.push('State that he does not fit the role. Name the missing requirements.');
  }

  // Required entities — MUST be named in the answer
  if (requiredEntities && requiredEntities.length > 0) {
    instructions.push(`You MUST name these in your answer: ${requiredEntities.join(', ')}`);
  }

  // Key facts to include
  if (keyFacts.length > 0) {
    const facts = keyFacts.slice(0, 3).join(' ');
    instructions.push(`Include these specific details: ${truncate(facts, 200)}`);
  }

  // Evidence strength guidance
  if (evidenceStrength) {
    if (evidenceStrength === 'INTERNSHIP') {
      instructions.push('This is internship/project experience, not production experience. Do not upgrade it.');
    } else if (evidenceStrength === 'PROJECT') {
      instructions.push('This is project-based evidence. State it as project work, not professional experience.');
    } else if (evidenceStrength === 'CERTIFICATION') {
      instructions.push('This is certification evidence. State the certification name.');
    }
  }

  // Boundary — important limitation to mention
  if (boundary) {
    instructions.push(`Important limitation to mention if relevant: ${boundary}`);
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
