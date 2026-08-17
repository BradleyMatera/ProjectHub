'use strict';

// Generic Conversation State Resolver
//
// Resolves referents (it, that, there, this thing, the other project, etc.)
// using conversation history and the knowledge base — NOT hardcoded entities.
//
// The harness resolves references BEFORE retrieval so the model doesn't have to.
//
// This module is domain-neutral. It uses:
//   - conversation history (recent turns)
//   - knowledge entities (projects, skills, companies, etc.)
//   - entity type inference
//   - comparison state
//
// It does NOT contain any tenant-specific logic.

/**
 * Extract entities mentioned in a text using the knowledge base.
 * @param {string} text - The text to scan
 * @param {object} knowledge - The knowledge base
 * @returns {Array<{name: string, type: string}>} - Found entities with types
 */
function extractEntitiesFromText(text, knowledge) {
  if (!text || !knowledge) return [];
  const lower = text.toLowerCase();
  const found = [];
  const add = (name, type, matchValue = name) => {
    if (!name || !matchValue) return;
    const position = lower.lastIndexOf(String(matchValue).toLowerCase());
    if (position >= 0) found.push({ name, type, position });
  };

  if (Array.isArray(knowledge.projects)) {
    for (const proj of knowledge.projects) {
      const name = proj.name || '';
      if (!name) continue;
      if (lower.includes(name.toLowerCase())) {
        add(name, 'project');
        continue;
      }
      for (const alias of proj.aliases || []) {
        if (alias && lower.includes(alias.toLowerCase())) {
          add(name, 'project', alias);
          break;
        }
      }
    }
  }

  if (Array.isArray(knowledge.experience)) {
    for (const exp of knowledge.experience) add(exp.company || '', 'company');
  }

  const skills = Array.isArray(knowledge.skills)
    ? knowledge.skills
    : (knowledge.skills && typeof knowledge.skills === 'object'
      ? Object.values(knowledge.skills).flatMap(value => Array.isArray(value) ? value : [])
      : []);
  for (const skill of skills) {
    const name = typeof skill === 'string' ? skill : (skill.name || '');
    if (name.length >= 3) add(name, 'skill');
  }

  if (Array.isArray(knowledge.certifications)) {
    for (const cert of knowledge.certifications) {
      const name = typeof cert === 'string' ? cert : (cert.name || '');
      if (name.length >= 3) add(name, 'certification');
    }
  }

  const latest = new Map();
  for (const entity of found) {
    const key = entity.name.toLowerCase();
    if (!latest.has(key) || latest.get(key).position < entity.position) latest.set(key, entity);
  }
  return [...latest.values()].sort((a, b) => a.position - b.position);
}

/**
 * Build a conversation state snapshot from history and knowledge.
 * @param {Array} history - Recent turns [{role, text}] or [{user, assistant}]
 * @param {object} knowledge - The knowledge base
 * @returns {object} Conversation state with activeEntity, previousEntity, etc.
 */
function buildConversationState(history, knowledge) {
  const turns = (history || []).slice(-6); // Last 6 turns
  if (turns.length === 0) {
    return {
      activeEntity: null,
      previousEntity: null,
      activeEntities: [],
      comparisonEntities: [],
      lastIntent: null,
      topicScope: null,
    };
  }

  // Extract entities from each turn, tracking recency
  const entityMentions = []; // {name, type, turnIndex}
  const allEntities = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    // Handle both {role, text} and {user, assistant} formats
    const text = turn.text || `${turn.user || ''} ${turn.assistant || ''}`;
    const entities = extractEntitiesFromText(text, knowledge);
    for (const e of entities) {
      entityMentions.push({ ...e, turnIndex: i });
      if (!allEntities.some(a => a.name === e.name)) {
        allEntities.push(e);
      }
    }
  }

  // Determine active entity (most recently mentioned project, company, or skill)
  // Projects and companies take priority; skills are used when no project/company
  // is active. This allows pronoun resolution ("it") to refer to skills like React.
  const projectCompanyMentions = entityMentions.filter(
    e => e.type === 'project' || e.type === 'company'
  );

  let activeEntity = null;
  let previousEntity = null;

  if (projectCompanyMentions.length > 0) {
    // Sort by turn index and mention position (most recent first)
    const sorted = [...projectCompanyMentions].sort((a, b) =>
      b.turnIndex - a.turnIndex || (b.position || 0) - (a.position || 0)
    );
    activeEntity = { name: sorted[0].name, type: sorted[0].type };

    // Find the previous (different) entity
    for (const m of sorted) {
      if (m.name !== activeEntity.name) {
        previousEntity = { name: m.name, type: m.type };
        break;
      }
    }
  } else {
    // No project/company in context — use the most recent skill/technology
    // as the active referent so pronouns like "it" can resolve to skills
    const skillMentions = entityMentions.filter(e => e.type === 'skill');
    if (skillMentions.length > 0) {
      const sorted = [...skillMentions].sort((a, b) =>
        b.turnIndex - a.turnIndex || (b.position || 0) - (a.position || 0)
      );
      activeEntity = { name: sorted[0].name, type: sorted[0].type };
    }
  }

  // Determine comparison entities — only projects and companies, not skills
  const comparisonEntities = [];
  if (allEntities.length >= 2) {
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
      const turnEntities = entityMentions.filter(
        e => e.turnIndex === turnIndex && (e.type === 'project' || e.type === 'company')
      );
      const unique = turnEntities.filter((entity, index, items) =>
        items.findIndex(item => item.name === entity.name) === index
      );
      if (unique.length >= 2) {
        for (const entity of unique) comparisonEntities.push({ name: entity.name, type: entity.type });
        break;
      }
    }
  }

  // Determine topic scope from entity types
  let topicScope = null;
  if (activeEntity) {
    if (activeEntity.type === 'project') topicScope = 'project';
    else if (activeEntity.type === 'company') topicScope = 'experience';
    else if (activeEntity.type === 'skill') topicScope = 'skill';
  }

  return {
    activeEntity,
    previousEntity,
    activeEntities: allEntities,
    comparisonEntities,
    lastIntent: null,
    topicScope,
  };
}

/**
 * Resolve a referent in the question using conversation state.
 * @param {string} question - The user's question
 * @param {object} convState - Conversation state from buildConversationState
 * @param {object} knowledge - The knowledge base
 * @returns {object} { resolved: boolean, entity: string|null, rewrittenQuery: string, referentType: string }
 */
function resolveReferent(question, convState, knowledge) {
  const q = (question || '').trim();
  const qLower = q.toLowerCase();

  // "there" — refers to the active entity (project, company, or experience context)
  if (/\bthere\b/i.test(q)) {
    if (convState.activeEntity) {
      const entity = convState.activeEntity.name;
      const preposition = convState.activeEntity.type === 'company' ? 'at' : 'in';
      const rewritten = q.replace(/\bthere\b/i, `${preposition} ${entity}`);
      return { resolved: true, entity, rewrittenQuery: rewritten, referentType: 'there' };
    }
    // No active entity — try to find any project/experience from knowledge
    if (knowledge?.projects?.length > 0) {
      // Can't resolve — leave as is
      return { resolved: false, entity: null, rewrittenQuery: q, referentType: 'there' };
    }
    return { resolved: false, entity: null, rewrittenQuery: q, referentType: 'there' };
  }

  // "this thing" / "that thing" — refers to the active entity
  if (/\b(?:this|that)\s+thing\b/i.test(q)) {
    if (convState.activeEntity) {
      const entity = convState.activeEntity.name;
      const rewritten = q.replace(/\b(?:this|that)\s+thing\b/i, entity);
      return { resolved: true, entity, rewrittenQuery: rewritten, referentType: 'this_thing' };
    }
    return { resolved: false, entity: null, rewrittenQuery: q, referentType: 'this_thing' };
  }

  // "the other project" / "the other one" — refers to a different project than the active one.
  // Resolution order:
  //   1. The other member of an active comparison (comparisonEntities >= 2)
  //   2. The previousEntity (a different project mentioned earlier)
  //   3. A different project from the knowledge base (only when an active entity exists,
  //      since "the other project" presupposes the user knows there is another one)
  if (/\bthe\s+other\s+(?:project|one)\b/i.test(q)) {
    const activeName = convState.activeEntity ? convState.activeEntity.name : null;
    let other = null;
    if (convState.comparisonEntities.length >= 2 && activeName) {
      other = convState.comparisonEntities.find(entity => entity.name !== activeName);
    }
    if (!other && convState.previousEntity && convState.previousEntity.name !== activeName) {
      other = convState.previousEntity;
    }
    if (!other && activeName && Array.isArray(knowledge.projects)) {
      const candidate = knowledge.projects.find(p => (p.name || '') !== activeName);
      if (candidate) other = { name: candidate.name, type: 'project' };
    }
    if (other) {
      const rewritten = q.replace(/\bthe\s+other\s+(?:project|one)\b/i, other.name);
      return { resolved: true, entity: other.name, rewrittenQuery: rewritten, referentType: 'other_project' };
    }
    return { resolved: false, entity: null, rewrittenQuery: q, referentType: 'other_project' };
  }

  // "he" / "him" / "his" — refers to the tenant subject (the candidate)
  // In a recruiter assistant context, these pronouns always refer to the
  // candidate being discussed. Rewrite to the subject's first name for
  // better retrieval and model comprehension.
  if (/\b(?:he|him|his)\b/i.test(q)) {
    const subjectName = knowledge?.identity?.name || knowledge?.identity?.preferredName || null;
    if (subjectName) {
      const subjectFirst = subjectName.split(/\s+/)[0];
      const rewritten = q
        .replace(/\bhe\b/gi, subjectFirst)
        .replace(/\bhim\b/gi, subjectFirst)
        .replace(/\bhis\b/gi, subjectFirst + "'s");
      if (rewritten !== q) {
        return { resolved: true, entity: subjectName, rewrittenQuery: rewritten, referentType: 'pronoun_he' };
      }
    }
  }

  // "it" — refers to active entity (pronoun resolution)
  // Resolve if there's a clear active entity (project, company, OR skill)
  if (q.split(/\s+/).length <= 12 && /\bit\b/i.test(q)) {
    if (convState.activeEntity) {
      const entity = convState.activeEntity.name;
      const rewritten = q.replace(/\bit\b/i, entity);
      if (rewritten !== q) {
        return { resolved: true, entity, rewrittenQuery: rewritten, referentType: 'pronoun_it' };
      }
    }
    // Only return unresolved (clarification) if there are ZERO active entities
    if (convState.activeEntities.length === 0) {
      return { resolved: false, entity: null, rewrittenQuery: q, referentType: 'pronoun_it' };
    }
    // If there are active entities but none is the primary, try the first one
    if (convState.activeEntities.length === 1) {
      const entity = convState.activeEntities[0].name;
      const rewritten = q.replace(/\bit\b/i, entity);
      if (rewritten !== q) {
        return { resolved: true, entity, rewrittenQuery: rewritten, referentType: 'pronoun_it' };
      }
    }
    return { resolved: false, entity: null, rewrittenQuery: q, referentType: 'pronoun_it' };
  }

  // "that" (standalone pronoun, not "that way", "that thing", etc.) — refers to active entity
  if (q.split(/\s+/).length <= 10 && /\bthat\b/i.test(q)) {
    // Only replace "that" when it's used as a standalone pronoun
    // Not when it's part of "that way", "that thing", "that project", etc.
    const thatPronounPattern = /\bthat\b(?!\s+(?:way|thing|project|company|count|time|part|role|job|position|counts?))\b/i;
    if (thatPronounPattern.test(q)) {
      if (convState.activeEntity) {
        const entity = convState.activeEntity.name;
        const rewritten = q.replace(thatPronounPattern, entity);
        if (rewritten !== q) {
          return { resolved: true, entity, rewrittenQuery: rewritten, referentType: 'pronoun_that' };
        }
      }
      return { resolved: false, entity: null, rewrittenQuery: q, referentType: 'pronoun_that' };
    }
  }

  // "that" in "Was that X?" — refers to active entity
  if (/^(?:was|is|was\s+that|is\s+that)\b/i.test(q) && convState.activeEntity) {
    const entity = convState.activeEntity.name;
    const rewritten = q.replace(/^((?:was|is)\s+)\bthat\b/i, `$1${entity}`);
    if (rewritten !== q) {
      return { resolved: true, entity, rewrittenQuery: rewritten, referentType: 'that_pronoun' };
    }
  }

  return { resolved: false, entity: null, rewrittenQuery: q, referentType: null };
}

module.exports = {
  extractEntitiesFromText,
  buildConversationState,
  resolveReferent,
};
