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

  const convState = buildConversationState(history || [], knowledge, sessionState);
  const activeEntity = convState.activeEntity || null;
  const alternatives = Array.isArray(convState.alternatives) ? convState.alternatives : [];

  // Entities explicitly named in the CURRENT turn. The current turn outranks
  // stale discourse context — an explicitly named entity is always the target.
  const explicitEntities = extractEntitiesFromText(resolved, knowledge, { source: 'user' })
    .filter(e => e && e.name && !subjectRefs.has(String(e.name).toLowerCase()) &&
      !_sameName(e.name, subjectName));

  const resolvedDiffers = resolved !== literal;
  const hasNonSubjectRef = NON_SUBJECT_REFERENT.test(literal);
  const hasOrdinal = ORDINAL_REF.test(literal);
  const hasComparisonRef = COMPARISON_REF.test(literal);
  const facetContinuation = FACET_CONTINUATION.test(literal) && !QUESTION_WORD.test(
    literal.replace(/^\s*(?:what|how)\s+about\b/i, '').replace(/^\s*(?:and|also|so)\s+/i, '')
  );

  // An explicitly named entity that differs from the active entity is an
  // entity-level topic shift. A named entity equal to the active entity is a
  // facet continuation on the same target.
  const namedNewEntity = explicitEntities.find(e =>
    !activeEntity || !_sameName(e.name, activeEntity.name));
  const namesActiveEntity = explicitEntities.some(e =>
    activeEntity && _sameName(e.name, activeEntity.name));

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
  } else if (facetContinuation && activeEntity) {
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
    const { buildRelationshipGraph } = require('./relationship-graph');
    const subjectNames = [subjectName, knowledge?.identity?.preferredName].filter(Boolean);
    requestedTopic = extractRequestedTopic(resolved, knowledge, subjectNames) || null;
    requestedRole = extractRequestedRole(resolved, knowledge) || null;
    const graph = knowledge ? buildRelationshipGraph(knowledge) : null;
    primaryFacet = graph
      ? assessPrimaryFacet({ question: resolved, knowledge, graph, subjectName })
      : null;
  } catch {
    // plan extraction is best-effort; retrieval falls back to literal legs
  }

  const requestedFacet = primaryFacet?.matched ? primaryFacet.facet : null;

  const topicContinuity = continuationType !== 'none' && !topicShift
    ? 'continuation'
    : (topicShift ? 'shift' : 'standalone');

  return {
    literalQuestion: literal,
    resolvedQuestion: resolved,
    subject: subjectName,
    activeEntity,
    activeEntitySource: activeEntity ? 'history' : null,
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
    userSuppliedContext: namesActiveEntity ? [activeEntity.name] : explicitEntities.map(e => e.name),
    needsRetrieval: true,
    needsTool: false,
    primaryFacet,
  };
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

  // LEG 1 — LITERAL CURRENT TURN (always present; highest protection).
  push('literal', exp(literal), 1.0);

  // LEG 2 — STRUCTURALLY RESOLVED CURRENT TURN (explicit referent
  // substitution only; never free-floating history words).
  if (resolved && resolved !== literal) {
    push('resolved', exp(resolved), 1.0);
  }

  // LEG 3 — ENTITY/FACET LEG: the resolved active entity plus the requested
  // facet. Only for genuine continuations — a topic shift supplies its own
  // target and must not inherit the old entity.
  if (plan?.activeEntity && plan.continuationType !== 'none' && !plan.topicShift) {
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

module.exports = {
  buildSemanticPlan,
  buildRetrievalLegs,
  NON_SUBJECT_REFERENT,
  ORDINAL_REF,
  COMPARISON_REF,
  FACET_CONTINUATION
};
