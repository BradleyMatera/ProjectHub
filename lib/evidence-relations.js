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
 *   FACT 1 [source:Name]\n<text>\n\nFACT 2 [faq]\n<text>
 *
 * This parser is tolerant: it handles original FACT headers, lowercased
 * headers (after cleanText/toLowerCase), and whitespace-collapsed input.
 */
function splitEvidenceBlocks(evidenceText) {
  if (!evidenceText) return [];
  const text = String(evidenceText);
  const headerRe = /\bfact\s+\d+\s+\[([^\]]+)\]/gi;
  const matches = [];
  let m;
  while ((m = headerRe.exec(text)) !== null) {
    matches.push({ index: m.index, match: m[0], source: m[1].trim() });
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
function hasRelationCue(blockText) {
  return /\b(?:uses?|used|using|utiliz\w+|built\s+(?:with|using)|developed\s+(?:with|using|in)|implemented\s+(?:with|using|in)|written\s+(?:in|with)|powered\s+by|runs\s+on|relies\s+on|depends\s+on|tech(?:nology)?(?:\s+stack)?)\b/i.test(blockText);
}

/**
 * Determine whether the source tag indicates an authoritative block where simple
 * subject+technology co-occurrence is enough to establish the relationship.
 */
function isAuthoritativeBlock(source) {
  const tag = String(source || '').toLowerCase().split(':')[0];
  return ['project', 'projecthub', 'direct-answer', 'faq'].includes(tag);
}

/**
 * Check whether the evidence packet supports a subject-to-technology relation
 * by requiring that subjectName and technology both appear inside the SAME
 * fact block, optionally with a relationship cue.
 *
 * @param {string[]} subjectNames - One or more names/aliases for the subject
 * @param {string} technology
 * @param {string} evidenceText
 * @param {object} [options]
 * @param {function} [options.normalizeToken]
 */
function evidenceSupportsTechnologyRelation(subjectNames, technology, evidenceText, options = {}) {
  if (!subjectNames?.length || !technology || !evidenceText) return false;
  const blocks = splitEvidenceBlocks(evidenceText);
  const normalizeToken = options.normalizeToken || canonicalizeToken;
  for (const block of blocks) {
    const blockText = block.text;
    if (!blockText) continue;
    // Split each block into sentences so that cross-sentence co-occurrence
    // (e.g. "ProjectHub uses X. Triangle Shader Lab uses Y." within one block)
    // is not treated as support. The split is case-insensitive because
    // grounding-validator passes a lowercased copy of the source text.
    const sentences = blockText.split(/(?<=[.!?])\s+(?=\S)/).filter(Boolean);
    const chunks = sentences.length > 0 ? sentences : [blockText];
    for (const chunk of chunks) {
      const techAppears = phraseAppears(chunk, technology, normalizeToken);
      if (!techAppears) continue;
      for (const subjectName of subjectNames) {
        if (!subjectName) continue;
        if (phraseAppears(chunk, subjectName, normalizeToken)) {
          if (isAuthoritativeBlock(block.source) || hasRelationCue(chunk)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

module.exports = {
  splitEvidenceBlocks,
  tokenSequence,
  phraseAppearsInTokens,
  phraseAppears,
  hasRelationCue,
  isAuthoritativeBlock,
  evidenceSupportsTechnologyRelation,
  canonicalizeToken
};
