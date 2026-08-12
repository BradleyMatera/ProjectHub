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

  // Adversarial — "He was X, right?" / "He has Y, correct?"
  if (/\b(?:right|correct|true|isn'?t it|don'?t you think)\b/.test(q) &&
      /^(?:he|she|they|it|you|bradley)\b/.test(q)) {
    return 'ADVERSARIAL';
  }

  // Negation question — "He was not X, was he?"
  if (/\b(?:was he|did he|is he|has he|have he)\b/.test(q) &&
      /\b(?:not|no|never)\b/.test(q)) {
    return 'ADVERSARIAL';
  }

  // Yes/No — starts with yes/no verb
  if (/^(?:does|do|is|was|has|have|can|could|would|will|are|were|did|should)\b/.test(q)) {
    // If it asks about a skill, classify as SKILL
    if (/\b(?:know|use|used|familiar|experience with|skilled)\b/.test(q)) {
      return 'SKILL';
    }
    return 'YES_NO';
  }

  // Comparison
  if (/\b(?:compare|versus|vs|difference|differ|better|worse|more complex|which one|which is)\b/.test(q)) {
    return 'COMPARISON';
  }

  // Job fit
  if (/\b(?:fit|role|job|position|hire|hiring|qualif|suitable|candidate for|match for)\b/.test(q)) {
    return 'JOB_FIT';
  }

  // Recruiter
  if (/\b(?:recruiter|hiring manager|interview|concern|why.*interview|quick version|summarize|summary|candidate)\b/.test(q)) {
    return 'RECRUITER';
  }

  // Opinion / personality
  if (/\b(?:what.*you.*think|what.*would.*you|favorite|most interesting|most impressive|best at|worst at|opinion)\b/.test(q)) {
    return 'OPINION';
  }

  // Follow-up — short questions that reference prior context
  // Check this BEFORE project/profile to catch "What about the backend?"
  if (q.split(/\s+/).length <= 8 &&
      /\b(?:that|it|this|the other|the one|what about|how about|why|which|where|when|how)\b/.test(q)) {
    return 'FOLLOW_UP';
  }

  // Profile — "tell me about Bradley" but NOT "tell me about ProjectHub"
  if (/\b(?:tell me about|who is|what.*about|describe|background|overview)\b/.test(q) &&
      !/\b(?:project|backend|frontend|stack|tech)\b/.test(q) &&
      !/(?:projecthub|ciris|pokedex|voice.?ops|serverless|metadata)/i.test(q)) {
    return 'PROFILE';
  }

  // Project — "tell me about ProjectHub", "what is the AWS project"
  if (/\b(?:tell me about|what is|describe|explain|what.*about|what.*does.*do)\b/.test(q) &&
      /(?:project|backend|frontend|stack|tech|build|built|architect|design|implement|projecthub|ciris|pokedex|voice.?ops|serverless|metadata)/i.test(q)) {
    return 'PROJECT';
  }

  // Skill
  if (/\b(?:skill|know|use|used|familiar|experience with|proficient|expert|best at)\b/.test(q)) {
    return 'SKILL';
  }

  // Honest gaps
  if (/\b(?:weakness|gap|lack|missing|concern|limitation|shortcoming|area.*improve)\b/.test(q)) {
    return 'RECRUITER';
  }

  return 'GENERAL';
}

/**
 * Evaluate conversational completeness of an answer.
 * @param {string} answer
 * @param {string} question
 * @param {object} evidence - retrieved evidence chunks
 * @returns {object} { complete: boolean, reason: string, intent: string, evidenceUtilization: number }
 */
function evaluateCompleteness(answer, question, evidence) {
  const text = String(answer || '').trim();
  const intent = classifyIntent(question);
  const words = text.split(/\s+/).filter(w => w.length > 0);

  // Empty or too short
  if (words.length < 3) {
    return { complete: false, reason: 'TOO_SHORT', intent, evidenceUtilization: 0 };
  }

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

  // Question repetition — answer just repeats the question
  const qWords = new Set(question.toLowerCase().match(/[a-z]{4,}/g) || []);
  const aWords = new Set(text.toLowerCase().match(/[a-z]{4,}/g) || []);
  const overlap = [...qWords].filter(w => aWords.has(w)).length;
  if (words.length < 15 && overlap / Math.max(qWords.size, 1) > 0.7) {
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
      if (words.length < 15) {
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
      if (!/\b(?:he|she|they|bradley|brad|his|her|their|candidate|him)\b/i.test(text)) {
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
