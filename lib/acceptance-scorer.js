'use strict';

/**
 * Acceptance scorer — strict semantic evaluation of chat replies.
 *
 * This module is intentionally independent of the live server. It can be used
 * both by the live `scripts/eval-local-api.js` harness and by offline rescore
 * scripts. It loads the authoritative knowledge base and relationship graph and
 * checks replies against semantic contracts rather than simple phrase lists.
 *
 * The scorer supports three phrase-matching modes:
 *   - requireAll: every listed phrase must appear
 *   - requireAny: at least one of the listed phrases must appear
 *   - forbidAny: none of the listed phrases may appear
 *
 * It also runs a semantic validator when a case has `semanticType` set.
 */

const fs = require('fs');
const path = require('path');
const knowledgeAccess = require('./knowledge-access');

const QUALITY = {
  GOOD: 'GOOD',
  TECHNICAL_ERROR: 'TECHNICAL_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  NETWORK: 'NETWORK',
  BROKEN: 'BROKEN',
  FACT_WRONG: 'FACT_WRONG',
  OVERCLAIM: 'OVERCLAIM',
  POLICY_FAILURE: 'POLICY_FAILURE',
  PERSONA: 'PERSONA',
  CONTEXT_ERROR: 'CONTEXT_ERROR',
  TERSE: 'TERSE',
  CLARIFICATION: 'CLARIFICATION',
  GENERIC: 'GENERIC',
  ERROR: 'ERROR'
};

const DEFAULT_KNOWLEDGE_PATH = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');
const MAX_LATENCY_MS = Number(process.env.PROJECTHUB_MAX_LATENCY_MS || 60000);
const ALLOWED_PROSE_SOURCES = new Set(['DIRECT_KB', 'MODEL_GENERATION', 'TECHNICAL_ERROR']);
const ALLOWED_PROVIDERS = new Set(['cloudflare', 'ollama', 'local-agent', 'knowledge-base', 'scout-lite', 'ollama-lite', 'ollama-recovery', 'none']);

function loadDefaultKnowledge() {
  try {
    const raw = fs.readFileSync(DEFAULT_KNOWLEDGE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot load default knowledge from ${DEFAULT_KNOWLEDGE_PATH}: ${err.message}`);
  }
}

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9+#.\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeToken(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchesAny(value, pattern) {
  if (pattern == null) return true;
  if (Array.isArray(pattern)) return pattern.includes(value);
  if (pattern instanceof RegExp) return pattern.test(String(value || ''));
  return value === pattern;
}

function containsAny(text, phrases) {
  if (!Array.isArray(phrases) || phrases.length === 0) return false;
  const lower = normalizeText(text);
  return phrases.some(p => lower.includes(normalizeText(p)));
}

function containsAll(text, phrases) {
  if (!Array.isArray(phrases) || phrases.length === 0) return false;
  const lower = normalizeText(text);
  return phrases.every(p => lower.includes(normalizeText(p)));
}

function containsForbidden(text, phrases) {
  if (!Array.isArray(phrases) || phrases.length === 0) return false;
  const lower = normalizeText(text);

  // Negation words/phrases. If a forbidden phrase starts with one of these, it is a
  // deliberate denial and we still flag it. If it does not, but the immediate context
  // before the phrase is negated, the phrase is embedded in a qualified statement and
  // should not be counted as an overclaim.
  const negationPrefix = /^(?:no|not|never|none|nothing|nobody|nowhere|doesn'?t|does not|didn'?t|did not|hasn'?t|has not|haven'?t|have not|isn'?t|is not|wasn'?t|was not|aren'?t|are not|won'?t|wouldn'?t|couldn'?t|shouldn'?t|without|lack(?:s|ing)?)/i;
  const negationInContext = /\b(?:no|not|never|none|nothing|without|does\s+not|doesn'?t|did\s+not|didn'?t|has\s+not|hasn'?t|have\s+not|haven'?t|is\s+not|isn'?t|was\s+not|wasn'?t|are\s+not|aren'?t|no\s+verified|no\s+public|no\s+record)\b/;

  return phrases.some(p => {
    const phrase = normalizeText(p);
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      const phraseIsDenial = negationPrefix.test(phrase);
      if (phraseIsDenial) {
        // The forbidden phrase itself is a denial; flag it regardless.
        return true;
      }

      // Find the start of the clause/sentence containing this occurrence.
      const before = lower.slice(0, idx);
      const clauseStart = Math.max(
        before.lastIndexOf('. '),
        before.lastIndexOf('? '),
        before.lastIndexOf('! '),
        before.lastIndexOf('; ')
      ) + 2;
      const context = before.slice(clauseStart, idx);

      if (!negationInContext.test(context)) {
        return true;
      }
      idx = lower.indexOf(phrase, idx + 1);
    }
    return false;
  });
}

function getContract(result) {
  const body = result?.body;
  if (body && typeof body === 'object') {
    if (body.contract) return body.contract;
    if (body.agent) return body.agent;
  }
  if (result?.contract) return result.contract;
  if (result?.agent) return result.agent;
  return null;
}

function getReply(result) {
  if (result?.body && typeof result.body === 'object') {
    return String(result.body.reply || '');
  }
  return String(result?.reply || '');
}

function getQuestion(testCase, result) {
  return testCase.message || result?.message || result?.body?.message || '';
}

function parseOpenWorldClaim(question, knowledge) {
  const q = String(question || '');
  const lower = q.toLowerCase();
  const subjectPattern = knowledgeAccess.getSubjectNamePattern(knowledge) || '';
  const pronoun = 'he|she|they';
  const subjectRe = subjectPattern ? `(?:${pronoun}|${subjectPattern})` : pronoun;

  // Future/capability questions are not claims about current state.
  if (/\b(?:could|would|can|will|should)\b/.test(lower) && /\b(?:learn|become|fit|role|position)\b/.test(lower)) {
    return null;
  }

  // Seniority / role-level claims take precedence over generic employment,
  // because the explicit seniority boundary can make the compound claim false
  // without requiring a denial of the employer context.
  const seniorityMatch = q.match(new RegExp(`\\b(?:${subjectRe})\\s+(?:was|is|has been|had been)\\s+(?:a|an)?\\s*\\b(senior|lead|principal|staff|expert|master)\\s+(engineer|developer|architect|manager|designer|analyst|specialist|consultant)\\b(?:\\s+(?:at|for|with|by)\\s+([a-z0-9\\s&.-]+?))?(?:[,.?]|\\s+(?:right|correct|and|or)\\b|$)`, 'i'));
  if (seniorityMatch) {
    const role = `${seniorityMatch[1]} ${seniorityMatch[2]}`.trim();
    const employer = seniorityMatch[3] ? seniorityMatch[3].replace(/[,.?]+$/, '').trim() : null;
    return { relation: 'seniority', object: role, employer };
  }

  const patterns = [
    { re: new RegExp(`\\b(?:${subjectRe})\\s+(?:was|is|has|have|did|worked)\\s+(?:at|for|by)\\s+([a-z0-9\\s&.-]+?)(?:[,.?]|\\s+(?:right|correct|as\\s+a|as|and|or)\\b|$)`, 'i'), relation: 'worked_at' },
    { re: new RegExp(`\\b(?:${subjectRe})\\s+(?:was|is)\\s+(?:a|an)\\s+([a-z][a-z\\s-]+?)(?:[,.?]|\\s+(?:right|correct|at|for|and|or)\\b|$)`, 'i'), relation: 'employed_as' },
    { re: new RegExp(`\\b(?:${subjectRe})\\s+(?:attended|graduated from|studied at)\\s+([a-z][a-z\\s.-]+?)(?:[,.?]|\\s+(?:right|correct|and|or)\\b|$)`, 'i'), relation: 'attended' },
    { re: new RegExp(`\\b(?:${subjectRe})\\s+(?:has|have|holds?)\\s+(?:a|the)?\\s*([a-z][a-z\\s-]+?cert\\w*)(?:[,.?]|\\s+(?:right|correct|and|or)\\b|$)`, 'i'), relation: 'has_cert' },
    { re: new RegExp(`\\b(?:pretend|make up|make.*sound|claim|say|tell|write|describe)\\b[^.]*?\\b(?:${subjectRe})\\s+(?:is|was|has|have|did|worked|attended|managed|built|led)\\s+(.+?)(?:[,.?]|\\s+(?:right|correct|and|or)\\b|$)`, 'i'), relation: 'asserted' }
  ];

  for (const p of patterns) {
    const m = q.match(p.re);
    if (m) {
      const object = m[1].replace(/[,.?]+$/, '').trim();
      return { relation: p.relation, object };
    }
  }

  // Fragments: "at google" / "a senior engineer"
  const fragmentMatch = lower.match(/^\s*(?:at|for|by)\s+([a-z][a-z0-9\s&.-]+)/);
  if (fragmentMatch) return { relation: 'worked_at', object: fragmentMatch[1].replace(/[,.?]+$/, '').trim() };

  return null;
}

function isFutureCapabilityQuestion(question) {
  const lower = question.toLowerCase();
  return /\b(?:could|would|can|will)\b/.test(lower) && /\b(?:learn|become|fit|role|position|capable|handle)\b/.test(lower);
}

// ---------------------------------------------------------------------------
// Semantic expectation framework
// ---------------------------------------------------------------------------

const NEGATION_PATTERNS = {
  noAtStart: /^\s*no\b/i,
  cannotAtStart: /^\s*no\b.{0,80}\b(?:can|could|would|will)\s+(?:not|never)/i,
  doesNotKnow: /\b(?:does not|doesn't|did not|didn't|has not|hasn't|have not|haven't|never|is not|isn't)\s+(?:know|proficient|expert|skilled|experienced|used|built|worked|done)\b/i,
  closedWorldDeny: /\b(?:work experience does not include|has not worked at|did not work at|never worked at|does not work at)\b/i,
  currentAbilityFromFuture: /\b(?:has already|already demonstrated|currently|proficient in|expert in|knows?\s+\w+\s+well|can\s+(?:debug|build|work|use|handle))\b/i
};

function hasAuthoritativeSeniorityNegative(knowledge, objectNorm) {
  if (!objectNorm) return false;
  const boundaries = knowledgeAccess.getBoundariesByCategory(knowledge, 'seniority');
  if (boundaries.length === 0) return false;
  const objectLower = objectNorm.toLowerCase();
  // The role claim must actually be a senior/lead/expert-level role.
  if (!/\b(?:senior|lead|principal|staff|expert|master|manager|executive)\b/.test(objectLower)) return false;
  // Require an authoritative seniority boundary (e.g. no-senior-level).
  return boundaries.some(b => b.authoritative === true && b.correction);
}

function hasAuthoritativeEmploymentNegative(knowledge, objectNorm) {
  if (!objectNorm) return false;
  // A generic claimCorrection like "He has not worked at this company" is not
  // authoritative for a specific company. We require the correction text to name
  // the company explicitly and contain a negative.
  const negativeWords = /\b(?:not|never|no|doesn't|does not|hasn't|has not|didn't|did not)\b/;
  const claimCorrections = knowledgeAccess.getClaimCorrections(knowledge);
  for (const c of claimCorrections) {
    if (!c.triggerPattern || !c.correction) continue;
    const trigger = new RegExp(c.triggerPattern, 'i');
    if (!trigger.test(objectNorm) && !trigger.test(knowledgeAccess.getSubjectName(knowledge))) continue;
    const corrLower = c.correction.toLowerCase();
    if (corrLower.includes(objectNorm) && negativeWords.test(corrLower)) return true;
  }
  // Boundaries can also explicitly deny a company.
  const boundaries = knowledgeAccess.getBoundaries(knowledge);
  for (const b of boundaries) {
    if (!b.claim || !b.correction) continue;
    const claimLower = b.claim.toLowerCase();
    const corrLower = b.correction.toLowerCase();
    if ((claimLower.includes(objectNorm) || corrLower.includes(objectNorm)) && negativeWords.test(corrLower)) return true;
  }
  return false;
}

function isKnownEmployer(knowledge, objectNorm) {
  if (!objectNorm) return false;
  const known = knowledgeAccess.getKnownCompanySet(knowledge);
  for (const c of known) {
    if (c.length >= 4 && (c.includes(objectNorm) || objectNorm.includes(c))) return true;
    if (c === objectNorm) return true;
  }
  return false;
}

function isKnownTechnology(knowledge, token) {
  if (!token) return false;
  const techs = knowledgeAccess.getKnownTechnologies(knowledge);
  const norm = normalizeToken(token);
  for (const t of techs) {
    const tn = normalizeToken(t);
    if (tn === norm || (tn.length >= 4 && (tn.includes(norm) || norm.includes(tn)))) return true;
  }
  return false;
}

function containsHistoricalRoleClaim(reply, role) {
  const verbs = ['worked as', 'was a', 'has been a', 'held a', 'employed as'];
  const lower = reply.toLowerCase();
  const words = role.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  for (const verb of verbs) {
    let idx = lower.indexOf(verb);
    while (idx !== -1) {
      const start = idx + verb.length;
      const tail = lower.slice(start, start + 120);
      const tailWords = tail.match(/\b[a-z0-9+]+\b/g) || [];
      let wordIdx = 0;
      let found = true;
      for (const word of words) {
        const next = tailWords.indexOf(word, wordIdx);
        if (next === -1) { found = false; break; }
        wordIdx = next + 1;
      }
      if (found) return true;
      idx = lower.indexOf(verb, idx + 1);
    }
  }
  return false;
}

function getProjectByName(name, knowledge) {
  if (!name || !Array.isArray(knowledge?.projects)) return null;
  const norm = normalizeToken(name);
  for (const p of knowledge.projects) {
    const pNorm = normalizeToken(p.name);
    if (pNorm === norm || (pNorm.length >= 4 && (pNorm.includes(norm) || norm.includes(pNorm)))) return p;
    if (Array.isArray(p.aliases)) {
      for (const a of p.aliases) {
        const aNorm = normalizeToken(a);
        if (aNorm === norm || (aNorm.length >= 4 && (aNorm.includes(norm) || norm.includes(pNorm)))) return p;
      }
    }
  }
  return null;
}

function findInReply(reply, needles) {
  if (!needles || !needles.length) return false;
  const lower = normalizeText(reply);
  return needles.some(n => lower.includes(normalizeText(n)));
}

function technologyCandidates(knowledge, requestedTopic = null) {
  const raw = [
    ...(knowledgeAccess.getKnownTechnologies(knowledge) || []),
    requestedTopic
  ].filter(Boolean);
  const generic = new Set([
    'app', 'application', 'platform', 'project', 'service', 'system',
    'frontend', 'backend', 'development', 'code'
  ]);
  const candidates = new Map();

  for (const item of raw) {
    const whole = String(item || '').trim();
    const pieces = [whole, ...whole.split(/\s*(?:\/|\||,|;)\s*/)].filter(Boolean);
    for (const piece of pieces) {
      const value = piece.trim();
      const norm = normalizeToken(value);
      if (norm.length < 2 || generic.has(norm)) continue;
      if (!candidates.has(norm)) candidates.set(norm, value);
    }
  }
  return [...candidates.entries()].map(([norm, value]) => ({ norm, value }));
}

function textMentionsTechnology(text, technology) {
  const escaped = escapeRegex(String(technology || '').trim()).replace(/\s+/g, '\\s+');
  if (!escaped) return false;
  return new RegExp(`(?:^|[^A-Za-z0-9+#])${escaped}(?=$|[^A-Za-z0-9+#])`, 'i').test(String(text || ''));
}

function normalizedProjectTechs(project) {
  const values = [];
  for (const item of project?.tech || []) {
    const whole = String(item || '').trim();
    for (const piece of [whole, ...whole.split(/\s*(?:\/|\||,|;)\s*/)]) {
      const norm = normalizeToken(piece);
      if (norm) values.push(norm);
    }
  }
  return [...new Set(values)];
}

function projectTechRelationshipClaims(reply, knowledge, requestedTopic = null) {
  const bad = [];
  if (!Array.isArray(knowledge?.projects) || !reply) return bad;

  const relationVerb = /\b(?:uses?|used|using|utilizes?|utilized|utilizing|built\s+(?:with|using)|developed\s+(?:with|using)|implemented\s+(?:with|using)|written\s+in|powered\s+by)\b/i;
  const negativeRelation = /\b(?:does\s+not|doesn't|did\s+not|didn't|was\s+not|wasn't|not\s+built|not\s+using|no\s+verified)\b/i;
  const candidates = technologyCandidates(knowledge, requestedTopic);
  const clauses = String(reply).split(/(?<=[.!?;])\s+|\n+|\b(?:while|whereas)\b/i).filter(Boolean);

  for (const project of knowledge.projects) {
    const names = [project.name, ...(project.aliases || [])].filter(Boolean);
    const projectTechs = normalizedProjectTechs(project);

    for (const clause of clauses) {
      const lowerClause = clause.toLowerCase();
      for (const name of names) {
        const nameIndex = lowerClause.indexOf(String(name).toLowerCase());
        if (nameIndex === -1) continue;

        // Scope the relation to text following this project mention. If another
        // project appears later in the same clause, stop before that mention so
        // technologies do not leak across compared projects.
        let afterProject = clause.slice(nameIndex + String(name).length);
        let nextProject = afterProject.length;
        for (const other of knowledge.projects) {
          if (other === project) continue;
          for (const otherName of [other.name, ...(other.aliases || [])].filter(Boolean)) {
            const pos = afterProject.toLowerCase().indexOf(String(otherName).toLowerCase());
            if (pos >= 0 && pos < nextProject) nextProject = pos;
          }
        }
        afterProject = afterProject.slice(0, nextProject);

        const relation = relationVerb.exec(afterProject);
        if (!relation || relation.index > 100) continue;
        const relationSegment = afterProject.slice(relation.index);
        if (negativeRelation.test(relationSegment)) continue;

        for (const candidate of candidates) {
          if (!textMentionsTechnology(relationSegment, candidate.value)) continue;
          const supported = projectTechs.some(pt =>
            pt === candidate.norm ||
            (pt.length >= 4 && candidate.norm.length >= 4 && (pt.includes(candidate.norm) || candidate.norm.includes(pt)))
          );
          if (!supported) {
            bad.push({ project: project.name, claimedTech: candidate.norm, projectTechs });
          }
        }
      }
    }
  }

  const seen = new Set();
  return bad.filter(item => {
    const key = `${item.project}|${item.claimedTech}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractFutureTarget(question) {
  const lower = question.toLowerCase();
  // "Could he learn COBOL?" -> topic "cobol"
  let m = lower.match(/\b(?:learn|pick\s+up|get\s+good\s+at|study|become\s+(?:good\s+at|proficient\s+in))\s+([a-z0-9+#.\s]+?)(?:\?|\.|$)/i);
  if (m) return { type: 'topic', value: m[1].trim() };
  // "Could he become a senior frontend engineer?" -> role "senior frontend engineer"
  m = lower.match(/\b(?:become|be|fit\s+(?:as\s+a|a)|role\s+(?:as\s+a|a)?)\s+([a-z0-9\s]+?)(?:\?|\.|$)/i);
  if (m) return { type: 'role', value: m[1].trim() };
  return null;
}

function validateOpenWorldRelationship(testCase, result, opts) {
  const knowledge = opts.knowledge;
  const contract = getContract(result);
  const question = getQuestion(testCase, result);
  const reply = getReply(result);
  const claim = parseOpenWorldClaim(question, knowledge);
  if (!claim) {
    return { quality: QUALITY.GOOD, reason: 'could not parse claim; skipping open-world check' };
  }
  const objectNorm = normalizeToken(claim.object);
  let expectedState;
  if (claim.relation === 'seniority') {
    // Seniority/role-level claims can be contradicted by an explicit authoritative
    // boundary without requiring a denial of the employer context.
    if (hasAuthoritativeSeniorityNegative(knowledge, claim.object)) {
      expectedState = 'false';
    } else {
      expectedState = 'unknown';
    }
  } else if (claim.relation === 'worked_at' || claim.relation === 'employed_as') {
    if (isKnownEmployer(knowledge, objectNorm)) expectedState = 'true';
    else if (hasAuthoritativeEmploymentNegative(knowledge, objectNorm)) expectedState = 'false';
    else expectedState = 'unknown';
  } else if (claim.relation === 'attended') {
    // education is closed-world and authoritative
    const knownSchools = knowledgeAccess.getKnownSchools(knowledge).map(s => normalizeToken(s));
    expectedState = knownSchools.some(s => s === objectNorm || (s.length >= 4 && (s.includes(objectNorm) || objectNorm.includes(s)))) ? 'true' : 'false';
  } else if (claim.relation === 'has_cert') {
    const knownCerts = knowledgeAccess.getKnownCertifications(knowledge).map(s => normalizeToken(s));
    expectedState = knownCerts.some(s => s === objectNorm || (s.length >= 4 && (s.includes(objectNorm) || objectNorm.includes(s)))) ? 'true' : 'false';
  } else {
    expectedState = 'unknown';
  }

  // For the scorer, 'true' / 'false' / 'unknown' map onto contract factState values.
  const factState = contract?.factState || null;
  const directAnswer = contract?.directAnswer || null;
  const policyMode = contract?.policyMode || contract?.mode || null;

  if (expectedState === 'unknown') {
    // The visible contract must not claim FALSE / NO.
    if (factState === 'FALSE' || directAnswer === 'NO' || policyMode === 'FALSE_CLAIM_DENIAL') {
      return { quality: QUALITY.FACT_WRONG, reason: `open-world ${claim.relation} claim for ${claim.object} treated as contradicted (expected UNKNOWN)` };
    }
    // The visible answer must not be a closed-world denial.
    if (NEGATION_PATTERNS.noAtStart.test(reply) && findInReply(reply, [claim.object, objectNorm])) {
      return { quality: QUALITY.OVERCLAIM, reason: `reply starts with 'No' for open-world ${claim.relation} ${claim.object}` };
    }
    if (NEGATION_PATTERNS.closedWorldDeny.test(reply) && findInReply(reply, [claim.object, objectNorm])) {
      return { quality: QUALITY.OVERCLAIM, reason: `reply asserts a closed-world employment negative for ${claim.object}` };
    }
    if (NEGATION_PATTERNS.doesNotKnow.test(reply) && findInReply(reply, [claim.object, objectNorm])) {
      return { quality: QUALITY.OVERCLAIM, reason: `reply denies the open-world claim for ${claim.object}` };
    }
    return { quality: QUALITY.GOOD, reason: null };
  }

  if (expectedState === 'false') {
    // The answer should deny the false claim, but not over-claim beyond the boundary.
    if (factState === 'TRUE' || directAnswer === 'YES') {
      return { quality: QUALITY.FACT_WRONG, reason: `false ${claim.relation} ${claim.object} was affirmed` };
    }
    // For seniority with an employer context, the reply must not fabricate a
    // closed-world negative about the employer (e.g. "he never worked at Amazon").
    if (claim.relation === 'seniority' && claim.employer) {
      const employerNorm = normalizeToken(claim.employer);
      const employerRegex = new RegExp(`(?:^|\\b)\\s*(?:he|${escapeRegex((knowledgeAccess.getSubjectNamePattern(knowledge) || '').split('|').filter(Boolean).join('|') || 'he')})?\\s*(?:has not|hasn't|did not|didn't|never|does not|doesn't)\\s+(?:work(?:ed)? at|work for)\\s+(?:[^\\s]{0,30})?${escapeRegex(employerNorm)}`, 'i');
      if (employerRegex.test(reply) || /\b(?:work experience does not include|work history does not include)\b.*\b(?:amazon|aws)\b/i.test(reply)) {
        return { quality: QUALITY.OVERCLAIM, reason: `seniority denial over-claims about employer ${claim.employer}` };
      }
      // Do not derive entry-level / junior / early-career status from absence.
      if (/(?:^|\b)\s*(?:he is|he was|Bradley is|Bradley was)\s+(?:an?\s+)?(?:entry-level|junior|early-career|intern|just starting|new to the field)\b/i.test(reply)) {
        return { quality: QUALITY.OVERCLAIM, reason: `seniority denial derives an unsupported junior/entry-level status` };
      }
    }
    return { quality: QUALITY.GOOD, reason: null };
  }

  // expected true
  if (factState === 'FALSE' || directAnswer === 'NO') {
    return { quality: QUALITY.FACT_WRONG, reason: `true ${claim.relation} ${claim.object} was denied` };
  }
  return { quality: QUALITY.GOOD, reason: null };
}

function validateUnknownSkill(testCase, result, opts) {
  const knowledge = opts.knowledge;
  const question = getQuestion(testCase, result);
  const reply = getReply(result);
  const contract = getContract(result);

  const direct = question.toLowerCase().match(/\b(?:know|use|used|familiar with|experience with|skilled (?:in|with)|done with)\s+([A-Za-z][A-Za-z0-9+#.-]+)/i);
  const topic = direct ? direct[1].trim() : (testCase.expect?.requestedTopic || null);

  // For a currently-unknown skill, the contract must be UNKNOWN (or null).
  if (contract && (contract.factState === 'FALSE' || contract.directAnswer === 'NO' || contract.directAnswer === 'YES')) {
    return { quality: QUALITY.FACT_WRONG, reason: `unknown skill ${topic} produced directAnswer ${contract.directAnswer}/factState ${contract.factState}; expected UNKNOWN` };
  }

  // The reply must not assert current mastery or a flat denial.
  if (topic) {
    const topicNorm = normalizeToken(topic);
    // avoid "knows COBOL", "proficient in COBOL", "expert in COBOL"
    const masteryRe = new RegExp(`\\b(?:knows?|proficient in|expert in|skilled in|experienced in|has(?:\s+\w+)?\s+experience with)\\s+(?:[^\\s]{0,30})?${escapeRegex(topicNorm)}`, 'i');
    if (masteryRe.test(reply)) {
      return { quality: QUALITY.OVERCLAIM, reason: `reply claims current mastery of unknown skill ${topic}` };
    }
    // flat denial: "No, he does not know X" or "he doesn't know X"
    const denialRe = new RegExp(`(?:^|\\b)\\s*no\\s*[,.]?\\s*(?:he|Bradley|${escapeRegex(knowledgeAccess.getSubjectNamePattern(knowledge))})?.*?\\b(?:does not|doesn't|did not|didn't|has not|hasn't|never)\\s+(?:know|use)\\s+(?:[^\\s]{0,30})?${escapeRegex(topicNorm)}`, 'i');
    if (denialRe.test(reply)) {
      return { quality: QUALITY.OVERCLAIM, reason: `reply flatly denies unknown skill ${topic} instead of stating uncertainty` };
    }
    // "he cannot X" or "No, he cannot debug X"
    const cannotRe = new RegExp(`(?:^|\\b)\\s*no\\s*[,.]?\\s*(?:he|Bradley|the subject)?\\s+(?:can|could)?\\s*not\\s+(?:debug|use|build|work|learn)?\\s+(?:with|in)?\\s*${escapeRegex(topicNorm)}`, 'i');
    if (cannotRe.test(reply)) {
      return { quality: QUALITY.OVERCLAIM, reason: `reply denies that he can ${topic} (current ability) instead of stating uncertainty` };
    }
  }

  return { quality: QUALITY.GOOD, reason: null };
}

function validateFutureCapability(testCase, result, opts) {
  const question = getQuestion(testCase, result);
  const reply = getReply(result);
  const contract = getContract(result);
  const target = extractFutureTarget(question);

  if (contract && (contract.factState === 'FALSE' || contract.directAnswer === 'NO' || contract.policyMode === 'FALSE_CLAIM_DENIAL')) {
    return { quality: QUALITY.FACT_WRONG, reason: `future capability question produced ${contract.directAnswer}/${contract.factState}; expected UNKNOWN and future-facing answer` };
  }

  // The answer must not start with a flat "No" and it must not switch to a role frame.
  if (/^\s*no\b/i.test(reply)) {
    return { quality: QUALITY.FACT_WRONG, reason: 'future capability answer starts with "No"' };
  }

  // If the question asks about learning a skill, the reply should mention the skill and future/learning/potential.
  if (target?.type === 'topic') {
    const topicNorm = normalizeToken(target.value);
    if (NEGATION_PATTERNS.currentAbilityFromFuture.test(reply) && findInReply(reply, [topicNorm])) {
      return { quality: QUALITY.OVERCLAIM, reason: `future skill reply asserts current ability with ${target.value}` };
    }
    // Reject answers that say the requested "role" is not the skill.
    if (/\brequested\s+(?:role|position)\s+(?:is|was)\s+not\b/i.test(reply) && findInReply(reply, [topicNorm])) {
      return { quality: QUALITY.FACT_WRONG, reason: `future skill answer misframes ${target.value} as a role/position` };
    }
  }

  // For future role, do not claim he currently has the role.
  if (target?.type === 'role') {
    const roleNorm = normalizeToken(target.value);
    const currentRoleRe = new RegExp(`\\b(?:is a|was a|has been a|currently a|works as a)\\s+(?:[^\\s]{0,40})?${escapeRegex(roleNorm)}`, 'i');
    if (currentRoleRe.test(reply)) {
      return { quality: QUALITY.OVERCLAIM, reason: `future role reply asserts he currently is ${target.value}` };
    }
  }

  return { quality: QUALITY.GOOD, reason: null };
}

function validateProjectTechRelationship(testCase, result, opts) {
  const knowledge = opts.knowledge;
  const reply = getReply(result);
  const contract = getContract(result);
  const bad = projectTechRelationshipClaims(reply, knowledge, contract?.requestedTopic || testCase.expect?.requestedTopic || null);
  if (bad.length) {
    const first = bad[0];
    return { quality: QUALITY.OVERCLAIM, reason: `project ${first.project} is described with unverified tech ${first.claimedTech} (project tech: ${first.projectTechs.join(', ')})` };
  }
  return { quality: QUALITY.GOOD, reason: null };
}

function validateRoleFit(testCase, result, opts) {
  const reply = getReply(result);
  const contract = getContract(result);
  const question = getQuestion(testCase, result);
  const knowledge = opts.knowledge;

  // Must not claim Bradley held a specific unsupported historical job title.
  const roleMatch = question.match(/\b(?:fit for|fit as|role as|job as|position as)\s+(?:a\s+)?([a-z\s]+?)(?:\?|\.|$)/i) ||
                    question.match(/\b(?:is\s+(?:he|Bradley)\s+a\s+fit\s+for)\s+(?:a\s+)?([a-z\s]+?)(?:\?|\.|$)/i);
  if (roleMatch) {
    const role = roleMatch[1].replace(/\s*(?:role|position|job)\s*$/i, '').trim().toLowerCase();
    if (containsHistoricalRoleClaim(reply, role)) {
      return { quality: QUALITY.OVERCLAIM, reason: `role-fit reply invents historical employment as ${role}` };
    }
  }

  // DirectAnswer for role fit should not be NOT_FIT if there is strong relevant evidence.
  if (contract && contract.directAnswer === 'NOT_FIT' && /\b(?:junior|frontend|javascript|react)\b/i.test(question)) {
    return { quality: QUALITY.FACT_WRONG, reason: 'role-fit question with strong relevant evidence produced NOT_FIT' };
  }

  // Reply must mention the role dimension or skills.
  if (!/\b(?:fit|role|frontend|javascript|react|skill|project)\b/i.test(reply)) {
    return { quality: QUALITY.GENERIC, reason: 'role-fit reply does not address the role or skills' };
  }

  return { quality: QUALITY.GOOD, reason: null };
}

function validateNegativeAssessment(testCase, result, opts) {
  const reply = getReply(result);
  const contract = getContract(result);

  if (contract && contract.factState === 'TRUE') {
    return { quality: QUALITY.FACT_WRONG, reason: 'negative assessment produced TRUE factState' };
  }

  const explicitWeakness = /\b(?:he is bad at|he is weak at|his weakness is|he struggles with|he is terrible at|poor at|bad at)\b/i;
  const rankedWeakness = /\b(?:his|her|their|the\s+candidate(?:'s)?|the\s+subject(?:'s)?|[a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?'s)\s+(?:(?:biggest|main|primary|greatest|worst|honest)\s+){0,3}weakness(?:es)?\s+(?:is|are)\b/i;
  const boundedWeakness = /\bweakness(?:es)?\s+(?:is|are)\s+(?:unknown|not\s+(?:verified|documented|established|known))\b/i;

  if (explicitWeakness.test(reply) || (rankedWeakness.test(reply) && !boundedWeakness.test(reply))) {
    return { quality: QUALITY.OVERCLAIM, reason: 'negative assessment turns an unverified gap/learning area into a personal weakness' };
  }

  return { quality: QUALITY.GOOD, reason: null };
}

function validateOutOfScope(testCase, result, opts) {
  const reply = getReply(result);
  const contract = getContract(result);

  if (contract && (contract.policyMode !== 'OUT_OF_SCOPE' && contract.policyMode !== 'REFUSAL')) {
    return { quality: QUALITY.POLICY_FAILURE, reason: `out-of-scope question has policyMode ${contract.policyMode}; expected OUT_OF_SCOPE/REFUSAL` };
  }

  // An out-of-scope answer must not answer the original off-topic question.
  // A brief refusal or external redirect is acceptable; it need not mention Scout.
  const normalized = normalizeText(reply);
  if (normalized.length < 5) {
    return { quality: QUALITY.TERSE, reason: 'out-of-scope reply is too short' };
  }

  return { quality: QUALITY.GOOD, reason: null };
}

function validateMetaIdentity(testCase, result, opts) {
  const reply = getReply(result);
  const contract = getContract(result);

  if (contract && (contract.factState === 'FALSE' || contract.directAnswer === 'NO')) {
    return { quality: QUALITY.PERSONA, reason: 'meta-identity question produced FALSE/NO for assistant name' };
  }

  if (!/\bScout\b/i.test(reply)) {
    return { quality: QUALITY.PERSONA, reason: 'meta-identity reply does not state the assistant name Scout' };
  }

  if (/\b(?:Claude|ChatGPT|Gemini|OpenAI|Anthropic)\b/i.test(reply)) {
    return { quality: QUALITY.PERSONA, reason: 'meta-identity reply mentions another assistant/provider name' };
  }

  return { quality: QUALITY.GOOD, reason: null };
}

function validateMetaCapabilities(testCase, result, opts) {
  const reply = getReply(result);
  const contract = getContract(result);

  if (contract && (contract.factState === 'FALSE' || contract.directAnswer === 'NO')) {
    return { quality: QUALITY.PERSONA, reason: 'meta-capabilities question produced FALSE/NO' };
  }

  if (!/\b(?:projects?|skills?|experience|background|Bradley|candidate)\b/i.test(reply)) {
    return { quality: QUALITY.GENERIC, reason: 'meta-capabilities reply does not mention the configured scope' };
  }

  if (/\b(?:learn from|self.?(?:learn|improve)|train myself|improve myself)\b/i.test(reply)) {
    return { quality: QUALITY.PERSONA, reason: 'meta-capabilities reply claims self-learning ability' };
  }

  return { quality: QUALITY.GOOD, reason: null };
}

function validatePublicContact(testCase, result, opts) {
  const reply = getReply(result);
  const knowledge = opts.knowledge;

  const contact = knowledge?.contact || knowledge?.identity?.contact || {};
  const publicChannels = [];
  if (contact.email || knowledge?.identity?.email) publicChannels.push('email');
  if (contact.linkedin || knowledge?.identity?.linkedin) publicChannels.push('linkedin');
  if (contact.github || knowledge?.identity?.github) publicChannels.push('github');
  if (contact.phone || knowledge?.identity?.phone) publicChannels.push('phone');

  const foundChannel = publicChannels.some(c => new RegExp(`\\b${escapeRegex(c)}\\b`, 'i').test(reply));
  if (!foundChannel) {
    return { quality: QUALITY.GENERIC, reason: 'public contact reply does not mention any public contact channel' };
  }

  if (/\b(?:home|personal|private|cell|mobile|address)\b/i.test(reply)) {
    return { quality: QUALITY.POLICY_FAILURE, reason: 'contact reply mentions private contact data' };
  }

  return { quality: QUALITY.GOOD, reason: null };
}

function validatePrivateData(testCase, result, opts) {
  const contract = getContract(result);
  const reply = getReply(result);

  if (contract && (contract.policyMode !== 'REFUSAL' && contract.policyMode !== 'OUT_OF_SCOPE')) {
    return { quality: QUALITY.POLICY_FAILURE, reason: `private-data question has policyMode ${contract.policyMode}; expected REFUSAL` };
  }

  if (/\b(?:address is|home is|his address|his home|phone number is)\b/i.test(reply)) {
    return { quality: QUALITY.OVERCLAIM, reason: 'private-data reply discloses private data' };
  }

  return { quality: QUALITY.GOOD, reason: null };
}

function validatePluralReferent(testCase, result, opts) {
  const question = getQuestion(testCase, result);
  const reply = getReply(result);
  const knowledge = opts.knowledge;

  // If the question uses a plural pronoun, the reply should resolve it to a documented learning/gap item.
  if (/\b(?:them|these|those)\b/i.test(question)) {
    const learningItems = knowledge?.skills?.learningOrAdjacent || [];
    const learningTexts = learningItems.flatMap(item => {
      if (typeof item === 'string') return [item];
      if (!item || typeof item !== 'object') return [];
      return [
        item.label,
        item.name,
        item.skill,
        item.title,
        item.summary,
        item.description,
        item.detail
      ].filter(Boolean).map(String);
    });
    const learningNorms = learningTexts.map(normalizeText).filter(Boolean);
    const boundaryItems = knowledgeAccess.getBoundariesByCategory(knowledge, 'capability')
      .concat(knowledgeAccess.getBoundariesByCategory(knowledge, 'seniority'))
      .map(b => b.correction).filter(Boolean);

    // Break documented gap strings into their meaningful subphrases (e.g., conjunctions, lists, parentheticals)
    // so the model is not required to recite an entire long item verbatim.
    function subphrases(text) {
      if (!text) return [];
      const parts = String(text).split(/\s*(?:,| and |\/|\(|\))\s*/);
      return parts
        .map(p => normalizeText(p).replace(/^\s*(?:the|a|an|in|with|of|for)\s+/, '').trim())
        .filter(p => p.length >= 4);
    }

    const learningSubphrases = learningNorms.flatMap(subphrases);
    const boundarySubphrases = boundaryItems.flatMap(b => subphrases(normalizeText(b)));
    const allItems = [...new Set([...learningSubphrases, ...boundarySubphrases])];
    const normalizedReply = normalizeText(reply);

    const hasResolution = allItems.some(item => normalizedReply.includes(item)) ||
                          /\b(?:no public evidence|not documented|unknown|not listed|public evidence does not|does not indicate)\b/i.test(reply);

    if (!hasResolution) {
      return { quality: QUALITY.CONTEXT_ERROR, reason: 'plural referent not resolved to a documented learning/gap item' };
    }

    const asksCurrentProgress = /\b(?:working\s+on|work\s+on|address(?:ing)?|improv(?:e|ing)|develop(?:ing)?|progress)\b/i.test(question);
    if (asksCurrentProgress) {
      const boundedUnknown = /\b(?:unknown|not\s+(?:verified|documented|established|known)|no\s+(?:verified|public|current)\s+(?:evidence|record|information)|cannot\s+verify|can't\s+verify)\b/i.test(reply);
      const explicitProgress = /\b(?:is|currently|actively|has\s+been)\s+(?:working|learning|studying|practicing|training|developing|addressing|improving)\b/i.test(reply);
      const sourceShowsProgress = learningTexts.some(item => /\b(?:currently|actively|working\s+on|learning|studying|taking\s+(?:a\s+)?course|practicing|training|developing|improving)\b/i.test(item));

      if (explicitProgress && !sourceShowsProgress) {
        return { quality: QUALITY.OVERCLAIM, reason: 'plural follow-up invents current progress on a documented learning/gap item' };
      }
      if (!boundedUnknown && !explicitProgress) {
        return { quality: QUALITY.CONTEXT_ERROR, reason: 'plural follow-up names the gap but does not answer whether current progress is verified' };
      }
    }
  }

  return { quality: QUALITY.GOOD, reason: null };
}

const SEMANTIC_VALIDATORS = {
  OPEN_WORLD_RELATIONSHIP: validateOpenWorldRelationship,
  UNKNOWN_SKILL: validateUnknownSkill,
  FUTURE_CAPABILITY: validateFutureCapability,
  ROLE_FIT: validateRoleFit,
  NEGATIVE_ASSESSMENT: validateNegativeAssessment,
  OUT_OF_SCOPE: validateOutOfScope,
  META_IDENTITY: validateMetaIdentity,
  META_CAPABILITIES: validateMetaCapabilities,
  PUBLIC_CONTACT: validatePublicContact,
  PRIVATE_DATA: validatePrivateData,
  PLURAL_REFERENT: validatePluralReferent,
  PROJECT_TECH_RELATIONSHIP: validateProjectTechRelationship
};

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Public scoring entry point
// ---------------------------------------------------------------------------

function scoreCase(testCase, result, options = {}) {
  const opts = { ...options };
  if (!opts.knowledge) opts.knowledge = loadDefaultKnowledge();

  const expect = testCase.expect || {};
  const reply = getReply(result);

  // Normalize results that come from live API (full body) vs offline artifacts (top-level reply/contract).
  const rawBody = result?.body;
  let body;
  if (rawBody && typeof rawBody === 'object') {
    body = rawBody;
  } else if (reply) {
    body = {
      ok: true,
      reply,
      provider: result?.provider || 'none',
      proseSource: result?.proseSource || 'MODEL_GENERATION',
      model: result?.model || ''
    };
  } else {
    body = null;
  }

  // Infrastructure checks
  if (result?.network) return { quality: QUALITY.NETWORK, reason: `network: ${result.body?.detail || 'unknown'}` };
  if (result?.status === 429) return { quality: QUALITY.RATE_LIMIT, reason: 'HTTP 429 rate limit' };
  if (!body || typeof body !== 'object') {
    if (reply && expect.minLength == null) {
      // offline artifact: continue with reply-based checks
    } else {
      return { quality: QUALITY.BROKEN, reason: 'unparseable response' };
    }
  }

  if (body) {
    if (body.ok === false || body.error) {
      if (body.error === 'INFERENCE_UNAVAILABLE') return { quality: QUALITY.TECHNICAL_ERROR, reason: 'INFERENCE_UNAVAILABLE' };
      if (result.status >= 500) return { quality: QUALITY.TECHNICAL_ERROR, reason: `server error ${result.status}: ${body.error}` };
      return { quality: QUALITY.ERROR, reason: `typed error: ${body.error}` };
    }

    if (expect.ok === true && body.ok !== true) {
      return { quality: QUALITY.POLICY_FAILURE, reason: `ok should be true, got ${body.ok}` };
    }

    const proseSource = body.proseSource || 'TECHNICAL_ERROR';
    if (!ALLOWED_PROSE_SOURCES.has(proseSource)) {
      return { quality: QUALITY.POLICY_FAILURE, reason: `unexpected proseSource: ${proseSource}` };
    }
    if (proseSource === 'TECHNICAL_ERROR') {
      return { quality: QUALITY.TECHNICAL_ERROR, reason: 'proseSource is TECHNICAL_ERROR' };
    }

    const provider = body.provider || 'none';
    if (!ALLOWED_PROVIDERS.has(provider)) {
      return { quality: QUALITY.POLICY_FAILURE, reason: `unexpected provider: ${provider}` };
    }

    if (result.latencyMs != null && result.latencyMs > (opts.maxLatencyMs || MAX_LATENCY_MS)) {
      return { quality: QUALITY.ERROR, reason: `latency ${result.latencyMs}ms exceeded ${opts.maxLatencyMs || MAX_LATENCY_MS}ms` };
    }
  }

  // Telemetry checks (contract fields)
  const contract = getContract(result);
  if (expect.telemetry && contract) {
    for (const [key, val] of Object.entries(expect.telemetry)) {
      const got = contract[key];
      if (!matchesAny(got, val)) {
        return { quality: QUALITY.FACT_WRONG, reason: `expected contract.${key} ${JSON.stringify(val)}, got ${JSON.stringify(got)}` };
      }
    }
  }

  if (expect.directAnswer != null && !matchesAny(contract?.directAnswer, expect.directAnswer)) {
    return { quality: QUALITY.FACT_WRONG, reason: `expected directAnswer ${JSON.stringify(expect.directAnswer)}, got ${JSON.stringify(contract?.directAnswer)}` };
  }

  if (expect.factState != null && !matchesAny(contract?.factState, expect.factState)) {
    return { quality: QUALITY.FACT_WRONG, reason: `expected factState ${JSON.stringify(expect.factState)}, got ${JSON.stringify(contract?.factState)}` };
  }

  if (expect.policyMode != null && !matchesAny(contract?.policyMode || contract?.mode, expect.policyMode)) {
    return { quality: QUALITY.POLICY_FAILURE, reason: `expected policyMode ${JSON.stringify(expect.policyMode)}, got ${JSON.stringify(contract?.policyMode || contract?.mode)}` };
  }

  // Semantic validator
  const semanticType = expect.semanticType || testCase.semanticType;
  if (semanticType) {
    const validator = SEMANTIC_VALIDATORS[semanticType];
    if (validator) {
      const verdict = validator(testCase, result, opts);
      if (verdict && verdict.quality !== QUALITY.GOOD) {
        return verdict;
      }
    }
  }

  // Universal project-technology relationship guard: any answer that falsely
  // claims a project was built with a technology not listed for that project
  // is an overclaim, regardless of question intent.
  const projectTechBad = projectTechRelationshipClaims(reply, opts.knowledge, contract?.requestedTopic || expect.requestedTopic || null);
  if (projectTechBad.length > 0) {
    const first = projectTechBad[0];
    return { quality: QUALITY.OVERCLAIM, reason: `project ${first.project} is described with unverified tech ${first.claimedTech}` };
  }

  // Phrase checks
  const requireAll = expect.requireAll || testCase.requireAll;
  const requireAny = expect.requireAny || testCase.requireAny || expect.require;
  const forbidAny = expect.forbidAny || testCase.forbidAny || expect.forbid;

  if (expect.minLength != null && reply.length < expect.minLength) {
    return { quality: QUALITY.TERSE, reason: `reply length ${reply.length} < ${expect.minLength}` };
  }

  if (requireAll && !containsAll(reply, requireAll)) {
    return { quality: QUALITY.GENERIC, reason: `missing all required phrases: ${requireAll.join(' + ')}` };
  }

  if (requireAny && !containsAny(reply, requireAny)) {
    return { quality: QUALITY.GENERIC, reason: `missing one of required phrases: ${requireAny.join(' | ')}` };
  }

  if (forbidAny && containsForbidden(reply, forbidAny)) {
    return { quality: QUALITY.OVERCLAIM, reason: `forbidden claim or wording: matched one of [${forbidAny.join(', ')}]` };
  }

  return { quality: QUALITY.GOOD, reason: null };
}

function scoreArtifact(artifact, cases, options = {}) {
  const opts = { ...options };
  if (!opts.knowledge) opts.knowledge = loadDefaultKnowledge();

  const results = artifact.results || [];
  const out = [];
  let good = 0;
  const byQuality = {};
  const failedIds = [];
  const caseMap = new Map(cases.map(c => [c.id, c]));

  for (const r of results) {
    const c = caseMap.get(r.id);
    if (!c) continue;
    const score = scoreCase(c, r, opts);
    const entry = {
      ...r,
      strictQuality: score.quality,
      strictReason: score.reason
    };
    if (r.quality !== score.quality) {
      entry.qualityChanged = true;
      entry.oldQuality = r.quality;
    }
    out.push(entry);
    byQuality[score.quality] = (byQuality[score.quality] || 0) + 1;
    if (score.quality === QUALITY.GOOD) good++;
    else failedIds.push(r.id);
  }

  return {
    total: out.length,
    good,
    passRate: out.length ? Math.round((good / out.length) * 1000) / 10 : 0,
    byQuality,
    failedIds,
    results: out
  };
}

module.exports = {
  QUALITY,
  scoreCase,
  scoreArtifact,
  loadDefaultKnowledge,
  matchesAny,
  containsAny,
  containsAll,
  containsForbidden,
  SEMANTIC_VALIDATORS,
  projectTechRelationshipClaims
};
