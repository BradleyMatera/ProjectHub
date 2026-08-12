'use strict';

// Canonical Entities — generic entity normalization and grounding.
//
// Replaces the SAFE_CAPITALIZED whack-a-mole approach with a system that:
//   1. Extracts known entities from the knowledge base (projects, skills,
//      employers, schools, certifications, candidate name).
//   2. Normalizes entities for matching (lowercase, strip punctuation/
//      hyphens/spaces) so "VoiceOps" matches "Voice Ops" matches "voice-ops".
//   3. Provides a small set of common English words that are always safe
//      (articles, conjunctions, discourse markers).
//   4. Grounds capitalized tokens from generated answers against the
//      source evidence text using normalized matching.

// --- Common English words that are always safe (not entity claims) ---
const COMMON_ENGLISH = new Set([
  // Articles / determiners
  'A', 'An', 'The', 'This', 'That', 'These', 'Those', 'Some', 'Any', 'All',
  'Both', 'Each', 'Every', 'Neither', 'Either', 'No', 'Yes',
  // Pronouns
  'I', 'Me', 'My', 'Mine', 'We', 'Us', 'Our', 'Ours', 'You', 'Your', 'Yours',
  'He', 'Him', 'His', 'She', 'Her', 'Hers', 'It', 'Its', 'They', 'Them', 'Their', 'Theirs',
  // Conjunctions
  'And', 'But', 'Or', 'Nor', 'So', 'Yet', 'For', 'As', 'If', 'Unless', 'Until', 'While',
  'Although', 'Though', 'Because', 'Since', 'When', 'Where', 'Whether', 'Whereas',
  // Prepositions
  'In', 'On', 'At', 'To', 'From', 'By', 'With', 'Without', 'Within', 'Of', 'About',
  'Into', 'Onto', 'Upon', 'Over', 'Under', 'Between', 'Among', 'Through', 'Across',
  // Discourse markers
  'However', 'Therefore', 'Moreover', 'Furthermore', 'Additionally', 'Also', 'Well',
  'Actually', 'Currently', 'Unfortunately', 'Honestly', 'Sure', 'Correct', 'Right',
  'True', 'False', 'Not', 'Overall', 'Instead', 'Rather', 'Meanwhile',
  // Scout / agent
  'Scout', 'Bradley', 'Brad',
]);

// --- Normalize a string for entity matching ---
// Lowercases, removes spaces, hyphens, underscores, and punctuation
// so "Voice Ops Platform" → "voiceopsplatform", "VoiceOps" → "voiceopsplatform"
// "Node.js" → "nodejs", "NodeJS" → "nodejs"
function normalizeEntity(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // keep only alphanumeric
}

// --- Build the entity registry from knowledge + source text ---
// Returns a set of normalized entity strings that are "known".
function buildEntityRegistry(knowledge, sourceText) {
  const registry = new Set();

  // 1. Add all common English words (normalized)
  for (const word of COMMON_ENGLISH) {
    registry.add(normalizeEntity(word));
  }

  // 2. Add candidate name parts
  if (knowledge) {
    const candidateName = knowledge.identity?.name || knowledge.summary?.name || '';
    if (candidateName) {
      const parts = candidateName.split(/\s+/);
      for (const part of parts) {
        registry.add(normalizeEntity(part));
      }
      registry.add(normalizeEntity(candidateName));
    }

    // 3. Add project names and aliases
    if (Array.isArray(knowledge.projects)) {
      for (const proj of knowledge.projects) {
        if (proj.name) {
          registry.add(normalizeEntity(proj.name));
          // Also add each word of multi-word names
          const parts = proj.name.split(/[\s:&()-]+/).filter(p => p.length > 1);
          for (const part of parts) {
            if (part.length >= 3) registry.add(normalizeEntity(part));
          }
        }
        if (Array.isArray(proj.aliases)) {
          for (const alias of proj.aliases) {
            registry.add(normalizeEntity(alias));
            const aliasParts = alias.split(/[\s:&()-]+/).filter(p => p.length > 1);
            for (const part of aliasParts) {
              if (part.length >= 3) registry.add(normalizeEntity(part));
            }
          }
        }
        // Add tech names from projects
        if (Array.isArray(proj.tech)) {
          for (const tech of proj.tech) {
            registry.add(normalizeEntity(tech));
          }
        }
      }
    }

    // 4. Add employer/company names from experience
    if (Array.isArray(knowledge.experience)) {
      for (const exp of knowledge.experience) {
        if (exp.company) {
          registry.add(normalizeEntity(exp.company));
          const parts = exp.company.split(/[\s:&()-]+/).filter(p => p.length > 1);
          for (const part of parts) {
            if (part.length >= 3) registry.add(normalizeEntity(part));
          }
        }
        if (exp.employer) {
          registry.add(normalizeEntity(exp.employer));
        }
      }
    }

    // 5. Add school name
    if (knowledge.education?.school) {
      registry.add(normalizeEntity(knowledge.education.school));
      const parts = knowledge.education.school.split(/\s+/).filter(p => p.length > 1);
      for (const part of parts) {
        if (part.length >= 3) registry.add(normalizeEntity(part));
      }
    }

    // 6. Add certification names
    if (Array.isArray(knowledge.certifications)) {
      for (const cert of knowledge.certifications) {
        const name = typeof cert === 'string' ? cert : (cert.name || '');
        if (name) {
          registry.add(normalizeEntity(name));
          const parts = name.split(/[\s:&()-]+/).filter(p => p.length > 1);
          for (const part of parts) {
            if (part.length >= 3) registry.add(normalizeEntity(part));
          }
        }
      }
    }

    // 7. Add skill names
    if (knowledge.skills) {
      const addSkillWords = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const skill of arr) {
          if (typeof skill === 'string') {
            registry.add(normalizeEntity(skill));
          } else if (skill && skill.name) {
            registry.add(normalizeEntity(skill.name));
          }
        }
      };
      for (const cat of Object.values(knowledge.skills)) {
        if (Array.isArray(cat)) addSkillWords(cat);
        else if (cat && typeof cat === 'object') addSkillWords(Object.values(cat));
      }
    }
  }

  // 8. Extract all capitalized words from the source text
  // This is the key: any capitalized word in the evidence is automatically grounded
  if (sourceText) {
    const sourceWords = sourceText.match(/\b[A-Z][A-Za-z0-9+#.-]{1,}\b/g) || [];
    for (const word of sourceWords) {
      registry.add(normalizeEntity(word));
    }
    // Also add multi-word capitalized phrases (e.g., "Voice Ops Platform")
    const sourcePhrases = sourceText.match(/\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}\b/g) || [];
    for (const phrase of sourcePhrases) {
      registry.add(normalizeEntity(phrase));
      // Also add each word of the phrase
      const parts = phrase.split(/\s+/);
      for (const part of parts) {
        if (part.length >= 3) registry.add(normalizeEntity(part));
      }
    }
  }

  return registry;
}

// --- Check if a capitalized token from the answer is grounded ---
// Uses normalized matching against the entity registry.
function isEntityGrounded(token, registry) {
  const normalized = normalizeEntity(token);
  if (normalized.length < 2) return true; // too short to be meaningful
  if (registry.has(normalized)) return true;
  // Try partial match for compound entities (e.g., "VoiceOps" might be "voiceops"
  // and the registry might have "voiceopsplatform")
  for (const entry of registry) {
    if (entry.length >= 4 && (entry.includes(normalized) || normalized.includes(entry))) {
      return true;
    }
  }
  return false;
}

// --- Extract capitalized tokens from answer text ---
function extractCapitalizedTokens(text) {
  return text.match(/\b[A-Z][A-Za-z0-9+#.-]{1,}\b/g) || [];
}

module.exports = {
  COMMON_ENGLISH,
  normalizeEntity,
  buildEntityRegistry,
  isEntityGrounded,
  extractCapitalizedTokens
};
