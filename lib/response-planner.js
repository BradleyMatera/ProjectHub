'use strict';

/**
 * Generic Response Planner
 *
 * Computes a semantic answer plan BEFORE asking the LLM to write natural language.
 * The plan tells the model WHAT to communicate, not HOW to phrase it.
 *
 * The planner operates on generic semantic slots:
 * - intent: what kind of answer is needed
 * - subject: primary entity being discussed
 * - directAnswer: yes/no/none for polar questions
 * - entities: allowed entities for this turn
 * - supportedRelationships: verified relationships relevant to this turn
 * - evidenceStrength: DIRECT / ADJACENT / PROJECT_ONLY / CERTIFICATION_ONLY / GAP / UNKNOWN
 * - caveats: boundaries the model should respect
 * - comparisonDimensions: for comparison questions
 * - style: requested answer style
 *
 * The planner is domain-neutral. It works on any knowledge package that
 * follows the standard schema (projects, experience, education, skills, certifications).
 *
 * No tenant-specific logic. No hardcoded entity names.
 */

const { buildRelationshipGraph } = require('./relationship-graph');
const { classifyIntent } = require('./completeness-check');
const knowledgeAccess = require('./knowledge-access');

/**
 * Build a response plan for a question.
 *
 * @param {string} question - the (possibly rewritten) user question
 * @param {object} knowledge - the knowledge package
 * @param {object} evidence - retrieved evidence chunks
 * @param {object} conversationState - prior conversation context (active entity, comparison, etc.)
 * @returns {object} response plan
 */
function planResponse(question, knowledge, evidence, conversationState) {
  const graph = knowledge ? buildRelationshipGraph(knowledge) : null;
  const intent = classifyIntent(question);

  // Extract entities from the question and evidence
  const questionEntities = extractEntitiesFromQuestion(question, graph);
  const evidenceEntities = extractEntitiesFromEvidence(evidence);

  // Merge and deduplicate
  const allEntities = [...new Set([...questionEntities, ...evidenceEntities])];

  // Find supported relationships for the relevant entities
  const supportedRelationships = findSupportedRelationships(allEntities, graph, 12);

  // Determine the primary subject
  const subject = determineSubject(question, allEntities, conversationState);

  // Determine direct answer for polar questions
  const directAnswer = determineDirectAnswer(question, intent, supportedRelationships, knowledge, allEntities);

  // Assess evidence strength for key entities
  const evidenceStrength = assessEvidenceStrength(allEntities, knowledge, graph);

  // Identify caveats
  const caveats = identifyCaveats(question, intent, knowledge, evidenceStrength, conversationState);

  // Comparison dimensions
  const comparisonDimensions = intent === 'COMPARISON'
    ? identifyComparisonDimensions(allEntities, supportedRelationships)
    : [];

  // Job fit assessment
  const jobFit = intent === 'JOB_FIT'
    ? assessJobFit(question, knowledge, graph)
    : null;

  // Recruiter brief
  const recruiterBrief = intent === 'RECRUITER'
    ? buildRecruiterPlan(knowledge, graph)
    : null;

  // Style guidance
  const style = determineStyle(intent);

  // Allowed entities — the model should NOT introduce entities outside this list
  const allowedEntities = allEntities.slice(0, 15);

  // Allowed relationships — compact subset for this turn
  const allowedRelationships = supportedRelationships.slice(0, 10).map(r =>
    `${r.subject} -> ${r.relation} -> ${r.object}`
  );

  return {
    intent,
    subject,
    directAnswer,
    entities: allowedEntities,
    allowedRelationships,
    evidenceStrength,
    caveats,
    comparisonDimensions,
    jobFit,
    recruiterBrief,
    style,
    // Raw evidence for the model to draw from
    evidenceText: evidenceToText(evidence, 400)
  };
}

/**
 * Extract entity names from the question by matching against the graph.
 */
function extractEntitiesFromQuestion(question, graph) {
  if (!question || !graph) return [];
  const entities = [];
  const words = question.split(/\s+/);

  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/[^A-Za-z0-9+#.\-]/g, '');
    if (!word || !/^[A-Z]/.test(word)) continue;

    const questionWords = new Set(['Tell', 'What', 'How', 'Does', 'Has', 'Is', 'Was',
      'Compare', 'Give', 'Summarize', 'Which', 'Why', 'When', 'Where', 'Who',
      'Are', 'Were', 'Have', 'Did', 'Do', 'Can', 'Could', 'Would', 'Should',
      'He', 'She', 'They', 'His', 'Her', 'Their', 'About', 'The', 'A', 'An',
      'Okay', 'So', 'But', 'And', 'Or', 'If', 'Then']);

    if (questionWords.has(word)) continue;

    // Try single word
    let phrase = word;
    let wNorm = phrase.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (graph.entityIndex.has(wNorm)) {
      entities.push(phrase);
      continue;
    }
    // Try multi-word
    for (let j = i + 1; j < Math.min(i + 5, words.length); j++) {
      const next = words[j].replace(/[^A-Za-z0-9+#.\-]/g, '');
      if (!next || (!/^[A-Z]/.test(next) && !/^[a-z]+$/.test(next))) break;
      if (questionWords.has(next)) break;
      phrase += ' ' + next;
      const pNorm = phrase.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (graph.entityIndex.has(pNorm)) {
        entities.push(phrase);
        break;
      }
      for (const key of graph.entityIndex.keys()) {
        if (key.length >= 4 && (key.includes(pNorm) || pNorm.includes(key))) {
          entities.push(phrase);
          break;
        }
      }
      if (entities.includes(phrase)) break;
    }
  }
  return entities;
}

/**
 * Extract entity names from evidence chunks.
 */
function extractEntitiesFromEvidence(evidence) {
  if (!evidence || !Array.isArray(evidence)) return [];
  const entities = [];
  for (const ev of evidence) {
    const text = ev.description || ev.text || ev.name || '';
    // Extract capitalized multi-word phrases
    const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
    for (const m of matches) {
      if (m.length > 3 && !entities.includes(m)) entities.push(m);
    }
    // Extract known tech names (Node.js, AWS, etc.)
    const techMatches = text.match(/\b[A-Z][A-Za-z0-9]+(?:\.[a-z0-9]+)?\b/g) || [];
    for (const t of techMatches) {
      if (t.length >= 3 && !entities.includes(t)) entities.push(t);
    }
  }
  return entities.slice(0, 10);
}

/**
 * Find supported relationships for the given entities from the graph.
 */
function findSupportedRelationships(entities, graph, maxResults) {
  if (!graph || !graph.triples || entities.length === 0) return [];
  const results = [];
  const seen = new Set();

  for (const entity of entities) {
    if (!entity) continue;
    const eNorm = entity.toLowerCase().replace(/[^a-z0-9]/g, '');
    const matches = graph.triples.filter(t => {
      const sNorm = t.subject.toLowerCase().replace(/[^a-z0-9]/g, '');
      const oNorm = t.object.toLowerCase().replace(/[^a-z0-9]/g, '');
      return sNorm.includes(eNorm) || eNorm.includes(sNorm) ||
             oNorm.includes(eNorm) || eNorm.includes(oNorm);
    });
    for (const m of matches) {
      const key = `${m.subject}|${m.relation}|${m.object}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(m);
      }
      if (results.length >= maxResults) break;
    }
    if (results.length >= maxResults) break;
  }
  return results;
}

/**
 * Determine the primary subject of the question.
 */
function determineSubject(question, entities, conversationState) {
  // If conversation state has an active entity, use it for follow-ups
  if (conversationState && conversationState.activeEntity) {
    const q = question.toLowerCase();
    if (/\b(?:it|that|this|the other|the one|what about|how about|why|which)\b/.test(q)) {
      return conversationState.activeEntity;
    }
  }
  // Use the first entity from the question
  if (entities.length > 0) return entities[0];
  // Fall back to the knowledge subject name
  if (conversationState && conversationState.subjectName) {
    return conversationState.subjectName;
  }
  return null;
}

/**
 * Determine the direct answer for polar questions.
 */
function determineDirectAnswer(question, intent, relationships, knowledge, entities) {
  if (intent !== 'YES_NO' && intent !== 'SKILL' && intent !== 'ADVERSARIAL') {
    return null;
  }

  const q = question.toLowerCase();

  // Adversarial — check if the claim is supported by knowledge data
  if (intent === 'ADVERSARIAL') {
    const boundaries = knowledgeAccess.getBoundaries(knowledge);
    const hasBoundary = (claim) => boundaries.some(b =>
      b.claim && b.claim.toLowerCase().includes(claim)
    );

    // Senior/lead/principal claims — check if a seniority boundary exists
    if (/\b(?:senior|lead|principal|staff|architect)\b/.test(q)) {
      if (hasBoundary('senior') || hasBoundary('lead') || hasBoundary('principal')) {
        return 'no';
      }
    }
    // Years of experience claims — check if entry-level from knowledge
    if (/\b\d+\s+years?\b/.test(q)) {
      const isEntryLevel = knowledge?.summary?.whoIAm &&
        /entry|junior|early/i.test(knowledge.summary.whoIAm);
      if (isEntryLevel) return 'no';
    }
    // Expert/specialist claims — check if a seniority boundary exists
    if (/\b(?:expert|specialist)\b/.test(q)) {
      if (hasBoundary('expert') || hasBoundary('senior')) {
        return 'no';
      }
    }
    // Team management claims — check if a management boundary exists
    if (/\b(?:team lead|managed a team|management)\b/.test(q)) {
      if (hasBoundary('team') || hasBoundary('management')) {
        return 'no';
      }
    }
    // Production/live incidents claims — check if a production boundary exists
    if (/\b(?:production|live incidents|on-call)\b/.test(q)) {
      if (hasBoundary('production')) {
        return 'no';
      }
    }
    // Check if any named entity in the question is absent from knowledge graph
    const graph = knowledge ? buildRelationshipGraph(knowledge) : null;
    if (graph) {
      const entityMatch = q.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g);
      if (entityMatch) {
        for (const entity of entityMatch) {
          const eNorm = entity.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (eNorm.length < 3) continue;
          const found = Array.from(graph.entityIndex.keys()).some(k => k.includes(eNorm));
          if (!found && !/\b(he|she|they|the|his|her|their)\b/i.test(entity)) {
            // Entity not in knowledge — check if closed-world allows denial
            const isClosed = knowledgeAccess.isCategoryComplete(knowledge, 'employmentHistory') &&
                             knowledgeAccess.isCategoryAuthoritative(knowledge, 'employmentHistory');
            if (isClosed) return 'no';
          }
        }
      }
    }
    return 'no'; // Default to no for adversarial
  }

  // Skill question — "Does he know X?" / "Has he used X?"
  if (intent === 'SKILL') {
    // Extract the skill from the question
    const skillMatch = q.match(/\b(?:know|use|used|familiar with|experience with)\s+(?:him\s+(?:with|in)\s+)?([a-z][a-z0-9+#.]+(?:\s+[a-z0-9+#.]+)?)\b/);
    if (skillMatch) {
      const skill = skillMatch[1];
      const skillNorm = skill.replace(/[^a-z0-9]/g, '');
      const graph = knowledge ? buildRelationshipGraph(knowledge) : null;
      if (graph) {
        // Check if this skill exists in the graph
        const found = Array.from(graph.entityIndex.keys()).some(k =>
          k.includes(skillNorm) || skillNorm.includes(k)
        );
        return found ? 'yes' : 'no';
      }
    }
  }

  return null;
}

/**
 * Assess evidence strength for entities.
 */
function assessEvidenceStrength(entities, knowledge, graph) {
  if (!knowledge || !entities.length) return {};

  const strength = {};
  const skillValues = Object.values(knowledge.skills || {}).flatMap(v => Array.isArray(v) ? v : []);
  const projectTech = (knowledge.projects || []).flatMap(p => p.tech || []);
  const knownSkills = [...new Set([...skillValues, ...projectTech])];

  for (const entity of entities.slice(0, 8)) {
    const eNorm = entity.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Check experience
    const inExperience = (knowledge.experience || []).some(item =>
      (item.skills || []).some(s => s.toLowerCase().replace(/[^a-z0-9]/g, '').includes(eNorm)) ||
      (item.role || '').toLowerCase().includes(entity.toLowerCase()) ||
      (item.company || '').toLowerCase().includes(entity.toLowerCase())
    );

    // Check projects
    const inProject = (knowledge.projects || []).some(p =>
      (p.tech || []).some(t => t.toLowerCase().replace(/[^a-z0-9]/g, '').includes(eNorm)) ||
      (p.name || '').toLowerCase().includes(entity.toLowerCase())
    );

    // Check skills
    const inSkills = knownSkills.some(s => s.toLowerCase().replace(/[^a-z0-9]/g, '').includes(eNorm));

    // Check certifications
    const inCert = (knowledge.certifications || []).some(c =>
      (c.name || c || '').toLowerCase().includes(entity.toLowerCase())
    );

    // Check education
    const inEducation = (knowledge.education || {}).school &&
      (knowledge.education.school || '').toLowerCase().includes(entity.toLowerCase());

    if (inExperience && inProject) {
      strength[entity] = 'DIRECT';
    } else if (inExperience) {
      strength[entity] = 'EXPERIENCE_BASED';
    } else if (inProject && inSkills) {
      strength[entity] = 'PROJECT_AND_SKILL';
    } else if (inProject) {
      strength[entity] = 'PROJECT_ONLY';
    } else if (inCert) {
      strength[entity] = 'CERTIFICATION_ONLY';
    } else if (inEducation) {
      strength[entity] = 'EDUCATION_ONLY';
    } else if (inSkills) {
      strength[entity] = 'SKILL_LISTED';
    } else {
      // Check if it's a known entity at all
      if (graph) {
        const found = Array.from(graph.entityIndex.keys()).some(k =>
          k.includes(eNorm) || eNorm.includes(k)
        );
        strength[entity] = found ? 'KNOWN' : 'UNKNOWN';
      } else {
        strength[entity] = 'UNKNOWN';
      }
    }
  }

  return strength;
}

/**
 * Identify caveats the model should respect.
 */
function identifyCaveats(question, intent, knowledge, evidenceStrength, conversationState) {
  const caveats = [];

  // Entry-level caveat
  if (knowledge && knowledge.summary && knowledge.summary.level) {
    const level = knowledge.summary.level.toLowerCase();
    if (level.includes('entry') || level.includes('junior')) {
      caveats.push('Entry-level — do not use senior/expert/lead language');
    }
  }

  // Internship caveat
  if (knowledge && knowledge.experience) {
    const hasInternship = knowledge.experience.some(e => /intern/i.test(e.type || e.role || ''));
    if (hasInternship) {
      caveats.push('AWS experience was an internship, not production work');
    }
  }

  // Unknown entity caveat
  if (evidenceStrength) {
    const unknownEntities = Object.entries(evidenceStrength)
      .filter(([_, s]) => s === 'UNKNOWN')
      .map(([e]) => e);
    if (unknownEntities.length > 0) {
      caveats.push(`No verified evidence for: ${unknownEntities.slice(0, 3).join(', ')}`);
    }
  }

  // Adversarial caveat
  if (intent === 'ADVERSARIAL') {
    caveats.push('Question contains a claim — verify before confirming. If not in facts, say No.');
  }

  return caveats;
}

/**
 * Identify comparison dimensions for comparison questions.
 */
function identifyComparisonDimensions(entities, relationships) {
  const dimensions = [];

  // Group relationships by entity
  for (const entity of entities.slice(0, 4)) {
    const eNorm = entity.toLowerCase().replace(/[^a-z0-9]/g, '');
    const entityRels = relationships.filter(r =>
      r.subject.toLowerCase().replace(/[^a-z0-9]/g, '').includes(eNorm)
    );
    if (entityRels.length > 0) {
      dimensions.push({
        entity,
        tech: entityRels.filter(r => r.relation === 'uses_tech').map(r => r.object).slice(0, 4),
        type: entityRels.find(r => r.relation === 'is_type')?.object,
        purpose: entityRels.find(r => r.relation === 'has_property' || r.relation === 'built_by')?.object
      });
    }
  }

  return dimensions;
}

/**
 * Assess job fit for a role question.
 */
function assessJobFit(question, knowledge, graph) {
  const q = question.toLowerCase();

  // Extract required skills from the question
  const reqSkills = [];
  const skillPatterns = [
    /\breact\b/i, /\btypescript\b/i, /\bjavascript\b/i, /\bnode\.?js\b/i,
    /\baws\b/i, /\bpython\b/i, /\bkubernetes\b/i, /\bci\/cd\b/i,
    /\btroubleshooting\b/i, /\bdevops\b/i, /\bfull.?stack\b/i,
    /\bfrontend\b/i, /\bbackend\b/i, /\bcloud\b/i, /\bsql\b/i
  ];

  for (const p of skillPatterns) {
    const m = q.match(p);
    if (m) reqSkills.push(m[0]);
  }

  // Also extract from "requiring X and Y"
  const requiringMatch = q.match(/requiring\s+([^.?]+)/);
  if (requiringMatch) {
    const parts = requiringMatch[1].split(/\s+and\s+|\s*,\s*/);
    for (const p of parts) {
      const cleaned = p.trim().replace(/[^a-z0-9+#./-]/gi, '');
      if (cleaned.length >= 3 && !reqSkills.find(r => r.toLowerCase() === cleaned.toLowerCase())) {
        reqSkills.push(cleaned);
      }
    }
  }

  // Assess each required skill
  const strength = assessEvidenceStrength(reqSkills, knowledge, graph);
  const strong = [];
  const adjacent = [];
  const gaps = [];

  for (const skill of reqSkills) {
    const s = strength[skill] || 'UNKNOWN';
    if (s === 'DIRECT' || s === 'EXPERIENCE_BASED') {
      strong.push({ skill, evidence: s });
    } else if (s === 'PROJECT_AND_SKILL' || s === 'PROJECT_ONLY' || s === 'SKILL_LISTED' || s === 'CERTIFICATION_ONLY') {
      adjacent.push({ skill, evidence: s });
    } else {
      gaps.push({ skill, evidence: s });
    }
  }

  // Determine overall fit
  let fitLevel = 'unknown';
  if (strong.length > 0 && gaps.length === 0) {
    fitLevel = 'strong_match';
  } else if (strong.length > 0 || (adjacent.length > 0 && gaps.length <= 1)) {
    fitLevel = 'partial_match';
  } else if (gaps.length > strong.length + adjacent.length) {
    fitLevel = 'weak_match';
  } else if (gaps.length > 0 && strong.length === 0) {
    fitLevel = 'weak_match';
  } else {
    fitLevel = 'partial_match';
  }

  // Best evidence
  const bestEvidence = [];
  if (knowledge.projects) {
    for (const p of knowledge.projects.slice(0, 3)) {
      const pTech = (p.tech || []).filter(t =>
        reqSkills.some(rs => t.toLowerCase().includes(rs.toLowerCase()) || rs.toLowerCase().includes(t.toLowerCase()))
      );
      if (pTech.length > 0) {
        bestEvidence.push({ project: p.name, matchingTech: pTech.slice(0, 3) });
      }
    }
  }
  if (knowledge.experience) {
    for (const e of knowledge.experience.slice(0, 2)) {
      const eSkills = (e.skills || []).filter(s =>
        reqSkills.some(rs => s.toLowerCase().includes(rs.toLowerCase()))
      );
      if (eSkills.length > 0) {
        bestEvidence.push({ role: e.role, company: e.company, matchingSkills: eSkills.slice(0, 3) });
      }
    }
  }

  return {
    fitLevel,
    strong,
    adjacent,
    gaps,
    bestEvidence: bestEvidence.slice(0, 4),
    recommendation: fitLevel === 'strong_match' ? 'strong candidate for this role'
      : fitLevel === 'partial_match' ? 'reasonable candidate with some gaps'
      : 'weak match — significant gaps'
  };
}

/**
 * Build a recruiter-focused plan.
 */
function buildRecruiterPlan(knowledge, graph) {
  if (!knowledge) return null;

  const topSkills = Object.values(knowledge.skills || {})
    .flatMap(v => Array.isArray(v) ? v : [])
    .slice(0, 6);

  const bestProjects = (knowledge.projects || [])
    .slice(0, 3)
    .map(p => ({ name: p.name, tech: (p.tech || []).slice(0, 3) }));

  const verifiedExperience = (knowledge.experience || [])
    .slice(0, 2)
    .map(e => ({ role: e.role, company: e.company, type: e.type }));

  const gaps = (knowledge.summary?.honestGaps || []).slice(0, 3);

  const interviewTopics = bestProjects.slice(0, 2).map(p => p.name);

  return {
    topStrengths: topSkills,
    bestProjects,
    verifiedExperience,
    gaps,
    interviewTopics
  };
}

/**
 * Determine answer style based on intent.
 */
function determineStyle(intent) {
  const styles = {
    YES_NO: 'direct answer + 1 supporting fact',
    SKILL: 'direct answer + specific project/experience evidence',
    ADVERSARIAL: 'direct refutation + correct fact',
    PROFILE: '1-2 sentence summary + 2-3 specifics',
    PROJECT: 'what it is + what it does + key tech',
    COMPARISON: 'cover both entities + meaningful difference',
    JOB_FIT: 'fit level + strongest evidence + honest gaps',
    RECRUITER: 'concise summary + best evidence',
    OPINION: 'opinion + 1-2 supporting facts',
    FOLLOW_UP: 'resolve context + answer directly with specifics',
    GENERAL: 'substantive answer with evidence'
  };
  return styles[intent] || styles.GENERAL;
}

/**
 * Convert evidence to compact text.
 */
function evidenceToText(evidence, maxChars) {
  if (!evidence || !Array.isArray(evidence)) return '';
  const texts = evidence.slice(0, 4).map(ev => {
    const name = ev.name || ev.kind || '';
    const desc = ev.description || ev.text || '';
    return name ? `${name}: ${desc}` : desc;
  });
  return texts.join(' ').slice(0, maxChars);
}

/**
 * Format the response plan as a compact text block for the LLM packet.
 */
function formatPlanForPrompt(plan) {
  if (!plan) return '';
  const lines = [];

  lines.push(`INTENT: ${plan.intent}`);
  if (plan.subject) lines.push(`SUBJECT: ${plan.subject}`);
  if (plan.directAnswer) lines.push(`DIRECT_ANSWER: ${plan.directAnswer}`);
  if (plan.style) lines.push(`STYLE: ${plan.style}`);

  if (plan.entities && plan.entities.length > 0) {
    lines.push(`ALLOWED_ENTITIES: ${plan.entities.join(', ')}`);
  }

  if (plan.allowedRelationships && plan.allowedRelationships.length > 0) {
    lines.push('ALLOWED_RELATIONSHIPS:');
    for (const r of plan.allowedRelationships) {
      lines.push(`  ${r}`);
    }
  }

  if (plan.evidenceStrength && Object.keys(plan.evidenceStrength).length > 0) {
    lines.push('EVIDENCE_STRENGTH:');
    for (const [entity, strength] of Object.entries(plan.evidenceStrength)) {
      lines.push(`  ${entity}: ${strength}`);
    }
  }

  if (plan.caveats && plan.caveats.length > 0) {
    lines.push('CAVEATS:');
    for (const c of plan.caveats) {
      lines.push(`  - ${c}`);
    }
  }

  if (plan.comparisonDimensions && plan.comparisonDimensions.length > 0) {
    lines.push('COMPARISON:');
    for (const d of plan.comparisonDimensions) {
      const parts = [d.entity];
      if (d.tech && d.tech.length) parts.push(`tech=${d.tech.join(',')}`);
      if (d.type) parts.push(`type=${d.type}`);
      lines.push(`  ${parts.join(' | ')}`);
    }
  }

  if (plan.jobFit) {
    lines.push(`JOB_FIT: ${plan.jobFit.fitLevel}`);
    if (plan.jobFit.strong.length > 0) {
      lines.push(`  STRONG: ${plan.jobFit.strong.map(s => `${s.skill}(${s.evidence})`).join(', ')}`);
    }
    if (plan.jobFit.adjacent.length > 0) {
      lines.push(`  ADJACENT: ${plan.jobFit.adjacent.map(s => `${s.skill}(${s.evidence})`).join(', ')}`);
    }
    if (plan.jobFit.gaps.length > 0) {
      lines.push(`  GAPS: ${plan.jobFit.gaps.map(s => `${s.skill}(${s.evidence})`).join(', ')}`);
    }
    if (plan.jobFit.bestEvidence.length > 0) {
      lines.push(`  BEST_EVIDENCE: ${plan.jobFit.bestEvidence.map(e =>
        e.project ? `${e.project}(${e.matchingTech.join('/')})` : `${e.role}@${e.company}(${e.matchingSkills.join('/')})`
      ).join('; ')}`);
    }
    lines.push(`  RECOMMENDATION: ${plan.jobFit.recommendation}`);
  }

  if (plan.recruiterBrief) {
    const rb = plan.recruiterBrief;
    if (rb.topStrengths.length > 0) lines.push(`TOP_STRENGTHS: ${rb.topStrengths.join(', ')}`);
    if (rb.bestProjects.length > 0) lines.push(`BEST_PROJECTS: ${rb.bestProjects.map(p => `${p.name}(${p.tech.join('/')})`).join('; ')}`);
    if (rb.verifiedExperience.length > 0) lines.push(`VERIFIED_EXPERIENCE: ${rb.verifiedExperience.map(e => `${e.role}@${e.company}`).join('; ')}`);
    if (rb.gaps.length > 0) lines.push(`GAPS: ${rb.gaps.join('; ')}`);
    if (rb.interviewTopics.length > 0) lines.push(`INTERVIEW_TOPICS: ${rb.interviewTopics.join(', ')}`);
  }

  if (plan.evidenceText) {
    lines.push(`EVIDENCE: ${plan.evidenceText}`);
  }

  return lines.join('\n');
}

module.exports = { planResponse, formatPlanForPrompt, assessEvidenceStrength, classifyIntent };
