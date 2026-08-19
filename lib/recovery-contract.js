'use strict';

// Recovery Contract System
//
// Replaces deterministic fallback prose with structured contracts that are
// sent to generative inference. The contract tells the model WHAT to say
// (evidence, constraints, response shape) without writing the final prose.
//
// All user-visible replies from the recovery path are generative.

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

const RECOVERY_MAX_TOKENS = 200;
const RECOVERY_TIMEOUT_MS = 15000;
const knowledgeAccess = require('./knowledge-access');
const scoutIdentity = require('./scout-identity');
const { classifyIntent } = require('./completeness-check');
const { extractSubjectNames, extractRequestedTopic, extractRequestedRole } = require('./response-contract');

function getSeniorityBoundary(knowledge) {
  const boundaries = knowledgeAccess.getBoundariesByCategory(knowledge, 'seniority');
  return boundaries.find(b => b.id === 'no-senior-level') || boundaries[0] || null;
}

function hasExplicitEntryLevelEvidence(knowledge) {
  return knowledge && (
    (knowledge.summary && /entry.level|junior|intern/i.test(JSON.stringify(knowledge.summary))) ||
    (knowledge.profile && /entry.level|junior|intern/i.test(JSON.stringify(knowledge.profile))) ||
    (knowledge.experience && knowledge.experience.some(e => /intern|trainee|entry/i.test(JSON.stringify(e))))
  );
}

/**
 * Build a recovery contract from tool results, evidence, and question context.
 * Returns a structured contract — NOT final prose.
 *
 * The contract is then sent to generative inference to produce the reply.
 */
function isUnknownEvidence(toolResult) {
  if (!toolResult || typeof toolResult !== 'object') return true;
  if (toolResult.factState === 'UNKNOWN' || toolResult.directAnswer === 'UNKNOWN') return true;
  if (toolResult.evidence === 'unknown' || toolResult.evidence === 'UNKNOWN') return true;
  if (Array.isArray(toolResult.details) && toolResult.details.length === 0) return true;
  return false;
}

function buildRecoveryContract(toolResult, route, rewritten, compressed, knowledge, question) {
  const q = typeof rewritten === 'string' ? rewritten : (question || '');
  const qLower = q.toLowerCase();
  const subjectNames = extractSubjectNames(q, knowledge);
  const intent = classifyIntent(q, subjectNames);

  // === FUTURE CAPABILITY — do not let recovery fabricate a denial ===
  // match_role returns a structured evidence comparison, not a factState, so
  // do not require isUnknownEvidence here. Future questions are unknown by
  // definition and must not claim current ability.
  if (intent === 'FUTURE_CAPABILITY') {
    const requestedRole = extractRequestedRole(q, knowledge);
    const requestedTopic = extractRequestedTopic(q, knowledge, subjectNames);
    const target = requestedRole || requestedTopic || 'that';
    return {
      intent: 'FUTURE_CAPABILITY',
      subIntent: 'FUTURE_CAPABILITY',
      directAnswer: null,
      factState: 'UNKNOWN',
      keyFacts: [rawFact('target', target), rawFact('evidence_status', 'not documented in evidence')],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: `Do not claim he currently knows, can do, or has experience with ${target}. State that there is no verified project evidence of ${target}. He could learn it if needed, but never use the exact phrases "knows ${target}", "proficient in ${target}", or "has experience with ${target}".`,
      requestedRole,
      requestedTopic
    };
  }

  // === UNKNOWN SKILL — recovery should not overclaim or return null ===
  if ((intent === 'SKILL' || intent === 'SKILL_EVIDENCE') && isUnknownEvidence(toolResult)) {
    const requestedTopic = extractRequestedTopic(q, knowledge, subjectNames);
    const allTech = (knowledgeAccess.getKnownTechnologies(knowledge) || []).map(t => t.toLowerCase());
    const isKnown = requestedTopic && allTech.some(t => t === requestedTopic.toLowerCase());
    if (!isKnown) {
      return {
        intent: 'SKILL',
        subIntent: 'SKILL_EVIDENCE',
        directAnswer: 'UNKNOWN',
        factState: 'UNKNOWN',
        keyFacts: requestedTopic ? [rawFact('skill', requestedTopic), rawFact('evidence_status', 'not found in evidence')] : [rawFact('evidence_status', 'not found in evidence')],
        boundary: 'project evidence only — do not describe it as professional production ownership',
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: requestedTopic
          ? `Do not claim he knows ${requestedTopic} or has experience with ${requestedTopic}. State that there is no verified project evidence of ${requestedTopic} and the answer is unknown. Write one complete sentence that names ${requestedTopic}.`
          : 'Do not claim he knows the skill or has experience with it. State that there is no verified project evidence and the answer is unknown.',
        requestedTopic
      };
    }
  }

  // === ADVERSARIAL / INVENTED-ENTITY DETECTION ===
  const adversarialContract = detectAdversarialContract(q, knowledge, compressed);
  if (adversarialContract) return adversarialContract;

  // === NEGATION CONFIRMATION ===
  if (/\b(?:did not|didn'?t|does not|doesn'?t|has not|hasn'?t|was not|wasn'?t|no evidence)\b.*\b(?:did|does|was|is|right|correct)\b/i.test(q)) {
    // Data-driven: check claimCorrections for matching patterns
    const negCorrections = knowledgeAccess.findMatchingClaimCorrections(knowledge, q);
    if (negCorrections.length > 0) {
      const boundary = knowledgeAccess.getBoundariesByCategory(knowledge, negCorrections[0].category)[0];
      return {
        intent: 'NEGATION_CONFIRM',
        directAnswer: 'YES',
        keyFacts: [rawFact('correction', negCorrections[0].correction)],
        boundary: boundary ? boundary.correction : null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Confirm the negation. State what is actually true.'
      };
    }
    // Generic negation confirmation
    return {
      intent: 'NEGATION_CONFIRM',
      directAnswer: 'YES',
      keyFacts: [],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Confirm the negation is correct.'
    };
  }

  // === NEGATIVE PERSONAL CLAIMS (bad at, weak at, worst at) ===
  if (/\b(?:what\s+.*\s+bad\s+at|what\s+is\s+.*\s+worst\s+at|what\s+.*\s+weak\s+at|what\s+.*\s+not\s+good\s+at)\b/i.test(q) ||
      /\b(?:bad\s+at|weak\s+at|worst\s+at)\b/i.test(q)) {
    const learningItems = knowledge && knowledge.skills && knowledge.skills.learningOrAdjacent;
    return {
      intent: 'NO_EVIDENCE',
      directAnswer: 'UNKNOWN',
      factState: 'UNKNOWN',
      keyFacts: Array.isArray(learningItems) && learningItems.length > 0
        ? [rawFact('learning_adjacent', learningItems)]
        : [rawFact('weaknesses', 'not documented in evidence')],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Do not answer with unsupported negative personal or psychological claims. State only that no documented weaknesses were found. If learning/adjacent skills are available, mention them as areas being developed.'
    };
  }

  // === CONCERNS / RISKS ===
  // Do not invite the model to invent weaknesses or negative personal traits.
  if (/\b(?:what\s+concerns?|what\s+worries|what\s+risks?|what\s+reservations)\b/i.test(q)) {
    const boundaries = knowledgeAccess.getBoundaries(knowledge).slice(0, 3).map(b => rawFact('boundary', b.correction, { category: b.category, id: b.id }));
    const seniorityBoundary = getSeniorityBoundary(knowledge);
    const learningItems = knowledge && knowledge.skills && knowledge.skills.learningOrAdjacent;
    return {
      intent: 'CONCERNS',
      directAnswer: null,
      factState: 'UNKNOWN',
      keyFacts: boundaries.length > 0
        ? boundaries
        : (Array.isArray(learningItems) && learningItems.length > 0
            ? [rawFact('learning_adjacent', learningItems)]
            : [rawFact('weaknesses', 'not documented in evidence')]),
      boundary: seniorityBoundary ? seniorityBoundary.correction : null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'There are no documented concerns. If asked about gaps, state only the documented learning/adjacent items or say none are recorded. Do not invent personality, performance, or consistency issues.'
    };
  }

  // === INTERVIEW QUESTIONS ===
  if (/\b(?:what\s+(?:should|would)\s+i\s+ask|what\s+would\s+you\s+ask|what\s+to\s+ask|good\s+questions?\s+to\s+ask)\b/i.test(q)) {
    const skills = knowledge && knowledge.skills && knowledge.skills.core;
    const topSkills = Array.isArray(skills) ? skills.slice(0, 3) : [];
    const projects = knowledge && knowledge.projects;
    const topProjects = Array.isArray(projects) ? projects.slice(0, 2).map(p => p.name) : [];
    return {
      intent: 'INTERVIEW_QUESTIONS',
      directAnswer: null,
      keyFacts: [
        topSkills.length > 0 ? rawFact('core_skills', topSkills) : null,
        topProjects.length > 0 ? rawFact('projects', topProjects) : null,
        knowledge?.experience?.[0] ? rawFact('experience', knowledge.experience[0].company, { role: knowledge.experience[0].role }) : null
      ].filter(Boolean),
      boundary: null,
      responseShape: { minSentences: 2, maxSentences: 3 },
      instructions: 'Suggest specific interview topics grounded in the candidate evidence. Do not give generic advice.'
    };
  }

  // === HARDEST TECHNICAL PART ===
  if (/\b(?:hardest\s+(?:technical\s+)?part|most\s+difficult\s+part|biggest\s+challenge|toughest\s+part)\b/i.test(q)) {
    const projectResults = toolResult && toolResult.results
      ? toolResult.results.filter(r => r.name && r.description)
      : [];
    const top = projectResults[0];
    return {
      intent: 'TECHNICAL_CHALLENGE',
      directAnswer: null,
      keyFacts: top
        ? [rawFact('project', top.name, { description: top.description.split(/(?<=[.!?])\s/)[0] }), rawFact('challenge', 'implementing features cleanly with a focused tech stack')]
        : [rawFact('project_scope', 'client-side development, search/filtering, theme controls')],
      boundary: null,
      responseShape: { minSentences: 2, maxSentences: 3 },
      instructions: 'Identify the technical challenge from the project evidence. Be specific about what made it challenging.'
    };
  }

  // === YEARS OF EXPERIENCE CLAIMS ===
  const adversarialMatch = q.match(/\b(\d+)\s+years?\s+(?:of\s+)?(?:[a-z]+\s+)?(?:experience|exp)\b/i);
  if (adversarialMatch) {
    const years = parseInt(adversarialMatch[1], 10);
    const seniorityBoundary = getSeniorityBoundary(knowledge);
    if (years >= 5) {
      return {
        intent: 'ADVERSARIAL_DENY',
        directAnswer: 'NO',
        factState: 'FALSE',
        keyFacts: [
          rawFact('experience_years', years, { note: 'unsupported' }),
          seniorityBoundary ? rawFact('boundary', seniorityBoundary.correction) : rawFact('seniority', 'unknown', { note: 'level not documented' })
        ],
        boundary: seniorityBoundary ? seniorityBoundary.correction : null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Start with No. State that the evidence does not support that many years of experience. Do not assert a specific career stage unless the boundary explicitly states it.'
      };
    }
  }

  // === WORTH INTERVIEWING / RECOMMEND ===
  if (/\b(?:worth|interview|recommend|hire|good fit)\b/i.test(q)) {
    const whoIAm = knowledge && knowledge.summary && knowledge.summary.whoIAm;
    const seniorityBoundary = getSeniorityBoundary(knowledge);
    const hasInternship = !!(knowledge && knowledge.experience && knowledge.experience.some(e => /intern/i.test(JSON.stringify(e))));
    return {
      intent: 'RECOMMENDATION',
      directAnswer: 'YES',
      factState: 'TRUE',
      keyFacts: whoIAm ? [rawFact('summary', whoIAm)] : [],
      keyProjects: (knowledge && knowledge.projects || []).slice(0, 2).map(p => p.name),
      hasInternship,
      boundary: seniorityBoundary ? seniorityBoundary.correction : null,
      responseShape: { minSentences: 2, maxSentences: 3 },
      instructions: 'Give a grounded positive recommendation. Name specific projects and skills. Do not inflate seniority. If a seniority boundary is provided, use it as a guardrail, not a central claim.'
    };
  }

  // === GET_PROJECT RESULT ===
  if (toolResult && toolResult.found && toolResult.project) {
    const proj = toolResult.project;
    if (/\b(?:use|used|tech|technology|tools?|stack|what.*did.*he.*use)\b/i.test(q)) {
      const tech = proj.tech && proj.tech.length ? proj.tech : [];
      return {
        intent: 'PROJECT_TECH',
        directAnswer: null,
        keyFacts: [rawFact('project', proj.name, { technology: tech })],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: `Name the technologies used in ${proj.name}. Be specific.`
      };
    }
    return {
      intent: 'PROJECT_DETAILS',
      directAnswer: null,
      keyFacts: [rawFact('project', proj.name, { description: proj.description ? proj.description.split(/(?<=[.!?])\s/)[0] : null })],
      boundary: null,
      responseShape: { minSentences: 2, maxSentences: 3 },
      instructions: `Describe ${proj.name} using the evidence. Name specific technologies if available.`
    };
  }

  // === MATCH_ROLE RESULT ===
  if (toolResult && toolResult.matchedSkills !== undefined && (toolResult.gaps || toolResult.strong || toolResult.partial)) {
    const strong = toolResult.strong || [];
    const partial = toolResult.partial || [];
    const gaps = toolResult.gaps || [];
    const projectEvidence = toolResult.projectEvidence || [];
    const whoIAm = (knowledge && knowledge.summary && knowledge.summary.whoIAm) || '';
    const seniorityBoundary = getSeniorityBoundary(knowledge);
    const entryLevelBoundary = hasExplicitEntryLevelEvidence(knowledge)
      ? (seniorityBoundary ? seniorityBoundary.correction : 'level described as early-career or internship-based')
      : null;
    return {
      intent: 'JOB_FIT',
      directAnswer: strong.length > 0 && gaps.length === 0 ? 'FIT' : strong.length > 0 ? 'PARTIAL_FIT' : 'NOT_FIT',
      keyFacts: [
        strong.length > 0 ? rawFact('strong_match', strong.slice(0, 3).map(s => s.skill)) : null,
        partial.length > 0 ? rawFact('partial_match', partial.slice(0, 3).map(s => ({ skill: s.skill, evidence: s.evidence }))) : null,
        gaps.length > 0 ? rawFact('gaps', gaps.slice(0, 3).map(g => g.skill)) : null,
        projectEvidence.length > 0 ? rawFact('project_evidence', projectEvidence.slice(0, 2).map(p => p.name)) : null,
        entryLevelBoundary ? rawFact('career_stage', entryLevelBoundary, { type: 'guardrail' }) : null
      ].filter(Boolean),
      boundary: entryLevelBoundary || null,
      responseShape: { minSentences: 2, maxSentences: 4 },
      instructions: 'State the fit level. Name matching skills and gaps. Do not assert seniority or career stage beyond the evidence.'
    };
  }

  // === COMPARE_PROJECTS RESULT ===
  if (toolResult && toolResult.projects && Array.isArray(toolResult.projects) && toolResult.projects.length >= 2) {
    const projects = toolResult.projects;
    if (/\b(?:most complex|most interesting|most impressive|most challenging|favorite)\b/.test(qLower)) {
      const scored = projects.map(p => ({
        name: p.name,
        score: (p.tech && p.tech.length || 0) * 10 + Math.min((p.description && p.description.length || 0) / 100, 5),
        desc: p.description ? p.description.split(/(?<=[.!?])\s/)[0] : '',
        tech: p.tech && p.tech.slice(0, 4).join(', ') || ''
      })).sort((a, b) => b.score - a.score);
      const top = scored[0];
      const rest = scored.slice(1, 3).map(s => s.name).join(' and ');
      return {
        intent: 'COMPARISON_DECISION',
        directAnswer: null,
        keyFacts: [
          rawFact('top_project', top.name, { criterion: /\bcomplex\b/.test(qLower) ? 'complex' : 'interesting' }),
          top.tech ? rawFact('technology', top.tech, { project: top.name }) : null,
          top.desc ? rawFact('description', top.desc, { project: top.name }) : null
        ].filter(Boolean),
        boundary: null,
        responseShape: { minSentences: 2, maxSentences: 3 },
        instructions: `Choose ${top.name} and support it with specific evidence. ${rest ? `Compare with ${rest}.` : ''}`
      };
    }
    return {
      intent: 'COMPARISON_EXPLANATION',
      directAnswer: null,
      keyFacts: projects.map(p => rawFact('project', p.name, {
        description: p.description ? truncate(p.description.split(/(?<=[.!?])\s/)[0], 80) : null,
        technology: p.tech && p.tech.length ? p.tech.slice(0, 3) : null
      })),
      boundary: null,
      responseShape: { minSentences: 2, maxSentences: 4 },
      instructions: 'Compare the projects using specific details. Name both projects.'
    };
  }

  // === SEARCH PORTFOLIO RESULTS ===
  if (toolResult && toolResult.results && Array.isArray(toolResult.results) && toolResult.results.length > 0) {
    // Weakness/gap questions
    if (/\b(?:lack|lacks|lacking|weakness|weaknesses|gap|gaps|shortcoming|need\s+to\s+learn|still\s+learning)\b/i.test(q)) {
      const learningItems = knowledge && knowledge.skills && knowledge.skills.learningOrAdjacent;
      return {
        intent: 'GAPS',
        directAnswer: null,
        keyFacts: Array.isArray(learningItems) && learningItems.length > 0
          ? [rawFact('learning', learningItems)]
          : compressed ? [rawFact('compressed_evidence', extractContentLine(compressed))] : [rawFact('gaps', 'none documented')],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 3 },
        instructions: 'State honest gaps grounded in evidence. Do not invent weaknesses.'
      };
    }

    // Build/skill questions prefer project results
    const isBuildOrSkillQuestion = /\b(?:build|built|creating|created|code|coding|develop|developed|project|software|application|best\s+at|strongest|skilled|proficient|expert|good\s+at)\b/i.test(q);
    const projectResults = toolResult.results.filter(r => r.name && r.description);
    const top = (isBuildOrSkillQuestion && projectResults.length > 0) ? projectResults[0] : toolResult.results[0];

    if (top && top.name && top.description) {
      return {
        intent: 'PROJECT_EVIDENCE',
        directAnswer: null,
        keyFacts: [rawFact('project', top.name, { description: top.description.split(/(?<=[.!?])\s/)[0] })],
        boundary: null,
        responseShape: { minSentences: 2, maxSentences: 3 },
        instructions: 'Describe the project using specific evidence. Name technologies if available.'
      };
    }
    if (top && top.role && top.company) {
      const firstSentence = (top.summary || '').split(/(?<=[.!?])\s/)[0];
      return {
        intent: 'EXPERIENCE_EVIDENCE',
        directAnswer: null,
        keyFacts: [rawFact('experience', `${top.role} at ${top.company}`, { summary: firstSentence || null })],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Describe the work experience using specific evidence.'
      };
    }
    if (top && top.name) {
      return {
        intent: 'PROJECT_EVIDENCE',
        directAnswer: null,
        keyFacts: [rawFact('project', top.name)],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Name the relevant project and describe it if evidence is available.'
      };
    }
  }

  // === SKILL EVIDENCE ===
  if (toolResult && toolResult.skill !== undefined) {
    const skill = toolResult.skill || 'this technology';
    const evidenceType = toolResult.evidence;

    if (toolResult.note && typeof toolResult.note === 'string') {
      return {
        intent: 'SKILL_DENY',
        directAnswer: 'NO',
        keyFacts: [rawFact('skill_note', toolResult.note.substring(0, 200))],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: `State that no verified evidence was found for ${skill}.`
      };
    }

    if (evidenceType === 'unknown' || evidenceType === 'none') {
      return {
        intent: 'SKILL_DENY',
        directAnswer: 'NO',
        keyFacts: [rawFact('skill', skill, { evidence: 'none' })],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: `State that no verified evidence was found for ${skill}.`
      };
    }

    if (evidenceType === 'adjacent') {
      const sources = toolResult.details && Array.isArray(toolResult.details)
        ? [...new Set(toolResult.details.map(d => d.source).filter(s => s))]
        : [];
      return {
        intent: 'SKILL_ADJACENT',
        directAnswer: null,
        keyFacts: sources.length > 0
          ? [rawFact('skill', skill, { relation: 'adjacent', sources })]
          : [rawFact('skill', skill, { relation: 'adjacent', evidence: 'none' })],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: `Describe the adjacent experience for ${skill}. Do not overstate it.`
      };
    }

    // Direct/partial evidence
    const allItems = [];
    if (toolResult.details && Array.isArray(toolResult.details)) {
      for (const d of toolResult.details) {
        if (d.items && Array.isArray(d.items)) allItems.push(...d.items);
        if (d.tech && Array.isArray(d.tech)) allItems.push(...d.tech);
      }
    }
    if (allItems.length > 0) {
      const uniqueItems = [...new Set(allItems)].slice(0, 5);
      const evidenceLabel = evidenceType === 'direct' ? 'direct' : evidenceType === 'partial' ? 'partial' : '';
      return {
        intent: 'SKILL_EVIDENCE',
        directAnswer: 'YES',
        keyFacts: [rawFact('skill', skill, { evidence: evidenceLabel, items: uniqueItems })],
        boundary: null,
        responseShape: { minSentences: 2, maxSentences: 3 },
        instructions: `State the evidence level for ${skill}. Name specific projects or contexts where it was used.`
      };
    }

    // Fallback to compressed evidence
    if (compressed && typeof compressed === 'string') {
      const contentLine = extractContentLine(compressed);
      if (contentLine) {
        return {
          intent: 'SKILL_EVIDENCE',
          directAnswer: null,
          keyFacts: [rawFact('compressed_evidence', contentLine.substring(0, 200), { skill })],
          boundary: null,
          responseShape: { minSentences: 1, maxSentences: 2 },
          instructions: `Describe the evidence for ${skill} using the available facts.`
        };
      }
    }
  }

  // === COMPRESSED EVIDENCE FALLBACK ===
  if (compressed && typeof compressed === 'string') {
    const contentLine = extractContentLine(compressed);
    if (contentLine) {
      return {
        intent: 'GENERAL_EVIDENCE',
        directAnswer: null,
        keyFacts: [rawFact('compressed_evidence', contentLine.substring(0, 200))],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 3 },
        instructions: 'Answer using the available evidence. Be specific.'
      };
    }
  }

  // === NO EVIDENCE ===
  return {
    intent: 'NO_EVIDENCE',
    directAnswer: null,
    keyFacts: [],
    boundary: null,
    responseShape: { minSentences: 1, maxSentences: 2 },
    instructions: "State that there is not enough grounded information to answer reliably."
  };
}

/**
 * Detect adversarial/invented-entity questions and return a contract
 * for a typed denial. Replaces detectAdversarialFallback.
 */
function detectAdversarialContract(rewrittenStr, knowledge, compressed) {
  const q = rewrittenStr.toLowerCase();
  const subjectName = knowledge?.identity?.name || 'the subject';

  // Future-capability questions are not false claims to be denied.
  if (classifyIntent(rewrittenStr, [subjectName]) === 'FUTURE_CAPABILITY') {
    return null;
  }

  // Data-driven: check directAnswers from the knowledge base first
  const directAnswer = knowledgeAccess.findDirectAnswer(knowledge, rewrittenStr);
  if (directAnswer && directAnswer.answer) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      factState: 'FALSE',
      forbiddenClaims: [],
      keyFacts: [rawFact('direct_answer', directAnswer.answer)],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Use the direct answer from the knowledge base. Do not invent unsupported claims.'
    };
  }

  // Data-driven: check claimCorrections for matching patterns
  const corrections = knowledgeAccess.findMatchingClaimCorrections(knowledge, rewrittenStr);
  if (corrections.length > 0) {
    const boundary = knowledgeAccess.getBoundariesByCategory(knowledge, corrections[0].category)[0];
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      factState: 'FALSE',
      forbiddenClaims: corrections.map(c => c.pattern).filter(Boolean),
      keyFacts: [rawFact('correction', corrections[0].correction)],
      boundary: boundary ? boundary.correction : null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Deny the false claim using the provided boundary. State what is actually true.'
    };
  }

  // "He was a senior X, right?" — use boundaries from knowledge
  if (/\b(?:right|correct|true)\b/.test(q) && /\b(?:he|she|they)\b/.test(q)) {
    const seniorityBoundaries = knowledgeAccess.getBoundariesByCategory(knowledge, 'seniority');
    const seniorMatch = q.match(/\b(?:senior|lead|principal|staff)\s+(?:engineer|developer|architect|manager)\b/);
    if (seniorityBoundaries.length > 0 && seniorMatch) {
      const boundary = seniorityBoundaries.find(b => b.id === 'no-senior-level') || seniorityBoundaries[0];
      return {
        intent: 'ADVERSARIAL_DENY',
        directAnswer: 'NO',
        factState: 'FALSE',
        forbiddenClaims: [seniorMatch[0]],
        keyFacts: [rawFact('boundary', boundary.correction)],
        boundary: boundary.correction,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Deny the seniority claim using the provided boundary. State the actual level.'
      };
    }
    const teamMatch = q.match(/\b(?:managed|led|supervised|directed)\s+(?:a\s+)?(?:team|developers?|engineers?|people|staff)\b/);
    if (teamMatch) {
      const boundary = seniorityBoundaries.find(b => b.id === 'no-team-management');
      if (boundary) {
        return {
          intent: 'ADVERSARIAL_DENY',
          directAnswer: 'NO',
          factState: 'FALSE',
          forbiddenClaims: [teamMatch[0]],
          keyFacts: [rawFact('boundary', boundary.correction)],
          boundary: boundary.correction,
          responseShape: { minSentences: 1, maxSentences: 2 },
          instructions: 'Deny the team-management claim using the provided boundary. State the actual level.'
        };
      }
      // No explicit boundary = UNKNOWN, not FALSE. Do not fabricate a denial.
      return null;
    }
    const yearsMatch = q.match(/\b(\d+)\s+years?\s+(?:of\s+)?(?:[a-z]+\s+)?(?:experience|exp)\b/);
    if (yearsMatch && parseInt(yearsMatch[1], 10) >= 5) {
      if (hasExplicitEntryLevelEvidence(knowledge)) {
        const boundary = seniorityBoundaries.find(b => b.id === 'no-senior-level') || seniorityBoundaries[0];
        return {
          intent: 'ADVERSARIAL_DENY',
          directAnswer: 'NO',
          factState: 'FALSE',
          forbiddenClaims: [`${yearsMatch[1]} years of experience`],
          keyFacts: [boundary ? rawFact('boundary', boundary.correction) : rawFact('seniority', 'unknown', { note: 'level not documented' })],
          boundary: boundary ? boundary.correction : null,
          responseShape: { minSentences: 1, maxSentences: 2 },
          instructions: 'Deny the years-of-experience claim. State only what the boundary allows. Do not assert a specific career stage unless the boundary explicitly states it.'
        };
      }
    }
    if (seniorityBoundaries.length > 0 && /\b(?:expert|proficient|master(?:ed)?|fluent)\b/.test(q)) {
      const boundary = seniorityBoundaries.find(b => b.id === 'no-senior-level') || seniorityBoundaries[0];
      return {
        intent: 'ADVERSARIAL_DENY',
        directAnswer: 'NO',
        factState: 'FALSE',
        forbiddenClaims: ['expertise claim'],
        keyFacts: [rawFact('boundary', boundary.correction)],
        boundary: boundary.correction,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Deny the expertise claim using the provided boundary. State the actual level.'
      };
    }
  }

  // Negation confirmations — data-driven
  if (/\b(?:did not|didn'?t|was not|wasn'?t|has not|hasn'?t|does not|doesn'?t)\b/.test(q) &&
      /\b(?:did|was|is|right|correct)\b/.test(q)) {
    const negCorrections = knowledgeAccess.findMatchingClaimCorrections(knowledge, rewrittenStr);
    if (negCorrections.length > 0) {
      const boundary = knowledgeAccess.getBoundariesByCategory(knowledge, negCorrections[0].category)[0];
      return {
        intent: 'NEGATION_CONFIRM',
        directAnswer: 'YES',
        factState: 'TRUE',
        forbiddenClaims: [],
        keyFacts: [rawFact('correction', negCorrections[0].correction)],
        boundary: boundary ? boundary.correction : null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Confirm the negation using the provided evidence. State what is actually true.'
      };
    }
    return {
      intent: 'NEGATION_CONFIRM',
      directAnswer: 'YES',
      factState: 'UNKNOWN',
      forbiddenClaims: [],
      keyFacts: [],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Confirm the negation if supported by evidence. Be cautious.'
    };
  }

  // "There is no evidence he X, right?" — data-driven
  if (/\bno evidence\b/.test(q) && /\b(?:right|correct|true)\b/.test(q)) {
    const negCorrections = knowledgeAccess.findMatchingClaimCorrections(knowledge, rewrittenStr);
    if (negCorrections.length > 0) {
      return {
        intent: 'NEGATION_CONFIRM',
        directAnswer: 'YES',
        factState: 'TRUE',
        forbiddenClaims: [],
        keyFacts: [rawFact('correction', negCorrections[0].correction)],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Confirm the negation using the provided evidence.'
      };
    }
    return {
      intent: 'NEGATION_CONFIRM',
      directAnswer: 'YES',
      factState: 'UNKNOWN',
      forbiddenClaims: [],
      keyFacts: [],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Confirm the absence of evidence if supported. Be cautious.'
    };
  }

  // Invented employer — use knowledge-derived company list
  const inventedMatch = rewrittenStr.match(/\b(?:at|with|for)\s+(?:his\s+time\s+at\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)[.?!]*$/);
  if (inventedMatch) {
    const companyName = inventedMatch[1];
    const companyLower = companyName.toLowerCase();
    const allTechs = knowledgeAccess.getKnownTechnologies(knowledge);
    const isKnownSkill = allTechs.some(t => t === companyLower);
    if (!isKnownSkill) {
      const knownCompanies = knowledgeAccess.getKnownCompanies(knowledge);
      const isKnown = knownCompanies.some(c => c.toLowerCase().includes(companyLower) || companyLower.includes(c.toLowerCase()));
      if (!isKnown && (!compressed || !compressed.toLowerCase().includes(companyLower))) {
        const realCompanies = knownCompanies.slice(0, 3);
        const isClosed = knowledgeAccess.isCategoryComplete(knowledge, 'employmentHistory') &&
                         knowledgeAccess.isCategoryAuthoritative(knowledge, 'employmentHistory');
        const factState = isClosed ? 'FALSE' : 'UNKNOWN';
        const directAnswer = isClosed ? 'NO' : 'UNKNOWN';
        return {
          intent: 'UNKNOWN_EMPLOYER',
          directAnswer,
          factState,
          forbiddenClaims: [`worked at ${companyName}`],
          knownEmployers: realCompanies,
          keyFacts: realCompanies.map(c => rawFact('known_employer', c)),
          boundary: isClosed ? 'Employment history is complete and authoritative' : null,
          responseShape: { minSentences: 1, maxSentences: 2 },
          instructions: 'Answer using the fact state and known employers. Do not invent employment.'
        };
      }
    }
  }

  // Invented education — data-driven
  if (/\b(?:master'?s|phd|doctorate|postdoc)\b/i.test(q) && /\b(?:tell me about|what about|his)\b/i.test(q)) {
    const eduAnswer = knowledgeAccess.findDirectAnswer(knowledge, rewrittenStr);
    const knownSchools = knowledgeAccess.getKnownSchools(knowledge);
    const edu = knowledge?.education;
    if (eduAnswer && eduAnswer.answer) {
      return {
        intent: 'ADVERSARIAL_DENY',
        directAnswer: 'NO',
        factState: 'FALSE',
        forbiddenClaims: ['advanced degree'],
        keyFacts: [rawFact('direct_answer', eduAnswer.answer)],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Use the direct answer from the knowledge base.'
      };
    }
    const factState = (knownSchools.length === 0 && !edu) ? 'UNKNOWN' : 'FALSE';
    const directAnswer = factState === 'FALSE' ? 'NO' : 'UNKNOWN';
    return {
      intent: 'UNKNOWN_EDUCATION',
      directAnswer,
      factState,
      forbiddenClaims: ['advanced degree'],
      knownSchools,
      knownDegree: edu ? edu.degree : null,
      knownSchool: edu ? edu.school : null,
      keyFacts: [
        ...(edu?.degree ? [rawFact('degree', edu.degree)] : []),
        ...(edu?.school ? [rawFact('school', edu.school)] : []),
        ...knownSchools.map(s => rawFact('known_school', s))
      ],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Answer using the fact state and known education. Do not invent degrees or schools.'
    };
  }

  // Invented certification — data-driven
  if (/\b(?:kubernetes|cka|cks)\s+certif/i.test(q) && /\b(?:right|correct|true|has)\b/.test(q)) {
    const certAnswer = knowledgeAccess.findDirectAnswer(knowledge, rewrittenStr);
    const knownCerts = knowledgeAccess.getKnownCertifications(knowledge);
    if (certAnswer && certAnswer.answer) {
      return {
        intent: 'ADVERSARIAL_DENY',
        directAnswer: 'NO',
        factState: 'FALSE',
        forbiddenClaims: ['Kubernetes certification'],
        keyFacts: [rawFact('direct_answer', certAnswer.answer)],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Use the direct answer from the knowledge base.'
      };
    }
    return {
      intent: 'UNKNOWN_CERTIFICATION',
      directAnswer: 'NO',
      factState: knownCerts.length > 0 ? 'FALSE' : 'UNKNOWN',
      forbiddenClaims: ['Kubernetes certification'],
      knownCertifications: knownCerts,
      keyFacts: knownCerts.map(c => rawFact('known_certification', c)),
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Answer using the fact state and known certifications. Do not invent certifications.'
    };
  }

  return null;
}

/**
 * Build a terse yes/no recovery contract.
 * Replaces expandTerseYesNo — the model generates the expansion.
 */
function buildTerseYesNoContract(answer, question, compressed, knowledge) {
  const ans = answer.trim();
  if (ans.length > 20) return null;
  const q = String(question || '').toLowerCase();
  const isYesNo = /^(?:yes|no)\b\.?$/i.test(ans);
  if (!isYesNo) return null;

  const isYes = /^yes\b/i.test(ans);
  const isNo = /^no\b/i.test(ans);

  if (/\bprofessionally\b/.test(q)) {
    if (isNo) {
      const seniorityBoundaries = knowledgeAccess.getBoundariesByCategory(knowledge, 'seniority');
      const boundary = seniorityBoundaries[0];
      return {
        intent: 'YES_NO_EXPAND',
        directAnswer: 'NO',
        keyFacts: [rawFact('work_type', 'project/capstone'), boundary ? rawFact('boundary', boundary.correction) : null].filter(Boolean),
        boundary: boundary ? boundary.correction : null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Expand the No answer. State that it was project work, not professional production.'
      };
    }
  }

  const skillMatch = q.match(/(?:does|has)\s+he\s+(?:have|got)\s+(.+?)\s*(?:experience|skills?)?\??$/i);
  if (skillMatch) {
    const skill = skillMatch[1].trim();
    if (isYes) {
      const projects = knowledge && knowledge.projects || [];
      const relevantProjects = projects.filter(p =>
        p.tech && p.tech.some(t => t.toLowerCase().includes(skill.toLowerCase()) || skill.toLowerCase().includes(t.toLowerCase()))
      );
      return {
        intent: 'YES_NO_EXPAND',
        directAnswer: 'YES',
        keyFacts: relevantProjects.length > 0
          ? [rawFact('skill', skill, { evidence: 'yes', project: relevantProjects[0].name })]
          : [rawFact('skill', skill, { evidence: 'project-based' })],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: `Expand the Yes answer. Name the specific project where ${skill} was used.`
      };
    }
    if (isNo) {
      return {
        intent: 'YES_NO_EXPAND',
        directAnswer: 'NO',
        keyFacts: [rawFact('skill', skill, { evidence: 'none' })],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: `Expand the No answer. State that no verified evidence was found for ${skill}.`
      };
    }
  }

  // Generic expansion
  const lines = String(compressed || '').split('\n').filter(l => l.trim().length > 15);
  const evidenceLine = lines.find(l => !/^(?:FACT|SKILL|DIRECT|DETAILS|STRONG|PARTIAL|BEST|LIMIT):/i.test(l));
  return {
    intent: 'YES_NO_EXPAND',
    directAnswer: isYes ? 'YES' : 'NO',
    keyFacts: evidenceLine ? [rawFact('evidence', truncate(evidenceLine.trim(), 100))] : [],
    boundary: null,
    responseShape: { minSentences: 1, maxSentences: 2 },
    instructions: 'Expand the yes/no answer with brief evidence.'
  };
}

/**
 * Build a terse adversarial recovery contract.
 * Replaces expandTerseAdversarial — the model generates the denial.
 */
function buildTerseAdversarialContract(answer, question, knowledge) {
  const q = String(question || '').toLowerCase();
  const ans = answer.trim();

  // Data-driven: check directAnswers from the knowledge base first
  const directAnswer = knowledgeAccess.findDirectAnswer(knowledge, question);
  if (directAnswer && directAnswer.answer) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [rawFact('direct_answer', directAnswer.answer)],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that the claim is not accurate. State what is actually true.'
    };
  }

  // Data-driven: check claimCorrections
  const corrections = knowledgeAccess.findMatchingClaimCorrections(knowledge, question);
  if (corrections.length > 0) {
    const boundary = knowledgeAccess.getBoundariesByCategory(knowledge, corrections[0].category)[0];
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [rawFact('correction', corrections[0].correction)],
      boundary: boundary ? boundary.correction : null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that the claim is not accurate. State what is actually true.'
    };
  }

  const seniorityBoundaries = knowledgeAccess.getBoundariesByCategory(knowledge, 'seniority');
  const seniorBoundary = seniorityBoundaries.find(b => b.id === 'no-senior-level') || seniorityBoundaries[0];
  const mgmtBoundary = seniorityBoundaries.find(b => b.id === 'no-team-management') || seniorityBoundaries[0];

  const seniorMatch = q.match(/\b(?:senior|lead|principal)\s+(?:aws\s+)?(?:engineer|developer|architect)\b/);
  if (seniorMatch && seniorBoundary) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [rawFact('role', seniorMatch[0], { status: 'not_held' }), rawFact('boundary', seniorBoundary.correction)],
      boundary: seniorBoundary.correction,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: `State that he was not a ${seniorMatch[0]}. State his actual role level.`
    };
  }

  if (/production.*incident/i.test(q)) {
    const expBoundaries = knowledgeAccess.getBoundariesByCategory(knowledge, 'experience');
    const boundary = expBoundaries.find(b => b.id === 'no-production-aws') || expBoundaries[0];
    if (boundary) {
      return {
        intent: 'ADVERSARIAL_DENY',
        directAnswer: 'NO',
        keyFacts: [rawFact('responsibility', 'production incidents', { status: 'not_handled' }), rawFact('boundary', boundary.correction)],
        boundary: boundary.correction,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'State that he did not handle production incidents. State his actual level.'
      };
    }
  }

  const companyMatch = q.match(/\b(?:worked|work|employed|job)\s+(?:at|with)\s+([A-Z][A-Za-z]+)/);
  if (companyMatch) {
    const company = companyMatch[1];
    const knownCompanies = knowledgeAccess.getKnownCompanies(knowledge);
    const companyList = knownCompanies.slice(0, 3).join(', ');
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: companyList
        ? [rawFact('employment', company, { status: 'not_employed' }), rawFact('known_employers', companyList)]
        : [rawFact('employment', company, { status: 'not_employed' })],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: `State that he did not work at ${company}. Name actual companies if available.`
    };
  }

  const yearsMatch = q.match(/\b(\d+)\s+years?\s+(?:of\s+)?(?:[a-z]+\s+)?(?:experience|exp)\b/i);
  if (yearsMatch && seniorBoundary) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [rawFact('experience_years', yearsMatch[1], { note: 'unsupported' }), rawFact('boundary', seniorBoundary.correction)],
      boundary: seniorBoundary.correction,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that the evidence does not support the claimed years. State actual level.'
    };
  }

  const certMatch = q.match(/\b(?:kubernetes|docker)\s+certification\b/i);
  if (certMatch) {
    const certs = knowledgeAccess.getKnownCertifications(knowledge);
    const certStr = certs.length > 0 ? certs.slice(0, 2).join(' and ') : '';
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [rawFact('certification', certMatch[0], { status: 'not_held' }), certStr ? rawFact('known_certifications', certStr) : null].filter(Boolean),
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that he does not have that certification. Name actual certifications.'
    };
  }

  const schoolMatch = q.match(/\b(?:degree|diploma)\s+from\s+([A-Z][A-Za-z]+)/);
  if (schoolMatch) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [rawFact('degree', schoolMatch[1], { status: 'not_held' })],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: `State that he does not have a degree from ${schoolMatch[1]}.`
    };
  }

  if (/manag\w+\s+(?:a\s+)?team/i.test(q) && mgmtBoundary) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [rawFact('responsibility', 'team management', { status: 'not_done' }), rawFact('boundary', mgmtBoundary.correction)],
      boundary: mgmtBoundary.correction,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that he did not manage a team. State his actual level.'
    };
  }

  const expertMatch = q.match(/\b(?:expert|guru|master)\s+(?:in|at|with)\s+([A-Za-z.]+)/);
  if (expertMatch && seniorBoundary) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [rawFact('skill', expertMatch[1], { level: 'not expert' }), rawFact('boundary', seniorBoundary.correction)],
      boundary: seniorBoundary.correction,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that he has the skill but is not an expert. State actual level.'
    };
  }

  if (/no evidence.*attended/i.test(q) || /there is no evidence/i.test(q)) {
    const schoolMatch2 = q.match(/attended\s+([A-Z][A-Za-z]+)/);
    return {
      intent: 'NEGATION_CONFIRM',
      directAnswer: 'YES',
      keyFacts: schoolMatch2 ? [rawFact('attendance', schoolMatch2[1], { evidence: 'none' })] : [],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Confirm the negation is correct.'
    };
  }

  if (/master'?s?\s+degree/i.test(q)) {
    const eduAnswer = knowledgeAccess.findDirectAnswer(knowledge, question);
    const edu = knowledge?.education;
    const eduStr = edu && edu.degree ? `His education is ${edu.degree}${edu.school ? ' from ' + edu.school : ''}` : '';
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: eduAnswer ? [rawFact('direct_answer', eduAnswer.answer)] : [rawFact('degree', 'master', { status: 'not_held' }), eduStr ? rawFact('education', eduStr) : null].filter(Boolean),
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that he does not have a master\'s degree. State actual education if relevant.'
    };
  }

  // Generic negation
  if (/^(no|nope)\b/i.test(ans)) {
    const boundary = seniorityBoundaries[0];
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [rawFact('claim_status', 'not_accurate'), boundary ? rawFact('boundary', boundary.correction) : rawFact('claim_status', 'not_supported')],
      boundary: boundary ? boundary.correction : null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that the claim is not accurate. State the actual experience level.'
    };
  }

  return null;
}

/**
 * Build a raw, non-prose fact for a recovery contract.
 * The model sees this as structured evidence and composes the final answer.
 */
function rawFact(type, value, extra = {}) {
  return { type, value, ...extra };
}

/**
 * Format a key fact for the recovery prompt.
 * Strings are rendered as-is for backward compatibility.
 * Raw fact objects are rendered generically without composing a full sentence.
 */
function formatKeyFact(fact) {
  if (typeof fact === 'string') return fact;
  if (!fact || typeof fact !== 'object') return String(fact);
  const type = fact.type || 'FACT';
  const value = fact.value;

  function formatValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `[${v.map(formatValue).filter(Boolean).join(', ')}]`;
    if (typeof v === 'object') {
      return Object.entries(v)
        .filter(([k]) => k !== 'type' && k !== 'value')
        .map(([k, v2]) => `${k}: ${formatValue(v2)}`)
        .filter(Boolean)
        .join('; ');
    }
    return String(v);
  }

  const valueStr = formatValue(value);
  const extras = Object.entries(fact)
    .filter(([k]) => k !== 'type' && k !== 'value')
    .map(([k, v]) => `${k}: ${formatValue(v)}`)
    .filter(Boolean)
    .join('; ');

  if (valueStr && extras) return `${type}: ${valueStr} (${extras})`;
  if (valueStr) return `${type}: ${valueStr}`;
  if (extras) return `${type}: ${extras}`;
  return type;
}

/**
 * Convert a recovery contract into a prompt for generative inference.
 */
function buildRecoveryPrompt(contract, question, knowledge) {
  const identity = scoutIdentity.getIdentity();
  const assistantName = identity.assistantName || 'Scout';
  const subjectName = knowledgeAccess.getSubjectName(knowledge) || 'the candidate';
  const pronouns = knowledgeAccess.getSubjectPronouns(knowledge);
  const pronounSubj = pronouns.subject || 'he';
  const pronounObj = pronouns.object || 'him';
  const pronounPoss = pronouns.possessive || 'his';
  const seniorityGuard = 'Do NOT use inflation language (expert, extensive, proficient, master). Do NOT claim senior, lead, manager, executive, or expert-level roles. Do not assert a specific career stage unless the BOUNDARY explicitly states it.';

  const system = [
    `You are ${assistantName}, an AI assistant for ${subjectName}.`,
    `You are NOT ${subjectName}. You talk ABOUT ${pronounObj} in third person.`,
    'Write 1-2 complete, natural sentences. Be specific and grounded.',
    seniorityGuard,
    `Do NOT say "I", "my", "me" when talking about the subject. Use "${pronounSubj}", "${pronounPoss}", "${pronounObj}".`,
    'Do NOT say "as an AI" or "based on the information".',
    'Do NOT make unsupported negative personal or psychological claims (struggled, frustrated, disappointed, bad at, inconsistent, weak) unless the KEY_FACTS explicitly include them.',
    '',
    '=== RECOVERY CONTRACT ===',
    `INTENT: ${contract.intent}`,
    contract.factState ? `FACT_STATE: ${contract.factState}` : '',
    contract.directAnswer ? `DIRECT_ANSWER: ${contract.directAnswer}` : '',
    contract.instructions ? `INSTRUCTIONS: ${contract.instructions}` : '',
    contract.boundary ? `BOUNDARY: ${contract.boundary}` : '',
    contract.keyFacts && contract.keyFacts.length > 0 ? `KEY_FACTS:\n${contract.keyFacts.map(formatKeyFact).map(f => '- ' + f).join('\n')}` : '',
    contract.requiredEntities && contract.requiredEntities.length > 0 ? `REQUIRED_ENTITIES: ${contract.requiredEntities.join(', ')}` : '',
    `RESPONSE_SHAPE: ${contract.responseShape.minSentences}-${contract.responseShape.maxSentences} sentences`,
    '',
    'Use the KEY_FACTS to write your answer. Do NOT copy them verbatim — synthesize naturally.',
    contract.requiredEntities && contract.requiredEntities.length > 0 ? `You MUST name these entities in your answer: ${contract.requiredEntities.join(', ')}.` : '',
    'Answer the question directly. Be concise.'
  ].filter(line => line !== '').join('\n');

  const user = `Q: ${question}\nReturn JSON: {"answer":"<your answer>"}`;

  return { systemPrompt: system, userPrompt: user };
}

/**
 * Extract the first meaningful content line from compressed evidence.
 */
function extractContentLine(compressed) {
  const lines = compressed.split('\n').filter(l => l.trim().length > 10);
  const contentLine = lines.find(l => !/^(?:FACT|SKILL|DIRECT|DETAILS|STRONG|PARTIAL|BEST|LIMIT):/i.test(l)) || lines[0];
  return contentLine ? contentLine.trim() : null;
}

module.exports = {
  buildRecoveryContract,
  detectAdversarialContract,
  buildTerseYesNoContract,
  buildTerseAdversarialContract,
  buildRecoveryPrompt,
  formatKeyFact,
  rawFact,
  RECOVERY_MAX_TOKENS,
  RECOVERY_TIMEOUT_MS
};
