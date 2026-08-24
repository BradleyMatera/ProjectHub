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

// Configurable subject name pattern for candidate reference detection
let _subjectNamePattern = '';
function configureSubjectNames(names = []) {
  const valid = names.filter(Boolean).map(n => n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  _subjectNamePattern = valid.length > 0 ? '|' + valid.join('|') : '';
}

function buildSubjectPattern(names = []) {
  if (!names || names.length === 0) return _subjectNamePattern;
  const valid = names.filter(Boolean).map(n => n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return valid.length > 0 ? '|' + valid.join('|') : '';
}

/**
 * Classify question intent into a generic intent class.
 * @param {string} question
 * @param {string[]} [names] - Optional subject names to resolve, e.g. [subjectName]
 * @returns {string} intent class
 */
function classifyIntent(question, names) {
  const q = (question || '').trim().toLowerCase();
  const subj = `(?:he|they|she${buildSubjectPattern(names)})`;

  // REFUSAL — requests for private/sensitive data that must be refused
  if (/\b(?:social\s+security|ssn|password|credit\s+card|bank\s+account|home\s+address|phone\s+number|date\s+of\s+birth|passport)\b/.test(q) ||
      /\b(?:give\s+me\s+every|all\s+(?:details|the\s+details|personal)|every\s+(?:personal\s+)?detail|exhaustive|personal\s+details?)\b/.test(q) && /\b(?:detail|personal|about\s+(?:him|her|them|the\s+candidate))\b/.test(q)) {
    return 'REFUSAL';
  }

  // OOS — questions clearly outside the bot's domain (weather, cooking, sports, politics, etc.)
  if (/\b(?:weather|temperature|forecast|rain|sunny|cloudy|humidity|wind\s+speed)\b/.test(q) &&
      !/\b(?:project|app|code|tech|stack|build)\b/.test(q)) {
    return 'OOS';
  }
  if (/\b(?:recipe|cook|baking|ingredient|how\s+do\s+i\s+(?:cook|bake))\b/.test(q)) {
    return 'OOS';
  }
  if (/\b(?:stock\s+price|invest|crypto|bitcoin|trading)\b/.test(q) &&
      !/\b(?:project|app|code|tech|build)\b/.test(q)) {
    return 'OOS';
  }

  // META — questions about the assistant itself (covers META_IDENTITY/CAPABILITIES/INFRASTRUCTURE/PRIVACY/LIMITS)
  if (/\b(?:what\s+can\s+you\s+tell\s+me|what\s+can\s+you\s+tell|what\s+do\s+you\s+know|what\s+information\s+do\s+you\s+have|what\s+are\s+you\s+able\s+to\s+tell\s+me|what\s+do\s+you\s+do|what\s+is\s+your\s+purpose|what\s+are\s+you\s+for|what\s+is\s+this\s+for|how\s+do\s+i\s+use\s+this|what\s+topics|what\s+questions|your\s+name|who\s+are\s+you|what\s+are\s+you|what\s+is\s+your\s+name|what\s+can\s+you\s+(?:do|help|answer)|what\s+can\s+i\s+ask\s+you|are\s+you\s+(?:an?\s+)?(?:ai|assistant)|which\s+assistant\s+are\s+you|what\s+model|what\s+provider|what\s+llm|what\s+ai|which\s+model|which\s+provider|what\s+powers\s+you|what\s+is\s+your\s+stack|what\s+mcp|what\s+connections|are\s+you\s+online|how\s+is\s+this\s+hosted|what\s+systems|what\s+is\s+this\s+chatbot|is\s+my\s+chat\s+private|is\s+my\s+conversation\s+private|what\s+data\s+do\s+you\s+use|is\s+this\s+hosted\s+on|where\s+is\s+data\s+sent|do\s+you\s+store|privacy|what\s+can(?:'t|not)\s+you\s+do|what\s+can\s+you\s+not\s+do|what\s+limits|daily\s+cap|rate\s+limit|what\s+are\s+your\s+limits|can\s+you\s+(?:go\s+(?:to|there)|visit|read|browse|open)\s+(?:a\s+)?(?:url|website|page|link|site)|can\s+you\s+(?:commit|save|store|persist|remember)\s+(?:this|that|it|them|new\s+information|data)\b|go\s+(?:to|there)\s+and\s+read|commit\s+(?:this|that|it|them)\s+to\s+(?:your|the)\s+(?:database|memory|knowledge)|save\s+(?:this|that|it|them)\s+to\s+your\s+(?:memory|database|knowledge)|read\s+(?:this|that|it|them)\s+from\s+(?:the\s+)?(?:url|website|page)|visit\s+(?:the\s+)?(?:url|website|page|link|site)\s+and\s+(?:read|commit|save|store))\b/.test(q)) {
    return 'META';
  }

  // FUTURE_CAPABILITY — questions about potential/learning, not current skill evidence
  if (new RegExp(`\\b(?:could\\s+${subj}\\s+(?:become|learn|get|pick|take|be\\s+able\\s+to)|would\\s+${subj}\\s+(?:be\\s+able\\s+to|be|become|learn)|will\\s+${subj}\\s+(?:be|become|learn)|can\\s+${subj}\\s+(?:learn|pick\\s+up|get\\s+good|become)|future\\s+(?:skill|role|capability)|potential\\s+(?:to|for)|someday|one\\s+day|learn\\s+in\\s+the\\s+future|eventually\\s+(?:lead|be|become|learn))\\b`).test(q)) {
    return 'FUTURE_CAPABILITY';
  }

  // Adversarial hypothetical claim — "Pretend he was X", "Suppose he worked at Y"
  if (/\b(?:pretend|suppose|imagine|assume)\b/.test(q) &&
      new RegExp(`\\b(?:he|she|they|it${_subjectNamePattern})\\b`).test(q) &&
      /\b(?:was|is|has|had|worked|worked at|became|is a|are a)\b/.test(q)) {
    return 'ADVERSARIAL';
  }

  // Adversarial — "He was X, right?" / "He has Y, correct?" / "There is no evidence... right?"
  if (/\b(?:right|correct|true|isn'?t it|don'?t you think)\b/.test(q) &&
      new RegExp(`\\b(?:he|she|they|it${_subjectNamePattern}|evidence|no\\s+evidence)\\b`).test(q)) {
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

  // Qualifications / skill-stack summary — before JOB_FIT so "what qualifications" is not reduced to a role-fit lookup
  if (/\b(?:what\s+qualifications?|his\s+qualifications?|qualifications?\s+(?:does|has|do)\b|what\s+(?:is|are)\s+(?:his|their|the)\s+(?:tech\s+stack|technology\s+stack|stack)|(?:his|their|the)\s+(?:tech\s+stack|technology\s+stack|stack)|what\s+skills?\s*(?:does|has|is)\b)\b/.test(q)) {
    return 'QUALIFICATIONS';
  }

  // Job fit — check BEFORE YES_NO so "Does he fit this role?" is JOB_FIT
  if (/\b(?:fit|role|job|position|hire|hiring|qualif|suitable|candidate for|match for)\b/.test(q)) {
    return 'JOB_FIT';
  }

  // Recruiter — check BEFORE YES_NO so "Is he worth interviewing?" is RECRUITER
  if (/\b(?:recruiter|hiring manager|interview|concerns?|why.*interview|quick version|summarize|summary|candidate|worth|ask\s+him|should\s+i\s+ask)\b/.test(q)) {
    return 'RECRUITER';
  }

  // Negative assessment — check BEFORE YES_NO so "Does he lack X?" and "What is his weakness?" go here
  if (/\b(?:weakness(?:es)?|gaps?|lacks?|lacking|missing|limitation|shortcoming|area.*improve|need.*to\s+learn|still\s+need)\b/.test(q)) {
    return 'NEGATIVE_ASSESSMENT';
  }

  // Opinion / personality — check BEFORE YES_NO so "Is that impressive?" is OPINION
  if (/\b(?:what.*you.*think|what.*would.*you.*bet|bet\s+on|favorite|most interesting|most impressive|best at|worst at|opinion|impressive|interesting|why.*should.*care|why.*matter|honest\s+thing|work\s+ethic|reliability|reliable|initiative|learning\s+ability|problem\s+solving|persistence|communication\s+style|strengths?|weaknesses?|risks?|character|attitude|soft\s+skills|professionalism|personality|fit|good\s+junior|why.*(good|strong|worthwhile).*(candidate|hire|interview))\b/.test(q)) {
    return 'OPINION';
  }

  // CONTACT — public contact info (email, linkedin, github, portfolio, public phone)
  if (/(?:\bcontact\b|email|linkedin|github|portfolio|reach|get.*touch|send.*message|\bphone\b)/.test(q) &&
      !/home address|ssn|password|credit card|bank|private/.test(q)) {
    return 'CONTACT';
  }

  // Yes/No — starts with yes/no verb (check before FOLLOW_UP for yes/no questions)
  if (/^(?:does|do|is|was|has|have|can|could|would|will|are|were|did|should)\b/.test(q)) {
    // If it asks about a skill, classify as SKILL
    if (/\b(?:know|use|used|familiar|experience with|skilled|done with|debug|build|write|create|code|handle|troubleshoot|implement|develop|program|work with)\b/.test(q)) {
      return 'SKILL';
    }
    return 'YES_NO';
  }

  // Follow-up — short questions with referents that reference prior context
  // Check AFTER specialized intents and YES_NO so they take priority
  // Two categories: (a) explicit referent words, (b) short question-word follow-ups
  if (q.split(/\s+/).length <= 10 &&
      /\b(?:that|it|this|there|the other|the one|them|these|those)\b/.test(q) &&
      !/\b(?:explain|describe)\b/.test(q)) {
    return 'FOLLOW_UP';
  }
  if (q.split(/\s+/).length <= 6 &&
      /\b(?:what about|how about|why|which|where|when|how)\b/.test(q) &&
      !/\b(?:fit|role|compare|versus|vs|which is|which one|explain|describe|build|built)\b/.test(q)) {
    return 'FOLLOW_UP';
  }

  // Experience / companies — before PROJECT so "what companies" gets experience evidence
  if (/\b(?:companies?|employers?|where\s+(?:has|did|does)\s+(?:he|she|they)\s+(?:work|worked|been\s+employed)|work\s+history|employment\s+history)\b/.test(q)) {
    return 'EXPERIENCE';
  }

  // Profile — "tell me about the candidate" but NOT "tell me about [Project]" or companies/degrees
  if (/\b(?:tell me about|who is|what.*about|describe|background|overview|what.*does.*do)\b/.test(q) &&
      !/\b(?:project\w*|backend|frontend|stack|tech|time\s+at|master|degree)\b/i.test(q)) {
    return 'PROFILE';
  }

  // Tech / skill stack questions are about skills, not a named project.
  if (/\b(?:tech\s+stack|technology\s+stack|stack)\b/i.test(q) && !/\bproject\b/i.test(q)) {
    return 'QUALIFICATIONS';
  }

  // Project — "tell me about [Project]", "what is the AWS project", "what did he build"
  if (/\b(?:tell me about|what is|describe|explain|what.*about|what.*does.*do|what.*build|what.*built|what.*did.*build|what.*did.*do\s+at|hardest|cool\s+part|technical\s+part)\b/.test(q) &&
      /\b(?:project\w*|backend|frontend|stack|tech|build|built|architect|design|implement|serverless|metadata|at\s+(?:microsoft|netflix|google|amazon|aws)|master|degree|time\s+at|cool\s+part|hardest|technical\s+part)\b/i.test(q)) {
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

  // Semantic completeness for confirmation-style contracts.
  // For AFFIRM, DENY, AFFIRM_NEGATION, DENY_NEGATION stances, a short
  // generated answer MAY satisfy minimum completeness when:
  // - polarity is correct (answer matches the required stance)
  // - the question is naturally binary (yes/no confirmation)
  // - no required evidence explanation is mandated by the contract
  // - no required entities are missing
  const answerStance = responseContract?.answerStance;
  if (answerStance && ['AFFIRM', 'DENY', 'AFFIRM_NEGATION', 'DENY_NEGATION'].includes(answerStance)) {
    const isAffirmative = /^(?:yes|correct|right|true|absolutely|indeed)\b/i.test(text);
    const isNegative = /^(?:no|incorrect|wrong|false|never)\b/i.test(text);
    const stanceNeedsAffirm = answerStance === 'AFFIRM' || answerStance === 'AFFIRM_NEGATION';
    const stanceNeedsDeny = answerStance === 'DENY' || answerStance === 'DENY_NEGATION';
    const polarityCorrect = (stanceNeedsAffirm && isAffirmative) || (stanceNeedsDeny && isNegative);

    // Check if the contract requires evidence explanation
    const requiresEvidence = responseContract?.evidenceRequirements?.length > 0;
    const hasRequiredEntities = responseContract?.requiredEntities?.length > 0;
    // Check if required entities are present
    let entitiesMissing = false;
    if (hasRequiredEntities) {
      const answerLower = text.toLowerCase();
      const answerNoSpace = answerLower.replace(/[^a-z0-9]/g, '');
      for (const entity of responseContract.requiredEntities) {
        const eLower = entity.toLowerCase();
        const eNoSpace = eLower.replace(/[^a-z0-9]/g, '');
        const firstWord = eLower.split(/[\s(]+/)[0];
        const found = answerLower.includes(eLower) || answerNoSpace.includes(eNoSpace) ||
          (firstWord && firstWord.length >= 4 && answerLower.includes(firstWord));
        if (!found) { entitiesMissing = true; break; }
      }
    }

    if (polarityCorrect && !requiresEvidence && !entitiesMissing) {
      return { complete: true, reason: null, intent, evidenceUtilization: 1 };
    }
    // If polarity is wrong, that's a polarity mismatch, not just incomplete
    if (!polarityCorrect && (isAffirmative || isNegative)) {
      return { complete: false, reason: 'POLARITY_MISMATCH', intent, evidenceUtilization: 0 };
    }
    // If polarity is correct but evidence is required, fall through to normal checks
  }

  // For GREETING, CONVERSATIONAL, and conversational-control modes, skip
  // evidence completeness checks. These modes don't require evidence overlap.
  // Policy compliance (persona, scope) is still enforced by the grounding validator.
  const CONVERSATIONAL_CONTROL_MODES = new Set(['GREETING', 'CONVERSATIONAL', 'USER_PROFILE_UPDATE', 'USER_PROFILE_QUERY', 'THANKS', 'FAREWELL', 'HELP']);
  const policyMode = responseContract?.policyMode || responseContract?.mode;
  if (CONVERSATIONAL_CONTROL_MODES.has(policyMode)) {
    // Still check for generic filler — even greetings shouldn't be AI filler
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
    return { complete: true, reason: null, intent, evidenceUtilization: 1 };
  }

  // Mode-aware completeness for REFUSAL and OUT_OF_SCOPE.
  // Refusals: must contain refusal language, must NOT contain sensitive data.
  // OOS: must redirect, must NOT answer the external topic.
  // Neither requires normal fact entity completeness.
  if (policyMode === 'REFUSAL') {
    const hasRefusal = /\b(?:cannot|can'?t|not able to|not in a position to|don'?t (?:have|share)|not (?:public|available|part of)|outside|only answer|not (?:able|permitted) to)\b/i.test(text);
    // Check for actual sensitive data patterns, not just category names
    // A refusal that says "I cannot share social security numbers" is safe
    const hasActualSensitiveData = /\b\d{3}-\d{2}-\d{4}\b/.test(text) || // SSN format
      /\b(?:\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/.test(text) || // credit card format
      /\bpassword\s*[:=]\s*\S+/i.test(text) || // password=value
      /\b(?:ssn|social\s+security)\s*(?:#|number|:)?\s*\d{3}/i.test(text); // SSN with digits
    if (!hasRefusal) {
      return { complete: false, reason: 'REFUSAL_MISSING_REFUSAL_LANGUAGE', intent, evidenceUtilization: 0 };
    }
    if (hasActualSensitiveData) {
      return { complete: false, reason: 'REFUSAL_LEAKED_SENSITIVE_DATA', intent, evidenceUtilization: 0 };
    }
    return { complete: true, reason: null, intent, evidenceUtilization: 1 };
  }
  if (policyMode === 'OUT_OF_SCOPE') {
    // OOS answers must not address the external topic directly.
    // The grounding validator already checks this, but completeness
    // should not enforce normal fact entity requirements.
    const hasRedirect = /\b(?:can'?t|cannot|not able to|outside|only answer|don'?t (?:have|do)|but i can|what i can)\b/i.test(text);
    if (!hasRedirect && words.length < 5) {
      return { complete: false, reason: 'OOS_TOO_SHORT_WITHOUT_REDIRECT', intent, evidenceUtilization: 0 };
    }
    return { complete: true, reason: null, intent, evidenceUtilization: 1 };
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
  //
  // EXEMPTION: Denials and negations are complete when they correctly answer
  // the question with NO/NOT_FIT polarity. A short denial like "the candidate has not
  // worked at Microsoft." is a complete answer to an invented-employer question.
  // Do not reject a truthful denial merely because it lacks unrelated evidence.
function getFactText(fact) {
  if (typeof fact === 'string') return fact;
  if (fact && typeof fact === 'object') {
    // Support raw fact objects from recovery contracts
    if (fact.value !== undefined) return `${fact.type || 'FACT'}: ${String(fact.value)}`;
    return JSON.stringify(fact);
  }
  return String(fact);
}

  if (responseContract && responseContract.keyFacts && responseContract.keyFacts.length > 0) {
    const answerLower = text.toLowerCase();
    const answerWords = new Set(answerLower.match(/[a-z][a-z0-9+#.-]{3,}/g) || []);
    let coveredFacts = 0;
    for (const fact of responseContract.keyFacts) {
      const factLower = getFactText(fact).toLowerCase();
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
    // Only flag if NO key facts are covered AND the answer is very short (< 8 words).
    // The 8-word threshold is a secondary heuristic: the primary check is semantic
    // (coveredFacts === 0). 8 words is the minimum for a complete sentence with
    // subject + verb + object. Answers >= 8 words likely have relevant content
    // even if word overlap with keyFacts is low. The previous 12-word threshold
    // was too strict and flagged valid short factual answers.
    if (coveredFacts === 0 && words.length < 8 && responseContract.keyFacts.length > 0) {
      // Exempt denials: if the answer correctly negates with NO/NOT_FIT polarity,
      // it is complete regardless of evidence word overlap
      const hasDenial = /\b(?:no|not|never|incorrect|wrong|false|hasn'?t|haven'?t|didn'?t|did not|wasn'?t|was not|isn'?t|is not|doesn'?t|does not|no verified|no evidence)\b/i.test(text);
      const contractDenial = responseContract.directAnswer === 'NO' || responseContract.directAnswer === 'NOT_FIT';
      const isAdversarialIntent = intent === 'ADVERSARIAL';
      // Exempt confirmations of negation premises: "Yes, that is correct." for
      // "No evidence he X, right?" — the answer confirms the absence, which is correct
      const isNegationConfirmation = isAdversarialIntent &&
        /\b(?:yes|correct|that'?s correct|that is correct|right|true)\b/i.test(text) &&
        !/\b(?:no|not|never|incorrect|wrong|false)\b/i.test(text) &&
        /\b(?:no evidence|not|never|no verified)\b/i.test(question);
      // Exempt RATIONALE-UNKNOWN: "not documented" type answers are complete
      const isRationaleUnknown = responseContract.subIntent === 'RATIONALE' && responseContract.directAnswer === 'UNKNOWN';
      const hasRationaleLimitation = /\b(?:no verified|not documented|does not document|doesn'?t document|not specified|does not specify|unknown|cannot verify|can'?t verify|not establish|doesn'?t establish|sources? do(?:es)? not)\b/i.test(text);
      if (!(hasDenial && (contractDenial || isAdversarialIntent)) && !isNegationConfirmation && !(isRationaleUnknown && hasRationaleLimitation)) {
        return { complete: false, reason: 'MISSING_REQUIRED_FACTS', intent, evidenceUtilization: 0, missingFacts: responseContract.keyFacts };
      }
    }
  }

  // Polarity check — if the contract specifies a direct answer, verify the answer matches.
  // Semantic polarity normalization: distinguish premise polarity from answer stance.
  // When the question has a negated premise ("No evidence he X, right?"), the correct
  // directAnswer is YES (confirming the negation). But the answer may express this as
  // either "Yes, that is correct." (affirming the negation) OR "No, there is no evidence..."
  // (denying the claim). Both are semantically correct — they share the same stance.
  if (responseContract && responseContract.directAnswer) {
    const da = responseContract.directAnswer;
    const isNegPremise = responseContract.isNegationConfirmation ||
      (da === 'YES' && isNegatedPremiseQuestionInline(question));
    if (da === 'NO' || da === 'NOT_FIT') {
      // Answer should contain negation OR confirm a negation premise
      const hasNegation = /\b(?:no|not|never|incorrect|wrong|false|didn'?t|did not|wasn'?t|was not|isn'?t|is not|doesn'?t|does not)\b/i.test(text);
      const isNegationPremiseConfirmation = intent === 'ADVERSARIAL' &&
        /\b(?:yes|correct|that'?s correct|that is correct|right|true)\b/i.test(text) &&
        !/\b(?:no|not|never|incorrect|wrong|false)\b/i.test(text) &&
        /\b(?:no evidence|not|never|no verified)\b/i.test(question);
      if (!hasNegation && !isNegationPremiseConfirmation) {
        return { complete: false, reason: 'POLARITY_MISMATCH', intent, evidenceUtilization: 0, expectedPolarity: da };
      }
    } else if (da === 'YES' || da === 'FIT') {
      if (isNegPremise) {
        // Negation confirmation: answer may use either "Yes, that is correct"
        // OR "No, there is no evidence..." — both confirm the negated premise.
        // Accept if the answer contains affirmation OR negation of the claim.
        // Only reject if the answer AFFIRMS the false claim (e.g., "Yes, he worked at Microsoft")
        // when the question asks "No evidence he worked at Microsoft, right?"
        const hasAffirmation = /\b(?:yes|correct|that'?s correct|that is correct|right|true)\b/i.test(text);
        const hasNegation = /\b(?:no|not|never|incorrect|wrong|false|didn'?t|did not|wasn'?t|was not|isn'?t|is not|doesn'?t|does not|no evidence|no verified)\b/i.test(text);
        if (!hasAffirmation && !hasNegation) {
          return { complete: false, reason: 'POLARITY_MISMATCH', intent, evidenceUtilization: 0, expectedPolarity: da };
        }
        // Both affirmation and negation are valid for negation-confirmation.
        // No mismatch possible here.
      } else {
        // Standard YES/FIT: answer should contain affirmation (but not negation of the affirmation)
        const hasAffirmation = /\b(?:yes|correct|right|true|absolutely|indeed|fits|matches|qualified)\b/i.test(text);
        const hasNegation = /\b(?:no|not|never|incorrect|wrong|false|doesn'?t|does not)\b/i.test(text);
        // For YES/FIT, either explicit yes or a positive statement without negation is OK
        // But if the answer starts with "No" when polarity is YES, that's a mismatch
        if (/^(?:no|not|never|incorrect)\b/i.test(text) && !hasAffirmation) {
          return { complete: false, reason: 'POLARITY_MISMATCH', intent, evidenceUtilization: 0, expectedPolarity: da };
        }
      }
    }
  }

  if (responseContract?.evidenceStrength && responseContract.evidenceStrength !== 'PROFESSIONAL') {
    const inflatedProfessionalTitle = /\b(?:experienced|professional|production)\s+(?:(?:full[- ]stack|software|cloud|frontend|backend|devops)\s+)?(?:engineer|developer|architect)\b/i;
    if (inflatedProfessionalTitle.test(text) && !/\b(?:not|isn'?t|wasn'?t|never)\b/i.test(text)) {
      return { complete: false, reason: 'EVIDENCE_STRENGTH_OVERCLAIM', intent, evidenceUtilization: 0, evidenceStrength: responseContract.evidenceStrength };
    }
  }

  if (responseContract?.subIntent === 'SKILL_EVIDENCE') {
    const sourceEntities = (responseContract.requiredFacts || []).map(fact => fact.sourceEntity).filter(Boolean);
    const hasSource = sourceEntities.some(entity => text.toLowerCase().includes(entity.toLowerCase().split(/[\s(]+/)[0]));
    const hasEvidenceLevel = /\b(?:project|internship|intern|professional|production|certification|education|coursework|work)\b/i.test(text);
    const hasCandidateLink = /\b(?:he|she|they|candidate|his|her|their|person|subject)\b/i.test(text);
    if (!hasCandidateLink || (!hasSource && !hasEvidenceLevel)) {
      return { complete: false, reason: 'SKILL_MISSING_USAGE_EVIDENCE', intent, evidenceUtilization: 0, missingEntities: sourceEntities };
    }
  }

  if (responseContract?.subIntent === 'RATIONALE') {
    if (responseContract.directAnswer === 'UNKNOWN') {
      if (!/\b(?:no verified|not documented|does not document|doesn'?t document|not specified|does not specify|unknown|cannot verify|can'?t verify|not establish|doesn'?t establish|sources? do(?:es)? not|do not establish|don'?t establish|no documented|not provide|doesn'?t provide|not capture|doesn'?t capture|not explain|doesn'?t explain|not address|doesn'?t address)\b/i.test(text)) {
        return { complete: false, reason: 'RATIONALE_NOT_ANSWERED', intent, evidenceUtilization: 0 };
      }
    } else if (!/\b(?:because|so that|in order to|reason|purpose|tradeoff|chose|decision)\b/i.test(text)) {
      return { complete: false, reason: 'RATIONALE_NOT_ANSWERED', intent, evidenceUtilization: 0 };
    }
  }

  if (responseContract?.subIntent === 'COMPARISON_DECISION') {
    const decision = String(responseContract.directAnswer || '').toLowerCase();
    const decisionToken = decision.split(/[\s(]+/)[0];
    if (!decisionToken || !text.toLowerCase().includes(decisionToken) ||
        !/\b(?:more|most|better|stronger|prefer|choose|complex|relevant|impress)\b/i.test(text)) {
      return { complete: false, reason: 'COMPARISON_MISSING_DECISION', intent, evidenceUtilization: 0 };
    }
  }

  if (responseContract?.subIntent === 'OPINION_DECISION') {
    const decision = String(responseContract.directAnswer || '').toLowerCase().split(/[\s(]+/)[0];
    if (!decision || !text.toLowerCase().includes(decision)) {
      return { complete: false, reason: 'OPINION_MISSING_DECISION', intent, evidenceUtilization: 0 };
    }
  }

  if (responseContract?.subIntent === 'RECRUITER_RECOMMENDATION') {
    const sourceEntities = (responseContract.requiredFacts || []).map(fact => fact.sourceEntity).filter(Boolean);
    const hasSource = sourceEntities.some(entity => text.toLowerCase().includes(entity.toLowerCase().split(/[\s(]+/)[0]));
    const hasEvidence = hasSource || /\b(?:project|internship|intern|experience|built|skill|certification|education|work)\b/i.test(text);
    const hasBoundary = /\b(?:entry|junior|early|limitation|gap|project|internship|not yet|still learning)\b/i.test(text);
    if (!/^(?:yes|no)\b/i.test(text) || !hasEvidence || !hasBoundary) {
      return { complete: false, reason: 'RECRUITER_RECOMMENDATION_INCOMPLETE', intent, evidenceUtilization: 0 };
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
      if (!new RegExp(`\\b(?:he|she|they${_subjectNamePattern}|his|her|their|candidate|him)\\b`, 'i').test(text)) {
        return { complete: false, reason: 'SKILL_NO_CANDIDATE_LINK', intent, evidenceUtilization };
      }
      return { complete: true, reason: 'OK', intent, evidenceUtilization };

    case 'ADVERSARIAL':
      // Need direct refutation. Short denials with correct negation are complete.
      // Short confirmations of negation premises ("Yes, that is correct.") are also complete.
      const hasNeg = /\b(?:no|not|never|incorrect|wrong|false|didn'?t|did not|wasn'?t|was not|isn'?t|is not|hasn'?t|haven'?t|doesn'?t|does not|no verified|no evidence)\b/i.test(text);
      const isConfirmation = /\b(?:yes|correct|that'?s correct|that is correct|right|true)\b/i.test(text);
      if ((hasNeg || isConfirmation) && words.length >= 4) {
        return { complete: true, reason: 'OK', intent, evidenceUtilization };
      }
      if (words.length < 8) {
        return { complete: false, reason: 'ADVERSARIAL_TOO_TERSE', intent, evidenceUtilization };
      }
      // Must contain negation or correction
      if (!hasNeg && !isConfirmation) {
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
      // Denials about fabricated entities (e.g., "the candidate has not worked at Microsoft.")
      // are complete answers even when short
      const isProjectDenial = /\b(?:no|not|never|hasn'?t|haven'?t|didn'?t|wasn'?t|isn'?t|doesn'?t|no verified|no evidence|not worked|didn'?t work|has not)\b/i.test(text);
      if (isProjectDenial && words.length >= 5) {
        return { complete: true, reason: 'OK', intent, evidenceUtilization };
      }
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
          !new RegExp(`\\b(?:he|she|they${_subjectNamePattern}|his|her|their|candidate|him)\\b`, 'i').test(text)) {
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

module.exports = { classifyIntent, evaluateCompleteness, configureSubjectNames };

/**
 * Inline negation-premise detection for use when responseContract
 * doesn't carry the isNegationConfirmation flag.
 * Generic and domain-neutral — checks linguistic structure only.
 */
function isNegatedPremiseQuestionInline(question) {
  const q = (question || '').toLowerCase();
  if (/\b(?:no\s+evidence|not\b|never\b|didn'?t\b|did not\b|no\s+mention|isn'?t\b|is not\b|wasn'?t\b|was not\b|doesn'?t\b|does not\b|haven'?t\b|have not\b|hasn'?t\b|has not\b)\b/i.test(question) &&
      /\b(?:right|correct|true)\b/.test(q)) {
    return true;
  }
  if (/\b(?:was he|did he|is he|has he)\b/.test(q) &&
      /\b(?:not|no|never)\b/.test(q)) {
    return true;
  }
  return false;
}
