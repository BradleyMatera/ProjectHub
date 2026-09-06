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

const { buildRelationshipGraph, checkRelationship, getEntityRelationships, assessEntityEvidence } = require('./relationship-graph');
const { normalizeEntity } = require('./canonical-entities');
const { classifyIntent } = require('./completeness-check');
const knowledgeAccess = require('./knowledge-access');
const { normalizeKnowledgeSkills } = require('./knowledge-entities');

function humanizeIdentifier(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function skillItemName(item) {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  return String(item.label || item.name || item.skill || item.title || '').trim();
}

function allSkillNames(knowledge) {
  return normalizeKnowledgeSkills(knowledge).map(skill => skill.name).filter(Boolean);
}

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

function assessRelationSupport({ graph, subject, target, requestedRelation } = {}) {
  const result = (support, supportingFacts = []) => ({
    support, supported: support === 'SUPPORTED', supportingFacts
  });
  if (!graph || !subject || !target || !requestedRelation) return result('UNKNOWN');
  const canonical = value => {
    const norm = normalizeEntity(value);
    if (graph.subjectAliases?.has(norm)) return graph.subjectNorm || normalizeEntity(graph.subjectName);
    return normalizeEntity(graph.aliasToCanonical?.get(norm) || value);
  };
  const subjectNorm = canonical(subject);
  const targetNorm = canonical(target);
  if (!subjectNorm || !targetNorm) return result('UNKNOWN');
  const triples = (graph.triples || []).filter(t =>
    (!t._conf || t._conf === 'high') && (!t.confidence || t.confidence === 'high'));
  const knowledge = ['knowledge', 'know', 'knows', 'has_skill', 'familiar_with'].includes(requestedRelation);
  const usage = ['usage', 'use', 'used', 'uses_tech'].includes(requestedRelation);
  const usageRelations = new Set(['uses_tech', 'uses_platform', 'built_with', 'deployed_at']);
  const directRelations = knowledge ? new Set(['has_skill', 'familiar_with'])
    : usage ? usageRelations : new Set([requestedRelation]);
  const outgoing = triples.filter(t => canonical(t.subject) === subjectNorm && canonical(t.object) === targetNorm);
  const direct = outgoing.filter(t => directRelations.has(t.relation));
  if (direct.length) return result('SUPPORTED', direct);
  if (!knowledge && !usage) return result('UNKNOWN');
  const gap = outgoing.filter(t => t.relation === 'has_gap');
  if (gap.length) return result('GAP', gap);
  const projectFacts = triples.filter(t => usageRelations.has(t.relation) && canonical(t.object) === targetNorm &&
    triples.some(owner => owner.relation === 'built_by' && canonical(owner.subject) === canonical(t.subject) && canonical(owner.object) === subjectNorm));
  if (projectFacts.length) return result(usage ? 'SUPPORTED' : 'ADJACENT', projectFacts);
  const adjacent = outgoing.filter(t => ['has_cert', 'learning', 'building_on'].includes(t.relation) ||
    (knowledge && usageRelations.has(t.relation)) || (usage && ['has_skill', 'familiar_with'].includes(t.relation)));
  return adjacent.length ? result('ADJACENT', adjacent) : result('UNKNOWN');
}

/**
 * Assess whether a requested facet (relation or property) of an active entity
 * is supported by the graph. Returns SUPPORTED with the actual triple(s) when
 * the relation/property exists; otherwise UNKNOWN with no facts.
 */
function assessFacetSupport({ graph, activeEntity, facet, facetRelation, requestedProperty } = {}) {
  if (!graph || !activeEntity) return { support: 'UNKNOWN', supportingFacts: [], requestedRelation: facetRelation, requestedProperty };
  const activeNorm = normalizeEntity(activeEntity);
  const f = String(facet || '').trim().toLowerCase();
  const prop = requestedProperty ? normalizeEntity(requestedProperty) : (f ? normalizeEntity(f) : null);
  const rel = facetRelation || 'has_property';
  const triples = getEntityRelationships(graph, activeEntity);
  const high = triples.filter(t => (!t._conf || t._conf === 'high') && (!t.confidence || t.confidence === 'high'));

  let found = [];
  if (rel === 'has_property' && prop) {
    found = high.filter(t =>
      t.relation === 'has_property' &&
      (normalizeEntity(t.meta?.property || '') === prop ||
       normalizeEntity(t.object || '') === prop ||
       normalizeEntity(humanizeKey(t.meta?.property || '')) === prop));
  } else {
    found = high.filter(t => t.relation === rel);
    if (!found.length && prop) {
      // Some relation aliases are stored as object labels on a generic relation.
      found = high.filter(t =>
        (t.relation === rel || t.relation === 'has_property') &&
        (normalizeEntity(t.object || '') === prop ||
         normalizeEntity(t.meta?.property || '') === prop));
    }
  }

  if (found.length) {
    return { support: 'SUPPORTED', supportingFacts: found.slice(0, 8), requestedRelation: rel, requestedProperty: prop };
  }
  return { support: 'UNKNOWN', supportingFacts: [], requestedRelation: rel, requestedProperty: prop };
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
  // Entity existence in the index is NOT proposition support: a has_gap edge
  // puts the entity in the graph without claiming the skill. Use relation
  // semantics: claiming edge -> yes; documented gap -> unknown; adjacent ->
  // unknown; nothing -> open-world null unless the skills category is an
  // authoritative closed world.
  if (intent === 'SKILL') {
    const skillMatch = q.match(/\b(know|use|used|familiar with|experience with)\s+(?:him\s+(?:with|in)\s+)?([a-z][a-z0-9+#.\- ]*?)\s*[?!.]*$/);
    if (skillMatch) {
      const skill = skillMatch[2].trim();
      const graph = knowledge ? buildRelationshipGraph(knowledge) : null;
      if (graph) {
        const namedSubject = q.match(/^(?:does|do|has|have|is|are)\s+(.+?)\s+(?:know|use|used|familiar with|experience with)\b/);
        const subject = namedSubject && !/^(?:he|she|they|the subject)$/.test(namedSubject[1])
          ? namedSubject[1] : graph.subjectName;
        const a = assessRelationSupport({ graph, subject, target: skill,
          requestedRelation: /^(?:use|used|experience with)$/.test(skillMatch[1]) ? 'usage' : 'knowledge' });
        if (a.support === 'SUPPORTED') return 'yes';
        if (a.support === 'GAP' || a.support === 'ADJACENT') return 'unknown';
        const closed = knowledgeAccess.isCategoryComplete(knowledge, 'skills') &&
                       knowledgeAccess.isCategoryAuthoritative(knowledge, 'skills');
        return closed ? 'no' : null;
      }
    }
  }

  return null;
}

/**
 * Assess evidence strength for entities.
 */
// Legacy planner labels mapped FROM canonical graph relationships — the
// graph is the single raw-fact source; this function interprets, it does not
// rediscover truth by substring-scanning the knowledge object.
const PLANNER_REL_CLASSES = {
  experience: new Set(['worked_at', 'interned_at', 'employed_as', 'employed_at', 'founder_of', 'company_behind', 'built_by']),
  project: new Set(['uses_tech', 'uses_platform', 'deployed_at', 'published_on', 'built_with']),
  cert: new Set(['has_cert']),
  education: new Set(['has_degree', 'attended']),
  skill: new Set(['has_skill', 'familiar_with', 'learning', 'building_on'])
};

function assessEvidenceStrength(entities, knowledge, graph) {
  if (!entities.length) return {};
  const g = graph || (knowledge ? buildRelationshipGraph(knowledge) : null);
  const strength = {};

  for (const entity of entities.slice(0, 8)) {
    if (!g) { strength[entity] = 'UNKNOWN'; continue; }
    const a = assessEntityEvidence(g, entity);
    // Only high-confidence edges carry factual weight — fuzzy context never
    // promotes a label.
    const rels = new Set([...a.positive, ...a.adjacent, ...a.gap]
      .filter(t => t._conf === 'high').map(t => t.relation));
    const has = (set) => [...rels].some(r => set.has(r));
    const exp = has(PLANNER_REL_CLASSES.experience);
    const proj = has(PLANNER_REL_CLASSES.project);
    const skill = has(PLANNER_REL_CLASSES.skill);
    const cert = has(PLANNER_REL_CLASSES.cert);
    const edu = has(PLANNER_REL_CLASSES.education);
    const gap = a.status === 'GAP';

    if (exp && proj) strength[entity] = 'DIRECT';
    else if (exp) strength[entity] = 'EXPERIENCE_BASED';
    else if (proj && skill) strength[entity] = 'PROJECT_AND_SKILL';
    else if (proj) strength[entity] = 'PROJECT_ONLY';
    else if (cert) strength[entity] = 'CERTIFICATION_ONLY';
    else if (edu) strength[entity] = 'EDUCATION_ONLY';
    else if (skill) strength[entity] = 'SKILL_LISTED';
    else if (gap) strength[entity] = 'GAP';
    else strength[entity] = a.mentioned ? 'KNOWN' : 'UNKNOWN';
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
// --- Requested-dimension support ---------------------------------------------
// "Entity is known" and "the requested comparison proposition is supported"
// are different axes. A set of known products can still have zero evidence
// for the dimension the user asked about ("which is lightest?" needs weight).
// This interprets raw graph relationships for the CURRENT question — the
// graph itself stays domain-neutral fact infrastructure.

// Domain-neutral physical/commercial property stems — what a comparison can
// ask ABOUT on any tenant (products, plans, vehicles, services...).
const DIMENSION_STEMS = {
  light: 'weight', heavy: 'weight',
  cheap: 'price', expensive: 'price', cost: 'price', price: 'price', pricier: 'price',
  new: 'recency', recent: 'recency', latest: 'recency', newest: 'recency', old: 'age', older: 'age',
  fast: 'speed', quick: 'speed', slow: 'speed',
  big: 'size', large: 'size', small: 'size', long: 'duration', short: 'duration',
  popular: 'popularity', easy: 'ease', hard: 'difficulty', simple: 'ease', complex: 'difficulty'
};

// Evaluative words mean "synthesize from member profiles" — an assessment,
// never a stored ranking.
const EVALUATIVE_WORDS = /\b(?:best|better|worst|strongest|weakest|favou?rite|most suitable|ideal|right one|better fit)\b/i;

function humanizeKey(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

function coverageOf(memberSupport) {
  const vals = Object.values(memberSupport || {});
  if (!vals.length) return 'UNKNOWN';
  const ok = vals.filter(v => v === 'SUPPORTED').length;
  return ok === vals.length ? 'FULL' : ok > 0 ? 'PARTIAL' : 'UNKNOWN';
}

/**
 * Assess whether the REQUESTED comparison dimension has support for the
 * given members — independent of whether the members themselves are known.
 *
 * Coverage is three-valued: FULL (every member has comparable dimension
 * evidence), PARTIAL (some do — state the verified side, qualify the rest,
 * never declare a winner over unknown members), UNKNOWN (no usable evidence).
 *
 * Dimensions are schema-first: tenant-declared property keys (has_property
 * meta.property, humanized) are matched against the question before the
 * small linguistic alias map is consulted.
 *
 * @returns {{dimension:string|null, dimensionKind:'relation'|'property'|'assessment',
 *            memberSupport:Object|null, support:'FULL'|'PARTIAL'|'SUPPORTED'|'UNKNOWN',
 *            supportingFacts:Array}}
 */
function assessComparisonSupport(question, members, graph) {
  const q = String(question || '').toLowerCase();
  const memberList = Array.isArray(members) ? members : [];

  // Relation dimension: "which of those used X / runs on X / built with X".
  // Multi-word targets are preserved; "A and B" splits into sub-targets.
  const rel = q.match(/\b(?:used?|uses|using|built with|written in|runs? on|deployed (?:on|at|to)|made (?:of|with|from)|powered by)\s+([a-z0-9+#.\- ]{2,60}?)\s*[?!.,]*$/i);
  if (rel && rel[1]) {
    const targets = rel[1].split(/\s+and\s+|\s*,\s*|\s+or\s+/i).map(s => s.trim()).filter(Boolean);
    const memberSupport = {};
    const supportingFacts = [];
    for (const m of memberList) {
      const matched = targets.map(t =>
        ['uses_tech', 'deployed_at', 'has_property', 'made_of']
          .some(r => graph && checkRelationship(graph, m, r, t).supported));
      memberSupport[m] = matched.every(Boolean) && targets.length ? 'SUPPORTED' : 'UNKNOWN';
      if (memberSupport[m] === 'SUPPORTED' && graph) {
        for (const t of getEntityRelationships(graph, m)) {
          if (targets.some(x => t.objectNorm === normalizeEntity(x) || t.objectNorm.includes(normalizeEntity(x)))) {
            supportingFacts.push({ member: m, relation: t.relation, object: t.object });
          }
        }
      }
    }
    return {
      dimension: targets.join(' and '), dimensionKind: 'relation', memberSupport,
      supportingFacts: supportingFacts.slice(0, 8),
      support: coverageOf(memberSupport)
    };
  }

  // Schema-first property dimension: collect tenant-declared property keys
  // from the compared entities' has_property edges and match the question
  // against the humanized key before falling back to linguistic aliases.
  const propertyKeys = new Map(); // normalized key -> raw key
  if (graph) {
    const memberNorms = new Set(memberList.map(m => normalizeEntity(graph.aliasToCanonical?.get(normalizeEntity(m)) || m)));
    for (const t of (graph.triples || [])) {
      if (t.relation === 'has_property' && t.meta?.property && memberNorms.has(normalizeEntity(t.subject))) {
        const raw = String(t.meta.property);
        propertyKeys.set(normalizeEntity(raw), raw);
        propertyKeys.set(normalizeEntity(humanizeKey(raw)), raw);
      }
    }
  }
  const qNorm = normalizeEntity(q);
  let schemaKey = null;
  for (const [kn, raw] of propertyKeys) {
    if (kn.length >= 3 && qNorm.includes(kn)) { schemaKey = raw; break; }
    // "battery life" question -> 'batterylife' key; also key-prefix hits like
    // "warranty" -> 'warrantyYears'
    if (kn.length >= 6) {
      for (const w of q.split(/[^a-z0-9]+/).filter(w => w.length >= 4)) {
        if (kn.startsWith(w) || kn.endsWith(w)) { schemaKey = raw; break; }
      }
      if (schemaKey) break;
    }
  }

  // Property dimension: superlative/comparative over a measurable attribute.
  let stem = null;
  const mostLeast = q.match(/\b(?:most|least)\s+([a-z]+)/i);
  if (mostLeast && !/^(?:suitable|likely|important|recent)$/.test(mostLeast[1])) {
    stem = mostLeast[1];
  } else {
    const m = q.match(/\b([a-z]{3,}?)(?:er|est)\b/i);
    if (m) {
      stem = m[1];
      if (stem.endsWith('i')) stem = stem.slice(0, -1) + 'y';   // 'easi' -> 'easy'
      else if (/(.)\1$/.test(stem)) stem = stem.slice(0, -1);   // 'bigg' -> 'big', 'bett' -> 'bet'
    }
  }

  // Dimension resolution order:
  //  1. tenant-declared property keys (schema-first — arbitrary keys work)
  //  2. explicit "<modifier> <noun phrase>" — a named property; resolves to a
  //     schema key by containment, else stays a named-but-unsupported property
  //  3. comparative/superlative stem via the small linguistic alias map
  //  4. evaluative stems -> assessment (synthesized from member profiles)
  const GENERIC_DIM_WORDS = new Set(['fit', 'one', 'option', 'choice', 'pick', 'candidate', 'deal', 'overall', 'thing']);
  const EVALUATIVE_STEMS = new Set(['strong', 'weak', 'good', 'great', 'bet', 'smart', 'wise', 'suit', 'prefer', 'nice', 'bad']);
  const propPhrase = q.match(/\b(?:more|less|better|worse|higher|lower|longer|shorter|bigger|smaller|faster|slower|cheaper|stronger|weaker|easier|harder|most|least)\s+([a-z][a-z0-9 ]{1,30}?)\s*[?!.,]*$/i);

  let dimKey = schemaKey || null;
  if (!dimKey) {
    const phrase = propPhrase ? propPhrase[1].trim() : null;
    const phraseNorm = phrase ? normalizeEntity(phrase) : '';
    if (phrase && !GENERIC_DIM_WORDS.has(phraseNorm) && phraseNorm.length >= 3) {
      for (const [kn, raw] of propertyKeys) {
        if (phraseNorm.includes(kn) || kn.includes(phraseNorm)) { dimKey = raw; break; }
      }
      if (!dimKey) dimKey = phrase; // named but unsupported property
    } else if (stem && DIMENSION_STEMS[stem]) {
      dimKey = DIMENSION_STEMS[stem];
      const candidates = dimKey === 'speed' ? ['speed', 'duration'] : [dimKey];
      dimKey = candidates.map(key => propertyKeys.get(key)).find(Boolean) || dimKey;
    } else if (stem && !EVALUATIVE_STEMS.has(stem) && !EVALUATIVE_WORDS.test(q)) {
      dimKey = stem; // arbitrary comparative adjective — a named dimension
    }
  }

  if (!dimKey) {
    // Assessment dimension: supported when at least one member has any
    // knowledge profile to reason over; otherwise honestly UNKNOWN.
    const hasBasis = !graph || memberList.some(m => {
      const a = assessEntityEvidence(graph, m);
      return a.status !== 'UNKNOWN';
    });
    return {
      dimension: stem || 'overall', dimensionKind: 'assessment', memberSupport: null,
      supportingFacts: [],
      support: (!graph || memberList.length === 0 || hasBasis) ? 'SUPPORTED' : 'UNKNOWN'
    };
  }

  const dimNorm = normalizeEntity(dimKey);
  const stemNorm = stem ? normalizeEntity(stem) : '';
  const memberSupport = {};
  const supportingFacts = [];
  for (const m of memberList) {
    const triples = graph ? getEntityRelationships(graph, m) : [];
    const propTriple = triples.find(t =>
      t.relation === 'has_property' &&
      (normalizeEntity(t.meta?.property || '') === dimNorm ||
       normalizeEntity(t.meta?.property || '') === stemNorm ||
       t.objectNorm === dimNorm || t.objectNorm === stemNorm));
    const advTriple = propTriple ? null : triples.find(t =>
      t.relation === 'comparative_advantage' &&
      (String(t.object || '').toLowerCase().includes(stem || dimKey) ||
       String(t.object || '').toLowerCase().includes(dimKey)));
    memberSupport[m] = (propTriple || advTriple) ? 'SUPPORTED' : 'UNKNOWN';
    if (propTriple) supportingFacts.push({ member: m, relation: 'has_property', property: dimKey, object: propTriple.object, source: propTriple.source, meta: propTriple.meta });
    else if (advTriple) supportingFacts.push({ member: m, relation: 'comparative_advantage', object: advTriple.object, source: advTriple.source, meta: advTriple.meta });
  }
  return {
    dimension: dimKey, dimensionKind: 'property', memberSupport,
    supportingFacts: supportingFacts.slice(0, 8),
    support: coverageOf(memberSupport)
  };
}

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
  const q = String(question || '').toLowerCase();
  const skillNames = allSkillNames(knowledge);
  const projectTech = (knowledge?.projects || []).flatMap(project => project.tech || []);
  const knownSkills = [...new Set([...skillNames, ...projectTech].filter(Boolean))];

  const explicitMatch = q.match(/\b(?:requiring|requires?|require|needs?|must\s+have)\s+(.+?)(?:[?.]|$)/i);
  const explicitRequirements = explicitMatch
    ? explicitMatch[1].split(/\s+and\s+|\s*,\s*|\s*\/\s*/).map(v => v.trim()).filter(v => v.length >= 2)
    : [];

  const roleMatch = q.match(/\b(?:fit\s+(?:for|as)\s+(?:a|an)?\s*|(?:a|an)\s+)([a-z0-9+#./ -]+?)(?:\s+(?:role|position|job)\b|\?|$)/i);
  const roleText = roleMatch ? roleMatch[1] : q;
  const roleTokens = roleText
    .replace(/\b(?:junior|senior|lead|staff|principal|developer|engineer|software|role|position|job|fit|candidate)\b/g, ' ')
    .split(/[^a-z0-9+#.-]+/)
    .filter(token => token.length >= 3);

  const roleEvidence = [];
  for (const [group, values] of Object.entries(knowledge?.skills || {})) {
    if (!Array.isArray(values)) continue;
    const groupLabel = humanizeIdentifier(group).toLowerCase();
    if (roleTokens.some(token => groupLabel.includes(token) || token.includes(groupLabel))) {
      for (const item of values) {
        const name = skillItemName(item);
        if (name && !roleEvidence.includes(name)) roleEvidence.push(name);
      }
    }
  }
  for (const project of knowledge?.projects || []) {
    const corpus = `${project.category || ''} ${project.description || ''} ${project.impact || ''}`.toLowerCase();
    if (roleTokens.some(token => corpus.includes(token))) {
      for (const tech of project.tech || []) if (tech && !roleEvidence.includes(tech)) roleEvidence.push(tech);
    }
  }

  const strength = assessEvidenceStrength(explicitRequirements, knowledge, graph);
  const strong = [];
  const adjacent = [];
  const gaps = [];
  for (const requirement of explicitRequirements) {
    const s = strength[requirement] || 'UNKNOWN';
    if (s === 'DIRECT' || s === 'EXPERIENCE_BASED') strong.push({ skill: requirement, evidence: s });
    else if (['PROJECT_AND_SKILL', 'PROJECT_ONLY', 'SKILL_LISTED', 'CERTIFICATION_ONLY'].includes(s)) adjacent.push({ skill: requirement, evidence: s });
    else if (s === 'GAP') gaps.push({ skill: requirement, evidence: 'GAP', detail: 'Documented gap or learning area — not claimed experience' });
    else gaps.push({ skill: requirement, evidence: 'UNKNOWN', detail: 'No verified evidence for this explicit requirement' });
  }

  let fitLevel = 'unknown';
  if (explicitRequirements.length > 0) {
    if (gaps.length === 0 && (strong.length + adjacent.length) === explicitRequirements.length) fitLevel = strong.length ? 'strong_match' : 'partial_match';
    else if (strong.length + adjacent.length > 0) fitLevel = 'partial_match';
  } else if (roleEvidence.length > 0) {
    fitLevel = 'partial_match';
  }

  const bestEvidence = [];
  for (const project of knowledge?.projects || []) {
    const matchingTech = (project.tech || []).filter(tech => roleEvidence.some(signal => String(signal).toLowerCase() === String(tech).toLowerCase()));
    if (matchingTech.length) bestEvidence.push({ project: project.name, matchingTech: matchingTech.slice(0, 5) });
  }

  return {
    fitLevel,
    strong,
    adjacent: [...adjacent, ...roleEvidence.slice(0, 8).map(skill => ({ skill, evidence: 'ROLE_DOMAIN_SIGNAL' }))],
    gaps,
    bestEvidence: bestEvidence.slice(0, 4),
    recommendation: fitLevel === 'strong_match'
      ? 'strong evidence match for the supplied requirements'
      : fitLevel === 'partial_match'
        ? 'verified evidence overlaps the role; unspecified requirements remain unknown'
        : 'role requirements are underspecified or not established by verified evidence'
  };
}

/**
 * Build a recruiter-focused plan.
 */
function buildRecruiterPlan(knowledge, graph) {
  if (!knowledge) return null;

  const topSkills = allSkillNames(knowledge).slice(0, 6);

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

module.exports = { planResponse, formatPlanForPrompt, assessEvidenceStrength, classifyIntent, assessComparisonSupport, assessRelationSupport, assessFacetSupport };
