'use strict';

// Grounding Validator — prevents hallucination and exaggeration in generated
// Scout answers. The model may write the answer, but it CANNOT invent Bradley's
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

const OVERCLAIM_RE = /\b(clear winner|best candidate|strong ai capabilities|production[- ]ready|enterprise[- ]ready|proven leader|guaranteed fit|valuable asset|deep expertise|years of experience|seasoned|veteran|senior engineer|architected|spearheaded|championed|revolutionized|cutting[- ]edge|state[- ]of[- ]the[- ]art|ground[- ]breaking|groundbreaking|game[- ]changer|industry[- ]leading|world[- ]class)\b/i;

// Upgrade patterns: the answer uses stronger language than the evidence supports.
const UPGRADE_PATTERNS = [
  { re: /\b(expert|master(?:ed|y)|deep knowledge)\b/i, flag: 'expertise_inflation', needs: /\b(expert|master(?:ed|y)|deep knowledge)\b/i },
  { re: /\b(led|leadership|headed|managed the team|directed)\b/i, flag: 'leadership_inflation', needs: /\b(led|leadership|headed|managed the team|directed)\b/i },
  { re: /\b(production system|production environment|live production|owned production)\b/i, flag: 'production_inflation', needs: /\b(production system|production environment|live production|owned production)\b/i },
  { re: /\b(senior|principal|staff)\b.*\b(engineer|developer|architect)\b/i, flag: 'seniority_inflation', needs: /\b(senior|principal|staff)\b.*\b(engineer|developer|architect)\b/i },
  { re: /\b(\d+)\s+years?\s+(of\s+)?experience\b/i, flag: 'years_claim', needs: null }
];

// Negation words that indicate a claim is being REFUTED, not asserted
const NEGATION_RE = /\b(not|never|no|wasn't|was not|isn't|is not|didn't|did not|doesn't|does not|don't|do not|cannot|can't|won't|will not|rather than|instead of|contrary to)\b/i;

// Check if a specific clause/sentence contains negation
function hasNegation(text) {
  return NEGATION_RE.test(text);
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
// e.g., "he was not a junior engineer; he was a senior engineer" →
//   ["he was not a junior engineer", "he was a senior engineer"]
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
  'about', 'affect', 'bradley', 'could', 'does', 'doing', 'from', 'have',
  'looks', 'should', 'their', 'there', 'these', 'thing', 'think', 'those',
  'through', 'under', 'what', 'when', 'where', 'which', 'while', 'would',
  'tell', 'about', 'know', 'knows', 'show', 'give', 'explain', 'describe'
]);

function cleanText(value, max) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
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

// Core validation. source = the concatenated evidence text the answer must be
// grounded in. question = the user's question (for relevance check).
// knowledge = optional knowledge object for relationship-aware validation.
function validateAnswer(answer, source, question = '', knowledge = null, history = [], graph = null) {
  const text = cleanText(answer, 800);
  const sourceText = cleanText(source, 16000).toLowerCase();
  const reasons = [];

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

  // 1b. Expanded overclaim detection — catches variants the regex misses.
  // "extensive experience", "expertise in", "specializing in", "adept at",
  // "proficient in", "complex systems", "scalable infrastructure", etc.
  const expandedOverclaimMatches = detectExpandedOverclaim(text);
  if (expandedOverclaimMatches.length > 0) {
    // Check each match for negation context
    for (const phrase of expandedOverclaimMatches) {
      const idx = text.toLowerCase().indexOf(phrase.toLowerCase());
      if (idx >= 0) {
        // Use a TIGHT negation context — only 20 chars before the phrase
        // "No, he has extensive experience" should NOT be treated as negated
        // because "No" refutes the question, not the overclaim.
        const ctxStart = Math.max(0, idx - 20);
        const ctxEnd = Math.min(text.length, idx + phrase.length + 20);
        const context = text.slice(ctxStart, ctxEnd);
        // Check for negation that directly precedes or follows the overclaim
        // "not an expert in" or "not extensive experience" → negated
        // "No, he has extensive experience" → NOT negated (No refutes the question)
        const tightNegation = /\b(?:not|never)\s+(?:an?\s+|the\s+)?(?:extensive|expert|expertise|specializ|proficient|adept)/i.test(context) ||
                              /(?:extensive experience|expertise|specializ|proficient|adept)[^.!?]{0,10}\b(?:not|never)\b/i.test(context);
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
  const numberMatches = [...text.matchAll(/\b\d[\d.,]*\b/g)];
  for (const match of numberMatches) {
    const num = match[0];
    // Skip single-digit numbers that are part of entity names (e.g., "Gen 1" in "Static Gen 1 Pokedex UI")
    // These are not standalone number claims — they're part of proper nouns.
    const before = text.slice(Math.max(0, match.index - 10), match.index);
    const after = text.slice(match.index + num.length, match.index + num.length + 10);
    if (/Gen\s$/i.test(before) || /^[\s-]*(?:Pokedex|Entries|Gen)/i.test(after)) {
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
  // so "VoiceOps" matches "Voice Ops" and "Matera" matches "Bradley Matera".
  // Also includes the profile summary so common tech terms are grounded.
  //
  // Generic approach: a word is a "named entity claim" only if it appears
  // in a multi-word capitalized phrase or is a known proper noun pattern.
  // Single capitalized words at sentence start are common English, not entities.
  const { buildCompactProfileSummary } = require('./profile-summary');
  const profileSrc = source + '\n' + buildCompactProfileSummary();
  const entityRegistry = buildEntityRegistry(null, profileSrc);

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
  const negEntityContexts = [];
  const negEntityRe = /\b(?:no(?:t|ne|,)?|never|didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|was not|no evidence|not (?:a )?(?:known|verified|documented))\b[^.!?]{0,60}/gi;
  let negEntityMatch;
  while ((negEntityMatch = negEntityRe.exec(text)) !== null) {
    negEntityContexts.push(negEntityMatch[0].toLowerCase());
  }

  // Generic English descriptors that are NOT entity claims. These are
  // adjectives/description words from project descriptions (e.g. "Static Gen 1
  // Pokedex" from the Interactive Pokedex description text) or generic nouns
  // that never represent a fabricated entity.
  // IMPORTANT: real technology/platform names (Kubernetes, Terraform, Udemy,
  // Coursera, Pluralsight, LinkedIn, DevOps, Bash) are deliberately NOT here.
  // Recognizable tech names must still pass entity grounding — an entity-
  // recognition exemption must NOT become a factual-grounding exemption.
  // "Bradley has Kubernetes experience" must fail grounding unless a supported
  // triple exists. Negated mentions ("no Kubernetes experience") are already
  // handled by the negation-context skip above.
  const GENERIC_DESCRIPTORS = new Set([
    'static', 'gen', 'interactive', 'generation', 'calculator', 'testing', 'entry',
    'entries', 'profile', 'summary', 'overview', 'background',
  ]);

  for (const token of entityClaims) {
    // Skip entities in negation context — they're being refuted, not asserted
    const tokenLower = token.toLowerCase();
    const inNegation = negEntityContexts.some(ctx => ctx.includes(tokenLower));
    if (inNegation) continue;
    // Skip common English descriptors — they're adjectives/generic words, not entity claims
    if (GENERIC_DESCRIPTORS.has(tokenLower)) continue;
    // Skip multi-word phrases starting with a generic descriptor
    const firstWord = tokenLower.split(/\s+/)[0];
    if (GENERIC_DESCRIPTORS.has(firstWord)) continue;
    if (!isEntityGrounded(token, entityRegistry)) {
      reasons.push(`entity_not_grounded:${token}`);
    }
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
  // For invented-entity refutations ("No, he did not work at Microsoft."),
  // accept 0 overlap — the answer is correctly denying a false premise.
  const isRefutation = hasNegation(text) && groundedMatches.size >= 1;
  const isInventedEntityRefutation = /^(?:no[,.]?\s+)?(?:he|she|they)\s+(?:did not|never|has not|hasn't|doesn't|does not|attended|worked)\b/i.test(text) ||
    /^(?:no[,.]?\s+)?there\s+is\s+no\s+(?:evidence|record)/i.test(text);
  // For yes/no questions, a short answer like "Yes, he knows React." is valid
  // with just 1 content word overlap (the entity being asked about).
  const isYesNoQuestion = /^(?:does|do|is|was|has|have|can|could|would|will|are|were|did)\b/i.test(question.trim()) ||
                          /\bright\??$/i.test(question) || /\bcorrect\??$/i.test(question);
  const isPureYesNo = /^(?:yes|no|yes\.|no\.)$/i.test(text.trim());
  const isShortYesNo = isYesNoQuestion && groundedMatches.size >= 1 && text.length < 100;
  const isOpenEndedQuestion = /\b(quick version|summary|brief|tell me about|honest thing|best at|strongest|weakness|weaknesses|gap|gaps|why (?:should|would) i|interview|mit|harvard|stanford|degree from|actually do|bet on|role)\b/i.test(question);
  if (groundedMatches.size < 2 && !isRefutation && !isShortYesNo && !isInventedEntityRefutation && !isOpenEndedQuestion && !(isPureYesNo && isYesNoQuestion)) { reasons.push('insufficient_content_overlap'); }

  // 6. Question relevance — match on full word, stem prefix, or short tech terms.
  // Include 3-char tech terms (AWS, SQL, API) that the {4,} regex misses.
  // This is a SOFT check: only hard-fail if the answer shares NO topic overlap
  // with the question at all (no terms, no entities, no topic words).
  const SHORT_TECH_TERMS = new Set(['aws', 'sql', 'api', 'css', 'html', 'url', 'gcp', 'npm', 'git', 'hub', 's3', 'ec2', 'rds']);
  const longQuestionTerms = (String(question).toLowerCase().match(/[a-z][a-z0-9+#.-]{4,}/g) || [])
    .filter(w => !QUESTION_STOPWORDS.has(w));
  const shortQuestionTerms = (String(question).toLowerCase().match(/[a-z][a-z0-9+#.]{2,3}\b/g) || [])
    .filter(w => SHORT_TECH_TERMS.has(w));
  const allQuestionTerms = [...longQuestionTerms, ...shortQuestionTerms];
  if (allQuestionTerms.length > 0) {
    const answerLower = text.toLowerCase();
    const answered = allQuestionTerms.some(w => answerLower.includes(w) || answerLower.includes(w.slice(0, 4)));
    if (!answered && !hasNegation(text) && !isInventedEntityRefutation && !isOpenEndedQuestion) { reasons.push('not_relevant_to_question'); }
  }

  // AI slop / self-revelation
  if (/\b(as an ai|i am an ai|i'?m an ai|based on the (data|information|evidence) provided|according to (the )?(data|information|evidence))\b/i.test(text)) {
    reasons.push('ai_slop');
  }

  // Leaked internal syntax — the model sometimes echoes relation names or
  // internal graph terminology from the context/repair packet instead of
  // verbalizing them naturally. These are broken outputs that must never
  // be displayed to the user.
  // Examples: "worked_at modern web development", "uses_tech in the project",
  //           "connecting entities", "technology/entity not in the knowledge base"
  const LEAKED_RELATION_NAMES = /\b(?:worked_at|uses_tech|has_experience|has_skill|built_by|built_during|interned_at|employed_as|is_type|attended|certified_in|has_expertise|has_extensive_experience|specializes_in|proficient_in|adept_at|context_drift|unsupported_relationship|fabricated_entity|insufficient_content)\b/i;
  if (LEAKED_RELATION_NAMES.test(text)) {
    reasons.push('leaked_relation_syntax');
  }
  // Also catch "tech=" shorthand that the model sometimes produces
  const LEAKED_TECH_SYNTAX = /\btech\s*=\s*[A-Z]/i;
  if (LEAKED_TECH_SYNTAX.test(text)) {
    reasons.push('leaked_relation_syntax');
  }
  const LEAKED_INTERNAL_PHRASES = /\b(?:connecting entities|technology\/entity not in the knowledge base|entity not in the knowledge base|not in the knowledge base|not grounded in|invalid based on the provided facts|relationship between.*is invalid|unsupported relationship|not supported by (?:the )?(?:provided )?facts)\b/i;
  if (LEAKED_INTERNAL_PHRASES.test(text)) {
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
      const hasThirdPerson = /\b(he|his|him|she|her|they|their|the candidate|the subject|bradley|brad)\b/i.test(text);
      if (!hasThirdPerson) {
        reasons.push('persona_confusion');
      }
      break;
    }
  }

  // 7b. Assistant/Subject Persona Boundary Check — Scout is the assistant, Bradley is the subject.
  // Scout must NOT claim ownership of Bradley's education, degree, employment, internship, or project authorship.
  const assistantSubjectConflationPatterns = [
    /\bscout'?s?\s+(?:education|degree|gpa|university|college|internship|employment|work|career)\b/i,
    /\b(?:built|developed|created|made|written)\s+by\s+(?:scout|the\s+assistant)\b/i,
    /\b(?:scout|the\s+assistant)\s+(?:worked|interned|graduated|studied|built|developed|completed)\b/i,
    /\bprojecthub\s+(?:and|vs\.?|versus)\s+scout\b/i,
    /\bscout\s+(?:and|vs\.?|versus)\s+projecthub\b/i
  ];
  for (const pat of assistantSubjectConflationPatterns) {
    if (pat.test(text) && !hasNegation(text)) {
      reasons.push('persona_confusion:assistant_subject_conflation');
      break;
    }
  }

  // 7c. Visitor/Subject Persona Boundary Check — Scout must not treat the
  // visitor as Bradley. When the question asks about Bradley ("him", "he",
  // "his", "Bradley"), the answer should use third-person ("his", "Bradley's")
  // not second-person ("your") for Bradley's attributes.
  // Example: "I'm interested in learning about your experience" → persona confusion
  // But "You could ask him about..." is fine — that's Scout addressing the visitor.
  const questionAboutSubject = /\b(?:him|his|he\b|bradley|brad)\b/i.test(question || '');
  if (questionAboutSubject) {
    // Match "your [attribute]" where the attribute is something that belongs
    // to Bradley, not the visitor
    const visitorAsSubjectPatterns = [
      /\byour\s+(?:experience|projects?|skills?|degree|internship|work|education|career|background|certifications?|employment)\b/i,
      /\byour\s+(?:time|role|position|job|training|intern)\b/i
    ];
    for (const pat of visitorAsSubjectPatterns) {
      if (pat.test(text)) {
        // Check if it's a legitimate address to the visitor
        // "You could ask him about your project" — this is still about the visitor's project, not Bradley's
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

  // 7d. False negation check — if the answer says "no experience building/with"
  // but the graph has built_by triples for the subject, this is a false negation.
  // Example: "He has no experience with building software." when Bradley has
  // multiple built_by triples.
  if (knowledge) {
    try {
      const relGraph = graph || buildRelationshipGraph(knowledge);
      const falseNegationPatterns = [
        // Only flag clear denials of ALL building experience, not qualified
        // assessments like "has not built anything substantial" or "has not
        // built a large-scale system" which are valid honest assessments.
        /\b(?:he|she|they|bradley|brad)\s+(?:has|have)\s+no\s+(?:experience|background)\s+(?:with|in|building|developing|creating)\b/i,
        /\b(?:he|she|they|bradley|brad)\s+(?:has|have)\s+no\s+(?:experience|background)\b/i,
        // "his projects do not involve building anything" — denies all building
        /\b(?:his|her|their)\s+projects\s+(?:do\s+not|don't)\s+(?:involve|include)\s+building\b/i,
        // "he does not build" / "he didn't build anything"
        /\b(?:he|she|they|bradley|brad)\s+(?:does|do|did)\s+not\s+build\s+(?:anything|any\s+(?:projects|software|applications))\b/i,
        // "no specific project is mentioned as being built by him" — denies
        // building experience by claiming no evidence of built projects
        /\bno\s+(?:specific\s+)?(?:project|application|software)\s+(?:is\s+)?(?:mentioned|known|listed)\s+as\s+being\s+built\b/i,
        // "not with building projects or applications" — denies building
        /\bnot\s+with\s+building\s+(?:projects|applications|software)\b/i,
        // "has not done any professional projects" — denies all professional work
        /\b(?:he|she|they|bradley|brad)\s+(?:has|have)\s+not\s+done\s+any\s+professional\s+(?:projects|work|experience)\b/i,
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

      // Check for "lacks experience with X" where X is a project Bradley built
      const lacksPattern = /\b(?:he|she|they|bradley|brad)\s+lacks\s+experience\s+(?:with|in)\s+([A-Z][A-Za-z0-9\s&.-]{2,50})/gi;
      const builtProjectNames = relGraph.triples
        .filter(t => t.relation === 'built_by')
        .map(t => (t.subject || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
      let lacksMatch;
      while ((lacksMatch = lacksPattern.exec(text)) !== null) {
        const claimedEntity = lacksMatch[1].trim();
        const claimedNorm = claimedEntity.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Check if this entity is a project Bradley built
        const isBuiltProject = builtProjectNames.some(name =>
          name.includes(claimedNorm) || claimedNorm.includes(name) ||
          (claimedNorm.length > 4 && name.length > 4 && claimedNorm.slice(0, 6) === name.slice(0, 6))
        );
        if (isBuiltProject) {
          reasons.push(`false_negation:lacks_experience_with_built_project:${claimedEntity}`);
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
    const certPattern = /\b((?:AWS|Google|Microsoft|Azure|Oracle|CompTIA|Cisco|freeCodeCamp)\s+Certified\s+[A-Z][A-Za-z0-9+#.\s-]{2,50})/g;
    const claimedCerts = [];
    let certMatch;
    while ((certMatch = certPattern.exec(text)) !== null) {
      claimedCerts.push(certMatch[1].trim());
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
      const relValidation = validateRelationships(text, relGraph, question, history);
      for (const uc of relValidation.unsupportedClaims) {
        reasons.push(`unsupported_relationship:${uc.subject}|${uc.relation}|${uc.object}`);
      }
      for (const oc of relValidation.overclaimClaims) {
        reasons.push(`relationship_overclaim:${oc.relation}|${oc.object}`);
      }

      // 8b. Fabricated entity detection — entities in the answer that don't
      // exist anywhere in the knowledge base (e.g., "Vue.js" when Vue.js
      // is not in any skill, project, or experience entry).
      const fabricated = detectFabricatedEntities(text, relGraph, question);
      for (const entity of fabricated) {
        reasons.push(`fabricated_entity:${entity}`);
      }

      // 8c. Fabricated employment detection — if the answer claims Bradley
      // worked at / interned at / was employed at a company that is NOT in
      // the knowledge base, reject it. This catches answers like "Bradley
      // was a Cloud Support Engineer Intern with Netflix" when Netflix is
      // not a known employer. The question may mention the company (e.g.,
      // "What did he do at Netflix?") but the answer must deny, not affirm.
      const knownCompanies = new Set(
        relGraph.triples
          .filter(t => ['worked_at', 'interned_at', 'employed_at', 'employed_as'].includes(t.relation))
          .map(t => normalizeEntity(t.object))
      );
      const employmentPattern = /\b(?:Bradley(?:\s+Matera)?|He|She|They)\s+(?:was|worked|interned|employed|served|joined|spent\s+time)\s+(?:(?:at|with|for)\s+|as\s+(?:an?\s+)?(?:[A-Za-z]+\s+)*?(?:intern|engineer|developer|support|cloud|specialist|analyst|architect)\s+(?:at|with|for)\s+|a\s+(?:[A-Za-z]+\s+){1,5}(?:at|with|for)\s+)([A-Z][A-Za-z0-9&.\s-]{2,50})/gi;
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

      // 8c1b. "At [Company], he [verb]" construction — implies employment
      // Example: "At Netflix, he built a serverless metadata workflow..."
      const atCompanyPattern = /\bAt\s+([A-Z][A-Za-z0-9&.\s-]{2,40}?),\s+(?:he|she|they|Bradley(?:\s+Matera)?)\s+(?:built|created|developed|worked|designed|implemented|led|managed|wrote|deployed|maintained|contributed)/gi;
      let atCompMatch;
      while ((atCompMatch = atCompanyPattern.exec(text)) !== null) {
        const companyName = atCompMatch[1].trim();
        const companyNorm = normalizeEntity(companyName);
        if (companyNorm.length < 3) continue;
        const isKnown = [...knownCompanies].some(known =>
          known === companyNorm || known.includes(companyNorm) || companyNorm.includes(known) ||
          (companyNorm.length > 4 && known.length > 4 && companyNorm.slice(0, 6) === known.slice(0, 6))
        );
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
      const endAtCompanyPattern = /\b(?:internship|intern|capstone|project|work|job|role|position|career)\s+(?:at|with|for)\s+([A-Z][A-Za-z0-9&.\s-]{2,40}?)(?:\.|$|,)/gi;
      let endAtMatch;
      while ((endAtMatch = endAtCompanyPattern.exec(text)) !== null) {
        const companyName = endAtMatch[1].trim();
        const companyNorm = normalizeEntity(companyName);
        if (companyNorm.length < 3) continue;
        const isKnown = [...knownCompanies].some(known =>
          known === companyNorm || known.includes(companyNorm) || companyNorm.includes(known) ||
          (companyNorm.length > 4 && known.length > 4 && companyNorm.slice(0, 6) === known.slice(0, 6))
        );
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
          const entityName = empAtMatch[1].trim().split(/[,.\s]/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
          if (projectNames.has(entityName)) {
            const sentStart = Math.max(0, text.lastIndexOf('.', empAtMatch.index) + 1);
            const sentEnd = text.indexOf('.', empAtMatch.index);
            const sentence = text.slice(sentStart, sentEnd > 0 ? sentEnd : text.length);
            const isNegated = /\b(?:no(?:t|ne|,)?|never|didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|was not|has not|hasn't|have not|haven't)\b/i.test(sentence);
            if (!isNegated) {
              reasons.push(`wrong_relationship:project_as_company:${empAtMatch[1].trim()}`);
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
      if (relGraph.knowledge && Array.isArray(relGraph.knowledge.projects)) {
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
        for (const proj of relGraph.knowledge.projects) {
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
          const descPattern = new RegExp(
            projFirstWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '\\s+(?:is|was|allows|features|provides|offers|enables|helps|lets)\\s+',
            'i'
          );
          if (!descPattern.test(text)) continue;
          // Extract non-generic content words from the KB description
          const kbDesc = (proj.description || '').toLowerCase();
          const kbWords = (kbDesc.match(/[a-z][a-z]{3,}/g) || [])
            .filter(w => !GENERIC_DESC_WORDS.has(w));
          // Check if at least one non-generic KB word appears in the answer
          const hasOverlap = kbWords.some(w => textLower.includes(w));
          if (!hasOverlap && kbWords.length > 0) {
            reasons.push(`unsupported_description:${proj.name}`);
          }
        }
      }
    } catch (err) {
      console.error('Relationship validation error in grounding-validator:', err);
    }
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
    r.startsWith('wrong_relationship:project_as_company:') ||
    r.startsWith('unsupported_description:') ||
    r === 'overclaim_language' ||
    r === 'ai_slop' ||
    r === 'leaked_relation_syntax' ||
    r === 'leaked_internal_language'
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
  }
  for (const r of reasons) {
    if (r.startsWith('fabricated_entity:')) {
      rejectionDetails.push({ reason: 'FABRICATED_ENTITY', detail: `Entity not in knowledge base: ${r.split(':')[1]}` });
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

module.exports = {
  OVERCLAIM_RE,
  UPGRADE_PATTERNS,
  cleanText,
  extractCompleteSentences,
  validateAnswer,
  validateToolDecision,
  attemptJsonRepair,
  hasNegation,
  splitSentences,
  splitClauses
};
