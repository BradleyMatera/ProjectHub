'use strict';

/**
 * Generic Conversational Completeness Evaluator
 *
 * Determines whether a factually-valid answer gives enough useful information
 * for the question type. This is NOT factual validation — it's conversational
 * quality assessment.
 *
 * Intent classes:
 * - YES_NO: direct answer + one supporting fact
 * - PROFILE: short summary + 2-4 important specifics
 * - PROJECT: what it is + what it does + key technical evidence
 * - SKILL: yes/no/degree of evidence + exact supporting context
 * - COMPARISON: cover both entities + meaningful difference
 * - JOB_FIT: strengths + evidence + honest gaps
 * - RECRUITER: concise useful summary + best evidence
 * - FOLLOW_UP: resolve current entity/context + answer directly
 * - ADVERSARIAL: direct refutation + correction
 * - OPINION: grounded reasoning from verified facts
 * - GENERAL: default — substantive answer with evidence
 */

/**
 * Classify question intent into a generic intent class.
 * @param {string} question
 * @returns {string} intent class
 */
function classifyIntent(question) {
  const q = (question || '').trim().toLowerCase();

  // Adversarial — "He was X, right?" / "He has Y, correct?" / "There is no evidence... right?"
  if (/\b(?:right|correct|true|isn'?t it|don'?t you think)\b/.test(q) &&
      /\b(?:he|she|they|it|bradley|evidence|no\s+evidence)\b/.test(q)) {
    return 'ADVERSARIAL';
  }

  // Negation question — "He was not X, was he?"
  if (/\b(?:was he|did he|is he|has he|have he)\b/.test(q) &&
      /\b(?:not|no|never)\b/.test(q)) {
    return 'ADVERSARIAL';
  }

  // Comparison — check BEFORE YES_NO so "Is A more complex than B?" is COMPARISON
  if (/\b(?:compare|versus|vs|difference|differ|better|worse|more complex|which one|which is|which project)\b/.test(q)) {
    return 'COMPARISON';
  }

  // Job fit — check BEFORE YES_NO so "Does he fit this role?" is JOB_FIT
  if (/\b(?:fit|role|job|position|hire|hiring|qualif|suitable|candidate for|match for)\b/.test(q)) {
    return 'JOB_FIT';
  }

  // Recruiter — check BEFORE YES_NO so "Is he worth interviewing?" is RECRUITER
  if (/\b(?:recruiter|hiring manager|interview|concerns?|why.*interview|quick version|summarize|summary|candidate|worth|ask\s+him|should\s+i\s+ask)\b/.test(q)) {
    return 'RECRUITER';
  }

  // Honest gaps — check BEFORE YES_NO so "Does he lack X?" is RECRUITER
  if (/\b(?:weakness(?:es)?|gaps?|lacks?|lacking|missing|limitation|shortcoming|area.*improve|need.*to\s+learn|still\s+need)\b/.test(q)) {
    return 'RECRUITER';
  }

  // Opinion / personality — check BEFORE YES_NO so "Is that impressive?" is OPINION
  if (/\b(?:what.*you.*think|what.*would.*you.*bet|bet\s+on|favorite|most interesting|most impressive|best at|worst at|opinion|impressive|interesting|why.*should.*care|why.*matter|honest\s+thing)\b/.test(q)) {
    return 'OPINION';
  }

  // Yes/No — starts with yes/no verb (check before FOLLOW_UP for yes/no questions)
  if (/^(?:does|do|is|was|has|have|can|could|would|will|are|were|did|should)\b/.test(q)) {
    // If it asks about a skill, classify as SKILL
    if (/\b(?:know|use|used|familiar|experience with|skilled|done with)\b/.test(q)) {
      return 'SKILL';
    }
    return 'YES_NO';
  }

  // Follow-up — short questions with referents that reference prior context
  // Check AFTER specialized intents and YES_NO so they take priority
  // Two categories: (a) explicit referent words, (b) short question-word follow-ups
  if (q.split(/\s+/).length <= 10 &&
      /\b(?:that|it|this|there|the other|the one)\b/.test(q) &&
      !/\b(?:explain|describe)\b/.test(q)) {
    return 'FOLLOW_UP';
  }
  if (q.split(/\s+/).length <= 6 &&
      /\b(?:what about|how about|why|which|where|when|how)\b/.test(q) &&
      !/\b(?:fit|role|compare|versus|vs|which is|which one|explain|describe|build|built)\b/.test(q)) {
    return 'FOLLOW_UP';
  }

  // Profile — "tell me about Bradley" but NOT "tell me about ProjectHub" or companies/degrees
  if (/\b(?:tell me about|who is|what.*about|describe|background|overview|what.*does.*do)\b/.test(q) &&
      !/\b(?:project|backend|frontend|stack|tech|time\s+at|master|degree)\b/.test(q) &&
      !/(?:projecthub|ciris|pokedex|voice.?ops|serverless|metadata)/i.test(q)) {
    return 'PROFILE';
  }

  // Project — "tell me about ProjectHub", "what is the AWS project", "what did he build"
  if (/\b(?:tell me about|what is|describe|explain|what.*about|what.*does.*do|what.*build|what.*built|what.*did.*build|what.*did.*do\s+at|hardest|cool\s+part|technical\s+part)\b/.test(q) &&
      /(?:project|backend|frontend|stack|tech|build|built|architect|design|implement|projecthub|ciris|pokedex|voice.?ops|serverless|metadata|at\s+(?:microsoft|netflix|google|amazon|aws)|master|degree|time\s+at|cool\s+part|hardest|technical\s+part)/i.test(q)) {
    return 'PROJECT';
  }

  // Skill
  if (/\b(?:skill|know|use|used|familiar|experience with|proficient|expert|best at|done with)\b/.test(q)) {
    return 'SKILL';
  }

  return 'GENERAL';
}

/**
 * Evaluate conversational completeness of an answer.
 * @param {string} answer
 * @param {string} question
 * @param {object} evidence - retrieved evidence chunks
 * @param {object} responseContract - optional response contract from buildResponseContract
 * @returns {object} { complete: boolean, reason: string, intent: string, evidenceUtilization: number, missingEntities: string[] }
 */
function evaluateCompleteness(answer, question, evidence, responseContract) {
  const text = String(answer || '').trim();
  const intent = classifyIntent(question);
  const words = text.split(/\s+/).filter(w => w.length > 0);

  // Empty or too short
  if (words.length < 3) {
    return { complete: false, reason: 'TOO_SHORT', intent, evidenceUtilization: 0 };
  };

  // Generic filler detection (structural, not phrase-specific)
  const fillerSignals = [
    /\b(?:would you like|could you (?:specify|clarify|provide)|to better assist)\b/i,
    /\bas an ai\b/i,
    /\bbased on the (?:information|data|evidence) (?:provided|available|given)\b/i,
    /\b(?:i don'?t have access|i cannot (?:access|provide))\b/i,
  ];
  for (const re of fillerSignals) {
    if (re.test(text)) {
      return { complete: false, reason: 'GENERIC_FILLER', intent, evidenceUtilization: 0 };
    }
  }

  // Required entity coverage — if the response contract specifies required entities,
  // the answer MUST mention them. This is the primary anti-generic mechanism.
  if (responseContract && responseContract.requiredEntities && responseContract.requiredEntities.length > 0) {
    const answerLower = text.toLowerCase();
    const answerNoSpace = answerLower.replace(/[^a-z0-9]/g, '');
    const missing = [];
    for (const entity of responseContract.requiredEntities) {
      const eLower = entity.toLowerCase();
      const eNoSpace = eLower.replace(/[^a-z0-9]/g, '');
      // Check multiple variants: exact, no-space, and partial (first significant word)
      // "ProjectHub (Scout)" should match "ProjectHub" in the answer
      const variants = [
        eLower,
        eNoSpace,
        eLower.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
      ];
      // Also check the first significant word (for entities like "ProjectHub (Scout)")
      const firstWord = eLower.split(/[\s(]+/)[0];
      if (firstWord && firstWord.length >= 4) {
        variants.push(firstWord);
      }
      const found = variants.some(v => {
        const vNoSpace = v.replace(/[^a-z0-9]/g, '');
        return answerLower.includes(v) || answerNoSpace.includes(vNoSpace);
      });
      if (!found) missing.push(entity);
    }
    if (missing.length > 0) {
      return { complete: false, reason: 'MISSING_REQUIRED_ENTITIES', intent, evidenceUtilization: 0, missingEntities: missing };
    }
  }

  // Required fact coverage — if the response contract has key facts,
  // check that the answer reflects at least some of their content.
  // This catches answers that are topically correct but miss specific evidence.
  // Only flag VERY SHORT answers (< 12 words) that don't cover any facts —
  // longer answers likely have relevant content even if word overlap is low.
  if (responseContract && responseContract.keyFacts && responseContract.keyFacts.length > 0) {
    const answerLower = text.toLowerCase();
    const answerWords = new Set(answerLower.match(/[a-z][a-z0-9+#.-]{3,}/g) || []);
    let coveredFacts = 0;
    for (const fact of responseContract.keyFacts) {
      const factLower = fact.toLowerCase();
      const factWords = new Set(factLower.match(/[a-z][a-z0-9+#.-]{3,}/g) || []);
      // A fact is "covered" if at least 20% of its significant words appear in the answer
      const significantWords = [...factWords].filter(w =>
        !/^(?:the|this|that|with|from|have|been|which|what|where|when|they|them|their|there|then|than|also|would|could|should|about|after|before|between|during|while|these|those|each|every|some|many|much|more|most|such|very|into|onto|upon|within|without|because|since|however|therefore|moreover|additionally|furthermore|nevertheless|nonetheless|project|experience|using|including|based)\b/.test(w)
      );
      if (significantWords.length === 0) continue;
      const matched = significantWords.filter(w => answerWords.has(w)).length;
      if (matched / significantWords.length >= 0.2) {
        coveredFacts++;
      }
    }
    // Only flag if NO key facts are covered AND the answer is very short (< 12 words)
    if (coveredFacts === 0 && words.length < 12 && responseContract.keyFacts.length > 0) {
      return { complete: false, reason: 'MISSING_REQUIRED_FACTS', intent, evidenceUtilization: 0, missingFacts: responseContract.keyFacts };
    }
  }

  // Polarity check — if the contract specifies a direct answer, verify the answer matches
  if (responseContract && responseContract.directAnswer) {
    const da = responseContract.directAnswer;
    if (da === 'NO' || da === 'NOT_FIT') {
      // Answer should contain negation
      if (!/\b(?:no|not|never|incorrect|wrong|false|didn'?t|did not|wasn'?t|was not|isn'?t|is not|doesn'?t|does not)\b/i.test(text)) {
        return { complete: false, reason: 'POLARITY_MISMATCH', intent, evidenceUtilization: 0, expectedPolarity: da };
      }
    } else if (da === 'YES' || da === 'FIT') {
      // Answer should contain affirmation (but not negation of the affirmation)
      const hasAffirmation = /\b(?:yes|correct|right|true|absolutely|indeed|fits|matches|qualified)\b/i.test(text);
      const hasNegation = /\b(?:no|not|never|incorrect|wrong|false|doesn'?t|does not)\b/i.test(text);
      // For YES/FIT, either explicit yes or a positive statement without negation is OK
      // But if the answer starts with "No" when polarity is YES, that's a mismatch
      if (/^(?:no|not|never|incorrect)\b/i.test(text) && !hasAffirmation) {
        return { complete: false, reason: 'POLARITY_MISMATCH', intent, evidenceUtilization: 0, expectedPolarity: da };
      }
    }
  }

  // Generic vague phrase detection — answers that use vague descriptors
  // instead of naming specific technologies, projects, or skills.
  // These pass validation but are not conversationally good.
  const GENERIC_VAGUE_PATTERNS = [
    /\b(?:simple|basic|small)\s+(?:projects|technologies|applications|apps|systems|things)\b/i,
    /\b(?:building|creating|making)\s+(?:simple|basic|small)\s+(?:projects|things|applications)\b/i,
    /\b(?:basic|simple)\s+(?:technologies|tools|skills|approaches|methods)\b/i,
    /\b(?:various|multiple|several|many)\s+(?:technologies|tools|skills|projects|platforms)\b/i,
    /\b(?:software development|web development)\s+(?:tools|platforms|technologies)\s+(?:and|or)\s+platforms\b/i,
  ];
  for (const re of GENERIC_VAGUE_PATTERNS) {
    if (re.test(text)) {
      return { complete: false, reason: 'GENERIC_VAGUE', intent, evidenceUtilization: 0 };
    }
  }

  // Question repetition — answer just repeats the question without adding anything
  const qWords = new Set(question.toLowerCase().match(/[a-z]{4,}/g) || []);
  const aWords = new Set(text.toLowerCase().match(/[a-z]{4,}/g) || []);
  const overlap = [...qWords].filter(w => aWords.has(w)).length;
  // Only flag as repetition if the answer has very few words that AREN'T in the question
  const uniqueAnswerWords = [...aWords].filter(w => !qWords.has(w)).length;
  if (words.length < 15 && overlap / Math.max(qWords.size, 1) > 0.7 && uniqueAnswerWords < 2) {
    return { complete: false, reason: 'QUESTION_REPETITION', intent, evidenceUtilization: 0 };
  }

  // Evidence utilization — how many evidence keywords appear in the answer
  const evidenceKeywords = new Set();
  if (evidence && Array.isArray(evidence)) {
    for (const ev of evidence) {
      const evText = (ev.description || ev.text || '').toLowerCase();
      const keywords = evText.match(/[a-z][a-z0-9+#.-]{3,}/g) || [];
      for (const kw of keywords) {
        if (kw.length >= 5 && !/^(?:the|this|that|with|from|have|been|which|what|where|when|they|them|their|there|then|than|also|would|could|should|about|after|before|between|during|while|these|those|each|every|some|many|much|more|most|such|very|into|onto|upon|within|without|because|since|however|therefore|moreover|additionally|furthermore|nevertheless|nonetheless)\b/.test(kw)) {
          evidenceKeywords.add(kw);
        }
      }
    }
  }
  const answerLower = text.toLowerCase();
  let usedKeywords = 0;
  for (const kw of evidenceKeywords) {
    if (answerLower.includes(kw)) usedKeywords++;
  }
  const evidenceUtilization = evidenceKeywords.size > 0
    ? usedKeywords / evidenceKeywords.size
    : 0;

  // Intent-specific completeness checks
  switch (intent) {
    case 'YES_NO':
      // Need at least a direct answer + some context
      if (words.length < 8) {
        return { complete: false, reason: 'YES_NO_TOO_TERSE', intent, evidenceUtilization };
      }
      // Check for direct yes/no
      if (!/\b(?:yes|no|correct|incorrect|right|wrong|true|false|absolutely|indeed|not)\b/i.test(text)) {
        return { complete: false, reason: 'NO_DIRECT_ANSWER', intent, evidenceUtilization };
      }
      // If evidence was provided but zero keywords were utilized, the answer is non-responsive filler
      if (evidenceKeywords.size >= 3 && usedKeywords === 0) {
        return { complete: false, reason: 'GENERIC_FILLER', intent, evidenceUtilization: 0 };
      }
      // For "did he do X professionally?" type questions, check that the
      // answer addresses the professional/internship distinction
      if (/\b(?:professionally|professional|production|internship|intern)\b/i.test(question) &&
          !/\b(?:professionally|professional|production|internship|intern|project|personal)\b/i.test(text)) {
        return { complete: false, reason: 'NOT_RELEVANT_TO_QUESTION', intent, evidenceUtilization };
      }
      return { complete: true, reason: 'OK', intent, evidenceUtilization };

    case 'SKILL':
      // Need yes/no + at least one supporting fact
      if (words.length < 10) {
        return { complete: false, reason: 'SKILL_TOO_TERSE', intent, evidenceUtilization };
      }
      // Check that the answer connects to the candidate, not just explains the technology
      if (!/\b(?:he|she|they|bradley|brad|his|her|their|candidate|him)\b/i.test(text)) {
        return { complete: false, reason: 'SKILL_NO_CANDIDATE_LINK', intent, evidenceUtilization };
      }
      return { complete: true, reason: 'OK', intent, evidenceUtilization };

    case 'ADVERSARIAL':
      // Need direct refutation + correction context
      if (words.length < 8) {
        return { complete: false, reason: 'ADVERSARIAL_TOO_TERSE', intent, evidenceUtilization };
      }
      // Must contain negation or correction
      if (!/\b(?:no|not|never|incorrect|wrong|false|didn'?t|did not|wasn'?t|was not|isn'?t|is not)\b/i.test(text)) {
        return { complete: false, reason: 'ADVERSARIAL_NO_REFUTATION', intent, evidenceUtilization };
      }
      return { complete: true, reason: 'OK', intent, evidenceUtilization };

    case 'PROFILE':
      if (words.length < 15) {
        return { complete: false, reason: 'PROFILE_TOO_SHORT', intent, evidenceUtilization };
      }
      // Profile answers must reference specific evidence
      if (evidenceKeywords.size >= 3 && usedKeywords === 0) {
        return { complete: false, reason: 'GENERIC_FILLER', intent, evidenceUtilization: 0 };
      }
      return { complete: true, reason: 'OK', intent, evidenceUtilization };

    case 'PROJECT':
      if (words.length < 15) {
        return { complete: false, reason: 'PROJECT_TOO_SHORT', intent, evidenceUtilization };
      }
      // Project answers must reference specific evidence
      if (evidenceKeywords.size >= 3 && usedKeywords === 0) {
        return { complete: false, reason: 'GENERIC_FILLER', intent, evidenceUtilization: 0 };
      }
      return { complete: true, reason: 'OK', intent, evidenceUtilization };

    case 'COMPARISON':
      // Need to mention both entities being compared
      if (words.length < 8) {
        return { complete: false, reason: 'COMPARISON_TOO_SHORT', intent, evidenceUtilization };
      }
      // Check that both entities from the question are mentioned in the answer
      {
        const compareMatch = question.match(/\b(?:compare|versus|vs\.?)\b\s+(.+?)\s+(?:and|to|with|vs\.?)\s+(.+)/i);
        if (compareMatch) {
          // Get raw entities before lowercasing to preserve camelCase
          const raw1 = compareMatch[1].trim().split(/[,.\s]/)[0];
          const raw2 = compareMatch[2].trim().split(/[,.\s]/)[0];
          const entity1 = raw1.toLowerCase();
          const entity2 = raw2.toLowerCase();
          const answerLower = answer.toLowerCase();
          const answerNoSpace = answerLower.replace(/[^a-z0-9]/g, '');
          // Check if both entities appear — try exact, normalized (no spaces/punct),
          // and space-separated (for camelCase like ProjectHub → project hub)
          const variants = e => [
            e,
            e.replace(/[^a-z0-9]/g, ''),
            e.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
            raw1 === e ? e : raw1.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
          ];
          const e1Variants = [...new Set([entity1, entity1.replace(/[^a-z0-9]/g, ''), raw1.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()])];
          const e2Variants = [...new Set([entity2, entity2.replace(/[^a-z0-9]/g, ''), raw2.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()])];
          const hasEntity1 = e1Variants.some(v => answerLower.includes(v) || answerNoSpace.includes(v));
          const hasEntity2 = e2Variants.some(v => answerLower.includes(v) || answerNoSpace.includes(v));
          if (!hasEntity1 || !hasEntity2) {
            return { complete: false, reason: 'COMPARISON_MISSING_ENTITY', intent, evidenceUtilization };
          }
        }
      }
      return { complete: true, reason: 'OK', intent, evidenceUtilization };

    case 'JOB_FIT':
      if (words.length < 15) {
        return { complete: false, reason: 'JOB_FIT_TOO_SHORT', intent, evidenceUtilization };
      }
      // Job fit answers must reference specific evidence
      if (evidenceKeywords.size >= 3 && usedKeywords === 0) {
        return { complete: false, reason: 'GENERIC_FILLER', intent, evidenceUtilization: 0 };
      }
      return { complete: true, reason: 'OK', intent, evidenceUtilization };

    case 'RECRUITER':
      if (words.length < 15) {
        return { complete: false, reason: 'RECRUITER_TOO_SHORT', intent, evidenceUtilization };
      }
      // Recruiter answers must reference specific evidence about the candidate
      if (evidenceKeywords.size >= 3 && usedKeywords === 0) {
        return { complete: false, reason: 'GENERIC_FILLER', intent, evidenceUtilization: 0 };
      }
      return { complete: true, reason: 'OK', intent, evidenceUtilization };

    case 'OPINION':
      if (words.length < 10) {
        return { complete: false, reason: 'OPINION_TOO_SHORT', intent, evidenceUtilization };
      }
      // Opinion answers must reference specific evidence
      if (evidenceKeywords.size >= 3 && usedKeywords === 0) {
        return { complete: false, reason: 'GENERIC_FILLER', intent, evidenceUtilization: 0 };
      }
      return { complete: true, reason: 'OK', intent, evidenceUtilization };

    case 'FOLLOW_UP':
      if (words.length < 10) {
        return { complete: false, reason: 'FOLLOW_UP_TOO_SHORT', intent, evidenceUtilization };
      }
      // Follow-up answers must use at least some evidence
      if (evidenceKeywords.size >= 3 && usedKeywords === 0) {
        return { complete: false, reason: 'GENERIC_FILLER', intent, evidenceUtilization: 0 };
      }
      // Follow-up answers about skills/tech must connect to the candidate
      // (not just explain what the technology is)
      // BUT: project follow-ups ("what about the other project?") don't need
      // to mention the candidate — they're about the project itself
      const isProjectFollowUp = /\b(?:project|other one|that one|this one|it|that|thing)\b/i.test(question);
      if (!isProjectFollowUp &&
          !/\b(?:he|she|they|bradley|brad|his|her|their|candidate|him)\b/i.test(text)) {
        return { complete: false, reason: 'SKILL_NO_CANDIDATE_LINK', intent, evidenceUtilization };
      }
      return { complete: true, reason: 'OK', intent, evidenceUtilization };

    default:
      if (words.length < 10) {
        return { complete: false, reason: 'TOO_SHORT', intent, evidenceUtilization };
      }
      // Generic answers that don't use any evidence are not complete
      if (evidenceKeywords.size >= 3 && usedKeywords === 0) {
        return { complete: false, reason: 'GENERIC_FILLER', intent, evidenceUtilization: 0 };
      }
      return { complete: true, reason: 'OK', intent, evidenceUtilization };
  }
}

module.exports = { classifyIntent, evaluateCompleteness };
