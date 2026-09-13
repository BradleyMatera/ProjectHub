'use strict';

// Grounding Validator — prevents hallucination and exaggeration in generated
// Scout answers. The model may write the answer, but it CANNOT invent the candidate's
// history. Every factual claim must be supported by Scout evidence.
//
// Validation layers:
//   1. Overclaim detection: flags exaggeration language ("expert", "led",
//      "production-ready", "mastery", etc.) with negation-aware context.
//   2. Entity grounding: capitalized tokens (project names, tech, employers)
//      must appear in the source evidence using normalized matching.
//   3. Number grounding: any number in the answer must appear in the evidence.
//   4. Content-word overlap: the answer must share enough content words with
//      the evidence to be grounded.
//   5. Question relevance: the answer must address the question's subject.
//   6. Length/structure: 1-2 sentences, ends with punctuation, not too long.
//   7. Upgrade detection: catches "worked with" → "expert in", "helped" → "led",
//      "internship" → "production", "learned" → "professional experience".
//   8. Claim-level validation: splits answer into sentences, detects negation
//      per-sentence, and only flags unsupported positive assertions.
//
// Returns a verdict: { valid, reasons[], verdict: 'supported'|'partial'|'unsupported', cleaned }

const { buildEntityRegistry, isEntityGrounded, normalizeEntity } = require('./canonical-entities');
const { validateRelationships, detectExpandedOverclaim, detectFabricatedEntities } = require('./relationship-validator');
const { buildRelationshipGraph } = require('./relationship-graph');
const { validateTechClaims, canonicalize, COMMON_ENGLISH_WORDS, GENERIC_DESCRIPTORS } = require('./tech-claim-validator');
const { evidenceSupportsTechnologyRelation, splitEvidenceBlocks, phraseAppears } = require('./evidence-relations');
const { getKnownTechnologies, findAuthoritativeNegativeAssessment } = require('./knowledge-access');
const { isTokenNegated, hasNegation: hasNegationShared, getNegatedClauses, stripDiscourseMarker } = require('./negation-scope');
const { validateClaims } = require('./claim-validator');
const scoutIdentity = require('./scout-identity');

const OVERCLAIM_RE = /\b(clear winner|best candidate|strong ai capabilities|production[- ]ready|enterprise[- ]ready|proven leader|guaranteed fit|valuable asset|deep expertise|years of experience|seasoned|veteran|senior engineer|architected|spearheaded|championed|revolutioniz(?:e|ed|ing)|cutting[- ]edge|state[- ]of[- ]the[- ]art|ground[- ]breaking|groundbreaking|game[- ]changer|industry[- ]leading|world[- ]class|disrupt(?:ive|ing|ed)?|transform(?:ative|ing)?\b|redefin(?:e|ed|ing)|next[- ]generation|paradigm shift)\b/i;

// Comparative claim detection regex — detects comparative language in
// generated text. This is NOT a blanket ban. Comparative statements are
// CLAIMS REQUIRING EVIDENCE. The validation path in relationship-validator.js
// checks whether the graph has comparative evidence to support them.
// "Atlas is faster than Orion" → supported if graph has comparative evidence.
// "Atlas is faster than Orion" → unsupported if no comparative evidence exists.
const COMPARATIVE_RE = /\b(?:better\s+(?:than|compared to)|more\s+(?:experienced|skilled|proficient|advanced|knowledgeable)\s+than|faster\s+than|superior\s+to|outperforms?|exceeds?\s+(?:all|every|most)|stronger\s+than|more\s+capable\s+than|ahead\s+of\s+(?:the\s+)?(?:competition|others|peers|alternatives)|top[- ]tier|best[- ]in[- ]class|unmatched|unrivaled|unsurpassed|second\s+to\s+none|the\s+best|the\s+most|the\s+fastest|the\s+strongest)\b/i;

// Upgrade patterns: the answer uses stronger language than the evidence supports.
const UPGRADE_PATTERNS = [
  { re: /\b(expert|master(?:ed|y)|deep knowledge)\b/i, flag: 'expertise_inflation', needs: /\b(expert|master(?:ed|y)|deep knowledge)\b/i },
  { re: /\b(led|leadership|headed|managed the team|directed)\b/i, flag: 'leadership_inflation', needs: /\b(led|leadership|headed|managed the team|directed)\b/i },
  { re: /\b(production system|production environment|live production|owned production)\b/i, flag: 'production_inflation', needs: /\b(production system|production environment|live production|owned production)\b/i },
  { re: /\b(senior|principal|staff)\b.*\b(engineer|developer|architect)\b/i, flag: 'seniority_inflation', needs: /\b(senior|principal|staff)\b.*\b(engineer|developer|architect)\b/i },
  { re: /\b(\d+)\s+years?\s+(of\s+)?experience\b/i, flag: 'years_claim', needs: null },
  // "built professionally" / "did professionally" — entry-level candidate
  // with only internship experience can't claim professional work
  { re: /\b(?:built|did|worked|developed)\s+(?:(?:their|the)\s+)?projects?\s+professionally\b/i, flag: 'professional_inflation', needs: /\bprofessionally\b/i },
  { re: /\bprofessionally\s+(?:built|developed|created)\b/i, flag: 'professional_inflation', needs: /\bprofessionally\b/i },
];

// Check if a specific clause/sentence contains negation (for skipping overclaim in negated context)
// Uses the shared negation-scope helper which strips discourse markers first.
function hasNegation(text) {
  return hasNegationShared(text);
}

const WEAKNESS_STOPWORDS = new Set([
  'the','and','or','is','are','was','were','his','her','their','him','he','she','they','candidate','subject',
  'biggest','main','primary','greatest','worst','honest','weakness','weaknesses','weak','gap','gaps','current',
  'documented','area','areas','skill','skills','learning','improving','working','improve','work','not','no',
  'but','has','have','had','with','for','from','that','this','these','those','one','only','just','like','about'
]);

function tokenizeForWeakness(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !WEAKNESS_STOPWORDS.has(w));
}

function collectAllowedWeaknessTokens(knowledge, assessment) {
  const allowed = new Set();
  const addTokens = (s) => {
    for (const w of tokenizeForWeakness(s)) allowed.add(w);
  };
  if (assessment?.answer) addTokens(assessment.answer);
  if (Array.isArray(knowledge?.summary?.honestGaps)) knowledge.summary.honestGaps.forEach(addTokens);
  if (Array.isArray(knowledge?.skills?.learningOrAdjacent)) {
    for (const item of knowledge.skills.learningOrAdjacent) {
      if (typeof item === 'string') addTokens(item);
      else addTokens(item?.name || item?.label || item?.skill || item?.title || item?.summary || '');
    }
  }
  if (Array.isArray(knowledge?.interviewStories)) {
    for (const story of knowledge.interviewStories) {
      addTokens(story?.prompt);
      addTokens(story?.answer);
    }
  }
  if (Array.isArray(knowledge?.faq)) {
    for (const entry of knowledge.faq) {
      addTokens(entry?.question);
      addTokens(entry?.answer);
    }
  }
  if (Array.isArray(knowledge?.directAnswers)) {
    for (const da of knowledge.directAnswers) {
      addTokens(da?.answer);
    }
  }
  return allowed;
}

function isRankedWeaknessSupported(text, question, knowledge) {
  const assessment = findAuthoritativeNegativeAssessment(knowledge, question);
  const answerTokens = tokenizeForWeakness(text);
  if (answerTokens.length === 0) return false;
  const allowed = collectAllowedWeaknessTokens(knowledge, assessment);
  return answerTokens.some(w => allowed.has(w));
}

// Split answer into sentences for claim-level analysis
// Handles periods in tech names (Node.js, React.js) by only splitting on
// sentence-ending punctuation: . ! ? followed by space + capital letter or end.
function splitSentences(text) {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z])|(?<=[.!?])$/)
    .map(s => s.trim())
    .filter(s => s.length >= 12);
  return parts.length > 0 ? parts : [text];
}

// Split a sentence into clauses (by semicolons, commas with conjunctions)
// so that negation in one clause doesn't mask positive assertions in another.
// e.g., "they were not a junior engineer; they were a senior engineer" →
//   ["they were not a junior engineer", "they were a senior engineer"]
function splitClauses(sentence) {
  // Split on semicolons first
  const semiParts = sentence.split(/[;]+/).map(s => s.trim()).filter(s => s.length > 5);
  if (semiParts.length > 1) return semiParts;
  // Split on ", but " or ", and " or ", however " if the parts are long enough
  const conjParts = sentence.split(/,\s*(?:but|however|rather|instead)\s+/i).map(s => s.trim()).filter(s => s.length > 10);
  if (conjParts.length > 1) return conjParts;
  return [sentence];
}

const QUESTION_STOPWORDS = new Set([
  'about', 'affect', 'could', 'does', 'doing', 'from', 'have',
  'looks', 'should', 'their', 'there', 'these', 'thing', 'think', 'those',
  'through', 'under', 'what', 'when', 'where', 'which', 'while', 'would',
  'tell', 'about', 'know', 'knows', 'show', 'give', 'explain', 'describe'
]);

// Add subject name parts to stopwords at runtime
let _subjectNameAlt = ''; // regex alternation like |name1|name2
let _assistantNamePattern = 'scout'; // default, overridden at runtime
function configureStopwords(subjectNames = []) {
  for (const name of subjectNames) {
    if (name) QUESTION_STOPWORDS.add(name.toLowerCase());
  }
  const valid = subjectNames.filter(Boolean).map(n => n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  _subjectNameAlt = valid.length > 0 ? '|' + valid.join('|') : '';
}
function configureAssistantName(name) {
  if (name) _assistantNamePattern = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanText(value, max) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
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
  const explicitCurrent = /\b(?:currently|actively|presently|ongoing|in\s+progress|working\s+on\s+now|working\s+on\s+currently)\b/i;
  return learningOrAdjacentTexts(knowledge).some(item => explicitCurrent.test(item));
}

function extractCompleteSentences(value, maxSentences = 2) {
  const text = cleanText(value, 1200);
  // Split on sentence-ending punctuation: . ! ? followed by space + capital letter, or end of string.
  // This handles periods in tech names (Node.js, React.js) correctly — they won't be split
  // because "Node." is followed by "js" (lowercase), not a capital letter.
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z])|(?<=[.!?])$/)
    .map(s => s.trim())
    .filter(s => s.length >= 12);
  return parts.slice(0, Math.max(1, maxSentences)).join(' ');
}

function findProjectMentions(text, projects) {
  const lower = text.toLowerCase();
  return (projects || []).filter(project => {
    const names = [project.name, ...(project.aliases || [])].filter(Boolean);
    return names.some(name => lower.includes(String(name).toLowerCase()));
  });
}

function documentedOccupation(role, company, knowledge, graph) {
  // Safe direction for company-tied roles: the documented role must contain the
  // asserted role. This prevents a stronger asserted role
  // ("Senior Quantum Cartographer") from inheriting support from a weaker
  // documented one ("Quantum Cartographer") at the same company.
  const roleMatches = documented => typeof documented === 'string' &&
    phraseAppears(documented, role);
  const companyMatches = documented => !company || normalizeEntity(documented) === normalizeEntity(company);
  if (graph?.triples?.some(triple => triple.relation === 'employed_as' &&
      normalizeEntity(triple.subject) === normalizeEntity(knowledge?.identity?.name || graph.subjectName) &&
      roleMatches(triple.object) && companyMatches(triple.meta?.company))) return true;
  // worked_at with role metadata: object is the company, meta.role is the role.
  if (graph?.triples?.some(triple => triple.relation === 'worked_at' &&
      normalizeEntity(triple.subject) === normalizeEntity(knowledge?.identity?.name || graph.subjectName) &&
      roleMatches(triple.meta?.role) && companyMatches(triple.object))) return true;
  if ((knowledge?.experience || []).some(exp => roleMatches(exp.role || exp.title) &&
      companyMatches(exp.company || exp.organization))) return true;
  // For identity-level role assertions (no company), an overlapping contiguous
  // subphrase in the documented title or whoIAm is enough support. This keeps
  // trailing context like "junior software engineer based in Denver" from
  // failing when the title is "Early-career Software Engineer".
  const softRoleMatches = documented => {
    if (typeof documented !== 'string' || !role) return false;
    const roleTokens = (String(role).toLowerCase().match(/[a-z0-9+#.\-/]+/g) || []);
    if (roleTokens.length < 2) return phraseAppears(documented, role) || phraseAppears(role, documented);
    for (let len = 2; len <= roleTokens.length; len++) {
      for (let start = 0; start <= roleTokens.length - len; start++) {
        const sub = roleTokens.slice(start, start + len).join(' ');
        if (phraseAppears(documented, sub) || phraseAppears(sub, documented)) return true;
      }
    }
    return false;
  };
  return !company && (softRoleMatches(knowledge?.identity?.title) || softRoleMatches(knowledge?.summary?.whoIAm));
}

function projectProvenanceClaims(text, target, projects) {
  const names = [target.name, ...(target.aliases || [])].filter(Boolean);
  const escapedNames = names.map(name => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const namePattern = `(?:${escapedNames.join('|')})`;
  const markers = 'freelance|internship|capstone|personal|professional|production|contributor';
  const claims = [];
  for (const sentence of String(text || '').split(/(?<=[.!?])\s+|[;\n]+/)) {
    for (const clause of sentence.split(/,?\s+(?:but|however|while|whereas)\s+/i)) {
      const patterns = [
        new RegExp(`\\b${namePattern}\\b\\s+(?:(?:is|was|has been)\\s+)?(?:(?:not|never)\\s+)?(?:built|created|developed|completed)?\\s*(?:(?:as|during|for|in|as part of|part of)\\s+)?(?:(?:a|an|the|his|her|their|own)\\s+)*(?:(${markers}))\\b(?:\\s+(?:project|work|app|application|capstone|engagement|experience|system))?`, 'gi'),
        new RegExp(`\\b(?:owned|owns|operated|operates|maintained|maintains)\\s+${namePattern}\\b\\s+in\\s+(production)\\b`, 'gi'),
        new RegExp(`\\b${namePattern}\\b\\s+(?:was|is)\\s+(?:owned|operated|maintained)\\s+in\\s+(production)\\b`, 'gi'),
        new RegExp(`\\b${namePattern}\\b\\s+(?:(?:was|is)\\s+)?(?:(?:not|never)\\s+)?(?:built|created|developed|completed)\\s+(?:during|as part of|for)\\s+(?:[a-z0-9'-]+\\s+){0,4}?(${markers})\\b`, 'gi')
      ];
      for (const [index, pattern] of patterns.entries()) {
        for (const match of clause.matchAll(pattern)) {
          if (isTokenNegated(clause.slice(0, match.index + match[0].length), match[1])) continue;
          if (findProjectMentions(match[0], projects).some(project => project !== target)) continue;
          claims.push({ marker: match[1].toLowerCase(), ownership: index > 0 });
        }
      }
    }
  }
  return claims;
}

function supportsProjectProvenance(target, claim, projects, evidenceInput) {
  const metadata = [target.category, target.type, target.context, target.builtDuring, target.built_during];
  // Structured evidence may carry category/type/builtDuring/context for a
  // specific entity. Treat those as provenance metadata when the block names
  // the target. Use splitEvidenceBlocks to normalise both string and array
  // evidence into a common block shape with .text and structured fields.
  const evidenceBlocks = splitEvidenceBlocks(evidenceInput);
  for (const block of evidenceBlocks) {
    const names = [block.name, block.sourceEntity, ...(block.aliases || [])].filter(Boolean);
    if (names.some(name =>
      name.toLowerCase() === (target.name || '').toLowerCase() ||
      (target.name || '').toLowerCase().startsWith(name.toLowerCase())
    )) {
      for (const field of ['category', 'type', 'builtDuring', 'context']) {
        if (block[field]) metadata.push(block[field]);
      }
    }
  }
  if (!claim.ownership && metadata.some(value => typeof value === 'string' &&
      phraseAppears(value, claim.marker) && !isTokenNegated(value, claim.marker))) return true;
  const texts = [target.description, target.summary, ...evidenceBlocks.map(block => block.text)].filter(Boolean);
  return texts.some(text => projectProvenanceClaims(text, target, projects)
    .some(supported => supported.marker === claim.marker && (!claim.ownership || supported.ownership)));
}

function detectCrossProjectProvenance(text, knowledge, evidenceText = '', evidence = null) {
  const projects = knowledge?.projects || [];
  if (projects.length === 0) return [];
  const issues = [];
  for (const target of projects) {
    for (const claim of projectProvenanceClaims(text, target, projects)) {
      if (!supportsProjectProvenance(target, claim, projects, evidence || evidenceText)) {
        issues.push(`${target.name}|${claim.marker}|unsupported_target`);
      }
    }
  }
  for (const sentence of splitSentences(text)) {
    const mentioned = findProjectMentions(sentence, projects);
    // Skip if no project mentioned or multiple projects mentioned
    // BUT: don't skip just because the sentence has negation — the negation
    // might be about a different aspect (e.g., "not hardcoding secrets" is
    // not a negation of the project claim, it's a description of a concept)
    if (mentioned.length !== 1) continue;
    // Only skip negation if it directly negates the project attribution
    // (e.g., "ProjectHub was not built with React" — don't flag React as wrong)
    const target = mentioned[0];
    const sentenceLower = sentence.toLowerCase();
    const targetCorpus = JSON.stringify(target).toLowerCase();
    for (const other of projects) {
      if (other === target) continue;
      // Fallback cross-project provenance marker detection: a sentence about a
      // target that uses a provenance marker (freelance, internship, etc.) and
      // another project's corpus contains that marker while the target's does
      // not, and neither target metadata nor evidence supports it, is a
      // cross-project provenance mismatch.
      const relationshipMarkers = ['freelance', 'internship', 'capstone', 'personal', 'professional', 'production', 'contributor'];
      for (const marker of relationshipMarkers) {
        if (sentenceLower.includes(marker) && !targetCorpus.includes(marker)) {
          const otherHasMarker = projects.some(p =>
            p !== target && JSON.stringify(p).toLowerCase().includes(marker)
          );
          if (otherHasMarker && !supportsProjectProvenance(target, { marker, ownership: false }, projects, evidence || evidenceText)) {
            issues.push(`${target.name}|${marker}|other`);
          }
        }
      }

      if (/\b(?:uses?|using|built with|powered by|tech(?:nology| stack)?)\b/i.test(sentence)) {
        for (const tech of other.tech || []) {
          const techLower = String(tech).toLowerCase();
          if (techLower.length < 3) continue;
          const { phraseAppears } = require('./evidence-relations');
          const { canonicalize: canonicalizeTech, resolveAlias: resolveTechAlias } = require('./tech-claim-validator');
          const techNormalizer = (token) => resolveTechAlias(canonicalizeTech(token));
          if (!phraseAppears(sentence, tech, techNormalizer)) continue;
          if (!targetCorpus.includes(techLower)) {
            const names = [target.name, ...(target.aliases || [])].filter(Boolean);
            if (!(evidence || evidenceText) || !evidenceSupportsTechnologyRelation(names, tech, evidence || evidenceText, { normalizeToken: techNormalizer })) {
              issues.push(`${target.name}|${tech}|${other.name}`);
            }
          }
        }
      }
      // Also check for distinctive description keywords from other projects
      // that appear in a sentence about this project (e.g., "secrets" from
      // Secrets & Env Vars Demo appearing in a sentence about Pokedex)
      if (other.description) {
        const otherDescWords = new Set(
          (other.description.toLowerCase().match(/[a-z][a-z0-9+#-]{4,}/g) || [])
            .filter(w => !/^(?:the|this|that|with|from|have|been|which|what|where|when|they|them|their|there|then|than|also|would|could|should|about|after|before|between|during|while|these|those|each|every|some|many|much|more|most|such|very|into|onto|upon|within|without|because|since|however|therefore|moreover|additionally|furthermore|nevertheless|nonetheless|project|experience|using|including|based|which|that|this|with|from|have|been|show|shows|shown|demonstrate|demonstrates)\b/.test(w)
              && !COMMON_ENGLISH_WORDS.has(w) && !GENERIC_DESCRIPTORS.has(w)
              && !/^(?:freelance|internship|capstone|personal|professional|production|contributor|authentication|authorization|deployment|development|application|applications|dashboard|interface|environments|environment|technology|technologies)$/.test(w)
              && !getKnownTechnologies(knowledge).some(tech => phraseAppears(tech, w)))
        );
        for (const word of otherDescWords) {
          if (word.length >= 8 && sentenceLower.includes(word) && !targetCorpus.includes(word)) {
            // Only flag if the word is distinctive (not a common word)
            // and appears in the other project's description but not this project's corpus
            issues.push(`${target.name}|${word}|${other.name}`);
          }
        }
      }
    }
  }
  return [...new Set(issues)];
}

// ---------------------------------------------------------------------------
// Leading-stance validation: the first visible sentence must align with the
// semantic contract (directAnswer, factState, answerStance, requiredStance).
// This is a small, high-confidence guard, not a general NLU classifier.
// ---------------------------------------------------------------------------

const LEADING_AFFIRM_RE = /^(?:yes|yeah|yep|yup|indeed|certainly|absolutely|it\s+is|(?:he|she)\s+is|they\s+are|(?:he|she|they)\s+(?:does|do|has|have|can)|there\s+is|there\s+are)\b/i;
const LEADING_DENY_RE = /^(?:no|nope|nah|not|(?:he|she)\s+isn['’]?t|(?:he|she)['’]?s\s+not|they['’]?re\s+not|they\s+aren['’]?t|(?:he|she|they)\s+(?:doesn['’]?t|does\s+not|don['’]?t|do\s+not|hasn['’]?t|has\s+not|haven['’]?t|have\s+not|cannot|can['’]?t)|there\s+is\s+no|there\s+is\s+not|there\s+isn['’]?t|there\s+are\s+no|it\s+is\s+not|it\s+isn['’]?t)\b/i;
// Named-subject hard denial: "Morgan definitely cannot use X", "Avery is
// unable to Y". Under an open-world UNKNOWN/QUALIFY contract a definitive
// capability denial is a stance violation — absence of evidence is not
// evidence of inability. Articles/determiners are excluded so qualified
// framings like "The evidence cannot confirm..." still parse as QUALIFY.
const LEADING_NAMED_DENY_RE = /^(?!(?:the|it|there|this|that|a|an|i|we|you|my|his|her|their|its)\b)[A-Z][A-Za-z0-9+#.'’-]*(?:\s+[A-Za-z0-9+#.'’]+){0,3}?\s+(?:definitely|absolutely|certainly|simply|just|really|clearly|currently)?\s*(?:cannot|can['’]?t|could\s+not|is\s+unable\s+to|will\s+never|would\s+never)\b/i;
const LEADING_QUALIFY_RE = /^(?:the\s+(?:available\s+)?evidence|it\s+is\s+not|there\s+is\s+(?:insufficient|no\s+verified|not\s+enough|no)\s+(?:evidence|information|data|record)|no\s+verified\s+evidence\s+establishes|there\s+is\s+no\s+direct\s+evidence\s+that|there\s+isn['’]?t\s+enough\s+evidence\s+to|the\s+profile\s+(?:does\s+not|doesn['’]?t)\s+(?:document|verify|establish)|the\s+public\s+profile\s+(?:does\s+not|doesn['’]?t)|the\s+(?:available\s+)?record\s+(?:does\s+not|doesn['’]?t)\s+(?:document|verify|establish)|it\s+is\s+not\s+(?:documented|verified|known|clear)|i\s+(?:don['’]?t|do\s+not)\s+(?:have|know)|i\s+cannot\s+confirm|it\s+is\s+unclear|it\s+is\s+unknown|the\s+answer\s+is\s+unknown|there\s+is\s+(?:insufficient|inadequate)|the\s+(?:available\s+)?evidence\s+is\s+(?:insufficient|inconclusive|unclear)|i\s+don['’]?t\s+have\s+(?:verified|sufficient|enough)\s+(?:evidence|information|data|records)|the\s+profile\s+documents\s+(?:a\s+gap|.*?rather\s+than\s+.*?)|the\s+profile\s+lists\s+.*?as\s+a\s+(?:gap|learning\s+area|documented\s+weakness))\b/i;

function parseLeadingStance(text) {
  const t = cleanText(text, 800).split(/[.!?](?:\s+|$)/, 1)[0].trim();
  // Check qualified/uncertain framing before bare denial, so phrases like
  // "There is no verified evidence..." are read as uncertainty rather than a
  // hard "No" under an UNKNOWN/QUALIFY contract.
  if (LEADING_QUALIFY_RE.test(t)) return 'QUALIFY';
  if (LEADING_DENY_RE.test(t) || LEADING_NAMED_DENY_RE.test(t)) return 'DENY';
  if (LEADING_AFFIRM_RE.test(t)) return 'AFFIRM';
  return 'UNKNOWN';
}

function expectedStance(responseContract) {
  const da = responseContract?.directAnswer;
  const fs = responseContract?.factState;
  const as = responseContract?.answerStance;
  const rs = responseContract?.requiredStance;
  // Negation-confirmation stances have special polarity: do not enforce a
  // simplistic leading word. Return null to skip the high-confidence guard.
  if (as === 'AFFIRM_NEGATION' || as === 'DENY_NEGATION' ||
      rs === 'AFFIRM_NEGATION' || rs === 'DENY_NEGATION') {
    return null;
  }
  // Authority order: explicit policy stance > answer stance > directAnswer > factState.
  if (rs === 'AFFIRM' || rs === 'DENY' || rs === 'QUALIFY') return rs;
  if (as === 'AFFIRM' || as === 'DENY' || as === 'QUALIFY') return as;
  if (da === 'YES' || da === 'FIT') return 'AFFIRM';
  if (da === 'NO' || da === 'NOT_FIT') return 'DENY';
  if (da === 'UNKNOWN' || da === 'MIXED' || da === 'PARTIAL_FIT') return 'QUALIFY';
  if (fs === 'TRUE') return 'AFFIRM';
  if (fs === 'FALSE') return 'DENY';
  if (fs === 'UNKNOWN' || fs === 'PARTIAL') return 'QUALIFY';
  return null;
}

function checkStance(text, question, responseContract) {
  if (!responseContract) return { valid: true };
  const expected = expectedStance(responseContract);
  if (!expected) return { valid: true };
  const actual = parseLeadingStance(text);
  if (actual === 'UNKNOWN') return { valid: true }; // not a strong leading stance
  if (expected === 'QUALIFY' && (actual === 'AFFIRM' || actual === 'DENY')) {
    return { valid: false, reason: 'stance_mismatch:contract_qualify', detail: `Expected qualified/uncertain leading stance; got ${actual.toLowerCase()}` };
  }
  if (expected === 'AFFIRM' && actual === 'DENY') {
    return { valid: false, reason: 'stance_mismatch:expected_affirm', detail: 'Expected affirmative leading stance; got negative' };
  }
  if (expected === 'DENY' && actual === 'AFFIRM') {
    return { valid: false, reason: 'stance_mismatch:expected_deny', detail: 'Expected negative leading stance; got affirmative' };
  }
  return { valid: true };
}

// Core validation. source = the concatenated evidence text the answer must be
// grounded in. question = the user's question (for relevance check).
// knowledge = optional knowledge object for relationship-aware validation.
function validateAnswer(answer, source, question = '', knowledge = null, history = [], graph = null, policyMode = null, responseContract = null, evidence = null) {
  const text = cleanText(answer, 800);
  const sourceText = cleanText(source, 16000).toLowerCase();
  const reasons = [];

  // Reject user-visible answers that leak RAG/prompt scaffolding references.
  // Phrases like "FACT 1" or "as mentioned in FACT 2" are internal labels;
  // plain words like "public evidence" or "verified information" are allowed.
  const SCAFFOLD_PATTERN = /\b(?:FACT|EVIDENCE)\s*\d+\b|\b(?:as mentioned in|based on|according to|provided by|retrieved from)\s+(?:FACT|EVIDENCE)\b|\bretrieved evidence\b|\bretrieved context\b|\bcontext block\b|\bevidence block\b|\bsource block\b|\[\s*[^\]\n]{2,80}\s*\]/i;
  if (SCAFFOLD_PATTERN.test(text)) {
    reasons.push('rag_scaffold_leak');
    return { valid: false, reasons, verdict: 'unsupported', cleaned: text };
  }

  // Future-capability questions with UNKNOWN current fact state must answer
  // future potential rather than collapse into a current yes/no lookup.
  if (responseContract?.subIntent === 'FUTURE_CAPABILITY' && responseContract?.factState === 'UNKNOWN') {
    const flatBinaryStart = /^\s*(?:yes|no)\b/i.test(text);
    const noInformationStart = /^\s*no\s+(?:verified\s+)?information\b/i.test(text);
    const futureLanguage = /\b(?:future|potential|learn|learning|could|would)\b/i.test(text);
    // A current-role claim only overclaims when the answer frames documented
    // skills as already qualifying the subject for the target role, or asserts
    // the subject currently can perform the role. Mentioning skills as a foundation is OK.
    // Claims inside a negated/refutational clause (e.g. "no verified evidence of
    // him having experience as a senior engineer") are explicit denials, not
    // positive current-role assertions, so they must not trigger this guard.
    const currentRoleRe = /\b(?:has\s+(?:already\s+)?(?:worked|experience)\s+(?:as|in\s+(?:a|the)\s+(?:role|position|job|capacity))|has\s+(?:already\s+)?(?:used|built)\s+(?:.*?)\s+(?:as|in\s+(?:a|the)\s+(?:role|position|job|capacity))|already\s+(?:knows|uses|can|demonstrated)|currently\s+(?:knows|uses|can)|has\s+experience\s+(?:as|with\s+(?:a|the))\s+(?:role|position|job)|can\s+(?:debug|use|build|work\s+with|handle)|is\s+(?:already|now)\s+(?:a|an)\s+(?:senior|lead|principal|staff|frontend|backend|full-stack))\b/ig;
    let currentRoleClaim = false;
    for (const match of text.matchAll(currentRoleRe)) {
      if (!isTokenNegated(text, match[0])) {
        currentRoleClaim = true;
        break;
      }
    }

    if (flatBinaryStart || noInformationStart) {
      return { valid: false, reasons: ['future_capability_wrong_frame'], verdict: 'unsupported', cleaned: text };
    }
    if (currentRoleClaim) {
      return { valid: false, reasons: ['future_capability_current_ability_overclaim'], verdict: 'overclaim', cleaned: text };
    }
    if (!futureLanguage) {
      return { valid: false, reasons: ['future_capability_missing_future_language'], verdict: 'unsupported', cleaned: text };
    }
  }

  // Facet follow-ups with UNKNOWN fact state must not assert a specific value.
  // The requested facet is not established in the knowledge base, so answers
  // like "the warranty is 30 days" overclaim even when raw source text happens
  // to mention a value.
  if (responseContract?.subIntent === 'ENTITY_FACET' && responseContract?.factState === 'UNKNOWN') {
    const valueAssertion = /\b(?:is|are|was|were|costs?|priced?|lasts?|covers?|extends?|offers?|provides?)\s+(?:[\$£€¥\d]|\d+(?:[-\s]+(?:day|days|month|months|year|years|hour|hours|minute|minutes|second|seconds|week|weeks))?\b)/i.test(text)
      || /\b\d+(?:\.\d+)?[-\s]*(?:day|days|month|months|year|years|hour|hours|minute|minutes|dollars?|usd|pounds?|euros?|€|\$|£)\b/i.test(text)
      || /\b[$£€¥]\s*\d+(?:\.\d{1,2})?\b/i.test(text)
      || /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:day|days|month|months|year|years|hour|hours|minute|minutes)\b/i.test(text);
    if (valueAssertion) {
      return { valid: false, reasons: ['facet_unknown_value_assertion'], verdict: 'overclaim', cleaned: text };
    }
  }

  // Negative-assessment/current-progress semantic guard. Deterministic code
  // rejects invalid semantic shapes; generative repair still authors the reply.
  if (responseContract?.subIntent === 'NEGATIVE_ASSESSMENT') {
    const rankedWeakness = /\b(?:his|her|their|the\s+candidate(?:'s)?|the\s+subject(?:'s)?|[a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?'s)\s+(?:(?:biggest|main|primary|greatest|worst|honest)\s+){0,3}weakness(?:es)?\s+(?:is|are)\b/i;
    const boundedWeakness = /\bweakness(?:es)?\s+(?:is|are)\s+(?:unknown|unclear|not\s+(?:verified|documented|established|known))\b/i;
    if (rankedWeakness.test(text) && !boundedWeakness.test(text)) {
      if (responseContract?.factState === 'UNKNOWN') {
        return { valid: false, reasons: ['negative_assessment_ranked_weakness'], verdict: 'overclaim', cleaned: text };
      }
      if (responseContract?.factState === 'TRUE') {
        // An explicitly supported ranked weakness is only allowed if the
        // answer's topic is grounded in the authoritative record or a documented
        // gap. The model cannot substitute its own topic even when factState
        // is TRUE.
        if (!isRankedWeaknessSupported(text, question, knowledge)) {
          return { valid: false, reasons: ['negative_assessment_ranked_weakness'], verdict: 'overclaim', cleaned: text };
        }
      }
    }

    if (responseContract?.factState === 'UNKNOWN') {
      const asksCurrentProgress = /\b(?:working\s+on|work\s+on|address(?:ing)?|improv(?:e|ing)|develop(?:ing)?|progress)\b/i.test(question);
      if (asksCurrentProgress) {
        const boundedUnknown = /\b(?:unknown|unclear|not\s+clear|not\s+(?:verified|documented|established|known)|no\s+(?:verified|public|current)\s+(?:evidence|record|information)|cannot\s+verify|can't\s+verify|does\s+not\s+establish|doesn't\s+establish)\b/i.test(text);
        const explicitProgressClaim = /\b(?:is|currently|actively|presently|has\s+been)\s+(?:actively\s+)?(?:working|seeking|learning|studying|taking|attending|practicing|training|developing|addressing|improving)\b/i.test(text);
        const progressSupported = hasExplicitCurrentProgressEvidence(knowledge);
        if (explicitProgressClaim && !progressSupported) return { valid: false, reasons: ['current_progress_unverified'], verdict: 'overclaim', cleaned: text };
        if (!boundedUnknown && !explicitProgressClaim) return { valid: false, reasons: ['current_progress_not_answered'], verdict: 'unsupported', cleaned: text };
      }
    }
  }

  // Build the authoritative known-technology set from structured knowledge.
  // When a knowledge object is provided, a tech is only supported if it appears
  // here — this prevents a full-KB source string (e.g., from unit tests) from
  // making any mentioned technology look grounded.
  const knownTechnologies = new Set();
  if (knowledge) {
    for (const t of getKnownTechnologies(knowledge)) {
      knownTechnologies.add(canonicalize(t));
    }
  }
  // Derive local subject name alternation from knowledge if module-level config hasn't been set
  let _localSubjectNameAlt = _subjectNameAlt;
  if (!_localSubjectNameAlt && knowledge) {
    const subjectName = knowledge.identity?.name || '';
    const preferredName = knowledge.identity?.preferredName || '';
    const aliases = knowledge.subjectAliases || [];
    const names = [subjectName, preferredName, ...aliases].filter(Boolean)
      .map(n => n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    _localSubjectNameAlt = names.length > 0 ? '|' + names.join('|') : '';
  } else if (!_localSubjectNameAlt) {
    // Fallback: extract from source text (e.g., "Morgan built...")
    const sourceNameMatch = source.match(/^([A-Z][a-z]{3,})\s+(?:built|worked|has|is|was|completed|developed|created)/);
    if (sourceNameMatch) {
      _localSubjectNameAlt = '|' + sourceNameMatch[1].toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  // eslint-disable-next-line no-console
  if (process.env.DEBUG_FALSE_NEGATION) console.error('DEBUG validateAnswer called, knowledge:', !!knowledge, 'text:', text.slice(0, 80));

  const CONTROL_MODES = new Set(['GREETING', 'USER_PROFILE_UPDATE', 'USER_PROFILE_QUERY', 'THANKS', 'FAREWELL', 'HELP', 'CONVERSATIONAL', 'SMALL_TALK', 'REQUEST_TO_SAY', 'CLARIFY_PREVIOUS_ASSISTANT', 'OUT_OF_SCOPE', 'REFUSAL', 'META']);
  if (CONTROL_MODES.has(policyMode)) {
    if (!text || text.length < 1) return { valid: false, reasons: ['empty'], verdict: 'unsupported', cleaned: text };
    if (text.length > 300) return { valid: false, reasons: ['too_long'], verdict: 'unsupported', cleaned: text };
    if ((text.match(/[.!?]+(?:\s|$)/g) || []).length > 5) return { valid: false, reasons: ['too_many_sentences'], verdict: 'unsupported', cleaned: text };
    // Declines must stay brief — a scope refusal should be one or two short
    // sentences, not a paragraph of policy explanation.
    if ((policyMode === 'REFUSAL' || policyMode === 'OUT_OF_SCOPE') &&
        text.split(/\s+/).filter(Boolean).length > 40) {
      return { valid: false, reasons: ['too_long'], verdict: 'unsupported', cleaned: text };
    }
    if (OVERCLAIM_RE.test(text) || detectExpandedOverclaim(text).length > 0) {
      return { valid: false, reasons: ['overclaim_language'], verdict: 'unsupported', cleaned: text };
    }
    return { valid: true, reasons: [], verdict: 'valid', cleaned: text };
  }

  // Refusal-shaped prose on a substantive turn is a mode mismatch — the model
  // echoed a decline instead of answering (e.g. leaking the previous turn's
  // refusal into a normal question). Treat as invalid so repair can retry.
  if (/^i\s+(?:cannot|can'?t|can only|won'?t|will not|am unable to)\s+(?:assist|help|provide|engage|answer|support)\b|\bmy scope limitation is\b/i.test(text)) {
    return { valid: false, reasons: ['refusal_mismatch'], verdict: 'unsupported', cleaned: text };
  }

  if (text.length < 15) {
    // Allow short "Yes." or "No." answers for yes/no questions
    const isYesNoAnswer = /^(?:yes|no|yes\.|no\.)$/i.test(text.trim());
    const isYesNoQuestion = /\b(?:was|is|are|wasn't|isn't|did|does|do|can|could|will|would|should|have|has)\b.*\?$/i.test(question) ||
                           /\bright\??$/i.test(question) || /\bcorrect\??$/i.test(question) ||
                           /\b(?:did|was|is|are|does|do|can|could|will|would|should|have|has)\b/i.test(question);
    if (isYesNoAnswer && isYesNoQuestion) {
      // Valid yes/no answer — don't flag as too_short
    } else {
      reasons.push('too_short');
      return { valid: false, reasons, verdict: 'unsupported', cleaned: text };
    }
  }

  // 0. Conversation contradiction check — if this answer affirms something
  // the assistant previously denied (or denies something previously affirmed),
  // flag it. This prevents identity drift and factual flip-flopping across turns.
  if (history && history.length > 0) {
    const answerLower = text.toLowerCase();
    const answerAffirms = !/\b(?:no|not|never|doesn'?t|does not|don'?t|do not|isn'?t|is not|wasn'?t|was not|hasn'?t|has not|haven'?t|have not|cannot|can'?t|won'?t|will not|didn'?t|did not)\b/i.test(text);
    const currentIsFutureCapability = responseContract?.subIntent === 'FUTURE_CAPABILITY' && /\b(?:can\s+learn|could\s+learn|would\s+learn|will\s+learn|future\s+learn|learning\s+(?:potential|curve))\b/i.test(answerLower);
    for (const turn of history) {
      const prevAssistant = (turn.assistant || turn.text || '').toLowerCase();
      if (!prevAssistant || prevAssistant.length < 10) continue;
      const prevDenied = /\b(?:no|not|never|doesn'?t|does not|don'?t|do not|isn'?t|is not|wasn'?t|was not|hasn'?t|has not|haven'?t|have not|cannot|can'?t|won'?t|will not|didn'?t|did not)\b/i.test(prevAssistant);
      // Check for technology stance contradictions
      const techMentions = answerLower.match(/\b(rust|go(?:lang)?|python|java|kotlin|swift|ruby|php|c\+\+|c#|scala|elixir|clojure|haskell|ocaml|f#|dart|julia|perl|lua|groovy|objective-?c|assembly|fortran|cobol|pascal|delphi|ada|prolog|lisp|scheme|racket|crystal|nim|zig|vlang|carbon|mojo|elm|purescript|idris|agda|coq|verilog|vhdl|systemverilog|matlab|mathematica|r|julia|sas|spss|stata)\b/i);
      if (techMentions) {
        const tech = techMentions[1];
        const prevMentionsTech = prevAssistant.includes(tech);
        // Future/potential answers can coexist with prior current-knowledge denials or affirmations.
        if (currentIsFutureCapability && prevMentionsTech) continue;
        if (prevMentionsTech && prevDenied && answerAffirms) {
          // Previously denied, now affirming — contradiction
          reasons.push(`conversation_contradiction:tech_${tech}`);
          break;
        }
        if (prevMentionsTech && !prevDenied && !answerAffirms) {
          // Previously affirmed, now denying — contradiction
          reasons.push(`conversation_contradiction:tech_${tech}`);
          break;
        }
      }
    }
  }
  if (text.length > 800) { reasons.push('too_long'); }
  if (!/[.!?]$/.test(text)) { reasons.push('no_terminal_punctuation'); }
  const sentenceCount = (text.match(/[.!?]+(?:\s|$)/g) || []).length;
  if (sentenceCount > 5) { reasons.push('too_many_sentences'); }

  // 1. Overclaim — clause-level negation-aware check.
  // Split into sentences and clauses, only flag overclaim in NON-negated clauses.
  const sentences = splitSentences(text);
  let overclaimFound = false;
  for (const sent of sentences) {
    const clauses = splitClauses(sent);
    for (const clause of clauses) {
      if (OVERCLAIM_RE.test(clause) && !hasNegation(clause)) {
        overclaimFound = true;
        break;
      }
    }
    if (overclaimFound) break;
  }
  if (overclaimFound) {
    reasons.push('overclaim_language');
  }
  // NOTE: Comparative claims are NOT blanket-banned here. They are detected
  // by COMPARATIVE_RE and validated as evidence-requiring claims in
  // relationship-validator.js. A comparative like "Atlas is faster than Orion"
  // may be supported if the graph has comparative evidence.

  // 1b. Expanded overclaim detection — catches variants the regex misses.
  // "extensive experience", "expertise in", "specializing in", "adept at",
  // "proficient in", "complex systems", "scalable infrastructure", etc.
  const expandedOverclaimMatches = detectExpandedOverclaim(text);

  // 1c. Job-fit overclaim — claiming to "fit" a requested role that requires
  // skills the candidate doesn't have. Uses the contract's requestedRole when
  // present rather than a hardcoded role vocabulary.
  const requestedRole = responseContract?.requestedRole;
  if (requestedRole && requestedRole.length >= 2) {
    const safeRole = String(requestedRole).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const jobFitRe = new RegExp(`\\b(?:fits?\\s+the\\s+(?:${safeRole})\\s*role|is\\s+a\\s+(?:great|good|strong|perfect)\\s+fit\\s+for\\s+(?:${safeRole}))\\b`, 'i');
    const jobFitOverclaim = text.match(jobFitRe);
    if (jobFitOverclaim) {
      // "despite not having X" is a concession, not a negation of the fit claim
      // Only skip if the answer explicitly denies fit or states that evidence is
      // insufficient to determine it.
      const deniesFit = /\b(?:does\s+not\s+fit|is\s+not\s+a\s+fit|not\s+a\s+(?:good|strong|perfect)\s+(?:fit|candidate|match)|no\s+(?:verified|public)\s+(?:evidence|record)|not\s+(?:documented|established|clear)|unknown|unclear|whether|if)\b[^.]{0,120}\b(?:fits?|fit\s+for)\b/i.test(text) ||
        /\b(?:lacks|does\s+not\s+have|does\s+not\s+have|missing)\s+(?:the\s+)?(?:required\s+|necessary\s+)?(?:skills|experience)\b/i.test(text);
      if (!deniesFit) {
        expandedOverclaimMatches.push(jobFitOverclaim[0]);
      }
    }
  }
  if (knowledge?.summary?.whoIAm && /\b(?:entry|junior|early|trainee)\b/i.test(knowledge.summary.whoIAm)) {
    const inflatedTitle = text.match(/\b(?:highly skilled|experienced\s+(?:[\w-]+\s+){0,3}?(?:engineer|developer|architect))\b/i);
    if (inflatedTitle && !hasNegation(text)) expandedOverclaimMatches.push(inflatedTitle[0]);
  }
  if (expandedOverclaimMatches.length > 0) {
    // Check each match for negation context. A strong phrase is also allowed
    // if the evidence itself uses the same root word (e.g., a documented gap
    // that says "architect a solution" permits an answer that says "architecting
    // solutions"). Skip matches whose root appears in the provided evidence.
    for (const phrase of expandedOverclaimMatches) {
      const phraseRoot = phrase.toLowerCase().replace(/\s+$/, '').replace(/(?:ed|ing|s)$/, '');
      if (sourceText && sourceText.toLowerCase().includes(phraseRoot) && phraseRoot.length > 4) {
        continue;
      }
      const idx = text.toLowerCase().indexOf(phrase.toLowerCase());
      if (idx >= 0) {
        // Use a TIGHT negation context — only 20 chars before the phrase
        // "No, they have extensive experience" should NOT be treated as negated
        // because "No" refutes the question, not the overclaim.
        const ctxStart = Math.max(0, idx - 20);
        const ctxEnd = Math.min(text.length, idx + phrase.length + 20);
        const context = text.slice(ctxStart, ctxEnd);
        // Check for negation that directly precedes or follows the overclaim
        // "not an expert in" or "not extensive experience" → negated
        // "No, they have extensive experience" → NOT negated (No refutes the question)
        const tightNegation = /\b(?:not|never)\s+(?:an?\s+|the\s+)?(?:extensive|expert|expertise|specializ|proficient|adept)/i.test(context) ||
                              /(?:extensive experience|expertise|specializ|proficient|adept)[^.!?]{0,10}\b(?:not|never)\b/i.test(context) ||
                              // "despite not having" is a concession, not a negation of the overclaim
                              // "fits the role" with "despite not having" is still an overclaim
                              false;
        // For "fits the role" overclaim, check if the answer actually denies fit
        const isFitClaim = /fits?\s+the\s+role|is\s+a\s+(?:great|good|strong|perfect)\s+fit/i.test(phrase);
        const deniesFit = /\b(?:does\s+not\s+fit|is\s+not\s+a\s+fit|not\s+a\s+good\s+fit|not\s+a\s+strong\s+fit|lacks\s+(?:the\s+)?(?:kubernetes|ci.?cd|devops)\s+(?:experience|skills))\b/i.test(text);
        if (isFitClaim && deniesFit) {
          // The answer denies fit, so don't flag
          continue;
        }
        if (!tightNegation) {
          reasons.push(`expanded_overclaim:${phrase}`);
          break; // one is enough to flag
        }
      }
    }
  }

  // 2. Upgrade detection — also negation-aware at clause level
  for (const pattern of UPGRADE_PATTERNS) {
    let patternFound = false;
    for (const sent of sentences) {
      const clauses = splitClauses(sent);
      for (const clause of clauses) {
        if (pattern.re.test(clause) && !hasNegation(clause)) {
          patternFound = true;
          break;
        }
      }
      if (patternFound) break;
    }
    if (patternFound) {
      if (pattern.needs && !pattern.needs.test(sourceText)) {
        reasons.push(`upgrade:${pattern.flag}`);
      } else if (!pattern.needs) {
        // years claim — must appear in source, unless refuting a question containing the number
        const yearsMatch = text.match(/\b(\d+)\s+years?\b/i);
        if (yearsMatch) {
          const numStr = yearsMatch[1];
          const inQuestion = String(question || '').includes(numStr);
          const isNegated = sentences.some(s => hasNegation(s) && s.includes(numStr));
          if (!sourceText.includes(numStr) && !inQuestion && !isNegated) {
            reasons.push('upgrade:years_claim_not_in_evidence');
          }
        }
      }
    }
  }

  // 3. Number grounding — contextual check.
  // A number is grounded if it appears in the source text OR if it was in the user's question
  // OR if it is mentioned in a negated refutation clause.
  // Build a set of known entity-name tokens from the tenant knowledge (e.g., project names).
  const knownEntityTokens = new Set(['Gen']);
  if (knowledge?.projects) {
    for (const p of knowledge.projects) {
      for (const token of String(p.name || '').split(/\s+/)) {
        if (token.length >= 3) knownEntityTokens.add(token);
      }
    }
  }
  const numberMatches = [...text.matchAll(/\b\d[\d.,]*\b/g)];
  for (const match of numberMatches) {
    const num = match[0];
    // Skip single-digit numbers that are part of entity names (e.g., "Gen 1" in "Static Gen 1 Pokedex UI")
    // These are not standalone number claims — they're part of proper nouns.
    const before = text.slice(Math.max(0, match.index - 10), match.index);
    const after = text.slice(match.index + num.length, match.index + num.length + 10);
    const afterToken = (after.match(/^[\s-]*([A-Za-z][A-Za-z0-9]*)/i) || [])[1];
    if (/Gen\s$/i.test(before) || (afterToken && knownEntityTokens.has(afterToken))) {
      continue; // Part of an entity name, not a number claim
    }
    const inQuestion = String(question || '').includes(num);
    const isNegated = sentences.some(s => hasNegation(s) && s.includes(num));
    if (inQuestion || isNegated) {
      continue; // Grounded in question context / refutation
    }

    // Extract ±30 chars of context around the number in the answer
    const ctxStart = Math.max(0, match.index - 30);
    const ctxEnd = Math.min(text.length, match.index + num.length + 30);
    const contextWindow = text.slice(ctxStart, ctxEnd).toLowerCase();
    // Content words from the context (3+ chars, excluding the number itself)
    const contextWords = (contextWindow.match(/[a-z][a-z]{2,}/g) || [])
      .filter(w => !/^\d/.test(w) && w.length >= 3);

    // Find all occurrences of the number as a whole word in the source text
    const numEscaped = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const numRegex = new RegExp(`\\b${numEscaped}\\b`, 'gi');
    let foundGrounded = false;
    let match2;
    while ((match2 = numRegex.exec(sourceText)) !== null) {
      if (contextWords.length === 0) {
        // No context words to check — accept the number as grounded
        foundGrounded = true;
        break;
      }
      // Check if any context word appears within 50 chars of this number occurrence
      const srcStart = Math.max(0, match2.index - 50);
      const srcEnd = Math.min(sourceText.length, match2.index + num.length + 50);
      const srcWindow = sourceText.slice(srcStart, srcEnd);
      if (contextWords.some(w => srcWindow.includes(w))) {
        foundGrounded = true;
        break;
      }
    }
    if (!foundGrounded) {
      reasons.push(`number_not_grounded:${num}`);
    }
  }

  // 4. Entity grounding — generic normalized matching.
  // Build entity registry from source text (any capitalized word in the
  // evidence is automatically grounded). Also matches normalized forms
  // so "VoiceOps" matches "Voice Ops" and normalized name parts match the full name.
  // Also includes the profile summary so common tech terms are grounded.
  //
  // Generic approach: a word is a "named entity claim" only if it appears
  // in a multi-word capitalized phrase or is a known proper noun pattern.
  // Single capitalized words at sentence start are common English, not entities.
  const { buildCompactProfileSummary } = require('./profile-summary');
  const profileSrc = source + '\n' + buildCompactProfileSummary();
  const entityRegistry = buildEntityRegistry(knowledge, profileSrc, evidence);
  // Requested role/domain terms are user context, not tenant evidence. They may
  // be named as comparison criteria without becoming subject facts.
  if (responseContract?.requestedRole) entityRegistry.add(normalizeEntity(responseContract.requestedRole));
  if (responseContract?.requestedTopic) entityRegistry.add(normalizeEntity(responseContract.requestedTopic));

  // Extract potential entity claims: multi-word capitalized phrases or
  // single capitalized words that are NOT at the start of a sentence.
  // Words at sentence start are capitalized by English convention and are
  // not necessarily named entities.
  const sentencesForEntities = splitSentences(text);
  const entityClaims = [];
  for (const sent of sentencesForEntities) {
    // Find multi-word capitalized phrases (likely named entities)
    const multiWord = sent.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
    for (const phrase of multiWord) {
      entityClaims.push(phrase);
    }
    // Find single capitalized words NOT at sentence start
    // (words after position 0 are more likely to be real entities)
    const words = sent.match(/\b[A-Z][A-Za-z0-9+#.-]{1,}\b/g) || [];
    for (const word of words) {
      const idx = sent.indexOf(word);
      // Skip if at sentence start (first 10 chars) — likely just English capitalization
      if (idx > 10 || /^[A-Z]{2,}$/.test(word)) {
        entityClaims.push(word);
      }
    }
  }

  // Detect negation context for entity grounding — entities mentioned in
  // negation ("did not work at Microsoft", "never attended MIT") should NOT
  // be flagged as ungrounded. They're being refuted, not asserted.
  // Uses the shared clause/proposition-aware negation scope helper so that
  // discourse markers ("No, Maria attended Stanford") do not mask positive
  // assertions, and negation only applies to the clause containing the
  // negation word, not the entire sentence.
  const negEntityContexts = getNegatedClauses(text);

  // Generic English descriptors that are NOT entity claims. These are
  // adjectives/description words from project descriptions (e.g. "Static Gen 1
  // Pokedex" from the Interactive Pokedex description text) or generic nouns
  // that never represent a fabricated entity.
  // IMPORTANT: generic technology, platform, learning, and infrastructure names
  // are deliberately NOT here. Tenant-specific brand names are not hardcoded;
  // each tenant's entities must be grounded in its own knowledge base.
  // Recognizable tech names must still pass entity grounding — an entity-
  // recognition exemption must NOT become a factual-grounding exemption.
  // "the candidate has Kubernetes experience" must fail grounding unless a supported
  // triple exists. Negated mentions ("no Kubernetes experience") are already
  // handled by the negation-context skip above.
  const GENERIC_DESCRIPTORS = new Set([
    'static', 'gen', 'interactive', 'generation', 'calculator', 'testing', 'entry',
    'entries', 'profile', 'summary', 'overview', 'background',
    'capstone', 'capstones', 'intern', 'interns', 'internship', 'trainee', 'associate',
    'native', 'ai-driven', 'driven', 'both', 'full', 'stack', 'end',
    'embeddable', 'uis', 'cloud', 'computing',
    'hello', 'hi', 'hey', 'welcome', 'dear',
    // Generic tech acronyms — not specific fabricated entities
    'ai', 'ml', 'dl', 'nlp', 'cv', 'rl', 'gan', 'llm', 'rag', 'bm25', 'rrf',
    'api', 'rest', 'graphql', 'grpc', 'rpc', 'sdk', 'cli', 'gui',
    'tdd', 'bdd', 'ddd', 'ci', 'cd', 'dev', 'qa', 'ux', 'ui', 'cx',
    'seo', 'sem', 'crm', 'erp', 'cms', 'dms', 'bi', 'etl', 'olap',
    'json', 'xml', 'yaml', 'html', 'css', 'sql', 'nosql', 'dom',
    'spa', 'mpa', 'pwa', 'ssr', 'ssg', 'isr', 'csr',
    'http', 'https', 'tcp', 'udp', 'dns', 'ssl', 'tls',
    'cpu', 'gpu', 'ram', 'ssd', 'hdd',
  ]);

  for (const token of entityClaims) {
    const tokenLower = token.toLowerCase();
    const inNegation = isTokenNegated(text, token);
    const inQuestion = String(question || '').toLowerCase().includes(tokenLower);
    // Entities in a negated/refutational clause (including question entities
    // repeated inside a denial like "No, they don't know COBOL") are being
    // refuted, not asserted, so they do not require source grounding.
    if (inNegation) continue;
    // Entities named in the user's question may be repeated or addressed in the answer.
    if (inQuestion) continue;
    // Skip common English descriptors — they're adjectives/generic words, not entity claims
    if (GENERIC_DESCRIPTORS.has(tokenLower)) continue;
    // Skip multi-word phrases starting with a generic descriptor
    const firstWord = tokenLower.split(/\s+/)[0];
    if (GENERIC_DESCRIPTORS.has(firstWord)) continue;
    // Skip entity grounding for GREETING mode — conversational responses may
    // mention nationalities, platforms, or other non-knowledge-base entities
    if (policyMode === 'GREETING') continue;
    if (!isEntityGrounded(token, entityRegistry)) {
      reasons.push(`entity_not_grounded:${token}`);
    }
  }

  // 4b. Technology claim support validation — checks whether each technology
  // mentioned in the answer is supported by the evidence packet (source),
  // not just the full knowledge base. This catches cases where a technology
  // exists in the knowledge base (used in other projects) but is not in the
  // evidence for THIS question. E.g., "Express" is in the KB but not in the
  // evidence packet for a tech_stack question that only mentions Node.js.
  const techClaimResult = validateTechClaims(text, source, knownTechnologies.size > 0 ? knownTechnologies : null);
  for (const unsupported of techClaimResult.unsupportedTechs) {
    reasons.push(`unsupported_tech_claim:${unsupported.technology}`);
  }

  // 5. Content-word overlap
  // Strip trailing punctuation from each match so "DynamoDB." doesn't fail to
  // match "DynamoDB" in the source. The regex character class includes "." for
  // version numbers (e.g. "Node.js") but trailing periods must be trimmed.
  const rawContentWords = text.toLowerCase().match(/[a-z][a-z0-9+#.-]{4,}/g) || [];
  const contentWords = rawContentWords.map(w => w.replace(/[.]+$/, ''));
  const groundedMatches = new Set(contentWords.filter(w => sourceText.includes(w)));
  // For adversarial refutations (answers that negate a false premise),
  // require only 1 content word overlap instead of 2. A short correct
  // refutation like "No. He was an intern, not senior." should pass even
  // though it doesn't share many content words with the evidence.
  // For invented-entity refutations ("No, they did not work at Microsoft."),
  // accept 0 overlap — the answer is correctly denying a false premise.
  const isRefutation = hasNegation(text) && groundedMatches.size >= 1;
  const isInventedEntityRefutation = /^(?:no[,.]?\s+)?(?:he|she|they)\s+(?:did not|never|has not|hasn't|doesn't|does not|attended|worked)\b/i.test(text) ||
    /^(?:no[,.]?\s+)?there\s+is\s+no\s+(?:evidence|record)/i.test(text);
  // For yes/no questions, a short answer like "Yes, they know React." is valid
  // with just 1 content word overlap (the entity being asked about).
  const isYesNoQuestion = /^(?:does|do|is|was|has|have|can|could|would|will|are|were|did)\b/i.test(question.trim()) ||
                          /\bright\??$/i.test(question) || /\bcorrect\??$/i.test(question);
  const isPureYesNo = /^(?:yes|no|yes\.|no\.)$/i.test(text.trim());
  const isShortYesNo = isYesNoQuestion && groundedMatches.size >= 1 && text.length < 100;
  const isOpenEndedQuestion = /\b(quick version|summary|brief|tell me about|honest thing|best at|strongest|weakness|weaknesses|gap|gaps|why (?:should|would) i|interview\w*|mit|harvard|stanford|degree from|actually do|bet on|role|lack|lacks|concern|concerns|what experience)\b/i.test(question);
  const isGreeting = /^(?:hi|hey|hello|yo|sup|good (?:morning|afternoon|evening)|hi\s+my\s+name\s+is)\b/i.test(question.trim()) ||
    /^(?:hi|hey|hello|yo|sup|good (?:morning|afternoon|evening))[\s!,.?]*$/i.test(question.trim());
  const isRefusal = /\b(?:not (?:able to|in a position to)|cannot|can'?t (?:share|provide|disclose)|not (?:in|part of) (?:public|verified) (?:data|information)|outside (?:my|the) scope|only answer (?:recruiter|professional))\b/i.test(text);
  if (groundedMatches.size < 2 && !isRefutation && !isShortYesNo && !isInventedEntityRefutation && !isOpenEndedQuestion && !(isPureYesNo && isYesNoQuestion) && !isGreeting && !isRefusal) { reasons.push('insufficient_content_overlap'); }

  // 6. Question relevance — match on full word, stem prefix, or short tech terms.
  // Include 3-char tech terms (AWS, SQL, API) that the {4,} regex misses.
  // This is a SOFT check: only hard-fail if the answer shares NO topic overlap
  // with the question at all (no terms, no entities, no topic words).
  const SHORT_TECH_TERMS = new Set(['aws', 'sql', 'api', 'css', 'html', 'url', 'gcp', 'npm', 'git', 'hub', 's3', 'ec2', 'rds']);
  // Build a local stopword set that includes subject names derived from knowledge
  // so question relevance filtering works even before configureStopwords is called.
  const localStopwords = new Set(QUESTION_STOPWORDS);
  if (knowledge) {
    const subjectName = knowledge.identity?.name || '';
    const preferredName = knowledge.identity?.preferredName || '';
    const aliases = knowledge.subjectAliases || [];
    for (const name of [subjectName, preferredName, ...aliases]) {
      if (name) {
        const parts = String(name).toLowerCase().split(/\s+/).filter(p => p.length >= 4);
        for (const p of parts) localStopwords.add(p);
      }
    }
  } else {
    // Fallback: extract potential subject name from source and question
    // when knowledge is not available (e.g., unit tests without configuration)
    const sourceNameMatch = source.match(/^([A-Z][a-z]{3,})\s+(?:built|worked|has|is|was|completed|developed|created|made|wrote|designed|interned|graduated|studied|used|knows|learned)/);
    if (sourceNameMatch) localStopwords.add(sourceNameMatch[1].toLowerCase());
    const questionNameMatch = question.match(/(?:did|does|do|is|was|has|have|can|could|will|would|should|about|tell me about)\s+([A-Z][a-z]{3,})\b/);
    if (questionNameMatch) localStopwords.add(questionNameMatch[1].toLowerCase());
  }
  const longQuestionTerms = (String(question).toLowerCase().match(/[a-z][a-z0-9+#.-]{4,}/g) || [])
    .filter(w => !localStopwords.has(w));
  const shortQuestionTerms = (String(question).toLowerCase().match(/[a-z][a-z0-9+#.]{2,3}\b/g) || [])
    .filter(w => SHORT_TECH_TERMS.has(w));
  const allQuestionTerms = [...longQuestionTerms, ...shortQuestionTerms];
  if (allQuestionTerms.length > 0) {
    const answerLower = text.toLowerCase();
    const answered = allQuestionTerms.some(w => answerLower.includes(w) || answerLower.includes(w.slice(0, 4)));
    if (!answered && !hasNegation(text) && !isInventedEntityRefutation && !isOpenEndedQuestion && policyMode !== 'GREETING') { reasons.push('not_relevant_to_question'); }
  }

  // AI slop / self-revelation
  if (/\b(as an ai|i am an ai|i'?m an ai|based on the (data|information|evidence) provided|according to (the )?(data|information|evidence))\b/i.test(text)) {
    reasons.push('ai_slop');
  }

  // Leaked internal/prompt language — the model echoes phrases from the
  // system prompt or repair instructions instead of answering naturally.
  // These are broken outputs that must never be displayed to the user.
  const LEAKED_PROMPT_PATTERNS = [
    /\bnot (?:directly )?related to the question\b/i,
    /\bthe (?:current )?answer is (?:too )?(?:brief|short)\b/i,
    /^\s*\[\s*[^\]\n]{2,80}\s*\]\s+\S/m,
  ];
  for (const pat of LEAKED_PROMPT_PATTERNS) {
    if (pat.test(text)) {
      reasons.push('leaked_prompt_language');
      break;
    }
  }

  // Leaked internal syntax — the model sometimes echoes relation names or
  // internal graph terminology from the context/repair packet instead of
  // verbalizing them naturally. These are broken outputs that must never
  // be displayed to the user.
  // Examples: "worked_at modern web development", "uses_tech in the project",
  //           "connecting entities", "technology/entity not in the knowledge base"
  // NOTE: "attended" is excluded because it's a common English verb.
  //       "certified_in" is excluded because "certified in AWS" is natural English.
  //       "proficient_in" is excluded because "proficient in React" is natural English.
  //       These relation names only leak as snake_case identifiers, so we match
  //       the snake_case form instead of the bare word.
  const LEAKED_RELATION_NAMES = /\b(?:worked_at|uses_tech|has_experience|has_skill|built_by|built_during|interned_at|employed_as|is_type|has_expertise|has_extensive_experience|specializes_in|adept_at|context_drift|unsupported_relationship|fabricated_entity|insufficient_content)\b/i;
  if (LEAKED_RELATION_NAMES.test(text)) {
    reasons.push('leaked_relation_syntax');
  }
  // Also catch "tech=" shorthand that the model sometimes produces
  const LEAKED_TECH_SYNTAX = /\btech\s*=\s*[A-Z]/i;
  if (LEAKED_TECH_SYNTAX.test(text)) {
    reasons.push('leaked_relation_syntax');
  }
  const LEAKED_INTERNAL_PHRASES = /\b(?:connecting entities|technology\/entity not in the knowledge base|entity not in the knowledge base|not in the knowledge base|not grounded in|invalid based on the provided facts|relationship between.*is invalid|unsupported relationship|not supported by (?:the )?(?:provided )?facts)\b/i;
  if (LEAKED_INTERNAL_PHRASES.test(text) || /\b(?:unknown|unsupported) (?:technology|skill|entity|relationship)\b[^.!?]{0,100}\b(?:treated|classified|marked|reported) as\b/i.test(text)) {
    reasons.push('leaked_internal_language');
  }

  // 7. Persona confusion — check if the answer uses first person
  // when it should be talking about the subject in third person.
  // Scout is the assistant; the subject is separate.
  // Only flag CLEAR first-person claims about the subject's experience,
  // not incidental mentions of titles like "software engineer".
  const firstPersonClaimPatterns = [
    /\bi (?:am|was|have|had|built|worked|used|created|developed|managed|led|learned|know|specialize|helped|designed)\b/i,
    /\bmy (?:work|experience|projects?|skills?|role|background|career|expertise|internship|degree|education|ability|abilities|strengths?|weaknesses?|certifications?|employment)\b/i,
    /\bin my (?:role|position|experience|work|capacity|internship|time at)\b/i,
    /\bas a software (?:engineer|developer|architect|intern)\b/i
  ];
  for (const pattern of firstPersonClaimPatterns) {
    if (pattern.test(text)) {
      // Check if there's also third-person reference — if so, it's probably
      // a mixed answer where the model is explaining its reasoning.
      // Pure first-person without any third-person reference is persona confusion.
      const hasThirdPerson = new RegExp(`\\b(he|his|him|she|her|they|their|the candidate|the subject${_localSubjectNameAlt})\\b`, 'i').test(text);
      if (!hasThirdPerson) {
        reasons.push('persona_confusion');
      }
      break;
    }
  }

  // 7b. Assistant/Subject Persona Boundary Check — the assistant is the assistant, the subject is the subject.
  // The assistant must NOT claim ownership of the subject's education, degree, employment, internship, or project authorship.
  const assistantSubjectConflationPatterns = [
    new RegExp(`\\b${_assistantNamePattern}'?s?\\s+(?:education|degree|gpa|university|college|internship|employment|work|career)\\b`, 'i'),
    new RegExp(`\\b(?:built|developed|created|made|written)\\s+by\\s+(?:${_assistantNamePattern}|the\\s+assistant)\\b`, 'i'),
    new RegExp(`\\b(?:${_assistantNamePattern}|the\\s+assistant)\\s+(?:worked|interned|graduated|studied|built|developed|completed)\\b`, 'i'),
    new RegExp(`\\b(?:${_assistantNamePattern}|the\\s+assistant)\\s+has\\s+(?:built|developed|created|made|written|designed)\\b`, 'i'),
    new RegExp(`\\b(?:${_assistantNamePattern}|the\\s+assistant)\\s+(?:is|was)\\s+(?:an?\\s+)?(?:embeddable|AI|recruiter)\\b`, 'i'),
    // "the assistant is a developer/engineer" — the assistant is an AI, not a developer
    new RegExp(`\\b${_assistantNamePattern}\\s+is\\s+(?:a|an)\\s+(?:web\\s+)?(?:developer|engineer|programmer|coder|designer|architect)\\b`, 'i'),
    // "the assistant has experience" — the assistant is an AI, it doesn't have personal experience
    new RegExp(`\\b${_assistantNamePattern}\\s+has\\s+(?:experience|skills|knowledge|background)\\b`, 'i'),
    new RegExp(`\\bprojecthub\\s+(?:and|vs\\.?|versus)\\s+${_assistantNamePattern}\\b`, 'i'),
    new RegExp(`\\b${_assistantNamePattern}\\s+(?:and|vs\\.?|versus)\\s+projecthub\\b`, 'i'),
    // "I am not [candidate name]" — the assistant should never claim to be or not be the candidate
    new RegExp(`\\bi\\s+am\\s+not\\s+(?:the\\s+candidate|the\\s+subject${_localSubjectNameAlt})\\b`, 'i'),
    // "I am [candidate name]" — the assistant should never claim to be the candidate
    new RegExp(`\\bi\\s+am\\s+(?:the\\s+candidate|the\\s+subject${_localSubjectNameAlt})\\b`, 'i')
  ];
  for (const pat of assistantSubjectConflationPatterns) {
    // "I am/I am not the candidate" is always persona confusion, regardless of negation
    const isIdentityClaim = pat.source.includes('i\\s+am');
    if (isIdentityClaim) {
      if (pat.test(text)) {
        reasons.push('persona_confusion:assistant_subject_conflation');
        break;
      }
    } else {
      const match = text.match(pat);
      if (match) {
        // Check negation only in the context around the match, not the entire text
        // This avoids false negatives when the text contains unrelated negations
        const matchIdx = match.index || 0;
        const ctxStart = Math.max(0, matchIdx - 30);
        const ctxEnd = Math.min(text.length, matchIdx + match[0].length + 30);
        const context = text.slice(ctxStart, ctxEnd);
        if (!hasNegation(context)) {
          reasons.push('persona_confusion:assistant_subject_conflation');
          break;
        }
      }
    }
  }

  // 7c0. Assistant denying its own existence — "the assistant is a hypothetical character",
  // "the assistant is fictional", "the assistant is not a real AI" — persona confusion
  const selfDenialPatterns = [
    new RegExp(`\\b(?:${_assistantNamePattern}|i)\\s+(?:is|am)\\s+(?:a\\s+)?(?:hypothetical|fictional|not\\s+a\\s+real|just\\s+a\\s+character|not\\s+real)\\b`, 'i'),
    new RegExp(`\\b(?:${_assistantNamePattern}|i)\\s+(?:do(?:es)?\\s+not|don'?t|doesn'?t)\\s+have\\s+(?:any\\s+)?(?:specific\\s+)?(?:technical|real)\\s+(?:background|knowledge|experience)\\b`, 'i'),
  ];
  for (const pat of selfDenialPatterns) {
    if (pat.test(text)) {
      reasons.push('persona_confusion:assistant_self_denial');
      break;
    }
  }

  // 7c0a. Leadership/seniority overclaim — "experience with leadership roles",
  // "managed teams", "leadership experience" — overclaim for entry-level
  if (knowledge && knowledge.targetRoles) {
    const isEntryLevel = knowledge.targetRoles.some(r =>
      /entry|junior|intern|trainee/i.test(r)
    );
    if (isEntryLevel) {
      const leadershipPatterns = [
        /\b(?:experience|background|skills?)\s+(?:with|in|including)\s+(?:leadership|management)\s+roles?\b/i,
        /\b(?:has|have)\s+(?:leadership|management)\s+(?:experience|roles?)\b/i,
        /\b(?:managed|led|directed)\s+(?:teams?|groups?|departments?)\b/i,
      ];
      for (const pat of leadershipPatterns) {
        if (pat.test(text) && !hasNegation(text)) {
          reasons.push('expanded_overclaim:leadership_roles');
          break;
        }
      }
    }
  }

  // 7c. Visitor/Subject Persona Boundary Check — the assistant must not treat the
  // visitor as the subject. When the question asks about the subject ("him", "he",
  // "his", or by name), the answer should use third-person not second-person ("your") for the subject's attributes.
  // Example: "I'm interested in learning about your experience" → persona confusion
  // But "You could ask him about..." is fine — that's Scout addressing the visitor.
  const questionAboutSubject = new RegExp(`\\b(?:him|his|her|their|(?:he|she|they)\\b${_localSubjectNameAlt})\\b`, 'i').test(question || '');
  if (questionAboutSubject) {
    // Match "your [attribute]" where the attribute is something that belongs
    // to the subject, not the visitor
    const visitorAsSubjectPatterns = [
      /\byour\s+(?:experience|projects?|skills?|degree|internship|work|education|career|background|certifications?|employment)\b/i,
      /\byour\s+(?:time|role|position|job|training|intern)\b/i
    ];
    for (const pat of visitorAsSubjectPatterns) {
      if (pat.test(text)) {
        // Check if it's a legitimate address to the visitor
        // "You could ask him about your project" — this is still about the visitor's project, not the subject's
        // Only flag if the "your" is NOT in a "you could/should/might" clause
        const youClause = /\b(?:you|you'd|you'll|you'll|you(?:r)?(?:\s+(?:could|should|might|can|may|would)))\b/i.test(text);
        const yourInAttribution = /\byour\s+(?:experience|projects?|skills?|degree|internship|work|education|career|background|certifications?|employment|time|role|position|job|training)\b/i.test(text);
        if (yourInAttribution) {
          reasons.push('persona_confusion:visitor_as_subject');
          break;
        }
      }
    }
  }

  // 7d0. Scout asking the visitor a question — persona confusion
  // Example: "What specific skills or projects do you have experience with?"
  // Scout should answer questions, not ask them (except for the visitor's name).
  const scoutAskingQuestion = /^(?:what|how|which|why|tell me about|could you|would you|do you have|what specific)\b[^.?!]*\?$/im.test(text);
  if (scoutAskingQuestion) {
    // Allow "You could ask him about..." style suggestions
    const isSuggestion = /\b(?:you could|you should|you might|you can|you may|you would|ask him|ask about)\b/i.test(text);
    if (!isSuggestion) {
      reasons.push('persona_confusion:scout_asking_visitor');
    }
  }

  // 7d. False negation check — if the answer says "no experience building/with"
  // but the graph has built_by triples for the subject, this is a false negation.
  // Example: "He has no experience with building software." when the subject has
  // multiple built_by triples.
  if (knowledge) {
    try {
      const relGraph = graph || buildRelationshipGraph(knowledge);
      // eslint-disable-next-line no-console
      if (process.env.DEBUG_FALSE_NEGATION) console.error('DEBUG false negation block entered, graph triples:', relGraph.triples.length);
      const falseNegationPatterns = [
        // Only flag clear denials of ALL building experience, not qualified
        // assessments like "has not built anything substantial" or "has not
        // built a large-scale system" which are valid honest assessments.
        new RegExp(`\\b(?:he|she|they${_localSubjectNameAlt})\\s+(?:has|have)\\s+no\\s+(?:experience|background)\\s+(?:with|in|building|developing|creating)\\b`, 'i'),
        new RegExp(`\\b(?:he|she|they${_localSubjectNameAlt})\\s+(?:has|have)\\s+no\\s+(?:experience|background)\\b`, 'i'),
        // "his projects do not involve building anything" — denies all building
        /\b(?:his|her|their)\s+projects\s+(?:do\s+not|don't)\s+(?:involve|include)\s+building\b/i,
        // "he does not build" / "he didn't build anything"
        new RegExp(`\\b(?:he|she|they${_localSubjectNameAlt})\\s+(?:does|do|did)\\s+not\\s+build\\s+(?:anything|any\\s+(?:projects|software|applications))\\b`, 'i'),
        // "no specific project is mentioned as being built by him" — denies
        // building experience by claiming no evidence of built projects
        /\bno\s+(?:specific\s+)?(?:project|application|software)\s+(?:is\s+)?(?:mentioned|known|listed)\s+as\s+being\s+built\b/i,
        // "not with building projects or applications" — denies building
        /\bnot\s+with\s+building\s+(?:projects|applications|software)\b/i,
        // "has not done any professional projects" — denies all professional work
        new RegExp(`\\b(?:he|she|they${_localSubjectNameAlt})\\s+(?:has|have)\\s+not\\s+done\\s+any\\s+professional\\s+(?:projects|work|experience)\\b`, 'i'),
      ];
      for (const pat of falseNegationPatterns) {
        if (pat.test(text)) {
          // Check if the graph has built_by triples for the subject
          const builtByTriples = relGraph.triples.filter(t => t.relation === 'built_by');
          if (builtByTriples.length > 0) {
            reasons.push('false_negation:denies_building_experience');
            break;
          }
        }
      }

      // Check for "lacks experience with X" where X is a project the subject built
      const lacksPattern = new RegExp(`\\b(?:he|she|they${_localSubjectNameAlt})\\s+lacks\\s+experience\\s+(?:with|in)\\s+([A-Z][A-Za-z0-9\\s&.-]{2,50})`, 'gi');
      const builtProjectNames = relGraph.triples
        .filter(t => t.relation === 'built_by')
        .map(t => (t.subject || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
      let lacksMatch;
      while ((lacksMatch = lacksPattern.exec(text)) !== null) {
        const claimedEntity = lacksMatch[1].trim();
        const claimedNorm = claimedEntity.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Check if this entity is a project the subject built
        const isBuiltProject = builtProjectNames.some(name =>
          name.includes(claimedNorm) || claimedNorm.includes(name) ||
          (claimedNorm.length > 4 && name.length > 4 && claimedNorm.slice(0, 6) === name.slice(0, 6))
        );
        if (isBuiltProject) {
          reasons.push(`false_negation:lacks_experience_with_built_project:${claimedEntity}`);
          break;
        }
      }

      // Check for "has not worked in/with [technology]" or "has not used [technology]"
      // when the graph has uses_tech or has_skill triples for that technology
      const techDenialPattern = new RegExp(`\\b(?:he|she|they${_localSubjectNameAlt})\\s+(?:has|have)\\s+not\\s+(?:worked\\s+(?:in|with|on)|used)\\s+([A-Za-z][A-Za-z0-9]+(?:\\s+[A-Za-z0-9]+){0,3})`, 'gi');
      // Also check "do not include [tech/experience]" and "does not have [tech] experience"
      // Allow optional adjectives like "real", "actual", "formal", "professional" between
      // the verb and the technology name
      // Also allow "projects and skills" or "skills and experience" combinations
      const techDenialPattern2 = /\b(?:his|her|their)\s+(?:projects(?:\s+and\s+(?:skills|experience|work))?|skills(?:\s+and\s+(?:experience|work))?|experience|work)\s+(?:do|does)\s+not\s+include\s+(?:(?:real|actual|formal|professional|production|any|much)\s+)?([A-Za-z][A-Za-z0-9]+(?:\s+[A-Za-z0-9]+){0,3})/gi;
      const techDenialPattern3 = new RegExp(`\\b(?:he|she|they${_localSubjectNameAlt})\\s+(?:do|does)\\s+not\\s+have\\s+(?:(?:real|actual|formal|professional|production|any|much)\\s+)?([A-Za-z][A-Za-z0-9]+(?:\\s+[A-Za-z0-9]+){0,3})\\s+experience\\b`, 'gi');
      // "has no experience with [tech]" / "has no direct experience with [tech]"
      const techDenialPattern4 = new RegExp(`\\b(?:he|she|they${_localSubjectNameAlt})\\s+(?:has|have)\\s+(?:no|not)\\s+(?:(?:direct|real|actual|formal|professional|production|any|much)\\s+)*experience\\s+(?:with|in|using)\\s+([A-Za-z][A-Za-z0-9]+)(?=\\s+(?:or|and|\\.|,|$))`, 'gi');
      // "does not indicate any experience with [tech]"
      const techDenialPattern5 = /\b(?:does|do)\s+not\s+indicate\s+(?:any\s+)?(?:(?:actual|real|formal|professional|production)\s+)*experience\s+(?:with|in|using)\s+(?:(?:real|actual)\s+)?([A-Za-z][A-Za-z0-9]+(?:\s+[A-Za-z0-9]+){0,3})/gi;
      // "do not indicate [adj] [tech] experience" — no preposition
      const techDenialPattern6 = /\b(?:does|do)\s+not\s+indicate\s+(?:(?:real|actual|formal|professional|production|any)\s+)?([A-Za-z][A-Za-z0-9]+)\s+experience\b/gi;
      const techTriples = relGraph.triples.filter(t =>
        t.relation === 'uses_tech' || t.relation === 'has_skill' || t.relation === 'has_expertise' || t.relation === 'has_gap'
      );
      const knownTechs = techTriples.map(t => (t.object || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
      // Also add broader experience terms from the graph
      const expTriples = relGraph.triples.filter(t =>
        t.relation === 'worked_at' || t.relation === 'interned_at' || t.relation === 'employed_as'
      );
      const knownExpAreas = expTriples.map(t => (t.object || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
      const allKnownAreas = [...knownTechs, ...knownExpAreas];

      const checkDenial = (deniedTech) => {
        const deniedNorm = deniedTech.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Extract significant words from the denied tech (skip common words)
        const skipWords = new Set(['the', 'a', 'an', 'or', 'and', 'in', 'with', 'on', 'environment', 'services', 'service', 'technologies', 'technology', 'real', 'actual', 'formal', 'professional', 'production']);
        const deniedWords = deniedTech.toLowerCase().split(/\s+/).filter(w => w.length >= 2 && !skipWords.has(w));
        // Check if this technology/experience is in the graph
        const isKnown = allKnownAreas.some(tech =>
          tech === deniedNorm ||
          tech.startsWith(deniedNorm) || deniedNorm.startsWith(tech) ||
          (deniedNorm.length >= 3 && tech.includes(deniedNorm)) ||
          (deniedNorm.length >= 3 && deniedNorm.includes(tech)) ||
          deniedWords.some(w => tech.startsWith(w.replace(/[^a-z0-9]/g, '')) && w.replace(/[^a-z0-9]/g, '').length >= 3)
        );
        return isKnown;
      };

      let techDenialMatch;
      while ((techDenialMatch = techDenialPattern.exec(text)) !== null) {
        if (checkDenial(techDenialMatch[1].trim())) {
          reasons.push(`false_negation:denies_tech_experience:${techDenialMatch[1].trim()}`);
          break;
        }
      }
      while ((techDenialMatch = techDenialPattern2.exec(text)) !== null) {
        if (checkDenial(techDenialMatch[1].trim())) {
          reasons.push(`false_negation:denies_tech_experience:${techDenialMatch[1].trim()}`);
          break;
        }
      }
      while ((techDenialMatch = techDenialPattern3.exec(text)) !== null) {
        if (checkDenial(techDenialMatch[1].trim())) {
          reasons.push(`false_negation:denies_tech_experience:${techDenialMatch[1].trim()}`);
          break;
        }
      }
      while ((techDenialMatch = techDenialPattern4.exec(text)) !== null) {
        if (checkDenial(techDenialMatch[1].trim())) {
          reasons.push(`false_negation:denies_tech_experience:${techDenialMatch[1].trim()}`);
          break;
        }
      }
      while ((techDenialMatch = techDenialPattern5.exec(text)) !== null) {
        if (checkDenial(techDenialMatch[1].trim())) {
          reasons.push(`false_negation:denies_tech_experience:${techDenialMatch[1].trim()}`);
          break;
        }
      }
      while ((techDenialMatch = techDenialPattern6.exec(text)) !== null) {
        if (checkDenial(techDenialMatch[1].trim())) {
          reasons.push(`false_negation:denies_tech_experience:${techDenialMatch[1].trim()}`);
          break;
        }
      }
    } catch (e) { /* ignore graph errors */ }
  }

  // 7e. Certification grounding — if the answer claims specific certifications,
  // verify each one against the knowledge base. This prevents fabricated
  // certifications like "AWS Certified Developer Associate" when the actual
  // certification is "AWS Certified Solutions Architect - Associate".
  if (knowledge && knowledge.certifications) {
    // Derive the certification vendor pattern from the tenant's own certs instead
    // of hardcoding cloud/learning vendor names. For "AWS Certified X" the vendor
    // is "AWS"; for "Vendor Y" the vendor is the tenant's own term.
    const certVendors = new Set();
    for (const c of knowledge.certifications) {
      const name = String(c.name || '');
      if (!name) continue;
      const m = name.match(/^([A-Za-z][A-Za-z0-9+#.\s-]{1,40}?)\s+(?:Certified\s+|[A-Z][A-Za-z0-9+#.\s-]{2,})/);
      if (m) certVendors.add(m[1].trim());
    }
    const vendorAlts = Array.from(certVendors).filter(Boolean).map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    // Match "<Vendor> Certified <Name>" only. The name must start with an
    // uppercase word to avoid matching ordinary sentences that mention the vendor.
    const certPattern = vendorAlts
      ? new RegExp(`\\b((?:${vendorAlts})\\s+Certified\\s+[A-Z][A-Za-z0-9+#.\\s-]{2,50})`, 'g')
      : null;
    const claimedCerts = [];
    if (certPattern) {
      let certMatch;
      while ((certMatch = certPattern.exec(text)) !== null) {
        claimedCerts.push(certMatch[1].trim());
      }
    }
    // Also detect common cert abbreviations: "AWS SAA" = "AWS Certified Solutions Architect - Associate"
    const abbrevPattern = /\bAWS\s+(SAA|SAP|DVA|DVA-C|SAA-C|SOA|DBS|ANS|MLS|SCS)\b/g;
    const certAbbrevs = {
      'SAA': 'AWS Certified Solutions Architect - Associate',
      'SAA-C': 'AWS Certified Solutions Architect - Associate',
      'SAP': 'AWS Certified Solutions Architect - Professional',
      'DVA': 'AWS Certified Developer - Associate',
      'DVA-C': 'AWS Certified Developer - Associate',
      'SOA': 'AWS Certified SysOps Administrator - Associate',
      'DBS': 'AWS Certified Database - Specialty',
      'ANS': 'AWS Certified Advanced Networking - Specialty',
      'MLS': 'AWS Certified Machine Learning - Specialty',
      'SCS': 'AWS Certified Security - Specialty'
    };
    let abbrevMatch;
    while ((abbrevMatch = abbrevPattern.exec(text)) !== null) {
      const fullCert = certAbbrevs[abbrevMatch[1]];
      if (fullCert) {
        claimedCerts.push(fullCert);
      }
    }
    const knownCerts = knowledge.certifications.map(c => (c.name || '').toLowerCase());
    for (const claimed of claimedCerts) {
      const claimedLower = claimed.toLowerCase();
      // Check if the claimed certification matches any known certification
      const isKnown = knownCerts.some(known => {
        if (known === claimedLower || known.includes(claimedLower) || claimedLower.includes(known)) return true;
        // For certification matching, require that the DISTINGUISHING words match,
        // not just common words like "certified" and "associate".
        // E.g., "AWS Certified Developer Associate" should NOT match "AWS Certified Solutions Architect Associate"
        // because "Developer" != "Solutions Architect".
        const stopWords = new Set(['aws', 'certified', 'associate', 'professional', 'specialty', 'foundation', 'cloud', 'practitioner', 'the', 'a', 'an']);
        const claimedContent = claimedLower.split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w));
        const knownContent = known.split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w));
        if (claimedContent.length === 0) return true; // Too generic to reject
        // All claimed content words must appear in the known certification
        return claimedContent.every(w => knownContent.some(kw => kw === w || kw.includes(w) || w.includes(kw)));
      });
      if (!isKnown) {
        reasons.push(`fabricated_certification:${claimed}`);
      }
    }
  }

  // 8. Relationship-aware grounding — check that claimed RELATIONSHIPS
  // between entities are supported by the knowledge base, not just that
  // the entities exist. This prevents the model from recombining unrelated
  // true facts into false claims (e.g., "ProjectHub was built at Amazon"
  // when both exist but the relationship doesn't).
  if (knowledge) {
    try {
      const relGraph = graph || buildRelationshipGraph(knowledge);
      // Requested role/domain terms are user context, not tenant evidence. They
      // may be named as comparison criteria without becoming subject facts.
      if (responseContract?.requestedRole) {
        const norm = normalizeEntity(responseContract.requestedRole);
        if (norm && !relGraph.entityIndex.has(norm)) relGraph.entityIndex.set(norm, []);
      }
      if (responseContract?.requestedTopic) {
        const norm = normalizeEntity(responseContract.requestedTopic);
        if (norm && !relGraph.entityIndex.has(norm)) relGraph.entityIndex.set(norm, []);
      }
      const relValidation = validateRelationships(text, relGraph, question, history, sourceText, evidence);
      for (const uc of relValidation.unsupportedClaims) {
        const relReason = `unsupported_relationship:${uc.subject}|${uc.relation}|${uc.object}`;
        if (!reasons.includes(relReason)) reasons.push(relReason);
      }
      for (const oc of relValidation.overclaimClaims) {
        reasons.push(`relationship_overclaim:${oc.relation}|${oc.object}`);
      }
      for (const issue of detectCrossProjectProvenance(text, knowledge, sourceText, evidence)) {
        reasons.push(`wrong_relationship:project_provenance:${issue}`);
      }

      // 8b. Fabricated entity detection — entities in the answer that don't
      // exist anywhere in the knowledge base (e.g., "Vue.js" when Vue.js
      // is not in any skill, project, or experience entry).
      // Skip for GREETING mode — conversational responses may mention
      // nationalities, platforms, or other non-knowledge-base entities.
      if (policyMode !== 'GREETING') {
        const fabricated = detectFabricatedEntities(text, relGraph, question);
        for (const entity of fabricated) {
          // If the capitalized term appears in the evidence source text, it is
          // grounded in the retrieved context even if it is not in the entity
          // index (e.g., "Alpha" in "ProjectHub Recruiter Alpha" description).
          const lowerEntity = entity.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const appearsInSource = new RegExp(`(?:^|[^a-z0-9])${lowerEntity}(?:[^a-z0-9]|$)`, 'i').test(sourceText);
          if (!appearsInSource) {
            reasons.push(`fabricated_entity:${entity}`);
          }
        }
      }

      // 8c. Fabricated employment detection — if the answer claims the subject
      // worked at / interned at / was employed at a company that is NOT in
      // the knowledge base, reject it. This catches answers like "the candidate
      // was a Cloud Support Engineer Intern with Netflix" when Netflix is
      // not a known employer. The question may mention the company (e.g.,
      // "What did they do at Netflix?") but the answer must deny, not affirm.
      const knownCompanies = new Set(
        relGraph.triples
          .filter(t => ['worked_at', 'interned_at', 'employed_at', 'employed_as'].includes(t.relation))
          .map(t => normalizeEntity(t.object))
      );
      // If a capitalized term appears in the source evidence text, it is grounded
      // even when an employment pattern would otherwise match it (e.g., AWS Lambda).
      // However, a company name in a negated/refutational source sentence should
      // not block fabricated-employment detection (e.g. "He did not work at Netflix").
      const appearsInSource = (name) => {
        const lower = name.toLowerCase();
        const idx = sourceText.indexOf(lower);
        if (idx === -1) return false;
        const sentStart = sourceText.lastIndexOf('.', idx) + 1;
        const sentEnd = sourceText.indexOf('.', idx);
        const sentence = sourceText.slice(sentStart, sentEnd > 0 ? sentEnd : sourceText.length);
        if (hasNegation(sentence)) return false;
        return true;
      };
      const employmentPattern = new RegExp(`\\b(?:He|She|They${_localSubjectNameAlt ? _localSubjectNameAlt.replace(/\\|/g, '|') : ''})\\s+(?:was|worked|interned|employed|served|joined|spent\\s+time)\\s+(?:(?:at|with|for)\\s+|as\\s+(?:an?\\s+)?(?:[A-Za-z]+\\s+)*?(?:intern|engineer|developer|support|cloud|specialist|analyst|architect)\\s+(?:at|with|for)\\s+|a\\s+(?:[A-Za-z]+\\s+){1,5}(?:at|with|for)\\s+)([A-Z][A-Za-z0-9&.\\s-]{2,50})`, 'gi');
      let empMatch;
      while ((empMatch = employmentPattern.exec(text)) !== null) {
        const companyName = empMatch[1].trim().replace(/\s+(?:focusing|where|which|that|to|in|on|for|as|and|with|his|her|their|the)\s.*$/i, '');
        const companyNorm = normalizeEntity(companyName);
        if (companyNorm.length < 3) continue;
        // Check if this company is a known employer
        const isKnown = [...knownCompanies].some(known =>
          known === companyNorm || known.includes(companyNorm) || companyNorm.includes(known) ||
          (companyNorm.length > 4 && known.length > 4 && companyNorm.slice(0, 6) === known.slice(0, 6))
        );
        if (appearsInSource(companyName)) continue;
        if (!isKnown) {
          // Check if the sentence is negated (denying employment is OK)
          const sentStart = text.lastIndexOf('.', empMatch.index) + 1;
          const sentEnd = text.indexOf('.', empMatch.index);
          const sentence = text.slice(sentStart, sentEnd > 0 ? sentEnd : text.length);
          const isNegated = /\b(?:no(?:t|ne|,)?|never|didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|was not|has not|hasn't|have not|haven't)\b/i.test(sentence);
          if (!isNegated) {
            reasons.push(`fabricated_employment:${companyName}`);
          }
        }
      }

      // 8c1b. "At [Company], they [verb]" construction — implies employment
      // Example: "At Netflix, they built a serverless metadata workflow..."
      const atCompanyPattern = new RegExp(`\\bAt\\s+([A-Z][A-Za-z0-9&.\\s-]{2,40}?),\\s+(?:he|she|they${_localSubjectNameAlt})\\s+(?:built|created|developed|worked|designed|implemented|led|managed|wrote|deployed|maintained|contributed)`, 'gi');
      let atCompMatch;
      while ((atCompMatch = atCompanyPattern.exec(text)) !== null) {
        const companyName = atCompMatch[1].trim();
        const companyNorm = normalizeEntity(companyName);
        if (companyNorm.length < 3) continue;
        const isKnown = [...knownCompanies].some(known =>
          known === companyNorm || known.includes(companyNorm) || companyNorm.includes(known) ||
          (companyNorm.length > 4 && known.length > 4 && companyNorm.slice(0, 6) === known.slice(0, 6))
        );
        if (appearsInSource(companyName)) continue;
        if (!isKnown) {
          const sentStart = text.lastIndexOf('.', atCompMatch.index) + 1;
          const sentEnd = text.indexOf('.', atCompMatch.index);
          const sentence = text.slice(sentStart, sentEnd > 0 ? sentEnd : text.length);
          const isNegated = /\b(?:no(?:t|ne|,)?|never|didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|was not|has not|hasn't|have not|haven't)\b/i.test(sentence);
          if (!isNegated) {
            reasons.push(`fabricated_employment:${companyName}`);
          }
        }
      }

      // 8c1c. "...at [Company]" at the end of a work/intern/build sentence
      // Example: "...as part of his AWS internship capstone project at Netflix."
      const endAtCompanyPattern = /\b(?:internship|intern|capstone|project|work|job|role|position|career)\s+(?:at|with|for)\s+([A-Z][A-Za-z0-9&.\s-]{2,40}?)(?:\.|$|,)/g;
      let endAtMatch;
      while ((endAtMatch = endAtCompanyPattern.exec(text)) !== null) {
        const companyName = endAtMatch[1].trim();
        const companyNorm = normalizeEntity(companyName);
        if (companyNorm.length < 3) continue;
        const isKnown = [...knownCompanies].some(known =>
          known === companyNorm || known.includes(companyNorm) || companyNorm.includes(known) ||
          (companyNorm.length > 4 && known.length > 4 && companyNorm.slice(0, 6) === known.slice(0, 6))
        );
        if (appearsInSource(companyName)) continue;
        if (!isKnown) {
          const sentStart = text.lastIndexOf('.', endAtMatch.index) + 1;
          const sentEnd = text.indexOf('.', endAtMatch.index);
          const sentence = text.slice(sentStart, sentEnd > 0 ? sentEnd : text.length);
          const isNegated = /\b(?:no(?:t|ne|,)?|never|didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|was not|has not|hasn't|have not|haven't)\b/i.test(sentence);
          if (!isNegated) {
            reasons.push(`fabricated_employment:${companyName}`);
          }
        }
      }

      // 8c1d. "built/developed/created X for [Company]" — implies employment
      // Example: "built a project called ProjectHub for Netflix" or "built a project for the Netflix app"
      // Also catches "built a mobile app for Netflix that was used..."
      const builtForCompanyPattern = /\b(?:built|developed|created|designed|implemented|wrote|deployed|maintained|contributed)\b[^.]*?\bfor\s+(?:the\s+|a\s+|an\s+)?([A-Z][A-Za-z0-9&.\s-]{2,40}?)(?:\s+(?:app|platform|company|API|service|project|that|which|where|when|to|in|on|as|and|with|his|her|their|the)|\.|$|,)/g;
      let builtForMatch;
      while ((builtForMatch = builtForCompanyPattern.exec(text)) !== null) {
        const bfCompanyName = builtForMatch[1].trim();
        const bfCompanyNorm = normalizeEntity(bfCompanyName);
        if (bfCompanyNorm.length < 3) continue;
        const bfIsKnown = [...knownCompanies].some(known =>
          known === bfCompanyNorm || known.includes(bfCompanyNorm) || bfCompanyNorm.includes(known) ||
          (bfCompanyNorm.length > 4 && known.length > 4 && bfCompanyNorm.slice(0, 6) === known.slice(0, 6))
        );
        if (appearsInSource(bfCompanyName)) continue;
        if (!bfIsKnown) {
          const bfSentStart = text.lastIndexOf('.', builtForMatch.index) + 1;
          const bfSentEnd = text.indexOf('.', builtForMatch.index);
          const bfSentence = text.slice(bfSentStart, bfSentEnd > 0 ? bfSentEnd : text.length);
          const bfIsNegated = /\b(?:no(?:t|ne|,)?|never|didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|was not|has not|hasn't|have not|haven't)\b/i.test(bfSentence);
          if (!bfIsNegated) {
            reasons.push(`fabricated_employment:${bfCompanyName}`);
          }
        }
      }

      // 8c1e. "[Company] was/is/as part of his internship/work/experience" — implies employment
      // Example: "Netflix was part of his internship." or "Netflix as part of his AWS internship."
      const companyAsPartPattern = /\b([A-Z][A-Za-z0-9&.\s-]{2,40}?)\s+(?:was|is|as)\s+part\s+of\s+(?:his|her|their)\s+(?:\w+\s+)?(?:internship|work|experience|career|job|role)/g;

      // 8c1f. "built/developed/created [Company]'s [X]" — implies employment
      // Example: "built Netflix's customer support system" or "built the first version of Netflix's system"
      const builtCompanyPossessivePattern = /\b(?:built|developed|created|designed|implemented|wrote|deployed|maintained|led|owned)\b[^.]*?\b([A-Z][A-Za-z0-9&.\s-]{2,40}?)'s\s/g;
      let bcpMatch;
      while ((bcpMatch = builtCompanyPossessivePattern.exec(text)) !== null) {
        const bcpCompanyName = bcpMatch[1].trim();
        const bcpCompanyNorm = normalizeEntity(bcpCompanyName);
        if (bcpCompanyNorm.length < 3) continue;
        const bcpIsKnown = [...knownCompanies].some(known =>
          known === bcpCompanyNorm || known.includes(bcpCompanyNorm) || bcpCompanyNorm.includes(known) ||
          (bcpCompanyNorm.length > 4 && known.length > 4 && bcpCompanyNorm.slice(0, 6) === known.slice(0, 6))
        );
        if (appearsInSource(bcpCompanyName)) continue;
        if (!bcpIsKnown) {
          const bcpSentStart = text.lastIndexOf('.', bcpMatch.index) + 1;
          const bcpSentEnd = text.indexOf('.', bcpMatch.index);
          const bcpSentence = text.slice(bcpSentStart, bcpSentEnd > 0 ? bcpSentEnd : text.length);
          const bcpIsNegated = /\b(?:no(?:t|ne|,)?|never|didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|was not|has not|hasn't|have not|haven't)\b/i.test(bcpSentence);
          if (!bcpIsNegated) {
            reasons.push(`fabricated_employment:${bcpCompanyName}`);
          }
        }
      }
      let capMatch;
      while ((capMatch = companyAsPartPattern.exec(text)) !== null) {
        const capCompanyName = capMatch[1].trim();
        const capCompanyNorm = normalizeEntity(capCompanyName);
        if (capCompanyNorm.length < 3) continue;
        const capIsKnown = [...knownCompanies].some(known =>
          known === capCompanyNorm || known.includes(capCompanyNorm) || capCompanyNorm.includes(known) ||
          (capCompanyNorm.length > 4 && known.length > 4 && capCompanyNorm.slice(0, 6) === known.slice(0, 6))
        );
        if (appearsInSource(capCompanyName)) continue;
        if (!capIsKnown) {
          const capSentStart = text.lastIndexOf('.', capMatch.index) + 1;
          const capSentEnd = text.indexOf('.', capMatch.index);
          const capSentence = text.slice(capSentStart, capSentEnd > 0 ? capSentEnd : text.length);
          const capIsNegated = /\b(?:no(?:t|ne|,)?|never|didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|was not|has not|hasn't|have not|haven't)\b/i.test(capSentence);
          if (!capIsNegated) {
            reasons.push(`fabricated_employment:${capCompanyName}`);
          }
        }
      }

      // 8c2. Project-as-company check — if the answer claims employment at
      // an entity that is actually a project in the knowledge base, reject it.
      // Example: "internships at companies such as ProjectHub" when ProjectHub
      // is a project, not a company.
      if (knowledge.projects && Array.isArray(knowledge.projects)) {
        const projectNames = new Set();
        for (const proj of knowledge.projects) {
          const name = (proj.name || '').toLowerCase();
          const firstName = name.split(/[\s(]+/)[0].replace(/[^a-z0-9]/g, '');
          if (firstName.length >= 4) projectNames.add(firstName);
          // Also add aliases
          if (proj.aliases && Array.isArray(proj.aliases)) {
            for (const alias of proj.aliases) {
              const aliasNorm = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
              if (aliasNorm.length >= 4) projectNames.add(aliasNorm);
            }
          }
        }
        // Check for employment claims involving project names
        const empAtPattern = /\b(?:at\s+(?:companies?\s+(?:such\s+as|like|including)\s+)?|internship\s+at\s+|interned\s+at\s+|worked\s+at\s+|employed\s+at\s+)([A-Z][A-Za-z0-9\s&.-]{2,50})/gi;
        let empAtMatch;
        while ((empAtMatch = empAtPattern.exec(text)) !== null) {
          const rawEntityName = empAtMatch[1].trim();
          const firstEntityName = rawEntityName.split(/[,.\s]/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
          const fullEntityNorm = normalizeEntity(rawEntityName);
          // A project that is also a known employer is legitimate; do not treat
          // it as a project-as-company false claim (e.g. CIRIS Ethical AI).
          const isKnownCompany = fullEntityNorm.length >= 3 && knownCompanies && [...knownCompanies].some(known =>
            known === fullEntityNorm || known.includes(fullEntityNorm) || fullEntityNorm.includes(known) ||
            (fullEntityNorm.length > 4 && known.length > 4 && fullEntityNorm.slice(0, 6) === known.slice(0, 6))
          );
          if (isKnownCompany) continue;
          if (projectNames.has(firstEntityName)) {
            const sentStart = Math.max(0, text.lastIndexOf('.', empAtMatch.index) + 1);
            const sentEnd = text.indexOf('.', empAtMatch.index);
            const sentence = text.slice(sentStart, sentEnd > 0 ? sentEnd : text.length);
            const isNegated = /\b(?:no(?:t|ne|,)?|never|didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|was not|has not|hasn't|have not|haven't)\b/i.test(sentence);
            if (!isNegated) {
              reasons.push(`wrong_relationship:project_as_company:${rawEntityName}`);
            }
          }
        }
      }

      // 8c3. Fabricated occupation/identity check — if the answer claims
      // the tenant subject has an occupation, profession, or identity that
      // conflicts with the authoritative identity in the knowledge base,
      // reject it. The model's pretraining does NOT get to override
      // authoritative tenant identity. This catches identity drift like
      // "the subject is an American professional stock car racing driver"
      // when the KB says they're a junior software engineer.
      if (relGraph?.subjectName || knowledge?.identity?.name || knowledge?.summary?.whoIAm) {
        const subjectName = knowledge?.identity?.name || relGraph?.subjectName || 'the candidate';
        const subjectFirst = subjectName.split(/\s+/)[0];
        // Occupation validation is structural: a claimed role/company pair must
        // match identity.title, summary.whoIAm, experience records, or graph
        // employed_as / worked_at / has_expertise triples. No static profession
        // blacklist is used as a semantic truth mechanism.
        const occupationClaims = [];
        for (const sentence of sentences.flatMap(splitClauses)) {
          // Forbidden-occupation blacklist removed — validation is structural.
          const explicitRole = /\b(?:worked|served|employed)\s+as\s+(?:an?\s+)?([a-z][a-z -]{1,70}?)\s+(?:at|with|for)\s+([^;,.!?]+)|\b(?:is|was)\s+(?:an?\s+)([a-z][a-z -]{1,70}?)\s+(?:at|with|for)\s+([^;,.!?]+)/gi;
          for (const match of sentence.matchAll(explicitRole)) {
            occupationClaims.push({ sentence, role: (match[1] || match[3]).trim(), company: (match[2] || match[4]).trim(), index: match.index });
          }
        }
        const genericAssessments = new Set([
          'good', 'great', 'strong', 'weak', 'poor', 'solid', 'top', 'excellent', 'bad', 'terrible', 'partial',
          'fit', 'match', 'candidate', 'prospect', 'applicant', 'choice', 'option', 'pick', 'role',
          'open', 'available', 'willing', 'ready', 'able'
        ]);
        for (const { sentence, role, company, index } of occupationClaims) {
          const roleWords = role.trim().split(/\s+/).filter(Boolean);
          if (roleWords.length > 0 && roleWords.every(w => genericAssessments.has(w))) continue;
          const isNegated = isTokenNegated(sentence.slice(0, index + sentence.slice(index).indexOf(role) + role.length), role);
          if (isNegated) continue;
          // Do not flag a claimed role when it appears with a documented
          // employer — the model is likely recounting actual prior experience
          // rather than hallucinating a current identity.
          const roleEnd = sentence.indexOf(role, index) + role.length;
          const employerMatch = sentence.slice(roleEnd).match(/^\s+(?:at|with|for)\s+([^;,.!?]+)/i);
          const claimedCompany = (company || employerMatch?.[1] || '').split(/\s+(?:and|but|where|during|from|in)\s+/i)[0].trim();
          if (documentedOccupation(role, claimedCompany, knowledge, relGraph)) continue;
          // A claimed "role" that fully contains a documented type/category of
          // a known non-person entity is an entity-type statement, not a
          // person occupation — "it is a support ticketing platform at $99/mo"
          // describes Northstar Desk's category, not employment.
          const claimedRoleLower = role.toLowerCase();
          const entityTypeClaim = (relGraph?.triples || []).some(t =>
            t.relation === 'is_type' &&
            t.subjectNorm && t.subjectNorm !== relGraph?.subjectNorm &&
            !(relGraph?.subjectAliases && relGraph.subjectAliases.has(t.subjectNorm)) &&
            (() => {
              const obj = String(t.object || '').toLowerCase().trim();
              return obj.length >= 4 && claimedRoleLower.includes(obj);
            })()
          );
          if (entityTypeClaim) continue;
          // Sentences that start with a known non-person entity (product,
          // service, project, etc.) are describing that entity's type, not a
          // person occupation — "Panel Upgrade is an electrical service...".
          const sentenceStart = sentence.trim().match(/^([A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*)/);
          if (sentenceStart) {
            const startNorm = normalizeEntity(sentenceStart[1]);
            if (startNorm && startNorm !== relGraph?.subjectNorm &&
                !relGraph?.subjectAliases?.has(startNorm) &&
                relGraph?.entityIndex?.has(startNorm)) {
              continue;
            }
          }
          const reason = `fabricated_occupation:${role}`;
          if (!reasons.includes(reason)) reasons.push(reason);
        }
        // Also catch bare "is a/an [noun]" claims about the subject. These are
        // structural role/identity assertions and are validated against the same
        // documented roles as explicit "worked as" / "is a [role] at" claims.
        // A small set of generic assessment phrases (fit, candidate, etc.) is
        // skipped so role-fit wording like "a good fit" is not misclassified as
        // a fabricated occupation; no static profession taxonomy is used.
        const secondName = (knowledge?.identity?.name || '').split(/\s+/)[1] || '';
        const subjectPattern = new RegExp(
          '\\b' + subjectFirst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          `(?:\\s+${secondName})?\\s+(?:is|was)\\s+(?:an?\\s+)?(\\w+(?:\\s+\\w+){0,4})`,
          'i'
        );
        const isAMatch = text.match(subjectPattern);
        if (isAMatch) {
          const claimedOcc = isAMatch[1].toLowerCase().trim();
          const sentStart = text.lastIndexOf('.', isAMatch.index) + 1;
          const sentEnd = text.indexOf('.', isAMatch.index);
          const isSentence = text.slice(sentStart, sentEnd > 0 ? sentEnd : text.length);
          const isNegated2 = /\b(?:no(?:t|ne|,)?|never|isn'?t|is not|wasn'?t|was not)\b/i.test(isSentence);
          if (!isNegated2) {
            const genericAssessments = new Set([
              'good', 'great', 'strong', 'weak', 'poor', 'solid', 'top', 'excellent', 'bad', 'terrible', 'partial',
              'fit', 'match', 'candidate', 'prospect', 'applicant', 'choice', 'option', 'pick', 'role',
              'based', 'located', 'from', 'born', 'raised',
              'open', 'available', 'willing', 'ready', 'able'
            ]);
            // Strip trailing prepositional/relative context so claims like
            // "a junior software engineer based in Denver" are validated by the
            // role head rather than the location phrase.
            const roleHead = claimedOcc
              .replace(/\s+(?:based|located|from|in|at|with|for|to|of|on|off|by|about|over|under|around|through|via|using|via|through)\s+.*$/i, '')
              .replace(/\s+(?:who|which|that|where|when|because|although|while|and|but|or|so|yet)\s+.*$/i, '')
              .trim();
            const headWords = roleHead.split(/\s+/).filter(Boolean);
            const onlyAssessment = headWords.length > 0 && headWords.every(w => genericAssessments.has(w));
            if (!onlyAssessment) {
              // Accept the claim if a leading prefix of the claimed role matches a
              // documented occupation. This lets trailing context like
              // "junior software engineer based in Denver" fall back to the
              // documented "junior software engineer" without allowing an
              // unsupported leading modifier like "Senior Quantum Cartographer"
              // to inherit support from the weaker documented "Quantum Cartographer".
              let found = false;
              const subphraseCount = headWords.length;
              for (let len = subphraseCount; len >= Math.min(2, subphraseCount); len--) {
                const sub = headWords.slice(0, len).join(' ');
                if (documentedOccupation(sub, null, knowledge, relGraph)) {
                  found = true;
                  break;
                }
              }
              if (!found) {
                const occReason = `fabricated_occupation:${claimedOcc}`;
                if (!reasons.includes(occReason)) reasons.push(occReason);
              }
            }
          }
        }
      }

      // 8d. Unsupported description check — if the answer explicitly describes
      // a known entity (e.g., "ProjectHub is a web application that..."), verify
      // that at least one non-generic content word from the KB description
      // appears in the answer. This catches completely fabricated descriptions
      // like "ProjectHub is a job application platform" when the KB says it's
      // an AI recruiter assistant.
      if (relGraph.knowledge) {
        const descriptionEntities = require('./knowledge-entities').normalizeKnowledgeEntities(relGraph.knowledge);
        const GENERIC_DESC_WORDS = new Set([
          'that', 'this', 'with', 'from', 'about', 'their', 'uses', 'allows',
          'users', 'user', 'based', 'features', 'interface', 'platform',
          'application', 'system', 'software', 'project', 'tool', 'web',
          'site', 'experience', 'skills', 'roles', 'questions', 'answers',
          'details', 'knowledge', 'base', 'search', 'apply', 'developer',
          'seekers', 'upload', 'resume', 'write', 'cover', 'letters',
          'submit', 'applications', 'directly', 'provides', 'helps',
          'people', 'looking', 'work', 'using', 'built', 'created',
          'designed', 'developed', 'implemented', 'includes', 'offers',
          'supports', 'enables', 'allows', 'focused', 'related', 'various',
          'specific', 'general', 'particular', 'certain', 'simple', 'complex',
          'clear', 'important', 'interesting', 'useful', 'helpful', 'available',
          'possible', 'technical', 'practical', 'basic', 'advanced', 'main',
          'major', 'minor', 'key', 'core', 'essential', 'front', 'back',
          'full', 'stack', 'mobile', 'desktop', 'client', 'server', 'data',
          'code', 'development', 'developer', 'engineering', 'engineer',
          'program', 'programming', 'product', 'service', 'solution'
        ]);
        for (const proj of descriptionEntities) {
          const projName = (proj.name || '').toLowerCase();
          const projNorm = projName.replace(/[^a-z0-9]/g, '');
          if (projNorm.length < 4) continue;
          // Use the first significant word of the project name for matching
          // (e.g., "ProjectHub" from "ProjectHub (Scout)")
          const projFirstWord = projName.split(/[\s(]+/)[0].replace(/[^a-z0-9]/g, '');
          if (projFirstWord.length < 4) continue;
          // Check if the answer mentions this project by name
          const textLower = text.toLowerCase();
          if (!textLower.includes(projFirstWord)) continue;
          // Check if the answer explicitly describes this project
          // Pattern: "ProjectName is a/an..." or "ProjectName allows/features..."
          const escapeName = name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const otherNames = descriptionEntities.filter(e => e.name !== proj.name).flatMap(e => [e.name, ...e.aliases]);
          const fullNames = [proj.name, ...proj.aliases];
          const fallbackText = otherNames.reduce((value, name) => value.replace(new RegExp(escapeName(name), 'gi'), ''), text);
          const matchedName = fullNames.find(name => new RegExp(`\\b${escapeName(name)}\\s+(?:is|was|allows|features|provides|offers|enables|helps|lets)\\s+`, 'i').test(text));
          const descriptionName = matchedName || (fallbackText.toLowerCase().includes(projFirstWord) ? projFirstWord : null);
          if (!descriptionName) continue;
          const descPattern = new RegExp(
            escapeName(descriptionName) +
            '\\s+(?:is|was|allows|features|provides|offers|enables|helps|lets)\\s+',
            'i'
          );
          if (!descPattern.test(text)) continue;
          // Extract the first sentence that describes this project
          // (the one matching the descPattern) and check it specifically.
          // If the first sentence is a vague lead-in (e.g., "is quite interesting",
          // "is noteworthy", "is impressive"), also include the next sentence
          // since that's where the actual description often follows.
          const descMatch = text.match(new RegExp(
            escapeName(descriptionName) +
            '\\s+(?:is|was|allows|features|provides|offers|enables|helps|lets)\\s+' +
            '[^.]+\\.?', 'i'
          ));
          let descSentence = descMatch ? descMatch[0].toLowerCase() : textLower;
          // A disavowal sentence ("... is a separate project" or "... is not
          // related to ...") is not a substantive project description, so it
          // does not need KB description overlap.
          const DISAVOWAL_PHRASES = /\b(?:separate|unrelated|different|not\s+related|not\s+connected|not\s+part\s+of|not\s+associated\s+with|not\s+clear|unclear|not\s+documented|not\s+mentioned)\b/i;
          if (DISAVOWAL_PHRASES.test(descSentence)) continue;

          // A sentence that states only a project type or provenance
          // ("Alpha is a freelance project.") is a relationship claim, not a
          // substantive description, and is validated by is_type/provenance
          // checks. If the evidence or KB metadata supports the stated
          // category, skip the description overlap requirement.
          const typeProvenancePattern = new RegExp(
            '^' + escapeName(descriptionName) +
            '\\s+(?:is|was)\\s+(?:a|an)\\s+([a-z]+(?:\\s+[a-z]+)*)\\s+(?:project|app|application|tool|system|work|capstone|engagement|experience)\\s*[.!?]?$',
            'i'
          );
          const tpMatch = descSentence.match(typeProvenancePattern);
          if (tpMatch) {
            const assertedPhrase = tpMatch[1].toLowerCase().trim();
            const knownValues = [
              proj.category, proj.type, proj.context, proj.builtDuring, proj.built_during
            ].filter(Boolean);
            if (Array.isArray(evidence)) {
              for (const block of evidence) {
                const names = [block.name, block.sourceEntity, ...(block.aliases || [])].filter(Boolean);
                const namesMatch = names.some(name =>
                  name.toLowerCase() === proj.name.toLowerCase() ||
                  proj.name.toLowerCase().startsWith(name.toLowerCase())
                );
                if (!namesMatch) continue;
                for (const field of ['category', 'type', 'builtDuring', 'context']) {
                  if (block[field]) knownValues.push(block[field]);
                }
              }
            }
            if (assertedPhrase.length > 0 && knownValues.some(v =>
              typeof v === 'string' && v.toLowerCase().includes(assertedPhrase))) {
              continue;
            }
          }

          // If the first descriptive sentence is a vague lead-in, include the
          // next sentence too — the actual description often follows.
          const VAGUE_LEADINS = /\b(?:is|was)\s+(?:quite\s+)?(?:interesting|impressive|noteworthy|cool|great|nice|remarkable|fascinating|compelling|appealing|promising)\b/i;
          if (descMatch && VAGUE_LEADINS.test(descSentence)) {
            const afterFirst = text.slice(descMatch.index + descMatch[0].length);
            const nextSentMatch = afterFirst.match(/^[\s]*([^.]+\.?)/);
            if (nextSentMatch) {
              descSentence = descSentence + ' ' + nextSentMatch[1].toLowerCase();
            }
          }
          // Extract non-generic content words from the KB description
          const kbDesc = (proj.description || '').toLowerCase();
          const kbWords = (kbDesc.match(/[a-z][a-z]{3,}/g) || [])
            .filter(w => !GENERIC_DESC_WORDS.has(w));
          // Extract key multi-word phrases from the KB description
          // These are more specific than single words and better indicate
          // whether the answer's description matches the KB's description.
          const kbPhrases = (kbDesc.match(/[a-z]+ [a-z]+ [a-z]+/g) || [])
            .filter(p => {
              const words = p.split(' ');
              return words.filter(w => !GENERIC_DESC_WORDS.has(w) && w.length > 3).length >= 2;
            })
            .map(p => p.replace(/[^a-z0-9 ]/g, ''));
          // Require either:
          // 1. At least 2 non-generic KB words in the DESC SENTENCE (word-boundary match), OR
          // 2. At least 1 key multi-word phrase from the KB in the DESC SENTENCE
          const matchingWords = kbWords.filter(w => {
            const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
            return re.test(descSentence);
          });
          const matchingPhrases = kbPhrases.filter(p => {
            const re = new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
            return re.test(descSentence);
          });
          const hasOverlap = matchingWords.length >= 2 || matchingPhrases.length >= 1;
          if (!hasOverlap && kbWords.length > 0) {
            reasons.push(`unsupported_description:${proj.name}`);
          }
        }
      }
    } catch (err) {
      console.error('Relationship validation error in grounding-validator:', err);
    }
  }

  // Runtime enforcement of response-contract forbidden claims.
  // A forbidden phrase is only a violation when it appears in a positive
  // (non-negated) clause. Negated references like "not live customer ticket
  // work" are explicit refutations, not claims.
  if (responseContract?.forbiddenClaims?.length) {
    const answerLower = text.toLowerCase();
    for (const phrase of responseContract.forbiddenClaims) {
      const phraseLower = String(phrase).toLowerCase();
      if (phraseLower.length >= 3 && answerLower.includes(phraseLower) && !isTokenNegated(text, phrase)) {
        reasons.push(`forbidden_claim:${phrase}`);
      }
    }
  }

  // Structured claim-type validation (assistant identity, negative traits, role fabrication, etc.)
  const claimIssues = validateClaims(text, question, responseContract, sourceText, knowledge, evidence);
  for (const issue of claimIssues) {
    reasons.push(`${issue.type.toLowerCase().replace(/_claim$/, '')}:${issue.detail}`);
  }

  // Leading-stance alignment: the answer's first visible sentence must match
  // the semantic contract. Provider variance can produce a YES under UNKNOWN;
  // this guard turns it into a repair opportunity.
  const stance = checkStance(text, question, responseContract);
  if (!stance.valid && stance.reason) {
    reasons.push(stance.reason);
  }

  // Hard fails: these always reject the answer.
  // not_relevant_to_question is SOFT — it contributes to a 'partial' verdict
  // but does not auto-reject, because the model may accurately paraphrase
  // using different words than the question.
  const hardFail = reasons.some(r =>
    r === 'too_short' ||
    r === 'insufficient_content_overlap' ||
    r.startsWith('persona_confusion') ||
    r.startsWith('false_negation') ||
    r.startsWith('fabricated_certification') ||
    r.startsWith('entity_not_grounded:') ||
    r.startsWith('number_not_grounded:') ||
    r.startsWith('upgrade:') ||
    r.startsWith('expanded_overclaim:') ||
    r.startsWith('unsupported_relationship:') ||
    r.startsWith('relationship_overclaim:') ||
    r.startsWith('fabricated_entity:') ||
    r.startsWith('fabricated_employment:') ||
    r.startsWith('fabricated_occupation:') ||
    r.startsWith('conversation_contradiction:') ||
    r.startsWith('wrong_relationship:') ||
    r.startsWith('unsupported_tech_claim:') ||
    r.startsWith('unsupported_description:') ||
    r.startsWith('assistant_identity_claim:') ||
    r.startsWith('role_title_claim:') ||
    r.startsWith('negative_personal_claim:') ||
    r.startsWith('negative_personal:') ||
    r.startsWith('out_of_scope_claim:') ||
    r.startsWith('project_relationship:') ||
    r.startsWith('forbidden_claim:') ||
    r === 'overclaim_language' ||
    r === 'ai_slop' ||
    r === 'leaked_relation_syntax' ||
    r === 'leaked_internal_language' ||
    r === 'leaked_prompt_language' ||
    r.startsWith('stance_mismatch')
  );
  // Soft fails that don't auto-reject but contribute to quality assessment
  // too_many_sentences, no_terminal_punctuation, too_long, not_relevant_to_question

  const verdict = hardFail ? 'unsupported' : (reasons.length > 0 ? 'partial' : 'supported');

  // Build structured rejection feedback for validation-guided repair.
  // Maps internal reasons to machine-useful categories.
  const rejectionDetails = [];
  if (reasons.includes('overclaim_language')) {
    rejectionDetails.push({ reason: 'OVERCLAIM', detail: 'Answer uses exaggeration language (expert, led, production-ready, etc.)' });
  }
  for (const r of reasons) {
    if (r.startsWith('upgrade:')) {
      rejectionDetails.push({ reason: 'OVERCLAIM', detail: `Inflated language: ${r}` });
    }
  }
  for (const r of reasons) {
    if (r.startsWith('expanded_overclaim:')) {
      rejectionDetails.push({ reason: 'OVERCLAIM', detail: `Expanded overclaim: ${r.split(':').slice(1).join(':')}` });
    }
  }
  for (const r of reasons) {
    if (r.startsWith('unsupported_relationship:')) {
      rejectionDetails.push({ reason: 'UNSUPPORTED_RELATIONSHIP', detail: `Claimed relationship not in evidence: ${r.split(':').slice(1).join(':')}` });
    }
  }
  for (const r of reasons) {
    if (r.startsWith('relationship_overclaim:')) {
      rejectionDetails.push({ reason: 'OVERCLAIM', detail: `Relationship overclaim: ${r.split(':').slice(1).join(':')}` });
    }
    if (r.startsWith('wrong_relationship:')) {
      rejectionDetails.push({ reason: 'WRONG_RELATIONSHIP', detail: `Fact provenance mismatch: ${r.split(':').slice(1).join(':')}` });
    }
  }
  for (const r of reasons) {
    if (r.startsWith('fabricated_entity:')) {
      rejectionDetails.push({ reason: 'FABRICATED_ENTITY', detail: `Entity not in knowledge base: ${r.split(':')[1]}` });
    }
  }
  for (const r of reasons) {
    if (r.startsWith('fabricated_occupation:')) {
      rejectionDetails.push({ reason: 'FABRICATED_OCCUPATION', detail: `Identity drift — subject claimed to have an occupation not in knowledge base: ${r.split(':').slice(1).join(':')}` });
    }
  }
  for (const r of reasons) {
    if (r.startsWith('entity_not_grounded:')) {
      rejectionDetails.push({ reason: 'UNSUPPORTED_ENTITY', detail: `Entity not in evidence: ${r.split(':')[1]}` });
    }
  }
  for (const r of reasons) {
    if (r.startsWith('number_not_grounded:')) {
      rejectionDetails.push({ reason: 'UNSUPPORTED_NUMBER', detail: `Number not in evidence: ${r.split(':')[1]}` });
    }
  }
  if (reasons.includes('insufficient_content_overlap')) {
    rejectionDetails.push({ reason: 'LOW_EVIDENCE_OVERLAP', detail: 'Answer does not share enough content words with verified evidence' });
  }
  if (reasons.includes('not_relevant_to_question')) {
    rejectionDetails.push({ reason: 'QUESTION_MISMATCH', detail: 'Answer may not address the question topic' });
  }
  if (reasons.some(r => r.startsWith('stance_mismatch'))) {
    rejectionDetails.push({ reason: 'STANCE_MISMATCH', detail: 'Answer leading stance contradicts the semantic contract' });
  }
  if (reasons.includes('too_short')) {
    rejectionDetails.push({ reason: 'TOO_SHORT', detail: 'Answer is too short (under 20 characters)' });
  }
  if (reasons.includes('too_long')) {
    rejectionDetails.push({ reason: 'TOO_LONG', detail: 'Answer is too long (over 600 characters)' });
  }
  if (reasons.includes('no_terminal_punctuation')) {
    rejectionDetails.push({ reason: 'INVALID_STRUCTURE', detail: 'Answer does not end with punctuation' });
  }
  if (reasons.includes('too_many_sentences')) {
    rejectionDetails.push({ reason: 'TOO_LONG', detail: 'Answer has more than 3 sentences' });
  }
  if (reasons.includes('ai_slop')) {
    rejectionDetails.push({ reason: 'AI_SLOP', detail: 'Answer uses AI self-revelation phrases' });
  }
  if (reasons.includes('leaked_relation_syntax')) {
    rejectionDetails.push({ reason: 'LEAKED_SYNTAX', detail: 'Answer echoes internal relation names (worked_at, uses_tech, etc.)' });
  }
  if (reasons.includes('leaked_internal_language')) {
    rejectionDetails.push({ reason: 'LEAKED_SYNTAX', detail: 'Answer echoes internal graph/validation terminology' });
  }

  return { valid: !hardFail, reasons, verdict, cleaned: text, rejectionDetails };
}

// Validate a structured tool-selection decision from the model.
// Small models often produce slightly wrong schemas — this validator is tolerant:
//   * {"action":"answer","answer":"..."}            — direct answer
//   * {"action":"tool","tool":"X","arguments":{}}   — tool request
//   * {"tool":"X","arguments":{}}                   — implicit tool request
//   * {"answer":"..."}                              — implicit answer
//   * {"action":"<tool_name>","arguments":{}}       — tool name as action
//   * Both answer + tool present                     — prefer answer if substantial
// Returns { valid, decision, error }
function validateToolDecision(parsed, allowedToolNames) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, decision: null, error: 'not_an_object' };
  }
  const allowed = new Set(allowedToolNames || []);
  const action = String(parsed.action || '').toLowerCase();
  const answer = String(parsed.answer || '').trim();
  const tool = String(parsed.tool || '').trim();
  const args = parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {};

  // If both answer and tool are present, prefer a substantial answer (the model
  // already reasoned over the evidence it was given).
  if (answer.length >= 20 && (action === 'answer' || !action || action === 'tool')) {
    return { valid: true, decision: { action: 'answer', answer }, error: null };
  }

  // Explicit answer action
  if (action === 'answer') {
    if (answer.length < 10) return { valid: false, decision: null, error: 'answer_too_short' };
    return { valid: true, decision: { action: 'answer', answer }, error: null };
  }

  // Tool request: action="tool" with tool field, OR tool field directly, OR
  // action is itself a tool name.
  let resolvedTool = tool;
  if (!resolvedTool && allowed.has(action)) resolvedTool = action;
  if (!resolvedTool) {
    // Maybe the model put the tool name in a different field
    for (const key of Object.keys(parsed)) {
      if (allowed.has(String(parsed[key]).toLowerCase())) {
        resolvedTool = String(parsed[key]).toLowerCase();
        break;
      }
    }
  }
  if (resolvedTool) {
    if (!allowed.has(resolvedTool)) return { valid: false, decision: null, error: `unknown_tool:${resolvedTool}` };
    return { valid: true, decision: { action: 'tool', tool: resolvedTool, arguments: args }, error: null };
  }

  // Fallback: if there's any answer-like text, use it
  if (answer.length >= 10) {
    return { valid: true, decision: { action: 'answer', answer }, error: null };
  }

  return { valid: false, decision: null, error: `unknown_action:${action || 'none'}` };
}

// Attempt to repair a model output that wasn't valid JSON. Returns parsed object
// or null if repair fails. Only attempts cheap, safe repairs.
function attemptJsonRepair(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  // Strip markdown code fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // Extract the first {...} block
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }
  try {
    return JSON.parse(text);
  } catch {
    // Try removing trailing commas
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      // Try removing stray quotes/commas before closing braces
      try {
        return JSON.parse(text.replace(/[",]\s*([}\]])/g, '$1'));
      } catch {
        // Last resort: extract the "answer" field directly with a regex
        const answerMatch = text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (answerMatch) return { action: 'answer', answer: answerMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') };
        const toolMatch = text.match(/"tool"\s*:\s*"([^"]+)"/);
        if (toolMatch) {
          const argsMatch = text.match(/"arguments"\s*:\s*(\{[^}]*\})/);
          return { action: 'tool', tool: toolMatch[1], arguments: argsMatch ? (() => { try { return JSON.parse(argsMatch[1]); } catch { return {}; } })() : {} };
        }
        return null;
      }
    }
  }
}

// OOS Semantic Policy Validator
// Checks whether a generated answer for an OUT_OF_SCOPE question actually
// answers the external question instead of redirecting. Returns true if
// the answer violates policy (answers the external question).
function answerAddressesExternalTopic(answer, question) {
  const ans = (answer || '').toLowerCase().trim();
  const q = (question || '').toLowerCase().trim();

  // If the answer starts with a redirect phrase, it's likely compliant
  const redirectPhrases = [
    /^(?:i (?:can(?:no|')?t|am (?:not able|unable)) (?:help|answer|assist))/,
    /^(?:sorry,? i (?:can(?:no|')?t|don'?t))/,
    /^(?:i'?m (?:not able|unable) to)/,
    /^(?:that'?s (?:outside|beyond) (?:my|the) scope)/,
    /^(?:i (?:only|mainly) (?:help|assist|answer) (?:with|questions about))/,
    /^(?:i'?m here to (?:help|assist|talk) (?:with|about))/,
    /^(?:i'?d be happy to (?:help|answer) (?:questions|things) (?:about|related to))/,
    /^(?:let'?s (?:focus|talk) (?:on|about))/,
    /^(?:i (?:focus|specialize) on)/,
  ];
  if (redirectPhrases.some(re => re.test(ans))) return false;

  // Extract the core topic from the question (remove question words)
  const topicWords = q
    .replace(/^(?:what|how|why|when|where|who|is|are|can|do|does|did|will|would|should|could|tell me about|what'?s)\b/i, '')
    .replace(/[?.!]+$/g, '')
    .trim()
    .split(/\s+/)
    .filter(w => w.length >= 3 && !/^(?:the|this|that|your|his|her|their|about|like|with|from|have|been|will|would|should|could|does|done|much|many|kind|sort|type)\b/i.test(w));

  // If the answer contains 3+ significant topic words from the question,
  // it's likely answering the external question
  let topicMatches = 0;
  for (const w of topicWords) {
    if (ans.includes(w)) topicMatches++;
  }
  if (topicMatches >= 3 && topicWords.length >= 3) return true;

  // If the answer contains 2+ significant topic words AND no redirect language
  if (topicMatches >= 2 && topicWords.length >= 2 && !/^(?:i (?:can|cannot|can'?t|don'?t|am|'?m)|that'?s|sorry|unfortunately)/i.test(ans)) return true;

  // Single-word external topics (e.g. "helm", "rust"): if the answer begins by
  // defining or describing that topic and does not redirect, it is an OOS violation.
  if (topicWords.length === 1 && topicMatches === 1 && !/^(?:i (?:can|cannot|can'?t|don'?t|am|'?m)|that'?s|sorry|unfortunately|no,?|i'?m (?:not|only|here))\b/i.test(ans)) {
    const firstSentence = ans.split(/[.!?](?:\s|$)/)[0].trim();
    if (new RegExp(`\\b${topicWords[0]}\\b`).test(firstSentence)) return true;
  }

  return false;
}

module.exports = {
  OVERCLAIM_RE,
  COMPARATIVE_RE,
  UPGRADE_PATTERNS,
  cleanText,
  extractCompleteSentences,
  validateAnswer,
  validateToolDecision,
  attemptJsonRepair,
  hasNegation,
  splitSentences,
  splitClauses,
  answerAddressesExternalTopic,
  configureStopwords,
  configureAssistantName,
  checkStance,
  parseLeadingStance,
  expectedStance
};
