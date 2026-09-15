'use strict';

// SemanticQueryPlan — one structured plan for the current turn.
//
// The plan is the single authoritative statement of what the user is asking
// about RIGHT NOW: the literal question, the referent-resolved question, the
// requested facet/topic/role, the active entity, and whether the turn
// continues the prior discourse or shifts to a new target.
//
// History may contribute ONLY resolved referents (pronouns, ordinals,
// elliptical facets, comparison alternatives). It may never contribute raw
// salient words — "Army", "AWS", "React" from an old turn must not leak into
// a new current-turn query. Current-turn semantics always have priority.

const {
  buildConversationState,
  extractEntitiesFromText
} = require('./conversation-resolver');
const { buildRelationshipGraph, resolveEntity } = require('./relationship-graph');
const knowledgeAccess = require('./knowledge-access');

// Non-subject referential syntax: references that require discourse context
// (unlike subject pronouns such as he/she/they, which point at the tenant
// subject and need no prior turn).
const NON_SUBJECT_REFERENT =
  /\b(?:it|its|itself|that|this|those|these|them)\b|\bthe\s+(?:first|second|third|fourth|fifth|last|other|former|latter)\s+one\b|\bthe\s+(?:other|former|latter)\b|\bwhich\s+(?:of|one|is|are)\b|\b(?:both|either|neither)\b/i;

// Ordinal / indexical references into an ordered alternative set.
const ORDINAL_REF =
  /\b(?:the\s+)?(?:first|second|third|fourth|fifth|last)\s+(?:one|of\s+(?:them|those|these))\b|\bthe\s+(?:other|next|previous)\s+one\b/i;

// Comparison-continuation syntax: deciding among discourse alternatives.
const COMPARISON_REF =
  /\bwhich\s+(?:of|one|is|are)\b|\b(?:stronger|strongest|better|best|worse|worst|more|most)\s+(?:of|between|among)\b|\b(?:between|among)\s+(?:them|those|these|the\s+two)\b/i;

// Bare facet-only continuation: "what about the deployment?", "and the
// warranty?", "price?" — a facet noun phrase with no entity and no verb
// clause of its own.
const FACET_CONTINUATION =
  /^\s*(?:what\s+about|how\s+about|and|also|what\s+of|so)\s+(?:the\s+|its\s+|their\s+)?[a-z0-9+#.'\s-]{1,40}\??\s*$/i;

const QUESTION_WORD =
  /\b(?:what|which|who|whose|whom|when|where|why|how|does|do|did|is|are|was|were|has|have|had|can|could|would|should)\b/i;

function _sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/**
 * Build the structured semantic plan for the current turn.
 *
 * @param {object} args
 * @param {string} args.question         - literal user message
 * @param {string} args.resolvedQuestion - referent-resolved question (may equal question)
 * @param {Array}  args.history          - conversation turns
 * @param {object} args.knowledge        - tenant knowledge
 * @param {object} args.sessionState     - server-owned session state (discourse frame)
 * @param {object} args.policy           - classified response policy (optional)
 * @param {object} args.resolution       - resolver result for the turn (optional)
 */
function buildSemanticPlan({ question, resolvedQuestion, history, knowledge, sessionState, policy, resolution } = {}) {
  const literal = String(question || '').trim();
  const resolved = String(resolvedQuestion || literal).trim();
  const subjectName = String(knowledge?.identity?.name || '').trim() || null;
  const subjectRefs = knowledgeAccess.getSubjectReferenceSet
    ? knowledgeAccess.getSubjectReferenceSet(knowledge)
    : new Set();

  const graph = knowledge ? buildRelationshipGraph(knowledge) : null;
  const subjectPronouns = knowledgeAccess.getSubjectPronouns
    ? knowledgeAccess.getSubjectPronouns(knowledge)
    : {};
  const pronounTokens = new Set(['he', 'she', 'they', 'him', 'her', 'them', 'his', 'their',
    subjectPronouns.subject, subjectPronouns.object, subjectPronouns.possessive]
    .filter(t => t && t.length >= 2).map(t => String(t).toLowerCase()));

  // A token refers to the tenant subject only when canonical graph
  // resolution agrees — a real entity bearing the same name as a subject
  // alias (project "Avery" under tenant "Avery Stone") stays an entity.
  const resolvesToSubject = name => {
    const lower = String(name || '').toLowerCase();
    if (!lower) return false;
    if (pronounTokens.has(lower)) return true;
    if (_sameName(name, subjectName)) return true;
    if (!subjectRefs.has(lower)) return false;
    if (graph && resolveEntity(graph, name) !== graph.subjectNorm) return false;
    return true;
  };

  const convState = buildConversationState(history || [], knowledge, sessionState);
  // priorActiveEntity is the discourse-state target inherited from history.
  // It is NOT necessarily this turn's target — see currentTarget below.
  const priorActiveEntity = convState.activeEntity || null;
  const alternatives = Array.isArray(convState.alternatives) ? convState.alternatives : [];

  // Entities explicitly named in the CURRENT turn. The current turn outranks
  // stale discourse context — an explicitly named entity is always the target.
  // Subject-phrase spans: a token inside a full subject-name mention
  // ("Avery Stone") is a name part, not an entity reference — even when a
  // real entity bears the colliding short name ("Avery" the project).
  const lowerResolved = resolved.toLowerCase();
  const subjectPhraseSpans = [];
  for (const phrase of [subjectName, knowledge?.identity?.preferredName, ...(knowledge?.subjectAliases || [])]) {
    const lp = String(phrase || '').toLowerCase().trim();
    if (lp.length < 3 || !lp.includes(' ')) continue; // multi-word names only
    let from = 0;
    let idx;
    while ((idx = lowerResolved.indexOf(lp, from)) >= 0) {
      subjectPhraseSpans.push([idx, idx + lp.length]);
      from = idx + lp.length;
    }
  }
  const inSubjectPhrase = e => subjectPhraseSpans.length && Number.isInteger(e.position) &&
    subjectPhraseSpans.some(([s, end]) => e.position >= s && e.position < end);

  const explicitEntities = extractEntitiesFromText(resolved, knowledge, { source: 'user' })
    .filter(e => e && e.name && !resolvesToSubject(e.name) && !inSubjectPhrase(e));

  const resolvedDiffers = resolved !== literal;
  const hasNonSubjectRef = NON_SUBJECT_REFERENT.test(literal);
  const hasOrdinal = ORDINAL_REF.test(literal);
  const hasComparisonRef = COMPARISON_REF.test(literal);
  const facetContinuation = FACET_CONTINUATION.test(literal) && !QUESTION_WORD.test(
    literal.replace(/^\s*(?:what|how)\s+about\b/i, '').replace(/^\s*(?:and|also|so)\s+/i, '')
  );

  // An explicitly named entity that differs from the prior discourse target
  // is an entity-level topic shift. A named entity equal to the prior target
  // is a facet continuation on the same target.
  const namedNewEntity = explicitEntities.find(e =>
    !priorActiveEntity || !_sameName(e.name, priorActiveEntity.name));
  const namesActiveEntity = explicitEntities.some(e =>
    priorActiveEntity && _sameName(e.name, priorActiveEntity.name));

  // Continuation requires a discourse dependency: a non-subject referent, a
  // resolver substitution, an ordinal/comparison reference, or a bare facet
  // fragment with no standalone question structure.
  let continuationType = 'none';
  if (hasComparisonRef && (alternatives.length >= 2 || convState.comparisonEntities?.length >= 2)) {
    continuationType = 'comparison';
  } else if (hasOrdinal) {
    continuationType = 'ordinal';
  } else if (resolvedDiffers || hasNonSubjectRef) {
    continuationType = 'referent';
  } else if (facetContinuation && priorActiveEntity) {
    continuationType = 'facet';
  }

  // Topic shift: the current turn supplies its own semantic target — a new
  // named entity, or a complete standalone question that does not
  // semantically depend on the prior turn. Subject pronouns (he/his/they)
  // do not create continuation — they always point at the tenant subject.
  let topicShift = false;
  let topicShiftReason = null;
  if (namedNewEntity) {
    topicShift = true;
    topicShiftReason = 'explicit-entity';
  } else if (continuationType === 'none') {
    // Standalone or new-facet question: no discourse dependency.
    topicShift = history && history.length > 0;
    topicShiftReason = history && history.length > 0 ? 'explicit-topic' : null;
  } else if (namedNewEntity && continuationType !== 'none') {
    // Referent AND new entity co-exist ("what about ProjectHub's deployment
    // after we discussed the other one") — the explicit entity wins.
    topicShift = true;
    topicShiftReason = 'explicit-entity';
  }

  // Requested facet / topic: derive lazily through the response-contract
  // extractors so the plan shares one vocabulary with the contract layer.
  // These are best-effort — extraction failures degrade to null, not errors.
  let requestedTopic = null;
  let requestedRole = null;
  let primaryFacet = null;
  try {
    const { extractRequestedTopic, extractRequestedRole } = require('./response-contract');
    const { assessPrimaryFacet } = require('./response-planner');
    const subjectNames = [subjectName, knowledge?.identity?.preferredName].filter(Boolean);
    requestedTopic = extractRequestedTopic(resolved, knowledge, subjectNames) || null;
    requestedRole = extractRequestedRole(resolved, knowledge) || null;
    primaryFacet = graph
      ? assessPrimaryFacet({ question: resolved, knowledge, graph, subjectName })
      : null;
  } catch {
    // plan extraction is best-effort; retrieval falls back to literal legs
  }

  const requestedFacet = primaryFacet?.matched ? primaryFacet.facet : null;

  // CURRENT TARGET semantics. `activeEntity` means the entity THIS turn is
  // about — never the stale historical target:
  //   - an explicit current-turn entity always wins (topic shift or not)
  //   - continuations legitimately inherit the prior discourse target
  //   - standalone/shift turns with no explicit entity have no entity target
  // `priorActiveEntity` retains the historical discourse target separately
  // so consumers can distinguish "inherited" from "current".
  const activeEntity = namedNewEntity
    ? { name: namedNewEntity.name, type: namedNewEntity.type || 'unknown', source: 'current-turn' }
    : (continuationType !== 'none' && !topicShift ? priorActiveEntity : null);
  const activeEntitySource = activeEntity
    ? (namedNewEntity ? 'current-turn' : 'history')
    : null;

  const topicContinuity = continuationType !== 'none' && !topicShift
    ? 'continuation'
    : (topicShift ? 'shift' : 'standalone');

  return {
    literalQuestion: literal,
    resolvedQuestion: resolved,
    subject: subjectName,
    activeEntity,
    activeEntitySource,
    priorActiveEntity,
    entityType: activeEntity?.type || null,
    explicitEntities: explicitEntities.map(e => ({ name: e.name, type: e.type })),
    requestedFacet,
    requestedRelation: primaryFacet?.relations?.[0] || null,
    requestedProperty: requestedFacet || requestedTopic || null,
    requestedTopic,
    requestedRole,
    alternatives,
    continuationType,
    topicShift,
    topicShiftReason,
    topicContinuity,
    explicitCriteria: Array.isArray(policy?.requiredEntities) ? policy.requiredEntities : [],
    userSuppliedContext: namesActiveEntity ? [priorActiveEntity.name] : explicitEntities.map(e => e.name),
    needsRetrieval: true,
    needsTool: false,
    primaryFacet,
  };
}

/**
 * Shared turn-planning pipeline: resolve referents (unless the caller already
 * produced a resolved question, e.g. the chat agent path), then build the
 * semantic plan. Every endpoint that derives retrieval legs or diagnostics
 * from a plan must go through this helper so equivalent inputs produce the
 * same effective plan. Endpoints without persisted session state derive all
 * available state from the supplied history — that is their explicit
 * limitation, not a divergence.
 *
 * @param {object} args - same shape as buildSemanticPlan
 * @returns {{resolvedQuestion: string, plan: object}}
 */
function planTurn(args = {}) {
  let resolved = String(args.resolvedQuestion || '').trim();
  if (!resolved) {
    try {
      resolved = require('./query-understanding').rewriteQuery(args.question, args.history, args.knowledge);
    } catch {
      resolved = args.question;
    }
  }
  const plan = buildSemanticPlan({ ...args, resolvedQuestion: resolved });
  return { resolvedQuestion: resolved, plan };
}

/**
 * Build the retrieval query legs for a plan. Every leg is derived from the
 * current turn's semantics — never from raw prior-turn vocabulary.
 *
 * @param {object} args
 * @param {object} args.plan    - buildSemanticPlan result
 * @param {Function} args.normalize - normalizeQuery
 * @param {Function} args.expand    - expandQueryAliases
 * @returns {Array<{name:string, query:string, weight:number}>}
 */
function buildRetrievalLegs({ plan, normalize, expand } = {}) {
  const norm = typeof normalize === 'function' ? normalize : (s => String(s || '').toLowerCase());
  const exp = typeof expand === 'function' ? expand : (s => s);
  const legs = [];
  const push = (name, query, weight) => {
    const q = String(query || '').trim();
    if (q && !legs.some(l => l.query === q)) legs.push({ name, query: q, weight });
  };

  const literal = norm(plan?.literalQuestion || '');
  const resolved = norm(plan?.resolvedQuestion || '');

  // LEG 1 — LITERAL CURRENT TURN (always present; weight 1.0). RRF can still
  // combine legs — this leg guarantees the current turn is always queried,
  // not a mathematical outrank guarantee.
  push('literal', exp(literal), 1.0);

  // LEG 2 — STRUCTURALLY RESOLVED CURRENT TURN (explicit referent
  // substitution only; never free-floating history words).
  if (resolved && resolved !== literal) {
    push('resolved', exp(resolved), 1.0);
  }

  // LEG 3 — ENTITY/FACET LEG: the CURRENT target entity plus the requested
  // facet. activeEntity is non-null only for an explicit current-turn entity
  // or a genuine continuation, so a topic shift can never inherit the old
  // target through this leg.
  if (plan?.activeEntity) {
    const facet = plan.requestedFacet || plan.requestedTopic || '';
    push('entity_facet', `${plan.activeEntity.name} ${facet}`.trim(), 0.9);
  }

  // LEG 4 — REQUESTED ROLE/CRITERIA leg: only when the turn explicitly
  // carries role/assessment semantics.
  if (plan?.requestedRole) {
    push('role', exp(norm(plan.requestedRole)), 0.8);
  }

  // LEG 5 — CONTINUATION leg: ordered alternative names for comparison or
  // ordinal resolution among the discourse alternative set.
  if ((plan?.continuationType === 'comparison' || plan?.continuationType === 'ordinal') &&
      Array.isArray(plan.alternatives) && plan.alternatives.length) {
    push('alternatives', plan.alternatives.map(a => a.name).join(' '), 0.8);
  }

  return legs;
}

/**
 * Semantic cache discriminator: normalized resolved question + current
 * target entity + requested facet/role. Only current-target semantics are
 * included — historical entities and raw history text never enter the key,
 * so semantically equivalent questions share a key regardless of history,
 * while different entity/facet/role targets never collide.
 */
function buildSemanticCacheKey({ plan, resolvedQuestion, normalize } = {}) {
  const norm = typeof normalize === 'function' ? normalize : (s => String(s || '').toLowerCase());
  const base = norm(resolvedQuestion || plan?.resolvedQuestion || plan?.literalQuestion || '');
  const parts = [
    plan?.activeEntity?.name,
    plan?.requestedFacet || plan?.requestedTopic,
    plan?.requestedRole
  ].filter(Boolean).map(v => String(v).toLowerCase());
  return parts.length ? `${base}|${parts.join('|')}` : base;
}

module.exports = {
  buildSemanticPlan,
  planTurn,
  buildRetrievalLegs,
  buildSemanticCacheKey,
  NON_SUBJECT_REFERENT,
  ORDINAL_REF,
  COMPARISON_REF,
  FACET_CONTINUATION
};
