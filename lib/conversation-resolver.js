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
function extractEntitiesFromText(text, knowledge, options = {}) {
  if (!text || !knowledge) return [];
  const source = options.source || 'unknown';
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

  // Helper: add an entity if the full name or a distinctive word appears in text.
  // Strips parenthetical acronyms and common non-distinctive business words so
  // generic terms like 'web' or 'services' do not false-positive on a company
  // such as 'Amazon Web Services (AWS)'.
  function addByNameOrDistinctiveWord(name, type) {
    if (!name) return;
    const lowerName = name.toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    const pos = lower.indexOf(lowerName);
    if (pos >= 0) {
      found.push({ name, type, position: pos });
      return;
    }
    const genericSuffixes = new Set([
      'inc', 'llc', 'ltd', 'group', 'corp', 'corporation', 'company', 'co',
      'and', 'the', 'of', 'web', 'services', 'solutions', 'systems', 'software',
      'network', 'cloud', 'data', 'global', 'international', 'holdings', 'partners',
      'consulting', 'technologies', 'technology', 'tech', 'digital', 'resources',
      'enterprises', 'enterprise'
    ]);
    const parts = lowerName.split(/\s+/).filter(w => w.length >= 3 && !genericSuffixes.has(w));
    for (const part of parts) {
      const re = new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      const m = lower.match(re);
      if (m) {
        found.push({ name, type, position: m.index });
        return;
      }
    }
  }

  if (Array.isArray(knowledge.experience)) {
    for (const exp of knowledge.experience) addByNameOrDistinctiveWord(exp.company || '', 'company');
  }
  // Include any employer-like entity declared in identity (e.g. accepted offer).
  const identityCompany = knowledge?.identity?.careerStatus?.acceptedOffer?.company
    || knowledge?.identity?.company
    || null;
  if (identityCompany) addByNameOrDistinctiveWord(identityCompany, 'company');

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

  // Collect names already known so we don't treat them as unknown technologies.
  const knownNames = new Set(found.map(e => e.name.toLowerCase()));
  if (knowledge.identity?.name) {
    const subjectName = String(knowledge.identity.name).trim();
    if (subjectName) {
      knownNames.add(subjectName.toLowerCase());
      subjectName.split(/\s+/).forEach(p => { if (p.length >= 2) knownNames.add(p.toLowerCase()); });
    }
  }
  if (knowledge.identity?.preferredName) {
    String(knowledge.identity.preferredName).trim().split(/\s+/).forEach(p => { if (p.length >= 2) knownNames.add(p.toLowerCase()); });
  }
  if (Array.isArray(knowledge.subjectAliases)) {
    for (const a of knowledge.subjectAliases) knownNames.add(String(a).toLowerCase());
  }

  // Extract unknown technology terms (e.g. "Rust", "Go") mentioned in a tech
  // context so follow-ups like "Could he eventually become really good at it?"
  // can resolve "it" to the newly introduced skill. Only do this from user text,
  // never from assistant text, to avoid hallucinated capitalized words becoming
  // active referents.
  if (source !== 'assistant') {
  const techContextPattern = /\b(?:in|with|using|know|knows|use|uses|used|code|coding|language|framework|library|tool|stack|technology|tech|skill|good\s+at|learn(?:ing|s)?)\b/i;
  const tokenPattern = /\b([A-Z][A-Za-z0-9+#.]{1,20})\b/g;
  let m;
  while ((m = tokenPattern.exec(text)) !== null) {
    const term = m[1];
    const termLower = term.toLowerCase();
    if (knownNames.has(termLower)) continue;
    if (/(?:hello|hi|good|morning|afternoon|evening|thank|thanks|please|sorry|scout|can|could|will|would|did|does|is|are|was|were|has|have|had|should|may|might|must|shall|do|does|be|am|been|being)/i.test(term)) continue;
    const start = Math.max(0, m.index - 50);
    const end = Math.min(text.length, m.index + term.length + 50);
    const context = text.slice(start, end).toLowerCase();
    if (!techContextPattern.test(context)) continue;
    if (!found.some(e => e.name.toLowerCase() === termLower)) {
      found.push({ name: term, type: 'skill', position: m.index });
    }
  }
  }

  const latest = new Map();
  for (const entity of found) {
    const key = entity.name.toLowerCase();
    if (!latest.has(key) || latest.get(key).position < entity.position) latest.set(key, entity);
  }
  return [...latest.values()].sort((a, b) => a.position - b.position);
}

// Plural / list concepts that can be referred to with "them" / "these" / "those".
const DISCOURSE_OBJECT_TYPES = [
  { re: /\bweakness(?:es)?\b/gi, name: 'weaknesses', type: 'concern' },
  { re: /\bgap(?:s)?\b/gi, name: 'gaps', type: 'gap' },
  { re: /\barea(?:s)?(?:\s+to\s+improve)?\b/gi, name: 'areas to improve', type: 'improvement' },
  { re: /\bconcern(?:s)?\b/gi, name: 'concerns', type: 'concern' },
  { re: /\blimitation(?:s)?\b/gi, name: 'limitations', type: 'concern' },
  { re: /\bstrength(?:s)?\b/gi, name: 'strengths', type: 'strength' },
  { re: /\bskill(?:s)?\b/gi, name: 'skills', type: 'skill-set' },
  { re: /\bproject(?:s)?\b/gi, name: 'projects', type: 'project-set' },
  { re: /\btech\s+area(?:s)?\b/gi, name: 'tech areas', type: 'skill-set' },
];

// Extract the specific referent context after a discourse marker so anaphora
// can resolve "them" to *which* gaps/areas were discussed, not just a generic label.
function extractClaimContext(text, matchEnd, source) {
  const tail = text.slice(matchEnd).replace(/^\s*[,.:;]\s*/, '');
  if (!tail) return '';
  const sentence = tail.split(/[.!?;]/)[0];
  let words = sentence.split(/\s+/).slice(0, 12);
  let ctx = words.join(' ').trim();
  if (source === 'assistant') {
    ctx = ctx
      .replace(/^(?:are|is|were|was)\s+(?:the\s+)?/i, '')
      .replace(/^(?:include|includes|including)\s+/i, '');
  }
  return ctx.replace(/[,.:;!?]+$/, '').trim();
}

function extractDiscourseObjects(text, source = 'unknown') {
  if (!text) return [];
  const found = [];
  const seen = new Set();
  for (const pattern of DISCOURSE_OBJECT_TYPES) {
    pattern.re.lastIndex = 0;
    let m;
    while ((m = pattern.re.exec(text)) !== null) {
      const key = `${pattern.name}-${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        name: pattern.name,
        type: pattern.type,
        position: m.index,
        matchedText: m[0],
        source,
        claimContext: extractClaimContext(text, m.index + m[0].length, source)
      });
    }
  }
  return found.sort((a, b) => a.position - b.position);
}

// Select the most relevant plural discourse object for the current question.
// Prefers assistant-sourced objects and matches the verb (improve -> gaps, etc.).
function selectPluralDiscourseObject(question, objects) {
  if (!objects?.length) return null;
  const lower = question.toLowerCase();
  const byType = {
    improve: ['gap', 'improvement', 'concern', 'limitation'],
    'work on': ['gap', 'improvement', 'concern', 'limitation'],
    fix: ['gap', 'improvement', 'concern', 'limitation'],
    address: ['gap', 'improvement', 'concern', 'limitation'],
    weakness: ['gap', 'improvement', 'concern', 'limitation'],
    weaknesses: ['gap', 'improvement', 'concern', 'limitation'],
    strength: ['strength', 'skill-set'],
    strengths: ['strength', 'skill-set'],
    skill: ['strength', 'skill-set'],
    skills: ['strength', 'skill-set'],
  };
  let preferred = null;
  for (const [verb, types] of Object.entries(byType)) {
    if (lower.includes(verb)) { preferred = types; break; }
  }
  const assistant = objects.filter(o => o.source === 'assistant');
  const pool = assistant.length ? assistant : objects;
  if (preferred) {
    const bestType = preferred.find(t => pool.some(o => o.type === t));
    if (bestType) {
      const candidates = pool.filter(o => o.type === bestType);
      return candidates[candidates.length - 1];
    }
  }
  return pool[pool.length - 1];
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
      discourseObjects: [],
    };
  }

  // Extract entities and plural discourse objects from each turn, tracking recency.
  const entityMentions = []; // {name, type, turnIndex}
  const allEntities = [];
  const discourseMentions = []; // {name, type, turnIndex, source}

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    let entities = [];
    let objects = [];
    if (turn.text) {
      // Role-based format: determine whether this is user or assistant text.
      const source = turn.role === 'assistant' ? 'assistant' : 'user';
      entities = extractEntitiesFromText(turn.text, knowledge, { source });
      objects = extractDiscourseObjects(turn.text, source);
    } else {
      // Legacy {user, assistant} format: extract separately so assistant text
      // cannot invent new technology referents.
      if (turn.user) {
        const u = extractEntitiesFromText(turn.user, knowledge, { source: 'user' });
        const o = extractDiscourseObjects(turn.user, 'user');
        entities.push(...u);
        objects.push(...o);
      }
      if (turn.assistant) {
        const a = extractEntitiesFromText(turn.assistant, knowledge, { source: 'assistant' });
        const oa = extractDiscourseObjects(turn.assistant, 'assistant');
        const offset = (turn.user || '').length + 1;
        entities.push(...a.map(e => ({ ...e, position: e.position + offset })));
        objects.push(...oa.map(e => ({ ...e, position: e.position + offset })));
      }
    }
    for (const e of entities) {
      const source = turn.role === 'assistant' ? 'assistant' : 'user';
      entityMentions.push({ ...e, turnIndex: i, source });
      if (!allEntities.some(a => a.name === e.name)) {
        allEntities.push(e);
      }
    }
    for (const o of objects) {
      const source = turn.role === 'assistant' ? 'assistant' : 'user';
      discourseMentions.push({ ...o, turnIndex: i, source });
    }
  }

  // Build the most-recent-first list of discourse objects (deduplicated by name).
  const discourseObjects = [];
  const seenDiscourse = new Set();
  for (let i = discourseMentions.length - 1; i >= 0; i--) {
    const o = discourseMentions[i];
    if (!seenDiscourse.has(o.name)) {
      seenDiscourse.add(o.name);
      discourseObjects.unshift(o);
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
    // Sort by source (user mentions are authoritative), then recency, then position.
    // For the user, the last-mentioned project in a turn is usually the active one.
    // For the assistant, the first-mentioned project in a reply is usually the main
    // topic, so later skill/company digressions do not steal the referent.
    const sourceWeight = e => e.source === 'user' ? 2 : 1;
    // User: last-mentioned project in a turn is active. Assistant: first-mentioned
    // project in a reply is active, so later skill/company digressions do not steal it.
    const positionBias = e => e.source === 'user' ? 1 : -1;
    const sorted = [...projectCompanyMentions].sort((a, b) =>
      sourceWeight(b) - sourceWeight(a) ||
      b.turnIndex - a.turnIndex ||
      positionBias(a) * ((b.position || 0) - (a.position || 0))
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
      const sourceWeight = e => e.source === 'user' ? 2 : 1;
      const positionBias = e => e.source === 'user' ? 1 : -1;
      const sorted = [...skillMentions].sort((a, b) =>
        sourceWeight(b) - sourceWeight(a) ||
        b.turnIndex - a.turnIndex ||
        positionBias(a) * ((b.position || 0) - (a.position || 0))
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
    discourseObjects,
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
  if (!q) return { resolved: false, entity: null, rewrittenQuery: q, referentType: null, referentContext: null };

  let rewritten = q;
  let resolved = false;
  let referentType = null;
  let entity = null;
  let referentContext = null;

  const subjectName = knowledge?.identity?.name || knowledge?.identity?.preferredName || null;
  const subjectFirst = subjectName ? subjectName.split(/\s+/)[0] : null;
  const active = convState?.activeEntity ? convState.activeEntity.name : null;
  const activeType = convState?.activeEntity ? convState.activeEntity.type : null;

  function mark(type, ent) {
    resolved = true;
    referentType = referentType ? `${referentType},${type}` : type;
    if (!entity) entity = ent;
  }

  function safeReplace(pattern, replacement) {
    const newText = rewritten.replace(pattern, replacement);
    if (newText !== rewritten) {
      rewritten = newText;
      return true;
    }
    return false;
  }

  // Non-person referents first: "it/that/there/this thing/the other" resolve
  // to the active project/company/skill. Subject pronouns are resolved last
  // so a question can contain both ("Could he become good at it?").
  if (active && /\bthere\b/i.test(rewritten)) {
    const prep = activeType === 'company' ? 'at' : 'in';
    if (safeReplace(/\bthere\b/gi, `${prep} ${active}`)) mark('there', active);
  }

  if (active && /\b(?:this|that)\s+thing\b/i.test(rewritten)) {
    if (safeReplace(/\b(?:this|that)\s+thing\b/gi, active)) mark('this_thing', active);
  }

  if (rewritten.split(/\s+/).length <= 12) {
    // "Which of them ..." with a known comparison/project pair resolves to the explicit set.
    if (/\bwhich\s+of\s+(?:them|these|those)\b/i.test(rewritten) && convState?.comparisonEntities?.length >= 2) {
      const names = convState.comparisonEntities.map(e => e.name).join(' and ');
      const typeLabel = convState.comparisonEntities[0].type === 'company' ? 'companies' : 'projects';
      const newText = rewritten.replace(/\b(?:them|these|those)\b/i, `those ${typeLabel} (${names})`);
      if (newText !== rewritten) {
        rewritten = newText;
        referentContext = names;
        mark('plural_set', typeLabel);
      }
    } else if (convState?.discourseObjects?.length > 0) {
      const pluralPronounPattern = /\b(them|these|those)\b/gi;
      let m = pluralPronounPattern.exec(rewritten);
      while (m) {
        const start = Math.max(0, m.index - 60);
        const end = Math.min(rewritten.length, m.index + 80);
        const window = rewritten.slice(start, end).toLowerCase();
        // Prefer discourse objects for "improve them" / "what about these" follow-ups.
        if (/\b(?:improve|address|fix|work\s+on|deal\s+with|what\s+about|tell\s+me\s+about|how\s+about)\b/.test(window) ||
            /\bwhich\s+of\s+(?:them|these|those)\b/i.test(rewritten) ||
            /\b(?:them|these|those)\s+(?:are|were|are\s+not)\b/.test(rewritten)) {
          const target = selectPluralDiscourseObject(rewritten, convState.discourseObjects);
          if (target) {
            const determiner = (m[1] || '').toLowerCase() === 'these' ? 'these' : 'those';
            const label = target.claimContext ? `${target.name} (${target.claimContext})` : target.name;
            const replacement = `${determiner} ${label}`;
            const newText = rewritten.replace(/\b(them|these|those)\b/i, replacement);
            if (newText !== rewritten) {
              rewritten = newText;
              mark('plural_pronoun', target.name);
              referentContext = target.claimContext || null;
            }
          }
          break;
        }
        m = pluralPronounPattern.exec(rewritten);
      }
    }
  }

  if (/\bthe\s+other\s+(?:project|one)\b/i.test(rewritten)) {
    const activeName = active;
    let other = null;
    if (convState?.comparisonEntities?.length >= 2 && activeName) {
      other = convState.comparisonEntities.find(e => e.name !== activeName);
    }
    if (!other && convState?.previousEntity && convState.previousEntity.name !== activeName) {
      other = convState.previousEntity;
    }
    if (!other && activeName && Array.isArray(knowledge?.projects)) {
      const candidate = knowledge.projects.find(p => (p.name || '') !== activeName);
      if (candidate) other = { name: candidate.name, type: 'project' };
    }
    if (other && safeReplace(/\bthe\s+other\s+(?:project|one)\b/gi, other.name)) {
      mark('other_project', other.name);
    }
  }

  if (rewritten.split(/\s+/).length <= 12 && active && /\bit\b/i.test(rewritten)) {
    if (safeReplace(/\bit\b/gi, active)) mark('pronoun_it', active);
  }

  if (rewritten.split(/\s+/).length <= 10 && active && /\bthat\b/i.test(rewritten)) {
    const thatPronounPattern = /\bthat\b(?!\s+(?:way|thing|project|company|count|time|part|role|job|position|counts?))\b/gi;
    if (thatPronounPattern.test(rewritten)) {
      thatPronounPattern.lastIndex = 0;
      if (safeReplace(thatPronounPattern, active)) mark('pronoun_that', active);
    }
  }

  if (/^(?:was|is)\s+that\b/i.test(rewritten) && active) {
    const r = /^((?:was|is)\s+)\bthat\b/gi;
    if (safeReplace(r, `$1${active}`)) mark('that_pronoun', active);
  }

  // Subject pronouns
  if (subjectFirst && /\b(?:he|him|his)\b/i.test(rewritten)) {
    const newText = rewritten
      .replace(/\bhe\b/gi, subjectFirst)
      .replace(/\bhim\b/gi, subjectFirst)
      .replace(/\bhis\b/gi, `${subjectFirst}'s`);
    if (newText !== rewritten) {
      rewritten = newText;
      mark('pronoun_he', subjectName);
    }
  }

  if (resolved) {
    return { resolved: true, entity, rewrittenQuery: rewritten, referentType, referentContext };
  }

  // If pronouns remain and we have no way to resolve them, request clarification.
  if (/\b(it|that|there|this|the other one|the other project)\b/i.test(q) && !active && !subjectFirst) {
    return { resolved: false, entity: null, rewrittenQuery: q, referentType: 'unresolved', referentContext: null };
  }

  return { resolved: false, entity: null, rewrittenQuery: q, referentType: null, referentContext: null };
}

module.exports = {
  extractEntitiesFromText,
  buildConversationState,
  resolveReferent,
};
