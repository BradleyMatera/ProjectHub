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
// It does NOT contain any Bradley-specific logic.

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

  // Check projects
  if (Array.isArray(knowledge.projects)) {
    for (const proj of knowledge.projects) {
      const name = proj.name || '';
      if (!name) continue;
      const nameLower = name.toLowerCase();
      if (lower.includes(nameLower)) {
        found.push({ name, type: 'project' });
        continue;
      }
      // Check aliases
      if (Array.isArray(proj.aliases)) {
        for (const alias of proj.aliases) {
          if (alias && lower.includes(alias.toLowerCase())) {
            found.push({ name, type: 'project' });
            break;
          }
        }
      }
    }
  }

  // Check experience/companies
  if (Array.isArray(knowledge.experience)) {
    for (const exp of knowledge.experience) {
      const company = exp.company || '';
      if (!company) continue;
      if (lower.includes(company.toLowerCase())) {
        found.push({ name: company, type: 'company' });
      }
    }
  }

  // Check skills/technologies
  if (Array.isArray(knowledge.skills)) {
    for (const skill of knowledge.skills) {
      const name = typeof skill === 'string' ? skill : (skill.name || '');
      if (!name || name.length < 3) continue;
      if (lower.includes(name.toLowerCase())) {
        found.push({ name, type: 'skill' });
      }
    }
  }

  // Check certifications
  if (Array.isArray(knowledge.certifications)) {
    for (const cert of knowledge.certifications) {
      const name = typeof cert === 'string' ? cert : (cert.name || '');
      if (!name || name.length < 3) continue;
      if (lower.includes(name.toLowerCase())) {
        found.push({ name, type: 'certification' });
      }
    }
  }

  // Deduplicate by name (case-insensitive)
  const seen = new Set();
  return found.filter(e => {
    const key = e.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

  // Determine active entity (most recently mentioned project or company)
  const projectCompanyMentions = entityMentions.filter(
    e => e.type === 'project' || e.type === 'company'
  );

  let activeEntity = null;
  let previousEntity = null;

  if (projectCompanyMentions.length > 0) {
    // Sort by turn index (most recent first)
    const sorted = [...projectCompanyMentions].sort((a, b) => b.turnIndex - a.turnIndex);
    activeEntity = { name: sorted[0].name, type: sorted[0].type };

    // Find the previous (different) entity
    for (const m of sorted) {
      if (m.name !== activeEntity.name) {
        previousEntity = { name: m.name, type: m.type };
        break;
      }
    }
  }

  // Determine comparison entities — only projects and companies, not skills
  const comparisonEntities = [];
  if (allEntities.length >= 2) {
    // If the last turn mentions 2+ project/company entities, they're being compared
    const lastTurnEntities = entityMentions.filter(
      e => e.turnIndex === turns.length - 1 && (e.type === 'project' || e.type === 'company')
    );
    if (lastTurnEntities.length >= 2) {
      for (const e of lastTurnEntities) {
        if (!comparisonEntities.some(c => c.name === e.name)) {
          comparisonEntities.push({ name: e.name, type: e.type });
        }
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
      const rewritten = q.replace(/\bthere\b/i, entity);
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

  // "the other project" / "the other one" — refers to previousEntity or a different project
  if (/\bthe\s+other\s+(?:project|one)\b/i.test(q)) {
    if (convState.previousEntity && (convState.previousEntity.type === 'project' || convState.previousEntity.type === 'company')) {
      const entity = convState.previousEntity.name;
      const rewritten = q.replace(/\bthe\s+other\s+(?:project|one)\b/i, entity);
      return { resolved: true, entity, rewrittenQuery: rewritten, referentType: 'other_project' };
    }
    // If we have comparison entities, pick the one that's not the active entity
    if (convState.comparisonEntities.length >= 2) {
      const other = convState.comparisonEntities.find(
        e => !convState.activeEntity || e.name !== convState.activeEntity.name
      );
      if (other) {
        const rewritten = q.replace(/\bthe\s+other\s+(?:project|one)\b/i, other.name);
        return { resolved: true, entity: other.name, rewrittenQuery: rewritten, referentType: 'other_project' };
      }
    }
    // Try to find a different project from knowledge
    if (knowledge?.projects && convState.activeEntity) {
      const other = knowledge.projects.find(
        p => p.name && p.name.toLowerCase() !== convState.activeEntity.name.toLowerCase()
      );
      if (other) {
        const rewritten = q.replace(/\bthe\s+other\s+(?:project|one)\b/i, other.name);
        return { resolved: true, entity: other.name, rewrittenQuery: rewritten, referentType: 'other_project' };
      }
    }
    return { resolved: false, entity: null, rewrittenQuery: q, referentType: 'other_project' };
  }

  // "it" — refers to active entity (pronoun resolution)
  // Only resolve if there's a clear active entity and the question is short
  if (q.split(/\s+/).length <= 10 && /\bit\b/i.test(q) && convState.activeEntity) {
    const entity = convState.activeEntity.name;
    const rewritten = q.replace(/\bit\b/i, entity);
    if (rewritten !== q) {
      return { resolved: true, entity, rewrittenQuery: rewritten, referentType: 'pronoun_it' };
    }
  }

  // "that" (standalone pronoun, not "that way", "that thing", etc.) — refers to active entity
  if (q.split(/\s+/).length <= 10 && /\bthat\b/i.test(q) && convState.activeEntity) {
    // Only replace "that" when it's used as a standalone pronoun
    // Not when it's part of "that way", "that thing", "that project", etc.
    const thatPronounPattern = /\bthat\b(?!\s+(?:way|thing|project|company|count|time|part|role|job|position|counts?))\b/i;
    if (thatPronounPattern.test(q)) {
      const entity = convState.activeEntity.name;
      const rewritten = q.replace(thatPronounPattern, entity);
      if (rewritten !== q) {
        return { resolved: true, entity, rewrittenQuery: rewritten, referentType: 'pronoun_that' };
      }
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
