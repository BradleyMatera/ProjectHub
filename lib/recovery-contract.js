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

const SCOUT_NAME = 'Scout';
const RECOVERY_MAX_TOKENS = 200;
const RECOVERY_TIMEOUT_MS = 15000;

/**
 * Build a recovery contract from tool results, evidence, and question context.
 * Returns a structured contract — NOT final prose.
 *
 * The contract is then sent to generative inference to produce the reply.
 */
function buildRecoveryContract(toolResult, route, rewritten, compressed, knowledge, question) {
  const q = typeof rewritten === 'string' ? rewritten : (question || '');
  const qLower = q.toLowerCase();

  // === ADVERSARIAL / INVENTED-ENTITY DETECTION ===
  const adversarialContract = detectAdversarialContract(q, knowledge, compressed);
  if (adversarialContract) return adversarialContract;

  // === NEGATION CONFIRMATION ===
  if (/\b(?:did not|didn'?t|does not|doesn'?t|has not|hasn'?t|was not|wasn'?t|no evidence)\b.*\b(?:did|does|was|is|right|correct)\b/i.test(q)) {
    if (/production.incidents?/i.test(q)) {
      return {
        intent: 'NEGATION_CONFIRM',
        directAnswer: 'YES',
        keyFacts: ['He did not handle production incidents', 'He was an entry-level developer and intern'],
        boundary: 'entry-level — internship and project experience only',
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Confirm the negation. State what is actually true.'
      };
    }
    if (/senior|lead|principal/i.test(q)) {
      return {
        intent: 'NEGATION_CONFIRM',
        directAnswer: 'YES',
        keyFacts: ['He was not a senior engineer', 'He was an intern/trainee'],
        boundary: 'entry-level — internship and project experience only',
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

  // === CONCERNS / RISKS ===
  if (/\b(?:what\s+concerns?|what\s+worries|what\s+risks?|what\s+reservations)\b/i.test(q)) {
    const isEntryLevel = knowledge && (
      (knowledge.profile && /entry.level|junior|intern/i.test(JSON.stringify(knowledge.profile))) ||
      (knowledge.experience && knowledge.experience.some(e => /intern|trainee|entry/i.test(JSON.stringify(e))))
    );
    return {
      intent: 'CONCERNS',
      directAnswer: null,
      keyFacts: isEntryLevel
        ? ['Production experience is limited to internship and capstone projects', 'Has not handled live production incidents or managed teams', 'Project portfolio is still growing']
        : ['Experience is primarily at the entry level with internship and training projects'],
      boundary: 'entry-level — internship and project experience only',
      responseShape: { minSentences: 2, maxSentences: 3 },
      instructions: 'State honest concerns grounded in the evidence level. Do not inflate or minimize.'
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
        topSkills.length > 0 ? `Core skills: ${topSkills.join(', ')}` : null,
        topProjects.length > 0 ? `Key projects: ${topProjects.join(' and ')}` : null,
        'AWS internship experience is worth exploring'
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
        ? [`${top.name}: ${top.description.split(/(?<=[.!?])\s/)[0]}`, 'Technical challenge is implementing features cleanly with a focused tech stack']
        : ['Projects involve client-side development, search/filtering, and theme controls'],
      boundary: null,
      responseShape: { minSentences: 2, maxSentences: 3 },
      instructions: 'Identify the technical challenge from the project evidence. Be specific about what made it challenging.'
    };
  }

  // === YEARS OF EXPERIENCE CLAIMS ===
  const adversarialMatch = q.match(/\b(\d+)\s+years?\s+(?:of\s+)?(?:[a-z]+\s+)?(?:experience|exp)\b/i);
  if (adversarialMatch) {
    const years = parseInt(adversarialMatch[1], 10);
    const isEntryLevel = knowledge && (
      (knowledge.profile && /entry.level|junior|intern/i.test(JSON.stringify(knowledge.profile))) ||
      (knowledge.experience && knowledge.experience.some(e => /intern|trainee|entry/i.test(JSON.stringify(e))))
    );
    if (years >= 5 && isEntryLevel) {
      return {
        intent: 'ADVERSARIAL_DENY',
        directAnswer: 'NO',
        keyFacts: [`Evidence does not support ${years} years of experience`, 'He is an entry-level developer'],
        boundary: 'entry-level — internship and project experience only',
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Start with No. State the actual experience level.'
      };
    }
  }

  // === WORTH INTERVIEWING / RECOMMEND ===
  if (/\b(?:worth|interview|recommend|hire|good fit)\b/i.test(q)) {
    const whoIAm = knowledge && knowledge.summary && knowledge.summary.whoIAm;
    return {
      intent: 'RECOMMENDATION',
      directAnswer: 'YES',
      keyFacts: whoIAm ? [whoIAm] : [],
      keyProjects: (knowledge && knowledge.projects || []).slice(0, 2).map(p => p.name),
      hasInternship: !!(knowledge && knowledge.experience && knowledge.experience.some(e => /intern/i.test(JSON.stringify(e)))),
      boundary: 'entry-level candidate with internship and project experience',
      responseShape: { minSentences: 2, maxSentences: 3 },
      instructions: 'Give a grounded positive recommendation. Name specific evidence. State the career level honestly.'
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
        keyFacts: [`${proj.name} uses ${tech.join(', ')}`],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: `Name the technologies used in ${proj.name}. Be specific.`
      };
    }
    return {
      intent: 'PROJECT_DETAILS',
      directAnswer: null,
      keyFacts: [proj.description ? `${proj.name}: ${proj.description.split(/(?<=[.!?])\s/)[0]}` : `Project: ${proj.name}`],
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
    const whoIAm = knowledge && knowledge.summary && knowledge.summary.whoIAm || '';
    const isEntryLevel = /entry|junior|early/i.test(whoIAm);
    return {
      intent: 'JOB_FIT',
      directAnswer: strong.length > 0 && gaps.length === 0 ? 'FIT' : strong.length > 0 ? 'PARTIAL_FIT' : 'NOT_FIT',
      keyFacts: [
        strong.length > 0 ? `Strong match: ${strong.slice(0, 3).map(s => s.skill).join(', ')}` : null,
        partial.length > 0 ? `Partial match: ${partial.slice(0, 3).map(s => `${s.skill} (${s.evidence.toLowerCase().replace('_', ' ')})`).join(', ')}` : null,
        gaps.length > 0 ? `Gaps: ${gaps.slice(0, 3).map(g => g.skill).join(', ')}` : null,
        projectEvidence.length > 0 ? `Project evidence: ${projectEvidence.slice(0, 2).map(p => p.name).join(', ')}` : null,
        isEntryLevel ? 'He is an entry-level candidate — evidence is internship and project-based' : null
      ].filter(Boolean),
      boundary: isEntryLevel ? 'entry-level — evidence is internship and project-based, not production' : null,
      responseShape: { minSentences: 2, maxSentences: 4 },
      instructions: 'State the fit level. Name matching skills and gaps. State the evidence level honestly.'
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
        keyFacts: [`${top.name} is the most ${/\bcomplex\b/.test(qLower) ? 'complex' : 'interesting'}`, top.tech ? `It uses ${top.tech}` : null, top.desc].filter(Boolean),
        boundary: null,
        responseShape: { minSentences: 2, maxSentences: 3 },
        instructions: `Choose ${top.name} and support it with specific evidence. ${rest ? `Compare with ${rest}.` : ''}`
      };
    }
    const parts = projects.map(p => {
      const desc = p.description ? p.description.split(/(?<=[.!?])\s/)[0] : '';
      const tech = p.tech && p.tech.length ? p.tech.slice(0, 3).join(', ') : '';
      return `${p.name}${desc ? ' — ' + truncate(desc, 80) : ''}${tech ? ' (tech: ' + tech + ')' : ''}`;
    });
    return {
      intent: 'COMPARISON_EXPLANATION',
      directAnswer: null,
      keyFacts: parts,
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
          ? [`Currently learning: ${learningItems.join(', ')}`]
          : compressed ? [extractContentLine(compressed)] : ["No specific learning gaps documented in the verified knowledge base"],
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
        keyFacts: [`${top.name}: ${top.description.split(/(?<=[.!?])\s/)[0]}`],
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
        keyFacts: [`${top.role} at ${top.company}${firstSentence ? '. ' + firstSentence : ''}`],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Describe the work experience using specific evidence.'
      };
    }
    if (top && top.name) {
      return {
        intent: 'PROJECT_EVIDENCE',
        directAnswer: null,
        keyFacts: [`Relevant project: ${top.name}`],
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
        keyFacts: [toolResult.note.substring(0, 200)],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: `State that no verified evidence was found for ${skill}.`
      };
    }

    if (evidenceType === 'unknown' || evidenceType === 'none') {
      return {
        intent: 'SKILL_DENY',
        directAnswer: 'NO',
        keyFacts: [`No verified evidence found for ${skill}`],
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
          ? [`Adjacent experience related to ${skill}, mentioned in ${sources.join(', ')}`]
          : [`Adjacent experience related to ${skill}, but no direct evidence`],
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
        keyFacts: [`He has ${evidenceLabel} experience with ${uniqueItems.join(', ')}`],
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
          keyFacts: [contentLine.substring(0, 200)],
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
        keyFacts: [contentLine.substring(0, 200)],
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

  // "He was a senior X, right?" / "He has Y years of experience, right?"
  if (/\b(?:right|correct|true)\b/.test(q) && /\b(?:he|she|they)\b/.test(q)) {
    if (/\b(?:senior|lead|principal|staff)\s+(?:engineer|developer|architect|manager)\b/.test(q)) {
      return {
        intent: 'ADVERSARIAL_DENY',
        directAnswer: 'NO',
        keyFacts: ['He was not a senior engineer', 'He was an entry-level developer and intern'],
        boundary: 'entry-level — internship and project experience only',
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Start with No. State what he actually was.'
      };
    }
    if (/\b(?:managed|led|supervised|directed)\s+(?:a\s+)?(?:team|developers?|engineers?|people|staff)\b/.test(q)) {
      return {
        intent: 'ADVERSARIAL_DENY',
        directAnswer: 'NO',
        keyFacts: ['No verified evidence that he managed a team', 'He is an entry-level developer'],
        boundary: 'entry-level — internship and project experience only',
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Start with No. State the actual experience level.'
      };
    }
    const yearsMatch = q.match(/\b(\d+)\s+years?\s+(?:of\s+)?(?:[a-z]+\s+)?(?:experience|exp)\b/);
    if (yearsMatch && parseInt(yearsMatch[1], 10) >= 5) {
      return {
        intent: 'ADVERSARIAL_DENY',
        directAnswer: 'NO',
        keyFacts: [`Evidence does not support ${yearsMatch[1]} years of experience`, 'He is an entry-level developer'],
        boundary: 'entry-level — internship and project experience only',
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Start with No. State the actual experience level.'
      };
    }
    if (/\b(?:expert|proficient|master(?:ed)?|fluent)\b/.test(q)) {
      return {
        intent: 'ADVERSARIAL_DENY',
        directAnswer: 'NO',
        keyFacts: ['He is not an expert', 'He is an entry-level developer with project and internship experience'],
        boundary: 'entry-level — internship and project experience only',
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Start with No. State the actual experience level.'
      };
    }
  }

  // Negation confirmations
  if (/\b(?:did not|didn'?t|was not|wasn'?t|has not|hasn'?t|does not|doesn'?t)\b/.test(q) &&
      /\b(?:did|was|is|right|correct)\b/.test(q)) {
    if (/production.incidents?/i.test(q)) {
      return {
        intent: 'NEGATION_CONFIRM',
        directAnswer: 'YES',
        keyFacts: ['He did not handle production incidents', 'He was an entry-level developer and intern'],
        boundary: 'entry-level — internship and project experience only',
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Confirm the negation. State what is actually true.'
      };
    }
    if (/\bsenior\b/i.test(q)) {
      return {
        intent: 'NEGATION_CONFIRM',
        directAnswer: 'YES',
        keyFacts: ['He was not a senior engineer', 'He was an intern/trainee'],
        boundary: 'entry-level — internship and project experience only',
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Confirm the negation. State what is actually true.'
      };
    }
    if (/\bmit\b/i.test(q)) {
      return {
        intent: 'NEGATION_CONFIRM',
        directAnswer: 'YES',
        keyFacts: ['There is no evidence he attended MIT'],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Confirm the negation is correct.'
      };
    }
    return {
      intent: 'NEGATION_CONFIRM',
      directAnswer: 'YES',
      keyFacts: [],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Confirm the negation is correct.'
    };
  }

  // "There is no evidence he X, right?"
  if (/\bno evidence\b/.test(q) && /\b(?:right|correct|true)\b/.test(q)) {
    if (/\bmit\b/i.test(q)) {
      return {
        intent: 'NEGATION_CONFIRM',
        directAnswer: 'YES',
        keyFacts: ['There is no evidence he attended MIT'],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: 'Confirm the negation is correct.'
      };
    }
    return {
      intent: 'NEGATION_CONFIRM',
      directAnswer: 'YES',
      keyFacts: [],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Confirm the negation is correct.'
    };
  }

  // Invented employer
  const inventedMatch = rewrittenStr.match(/\b(?:at|with|for)\s+(?:his\s+time\s+at\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)[.?!]*$/);
  if (inventedMatch) {
    const companyName = inventedMatch[1];
    const companyLower = companyName.toLowerCase();
    const allSkills = [];
    if (knowledge && knowledge.skills && typeof knowledge.skills === 'object') {
      for (const vals of Object.values(knowledge.skills)) {
        if (Array.isArray(vals)) allSkills.push(...vals);
      }
    }
    if (knowledge && knowledge.projects) {
      for (const p of knowledge.projects) {
        if (p.tech) allSkills.push(...p.tech);
      }
    }
    const isKnownSkill = allSkills.some(s => String(s).toLowerCase() === companyLower);
    if (!isKnownSkill) {
      const knownCompanies = [];
      if (knowledge && knowledge.experience) {
        for (const exp of knowledge.experience) {
          if (exp.company) knownCompanies.push(String(exp.company).toLowerCase());
        }
      }
      const isKnown = knownCompanies.some(c => c.includes(companyLower) || companyLower.includes(c));
      if (!isKnown && (!compressed || !compressed.toLowerCase().includes(companyLower))) {
        const realCompanies = (knowledge && knowledge.experience || []).map(e => e.company).filter(Boolean).slice(0, 3).join(', ');
        return {
          intent: 'ADVERSARIAL_DENY',
          directAnswer: 'NO',
          keyFacts: realCompanies
            ? [`No verified evidence he worked at ${companyName}`, `His work experience includes ${realCompanies}`]
            : [`No verified evidence he worked at ${companyName}`],
          boundary: null,
          responseShape: { minSentences: 1, maxSentences: 2 },
          instructions: `State that there is no evidence he worked at ${companyName}. Name the actual companies if available.`
        };
      }
    }
  }

  // Invented education
  if (/\b(?:master'?s|phd|doctorate|postdoc)\b/i.test(q) && /\b(?:tell me about|what about|his)\b/i.test(q)) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: ['He does not have a master\'s degree or PhD', 'His education is a Bachelor of Science in Web Development from Full Sail University'],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that he does not have an advanced degree. Name the actual education.'
    };
  }

  // Invented certification
  if (/\b(?:kubernetes|cka|cks)\s+certif/i.test(q) && /\b(?:right|correct|true|has)\b/.test(q)) {
    const certs = knowledge && knowledge.certifications
      ? knowledge.certifications.map(c => c.name).join(' and ')
      : 'AWS Certified Solutions Architect Associate and AWS Certified AI Practitioner';
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [`He does not have a Kubernetes certification`, `His certifications include ${certs}`],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that he does not have a Kubernetes certification. Name the actual certifications.'
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
      return {
        intent: 'YES_NO_EXPAND',
        directAnswer: 'NO',
        keyFacts: ['That was a project/capstone, not professional production work', 'He is an entry-level developer with internship and project experience'],
        boundary: 'entry-level — internship and project experience only',
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
          ? [`Yes, he has ${skill} experience`, `He used ${skill} in ${relevantProjects[0].name}`]
          : [`Yes, he has ${skill} experience from his projects`],
        boundary: null,
        responseShape: { minSentences: 1, maxSentences: 2 },
        instructions: `Expand the Yes answer. Name the specific project where ${skill} was used.`
      };
    }
    if (isNo) {
      return {
        intent: 'YES_NO_EXPAND',
        directAnswer: 'NO',
        keyFacts: [`No verified evidence found for ${skill}`],
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
    keyFacts: evidenceLine ? [truncate(evidenceLine.trim(), 100)] : [],
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

  const seniorMatch = q.match(/\b(?:senior|lead|principal)\s+(?:aws\s+)?(?:engineer|developer|architect)\b/);
  if (seniorMatch) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [`He was not a ${seniorMatch[0]}`, 'His AWS role was intern/trainee level only'],
      boundary: 'entry-level — internship and project experience only',
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: `State that he was not a ${seniorMatch[0]}. State his actual role level.`
    };
  }

  if (/production.*incident/i.test(q)) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: ['He did not handle production AWS incidents', 'He was an entry-level developer and intern'],
      boundary: 'entry-level — internship and project experience only',
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that he did not handle production incidents. State his actual level.'
    };
  }

  const companyMatch = q.match(/\b(?:worked|work|employed|job)\s+(?:at|with)\s+([A-Z][A-Za-z]+)/);
  if (companyMatch) {
    const company = companyMatch[1];
    const knownCompanies = (knowledge && knowledge.experience || []).map(e => e.company).filter(Boolean);
    const companyList = knownCompanies.slice(0, 3).join(', ');
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: companyList
        ? [`He did not work at ${company}`, `His work experience includes ${companyList}`]
        : [`He did not work at ${company}`],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: `State that he did not work at ${company}. Name actual companies if available.`
    };
  }

  const yearsMatch = q.match(/\b(\d+)\s+years?\s+(?:of\s+)?(?:[a-z]+\s+)?(?:experience|exp)\b/i);
  if (yearsMatch) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [`Evidence does not support ${yearsMatch[1]} years of experience`, 'He is an entry-level developer'],
      boundary: 'entry-level — internship and project experience only',
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that the evidence does not support the claimed years. State actual level.'
    };
  }

  const certMatch = q.match(/\b(?:kubernetes|docker)\s+certification\b/i);
  if (certMatch) {
    const certs = knowledge && knowledge.certifications
      ? knowledge.certifications.map(c => c.name).join(' and ')
      : 'AWS Certified Solutions Architect - Associate and AWS Certified AI Practitioner';
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [`He does not have a ${certMatch[0]}`, `His certifications include ${certs}`],
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
      keyFacts: [`He does not have a degree from ${schoolMatch[1]}`],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: `State that he does not have a degree from ${schoolMatch[1]}.`
    };
  }

  if (/manag\w+\s+(?:a\s+)?team/i.test(q)) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: ['He did not manage a team', 'He was an entry-level developer'],
      boundary: 'entry-level — internship and project experience only',
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that he did not manage a team. State his actual level.'
    };
  }

  const expertMatch = q.match(/\b(?:expert|guru|master)\s+(?:in|at|with)\s+([A-Za-z.]+)/);
  if (expertMatch) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: [`His skills include ${expertMatch[1]}, but he is not an expert`, 'He is an entry-level developer'],
      boundary: 'entry-level — internship and project experience only',
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that he has the skill but is not an expert. State actual level.'
    };
  }

  if (/no evidence.*attended/i.test(q) || /there is no evidence/i.test(q)) {
    const schoolMatch2 = q.match(/attended\s+([A-Z][A-Za-z]+)/);
    return {
      intent: 'NEGATION_CONFIRM',
      directAnswer: 'YES',
      keyFacts: schoolMatch2 ? [`There is no evidence he attended ${schoolMatch2[1]}`] : [],
      boundary: null,
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'Confirm the negation is correct.'
    };
  }

  if (/master'?s?\s+degree/i.test(q)) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: ['He does not have a master\'s degree', 'He is an entry-level developer'],
      boundary: 'entry-level — internship and project experience only',
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that he does not have a master\'s degree. State actual education if relevant.'
    };
  }

  // Generic negation
  if (/^(no|nope)\b/i.test(ans)) {
    return {
      intent: 'ADVERSARIAL_DENY',
      directAnswer: 'NO',
      keyFacts: ['That is not accurate', 'He is an entry-level developer with internship and project experience'],
      boundary: 'entry-level — internship and project experience only',
      responseShape: { minSentences: 1, maxSentences: 2 },
      instructions: 'State that the claim is not accurate. State the actual experience level.'
    };
  }

  return null;
}

/**
 * Convert a recovery contract into a prompt for generative inference.
 */
function buildRecoveryPrompt(contract, question, knowledge) {
  const subjectName = (knowledge && knowledge.profile && knowledge.profile.name) || 'the candidate';

  const system = [
    `You are ${SCOUT_NAME}, an AI assistant for ${subjectName}.`,
    `You are NOT ${subjectName}. You talk ABOUT him in third person.`,
    'Write 1-2 complete, natural sentences. Be specific and grounded.',
    'Do NOT use inflation language (expert, extensive, proficient). He is entry-level.',
    'Do NOT say "I", "my", "me" when talking about the subject. Use "he", "his", "him".',
    'Do NOT say "as an AI" or "based on the information".',
    '',
    '=== RECOVERY CONTRACT ===',
    `INTENT: ${contract.intent}`,
    contract.directAnswer ? `DIRECT_ANSWER: ${contract.directAnswer}` : '',
    contract.instructions ? `INSTRUCTIONS: ${contract.instructions}` : '',
    contract.boundary ? `BOUNDARY: ${contract.boundary}` : '',
    contract.keyFacts && contract.keyFacts.length > 0 ? `KEY_FACTS:\n${contract.keyFacts.map(f => '- ' + f).join('\n')}` : '',
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
  RECOVERY_MAX_TOKENS,
  RECOVERY_TIMEOUT_MS
};
