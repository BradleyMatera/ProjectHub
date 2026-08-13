'use strict';

/**
 * Relationship Graph — generic, domain-neutral fact relationship system.
 *
 * Builds a graph of (subject, relation, object) triples from ANY knowledge
 * package that follows the standard schema (projects, experience, education,
 * certifications, skills). The graph preserves provenance so that downstream
 * validation can check whether a SPECIFIC RELATIONSHIP is supported, not just
 * whether the individual entities exist.
 *
 * This is the foundation for relationship-aware grounding. It prevents the
 * model from recombining unrelated true facts into false claims:
 *
 *   ProjectHub exists. Amazon exists.            → supported entities
 *   ProjectHub was built at Amazon.              → UNSUPPORTED relationship
 *
 *   AWS capstone exists. React exists.           → supported entities
 *   AWS capstone used React.                     → UNSUPPORTED relationship
 *
 * The graph is derived entirely from the knowledge data structure. No
 * domain-specific hardcoding. The same code works for a tire shop
 * (Michelin Defender → has_warranty → 80k miles), a restaurant
 * (Burger A → contains_peanuts → false), or a SaaS product
 * (Basic Plan → max_users → 5).
 *
 * Relation classes (semantic, normalized):
 *   uses_tech       — project uses a technology
 *   built_by        — project was built by a person/entity
 *   worked_at       — person worked at a company (any capacity)
 *   interned_at     — person interned at a company (subset of worked_at)
 *   employed_as     — person held a specific role at a company
 *   has_degree      — person holds a degree from a school
 *   has_cert        — person holds a certification
 *   has_skill       — person has a listed skill
 *   is_type         — entity is of a certain type (project, internship, etc.)
 *   has_property    — entity has a named property (price, warranty, etc.)
 *   built_during    — project was built during a time period/event
 *   deployed_at     — project is deployed at a location/platform
 *
 * Provenance: each triple records its source path in the knowledge file
 * (e.g., "projects[5].tech", "experience[0].skills") so validation can
 * explain WHY a relationship is or is not supported.
 */

const { normalizeEntity } = require('./canonical-entities');

/**
 * Build the relationship graph from a knowledge object.
 * Returns { triples, entityIndex, relationIndex }
 *
 * triples:      Array of { subject, relation, object, source, meta }
 * entityIndex:  Map of normalized entity → list of triples involving it
 * relationIndex: Map of "subject|relation" → list of matching triples
 */
function buildRelationshipGraph(knowledge) {
  const k = knowledge || {};
  const triples = [];
  const subjectName = k.identity?.name || k.agent?.subjectName || 'the subject';
  const subjectNorm = normalizeEntity(subjectName);
  const subjectAliases = new Set([subjectNorm, normalizeEntity(k.identity?.preferredName || '')].filter(Boolean));

  const add = (subject, relation, object, source, meta) => {
    if (!subject || !object) return;
    triples.push({
      subject: String(subject),
      subjectNorm: normalizeEntity(subject),
      relation,
      object: String(object),
      objectNorm: normalizeEntity(object),
      source: source || 'unknown',
      meta: meta || {}
    });
  };

  // --- Person → has_skill (from skills section) ---
  if (k.skills && typeof k.skills === 'object') {
    for (const [group, values] of Object.entries(k.skills)) {
      if (!Array.isArray(values)) continue;
      for (const skill of values) {
        if (typeof skill === 'string' && skill.trim()) {
          add(subjectName, 'has_skill', skill, `skills.${group}`, { group });
        }
      }
    }
  }

  // --- Projects → uses_tech, is_type, built_by, deployed_at ---
  if (Array.isArray(k.projects)) {
    for (let i = 0; i < k.projects.length; i++) {
      const p = k.projects[i];
      const pname = p.name || p.title || '';
      if (!pname) continue;

      // project is_type category
      if (p.category) add(pname, 'is_type', p.category, `projects[${i}].category`);

      // Add project aliases as "is_alias_of" relationships and index them
      if (Array.isArray(p.aliases)) {
        for (const alias of p.aliases) {
          if (alias && typeof alias === 'string') {
            add(pname, 'has_alias', alias, `projects[${i}].aliases`);
          }
        }
      }

      // project uses_tech (each technology)
      if (Array.isArray(p.tech)) {
        for (const tech of p.tech) {
          if (tech && typeof tech === 'string') {
            add(pname, 'uses_tech', tech, `projects[${i}].tech`);
          }
        }
      }

      // project built_by subject (all projects are by the subject in this schema)
      add(pname, 'built_by', subjectName, `projects[${i}]`, { inferred: true });

      // project deployed_at (from URL)
      if (p.url) {
        let platform = 'unknown';
        if (p.url.includes('github.io')) platform = 'GitHub Pages';
        else if (p.url.includes('github.com')) platform = 'GitHub';
        else if (p.url.includes('itch.io')) platform = 'itch.io';
        if (platform !== 'unknown') {
          add(pname, 'deployed_at', platform, `projects[${i}].url`, { url: p.url });
        }
      }

      // project has_property type (if type field exists)
      if (p.type) add(pname, 'has_property', p.type, `projects[${i}].type`, { property: 'type' });
    }
  }

  // --- Person → worked_at, interned_at, employed_as, has_skill (from experience) ---
  if (Array.isArray(k.experience)) {
    for (let i = 0; i < k.experience.length; i++) {
      const e = k.experience[i];
      const company = e.company || e.organization || '';
      const role = e.role || e.title || '';
      const type = e.type || '';

      if (company) {
        // person worked_at company
        add(subjectName, 'worked_at', company, `experience[${i}].company`, { role, type, dates: e.dates });

        // person interned_at company (if type is internship)
        if (/intern/i.test(type)) {
          add(subjectName, 'interned_at', company, `experience[${i}].type`, { role, dates: e.dates });
        }

        // person employed_as role at company
        if (role) {
          add(subjectName, 'employed_as', role, `experience[${i}].role`, { company, type });
        }
      }

      // person has_skill (from experience skills)
      if (Array.isArray(e.skills)) {
        for (const skill of e.skills) {
          if (skill && typeof skill === 'string') {
            add(subjectName, 'has_skill', skill, `experience[${i}].skills`, { context: company });
          }
        }
      }
    }
  }

  // --- Person → has_degree (from education) ---
  if (k.education) {
    const edu = k.education;
    const degree = edu.degree || edu.degreeName || '';
    const school = edu.school || edu.institution || '';
    if (degree && school) {
      add(subjectName, 'has_degree', degree, `education.degree`, { school });
      add(subjectName, 'attended', school, `education.school`, { degree });
    } else if (degree) {
      add(subjectName, 'has_degree', degree, `education.degree`);
    } else if (school) {
      add(subjectName, 'attended', school, `education.school`);
    }
    // Index education properties (GPA, location, graduation date, etc.)
    if (edu.gpa) add(subjectName, 'has_property', `GPA ${edu.gpa}`, `education.gpa`, { property: 'gpa', value: edu.gpa });
    if (edu.location) add(subjectName, 'has_property', edu.location, `education.location`, { property: 'location' });
    if (edu.graduationDate) add(subjectName, 'has_property', edu.graduationDate, `education.graduationDate`, { property: 'graduationDate' });
    // Index relevant coursework as skills
    if (Array.isArray(edu.relevantCoursework)) {
      for (const course of edu.relevantCoursework) {
        if (course && typeof course === 'string') {
          add(subjectName, 'has_skill', course, `education.relevantCoursework`, { context: 'coursework' });
        }
      }
    }
  }

  // --- Person → has_cert (from certifications) ---
  if (Array.isArray(k.certifications)) {
    for (let i = 0; i < k.certifications.length; i++) {
      const c = k.certifications[i];
      const name = typeof c === 'string' ? c : (c.name || c.title || '');
      if (name) {
        add(subjectName, 'has_cert', name, `certifications[${i}]`, {
          code: c.code || null,
          issued: c.issued || null
        });
      }
    }
  }

  // --- Honest gaps / weaknesses → has_gap ---
  // These entities (DSA, Udemy, etc.) need to be in the graph so they're
  // not flagged as fabricated when the model mentions them.
  if (Array.isArray(k.summary?.honestGaps)) {
    for (const gap of k.summary.honestGaps) {
      if (typeof gap === 'string' && gap.trim()) {
        // Extract the gap name (before any period or explanation)
        const gapName = gap.split('.')[0].trim();
        if (gapName) {
          add(subjectName, 'has_gap', gapName, 'summary.honestGaps');
          // Also add any mentioned learning platforms (Udemy, Coursera, etc.)
          const platforms = gap.match(/\b(?:Udemy|Coursera|Pluralsight|LinkedIn Learning|Codecademy|freeCodeCamp)\b/gi) || [];
          for (const p of platforms) {
            add(subjectName, 'uses_platform', p, 'summary.honestGaps');
          }
        }
      }
    }
  }

  // --- Build indices ---
  const entityIndex = new Map();
  const relationIndex = new Map();
  const aliasToCanonical = new Map(); // alias norm → canonical name

  // First pass: collect aliases
  for (const t of triples) {
    if (t.relation === 'has_alias') {
      aliasToCanonical.set(t.objectNorm, t.subject);
    }
  }

  for (const t of triples) {
    // Index by subject and object (both directions for lookup)
    for (const key of [t.subjectNorm, t.objectNorm]) {
      if (!entityIndex.has(key)) entityIndex.set(key, []);
      entityIndex.get(key).push(t);
    }
    // Index by "subject|relation" for direct relationship lookup
    const relKey = `${t.subjectNorm}|${t.relation}`;
    if (!relationIndex.has(relKey)) relationIndex.set(relKey, []);
    relationIndex.get(relKey).push(t);

    // If this is an alias relationship, also index the alias as a subject
    // for all relationships of the canonical entity
    if (t.relation === 'has_alias') {
      const canonicalNorm = t.subjectNorm;
      const aliasNorm = t.objectNorm;
      aliasToCanonical.set(aliasNorm, t.subject);
      // Copy all of the canonical entity's relationships to the alias
      const canonicalRels = triples.filter(rt =>
        rt.subjectNorm === canonicalNorm && rt.relation !== 'has_alias'
      );
      for (const cr of canonicalRels) {
        const aliasRelKey = `${aliasNorm}|${cr.relation}`;
        if (!relationIndex.has(aliasRelKey)) relationIndex.set(aliasRelKey, []);
        relationIndex.get(aliasRelKey).push({
          ...cr,
          subject: t.object, // use alias as subject
          subjectNorm: aliasNorm,
          source: cr.source + ' (via alias: ' + t.object + ')'
        });
        // Also index alias in entityIndex
        if (!entityIndex.has(aliasNorm)) entityIndex.set(aliasNorm, []);
        entityIndex.get(aliasNorm).push({
          ...cr,
          subject: t.object,
          subjectNorm: aliasNorm
        });
      }
    }
  }

  // Add subject aliases to entity index
  for (const alias of subjectAliases) {
    if (!entityIndex.has(alias)) entityIndex.set(alias, []);
  }

  return {
    triples,
    entityIndex,
    relationIndex,
    aliasToCanonical,
    subjectName,
    subjectNorm,
    subjectAliases,
    knowledge: k
  };
}

/**
 * Resolve an entity name to its canonical form using the alias map and fuzzy matching.
 * Returns the normalized canonical name, or the original normalized name if no match.
 */
function resolveEntity(graph, name) {
  const norm = normalizeEntity(name);
  if (!norm || norm.length < 3) return norm;

  // Check alias map first
  if (graph.aliasToCanonical && graph.aliasToCanonical.has(norm)) {
    return normalizeEntity(graph.aliasToCanonical.get(norm));
  }

  // Check direct entity index
  if (graph.entityIndex.has(norm)) return norm;

  // Description-based resolution: if the name matches a substring of a
  // typed entity's description, treat it as a reference to that entity.
  // e.g., "webGPU learning demo" matches a project description
  // "WebGPU learning demo with hello-triangle and textured-cube examples..."
  // Uses graph triples to find typed entities and their descriptions generically.
  if (graph.knowledge) {
    const nameLower = (name || '').toLowerCase();
    const nameNorm = norm;
    // Collect all typed entities from the graph
    const typedEntities = graph.triples
      .filter(t => t.relation === 'is_type')
      .map(t => t.subject);
    for (const entityName of [...new Set(typedEntities)]) {
      const desc = getEntityDescription(entityName, graph).toLowerCase();
      const descNorm = normalizeEntity(desc);
      // Check if the name (normalized) is a substring of the description
      // (normalized), with at least 10 chars to avoid short false matches
      if (nameNorm.length >= 10 && descNorm.includes(nameNorm)) {
        return normalizeEntity(entityName);
      }
      // Also check word-level overlap: if all significant words from the
      // name appear in the description, it's likely a reference to that entity
      const nameWords = nameLower.split(/\s+/).filter(w => w.length > 2);
      if (nameWords.length >= 2) {
        const allInDesc = nameWords.every(w => desc.includes(w));
        if (allInDesc) {
          return normalizeEntity(entityName);
        }
      }
    }
  }

  // Fuzzy match: find the best matching entity
  let bestMatch = null;
  let bestScore = 0;
  for (const key of graph.entityIndex.keys()) {
    if (key.length < 4) continue;
    // Exact substring match
    if (key.includes(norm) || norm.includes(key)) {
      const score = Math.min(key.length, norm.length) / Math.max(key.length, norm.length);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = key;
      }
    }
    // Word overlap match (for "AWS internship capstone" vs "AWS Serverless Metadata Extraction Workflow")
    const normWords = norm.split(/(?=[A-Z])/).filter(w => w.length > 2);
    const keyWords = key.split(/(?=[A-Z])/).filter(w => w.length > 2);
    if (normWords.length > 0 && keyWords.length > 0) {
      const overlap = normWords.filter(w => keyWords.some(kw => kw.includes(w) || w.includes(kw)));
      if (overlap.length > 0) {
        const score = overlap.length / Math.max(normWords.length, keyWords.length);
        if (score > bestScore && score > 0.3) {
          bestScore = score;
          bestMatch = key;
        }
      }
    }
  }

  return bestMatch || norm;
}

/**
 * Check if a specific relationship is supported by the graph.
 * Uses fuzzy entity matching to handle paraphrased entity names.
 *
 * @param {Object} graph - The relationship graph
 * @param {string} subject - Entity name (e.g., "ProjectHub")
 * @param {string} relation - Relation class (e.g., "uses_tech")
 * @param {string} object - Entity name (e.g., "React")
 * @returns {Object} { supported, evidence, reason }
 */
function checkRelationship(graph, subject, relation, object) {
  // Resolve entities to canonical forms
  const sNorm = resolveEntity(graph, subject);
  const oNorm = resolveEntity(graph, object);

  // Relation synonyms: some relations are semantically equivalent for
  // validation purposes. When a claim uses one relation but the graph
  // stores it under a synonym, accept the match.
  const RELATION_SYNONYMS = {
    has_degree: ['attended'],  // "has a degree from X" ≈ "attended X"
    attended: ['has_degree'],
  };
  const synonyms = RELATION_SYNONYMS[relation] || [];

  // Direct lookup: subject|relation|object
  const relKey = `${sNorm}|${relation}`;
  const candidates = graph.relationIndex.get(relKey) || [];
  const direct = candidates.find(t => t.objectNorm === oNorm);
  if (direct) {
    return {
      supported: true,
      evidence: direct.source,
      reason: `Supported: ${direct.subject} ${direct.relation} ${direct.object} (${direct.source})`
    };
  }

  // Synonym lookup: try synonym relations for the same object
  for (const synRel of synonyms) {
    const synKey = `${sNorm}|${synRel}`;
    const synCandidates = graph.relationIndex.get(synKey) || [];
    const synDirect = synCandidates.find(t => t.objectNorm === oNorm);
    if (synDirect) {
      return {
        supported: true,
        evidence: synDirect.source,
        reason: `Supported (synonym ${synRel}): ${synDirect.subject} ${synDirect.relation} ${synDirect.object} (${synDirect.source})`
      };
    }
  }

  // Partial object match: "Amplify" should match "AWS Amplify" (normalized "awsamplify")
  // because "amplify" is a suffix of "awsamplify". Only match when the shorter
  // string is a suffix of the longer one (with at least 60% length overlap)
  // to avoid false matches like "peanut" matching "peanutbutter".
  // Also reject when the prefix is a negation ("no", "not", "non") to avoid
  // "peanuts" matching "no peanuts".
  const partialMatch = candidates.find(t => {
    if (t.objectNorm === oNorm) return false;
    if (oNorm.length < 4 || t.objectNorm.length < 4) return false;
    const longer = t.objectNorm.length > oNorm.length ? t.objectNorm : oNorm;
    const shorter = t.objectNorm.length > oNorm.length ? oNorm : t.objectNorm;
    if (!longer.endsWith(shorter) || shorter.length / longer.length < 0.6) return false;
    // Check the prefix doesn't start with a negation
    const prefix = longer.slice(0, longer.length - shorter.length);
    if (/^(?:no|not|non|never|without)$/i.test(prefix)) return false;
    return true;
  });
  if (partialMatch) {
    return {
      supported: true,
      evidence: partialMatch.source,
      reason: `Supported: ${partialMatch.subject} ${partialMatch.relation} ${partialMatch.object} (${partialMatch.source})`
    };
  }

  // Also try with original normalized names (in case resolveEntity changed something)
  const sOrigNorm = normalizeEntity(subject);
  const oOrigNorm = normalizeEntity(object);
  if (sOrigNorm !== sNorm || oOrigNorm !== oNorm) {
    const relKey2 = `${sOrigNorm}|${relation}`;
    const candidates2 = graph.relationIndex.get(relKey2) || [];
    const direct2 = candidates2.find(t => t.objectNorm === oOrigNorm);
    if (direct2) {
      return {
        supported: true,
        evidence: direct2.source,
        reason: `Supported: ${direct2.subject} ${direct2.relation} ${direct2.object} (${direct2.source})`
      };
    }
  }

  // Check if the subject exists at all
  const subjectExists = graph.entityIndex.has(sNorm) ||
    [...graph.entityIndex.keys()].some(k => k.includes(sNorm) || sNorm.includes(k));
  const objectExists = graph.entityIndex.has(oNorm) ||
    [...graph.entityIndex.keys()].some(k => k.includes(oNorm) || oNorm.includes(k));

  if (!subjectExists && !objectExists) {
    return { supported: false, evidence: null, reason: `Neither "${subject}" nor "${object}" found in knowledge` };
  }
  if (!subjectExists) {
    return { supported: false, evidence: null, reason: `"${subject}" not found in knowledge` };
  }
  if (!objectExists) {
    return { supported: false, evidence: null, reason: `"${object}" not found in knowledge` };
  }

  // Both entities exist but the specific relationship is not supported
  // Check if the subject has ANY relationship of this type
  const subjectRels = (graph.entityIndex.get(sNorm) || [])
    .filter(t => t.subjectNorm === sNorm && t.relation === relation);

  if (subjectRels.length > 0) {
    // Subject has this relation type, just not with this object
    const knownObjects = [...new Set(subjectRels.map(t => t.object))].join(', ');
    return {
      supported: false,
      evidence: null,
      reason: `"${subject}" has ${relation} with: ${knownObjects}. NOT with "${object}".`
    };
  }

  // Check if object has this relation with anything
  const objectRels = (graph.entityIndex.get(oNorm) || [])
    .filter(t => t.objectNorm === oNorm && t.relation === relation);

  if (objectRels.length > 0) {
    const knownSubjects = [...new Set(objectRels.map(t => t.subject))].join(', ');
    return {
      supported: false,
      evidence: null,
      reason: `"${object}" is used by ${relation} from: ${knownSubjects}. NOT from "${subject}".`
    };
  }

  return {
    supported: false,
    evidence: null,
    reason: `No ${relation} relationship found between "${subject}" and "${object}"`
  };
}

/**
 * Get all known relationships for an entity (for entity-scoped evidence).
 * Returns triples where the entity is either subject or object.
 */
function getEntityRelationships(graph, entityName) {
  const eNorm = normalizeEntity(entityName);
  const triples = graph.entityIndex.get(eNorm) || [];

  // Also check partial matches (e.g., "AWS capstone" matches "AWS Serverless Metadata Extraction Workflow")
  for (const [key, tList] of graph.entityIndex.entries()) {
    if (key !== eNorm && (key.includes(eNorm) || eNorm.includes(key)) && eNorm.length >= 4) {
      triples.push(...tList);
    }
  }

  // Deduplicate
  const seen = new Set();
  return triples.filter(t => {
    const key = `${t.subjectNorm}|${t.relation}|${t.objectNorm}|${t.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Get all technologies used by a specific project.
 */
function getProjectTech(graph, projectName) {
  const pNorm = normalizeEntity(projectName);
  const techs = new Set();
  for (const t of graph.triples) {
    if (t.relation === 'uses_tech' && (t.subjectNorm === pNorm ||
      t.subjectNorm.includes(pNorm) || pNorm.includes(t.subjectNorm))) {
      techs.add(t.object);
    }
  }
  return Array.from(techs);
}

/**
 * Get all projects that use a specific technology.
 */
function getTechProjects(graph, techName) {
  const tNorm = normalizeEntity(techName);
  const projects = new Set();
  for (const t of graph.triples) {
    if (t.relation === 'uses_tech' && (t.objectNorm === tNorm ||
      t.objectNorm.includes(tNorm) || tNorm.includes(t.objectNorm))) {
      projects.add(t.subject);
    }
  }
  return Array.from(projects);
}

/**
 * Get all types for an entity from the graph's is_type triples.
 * Generic — works for any knowledge package that builds is_type triples.
 * @param {string} entityName
 * @param {Object} graph
 * @returns {string[]} array of type strings (e.g., ['AI assistant', 'Cloud project'])
 */
function getEntityTypes(entityName, graph) {
  if (!graph || !graph.triples) return [];
  const norm = normalizeEntity(entityName);
  if (!norm) return [];
  return graph.triples
    .filter(t => t.relation === 'is_type' &&
      (t.subjectNorm || '').includes(norm.slice(0, 6)))
    .map(t => t.object)
    .filter(Boolean);
}

/**
 * Check if an entity has any is_type triple in the graph.
 * This is the generic replacement for "is this a project?" checks.
 * @param {string} entityName
 * @param {Object} graph
 * @returns {boolean}
 */
function isTypedEntity(entityName, graph) {
  return getEntityTypes(entityName, graph).length > 0;
}

/**
 * Get the description of an entity from the graph's knowledge.
 * Generic — checks all entity collections that have descriptions.
 * @param {string} entityName
 * @param {Object} graph
 * @returns {string} description or ''
 */
function getEntityDescription(entityName, graph) {
  if (!graph || !graph.knowledge) return '';
  const norm = normalizeEntity(entityName);
  if (!norm) return '';
  const k = graph.knowledge;
  // Check projects
  if (Array.isArray(k.projects)) {
    for (const p of k.projects) {
      const pNorm = normalizeEntity(p.name || p.title || '');
      if (pNorm.includes(norm.slice(0, 6)) || norm.includes(pNorm.slice(0, 6))) {
        return p.description || '';
      }
    }
  }
  // Check experience
  if (Array.isArray(k.experience)) {
    for (const e of k.experience) {
      const eNorm = normalizeEntity(e.company || e.organization || '');
      if (eNorm.includes(norm.slice(0, 6)) || norm.includes(eNorm.slice(0, 6))) {
        return e.summary || e.description || '';
      }
    }
  }
  return '';
}

/**
 * Collect all distinct type words from the graph's is_type triples.
 * Used to derive the "specific nouns" list dynamically instead of hardcoding.
 * @param {Object} graph
 * @returns {Set<string>} set of lowercase type words
 */
function collectGraphTypeWords(graph) {
  const words = new Set();
  if (!graph || !graph.triples) return words;
  for (const t of graph.triples) {
    if (t.relation === 'is_type' && t.object) {
      for (const w of t.object.toLowerCase().split(/\s+/)) {
        if (w.length >= 4 && w !== '/') words.add(w);
      }
    }
  }
  return words;
}

module.exports = {
  buildRelationshipGraph,
  checkRelationship,
  getEntityRelationships,
  getProjectTech,
  getTechProjects,
  getEntityTypes,
  isTypedEntity,
  getEntityDescription,
  collectGraphTypeWords
};
