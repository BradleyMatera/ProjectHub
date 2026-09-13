'use strict';

/**
 * Evidence Relations — same-FACT evidence relation validation helpers.
 *
 * The RAG evidence packet is formatted as a sequence of FACT blocks by
 * lib/rag-agent.js::buildRagEvidenceText().  Each block looks like:
 *
 *   FACT 1 [source:Name]
 *   <text>
 *
 *   FACT 2 [faq]
 *   <text>
 *
 * A relationship claim should only be accepted from evidence when both the
 * subject and the object appear inside the SAME fact block.  Cross-block
 * co-occurrence is not authoritative and is ignored to avoid recombining
 * unrelated true facts into false claims.
 *
 * This module is generic and tenant-agnostic: it only manipulates text and
 * normalized token sequences.
 */

const DEFAULT_TOKEN_PATTERN = /[a-z0-9+#.\-/]+/g;

/**
 * Canonicalize a raw token for comparison.
 * Lowercases and strips remaining non-alphanumeric characters.
 * "Node.js" → "nodejs", "C++" → "cplusplus" becomes "c" (alias handled by caller).
 */
function canonicalizeToken(rawToken) {
  return String(rawToken || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Split evidence text into its fact blocks.
 *
 * Evidence is formatted by lib/rag-agent.js::buildRagEvidenceText() as:
 *   - [source:Name] <text>
 *   - [faq] <text>
 *
 * Legacy FACT headers are also accepted for backward compatibility:
 *   FACT 1 [source:Name]\n<text>\n\nFACT 2 [faq]\n<text>
 */
function splitEvidenceBlocks(evidenceInput) {
  // Structured evidence objects — build blocks directly from source data.
  if (Array.isArray(evidenceInput)) {
    return evidenceInput.map(item => ({
      header: null,
      source: item.kind || item.tag || 'unknown',
      name: item.name || null,
      sourceEntity: item.sourceEntity || null,
      aliases: Array.isArray(item.aliases) ? [...item.aliases] : [],
      category: item.category || null,
      type: item.type || null,
      builtDuring: item.builtDuring || null,
      context: item.context || null,
      text: String(item.description || item.text || '').trim(),
      raw: String(item.description || item.text || '')
    })).filter(b => b.text || b.category || b.type || b.builtDuring || b.context);
  }

  if (!evidenceInput) return [];
  const text = String(evidenceInput);
  // Match either a bullet with a source tag or the old FACT N [source] header.
  const headerRe = /(?:^|\n)\s*(?:-\s+\[([^\]]+)\]|\bfact\s+\d+\s+\[([^\]]+)\])/gi;
  const matches = [];
  let m;
  while ((m = headerRe.exec(text)) !== null) {
    matches.push({ index: m.index, match: m[0], source: (m[1] || m[2]).trim() });
  }

  if (matches.length === 0) {
    const trimmed = text.trim();
    return trimmed ? [{ header: null, source: 'unknown', text: trimmed, raw: text }] : [];
  }

  const blocks = [];
  for (let i = 0; i < matches.length; i++) {
    const curr = matches[i];
    const start = curr.index + curr.match.length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const raw = text.slice(curr.index, end);
    blocks.push({
      header: curr.match,
      source: curr.source,
      text: text.slice(start, end).trim(),
      raw
    });
  }

  // Any leftover before the first header is unmarked text.
  const first = matches[0];
  if (first.index > 0) {
    const lead = text.slice(0, first.index).trim();
    if (lead) {
      blocks.unshift({ header: null, source: 'unknown', text: lead, raw: lead });
    }
  }

  return blocks;
}

/**
 * Tokenize a string into a sequence of normalized tokens.
 * An optional normalizeToken function can be supplied for alias resolution.
 */
function tokenSequence(text, normalizeToken = canonicalizeToken) {
  const raw = String(text).toLowerCase().match(DEFAULT_TOKEN_PATTERN) || [];
  return raw.map(normalizeToken).filter(Boolean);
}

/**
 * Check whether a normalized token-sequence phrase appears as a contiguous
 * subsequence inside another token sequence.
 */
function phraseAppearsInTokens(haystackTokens, needleTokens) {
  if (!needleTokens || needleTokens.length === 0) return false;
  if (!haystackTokens || haystackTokens.length < needleTokens.length) return false;
  outer: for (let i = 0; i <= haystackTokens.length - needleTokens.length; i++) {
    for (let j = 0; j < needleTokens.length; j++) {
      if (haystackTokens[i + j] !== needleTokens[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Check whether an entity/technology phrase appears in a block of text.
 * Uses exact token-sequence matching, avoiding substring bugs like
 * "Go" matching the first two characters of "Google".
 *
 * @param {string} blockText
 * @param {string} phrase
 * @param {function} [normalizeToken]
 */
function phraseAppears(blockText, phrase, normalizeToken = canonicalizeToken) {
  const blockTokens = tokenSequence(blockText, normalizeToken);
  const phraseTokens = tokenSequence(phrase, normalizeToken);
  return phraseAppearsInTokens(blockTokens, phraseTokens);
}

/**
 * Check whether a block of evidence contains a technology relationship cue.
 * Cues are verbs/phrases that explicitly link a subject to a technology.
 */
const TECHNOLOGY_RELATION_CUE = /\b(?:uses?|used|using|utiliz(?:es?|ed|ing)|built\s+(?:with|using)|developed\s+(?:with|using|in)|implemented\s+(?:with|using|in)|written\s+(?:in|with)|powered\s+by|runs?\s+on|relies\s+on|depends\s+on|(?:tech(?:nology)?\s+stack|technologies)\s*(?::|includes?|is|are|contains?|consists\s+of))\b/gi;
const NON_ACTUAL_TECHNOLOGY = /\b(?:not|never|neither|nor|without|cannot|can['’]?t|doesn['’]?t|didn['’]?t|isn['’]?t|wasn['’]?t|won['’]?t|no\s+(?:evidence|verified|documented)|plans?|planned|planning|proposed|proposes?|consider(?:s|ed|ing)?|intends?|intended|hopes?|wants?|will|would|could|should|may|might|if|whether|compar(?:e[sd]?|ing|ison)|versus|vs|instead|rather)\b/i;

function hasRelationCue(blockText) {
  return new RegExp(TECHNOLOGY_RELATION_CUE.source, 'i').test(blockText);
}

function technologyRelationObjects(subjectNames, text, options = {}) {
  const objects = [];
  const normalizeToken = options.normalizeToken || canonicalizeToken;
  const names = subjectNames.filter(Boolean);
  const sourceNames = [options.name, options.sourceEntity, ...(options.aliases || [])]
    .map(value => typeof value === 'string' ? value : value?.name).filter(Boolean);
  const scoped = sourceNames.some(source => names.some(name =>
    phraseAppears(source, name, normalizeToken) && phraseAppears(name, source, normalizeToken)));
  const escapedNames = names.map(name => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const subjectRe = new RegExp(`^(?:(?:the|this)\\s+)?(?:project\\s+)?(?:${escapedNames.join('|')})(?:['’]s)?(?:\\s+(?:project|application|app|workflow))?(?:\\s+(?:is|was|has|been|currently|also|now))*\\s*[:,]?\\s*(.*)$`, 'i');
  const implicitSubjectRe = /^(?:(?:it|(?:the|this)\s+(?:project|application|app|workflow))\s+)?(?:(?:is|was|has|been|currently|also|now)\s+)*$/i;
  const clauses = String(text || '').replace(/https?:\/\/\S+|www\.\S+/g, ' ')
    .split(/(?<=[.!?])\s+|[;:\n]+|(?:,?\s+)(?:but|whereas|while|although|however|yet)\s+|(?:,?\s+)and\s+(?=[^,;.!?]{1,100}?\b(?:uses?|used|is|was|has|runs|plans?|compares?)\b)/i);
  for (const rawClause of clauses) {
    const clause = rawClause.trim().replace(/^(?:yes|no|correct),\s*/i, '').replace(/^[*\-\s]+/, '');
    const cues = [...clause.matchAll(new RegExp(TECHNOLOGY_RELATION_CUE.source, 'gi'))];
    for (const cue of cues) {
      const prefix = clause.slice(0, cue.index).replace(/[*_`]/g, '');
      const subjectMatch = prefix.match(subjectRe);
      const implicit = scoped && implicitSubjectRe.test(prefix);
      if (!subjectMatch && !implicit) continue;
      // Non-actual markers must be evaluated in the space between the subject
      // and the relation cue, not inside the subject name itself (e.g.
      // "AWS Pricing Comparison" contains "Comparison").
      const preCue = subjectMatch ? (subjectMatch[1] || '').trim() : '';
      if (NON_ACTUAL_TECHNOLOGY.test(preCue)) continue;
      const rest = clause.slice(cue.index + cue[0].length);
      const object = rest.split(/\s+(?:for|to|that|which|where|when|because|compared|comparing|versus|vs|rather|instead)\b|,\s*(?:not|never)\b/i)[0].trim();
      if (!object || NON_ACTUAL_TECHNOLOGY.test(object)) continue;
      objects.push(object);
    }
  }
  return objects;
}

/**
 * Determine whether the source tag identifies structured authoritative evidence.
 * A technology relationship still requires an affirmative, subject-scoped cue.
 */
function isAuthoritativeBlock(source) {
  const tag = String(source || '').toLowerCase().split(':')[0];
  return ['project', 'projecthub', 'direct-answer', 'faq'].includes(tag);
}

/**
 * Check whether the evidence packet supports a subject-to-technology relation
 * by requiring an affirmative relation between the subject and technology in
 * the SAME fact block, with structured entity metadata supplying omitted subjects.
 *
 * @param {string[]} subjectNames - One or more names/aliases for the subject
 * @param {string} technology
 * @param {string} evidenceText
 * @param {object} [options]
 * @param {function} [options.normalizeToken]
 */
function evidenceSupportsTechnologyRelation(subjectNames, technology, evidenceInput, options = {}) {
  if (!subjectNames?.length || !technology || !evidenceInput) return false;
  const blocks = splitEvidenceBlocks(evidenceInput);
  const normalizeToken = options.normalizeToken || canonicalizeToken;
  for (const block of blocks) {
    const blockText = block.text;
    if (!blockText) continue;
    // Split each block into scoped propositions so that cross-clause co-occurrence
    // (e.g. "ProjectHub uses X; Triangle Shader Lab uses Y." within one block)
    // is not treated as support. Matching remains case-insensitive because
    // grounding-validator passes a lowercased copy of the source text.
    const objects = technologyRelationObjects(subjectNames, blockText, { ...block, normalizeToken });
    if (objects.some(object => phraseAppears(object, technology, normalizeToken))) return true;
  }
  return false;
}

module.exports = {
  splitEvidenceBlocks,
  tokenSequence,
  phraseAppearsInTokens,
  phraseAppears,
  hasRelationCue,
  technologyRelationObjects,
  isAuthoritativeBlock,
  evidenceSupportsTechnologyRelation,
  canonicalizeToken
};
