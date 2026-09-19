'use strict';

/**
 * tool-capabilities — the default tenant-neutral capability set for the
 * Scout action runtime.
 *
 * `buildToolRegistry` wires the capabilities every Scout tenant gets:
 * pure computation, tenant-knowledge reads, entity resolution, and content
 * search — all read-only. Side-effecting capabilities (send/create/schedule)
 * register through the same registry but require `sideEffect: true` +
 * `requiresConfirmation: true`, enforced by the executor's permission gate.
 *
 * The `calculator` capability wraps the existing arithmetic engine so the
 * runtime consumes it through the generic ToolExecutor path (provenance
 * COMPUTED_FACT) instead of a bespoke call site.
 */

const { ToolRegistry } = require('./tool-registry');
const { findArithmeticSubtasks, formatComputedFacts } = require('./arithmetic-tool');
const { resolveEntity, buildRelationshipGraph } = require('./relationship-graph');
const knowledgeAccess = require('./knowledge-access');

const KNOWLEDGE_SECTIONS = [
  'summary', 'skills', 'experience', 'education', 'certifications',
  'projects', 'goals', 'boundaries', 'faq'
];

function calculatorTool() {
  return {
    id: 'calculator',
    name: 'Calculator',
    description: 'Evaluate an arithmetic or quantity-reasoning expression found in text. Returns verified computed facts.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Text containing the arithmetic subtask.' }
      },
      required: ['expression']
    },
    readOnly: true,
    sideEffect: false,
    permissionScope: 'compute',
    resultProvenance: 'COMPUTED_FACT',
    timeoutMs: 1000,
    handler: (args) => {
      const facts = findArithmeticSubtasks(String(args.expression));
      return {
        facts: facts || [],
        formatted: facts && facts.length ? formatComputedFacts(facts) : null
      };
    }
  };
}

function knowledgeLookupTool() {
  return {
    id: 'knowledge_lookup',
    name: 'Tenant knowledge lookup',
    description: 'Read one section of the tenant knowledge base (skills, experience, projects, education, boundaries, ...).',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: KNOWLEDGE_SECTIONS }
      },
      required: ['section']
    },
    readOnly: true,
    permissionScope: 'knowledge:read',
    resultProvenance: 'TENANT_EVIDENCE',
    timeoutMs: 1000,
    tenantAvailability: knowledge => !!knowledge && typeof knowledge === 'object',
    handler: (args, context) => ({
      section: args.section,
      data: context.knowledge?.[args.section] ?? null,
      found: context.knowledge?.[args.section] != null
    })
  };
}

function entityLookupTool() {
  return {
    id: 'entity_lookup',
    name: 'Entity lookup',
    description: 'Resolve a name or alias to the canonical tenant entity and return its recorded relationships.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Entity name or alias to resolve.' }
      },
      required: ['name']
    },
    readOnly: true,
    permissionScope: 'entity:read',
    resultProvenance: 'TENANT_EVIDENCE',
    timeoutMs: 1000,
    tenantAvailability: knowledge => !!knowledge,
    handler: (args, context) => {
      const graph = context.relationshipGraph || buildRelationshipGraph(context.knowledge || {});
      const canonical = resolveEntity(graph, args.name);
      if (!canonical) return { found: false, canonical: null, relationships: [] };
      const relationships = graph.triples
        .filter(t => t.subject === canonical || t.object === canonical)
        .slice(0, 20)
        .map(t => ({ predicate: t.predicate, subject: t.subject, object: t.object }));
      return {
        found: graph.entityIndex?.has(canonical) || canonical === graph.subjectNorm,
        canonical,
        relationships
      };
    }
  };
}

function contentSearchTool() {
  return {
    id: 'content_search',
    name: 'Tenant content search',
    description: 'Search tenant content chunks by relevance (BM25).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' }
      },
      required: ['query']
    },
    readOnly: true,
    permissionScope: 'search:read',
    resultProvenance: 'TENANT_EVIDENCE',
    timeoutMs: 2000,
    tenantAvailability: knowledge => !!knowledge,
    handler: (args, context) => {
      const index = context.bm25Index;
      if (!index) return { found: false, hits: [] };
      const hits = index.search(String(args.query), args.limit || 5) || [];
      return {
        found: hits.length > 0,
        hits: hits.map(h => ({
          id: h.id ?? h.chunkId ?? null,
          score: h.score ?? null,
          text: String(h.text || h.content || '').slice(0, 500)
        }))
      };
    }
  };
}

/**
 * Example side-effecting capability: proves the confirmation gate end-to-end
 * without performing a real external action. The handler is an injectable
 * adapter — production wiring (mail, CRM, scheduler) registers its own
 * descriptor with the same gate semantics.
 */
function sendNotificationTool(deliverFn = null) {
  return {
    id: 'send_notification',
    name: 'Send notification',
    description: 'Queue a notification to a recipient. Side-effecting: requires explicit user confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' }
      },
      required: ['recipient', 'subject', 'body']
    },
    readOnly: false,
    sideEffect: true,
    requiresConfirmation: true,
    // Execution semantics required of every side-effecting descriptor:
    // a mock queue is NOT idempotent (a retry could deliver twice) and the
    // adapter honors context.signal cancellation.
    idempotent: false,
    supportsAbort: true,
    permissionScope: 'action:write',
    resultProvenance: 'TOOL_RESULT',
    timeoutMs: 3000,
    tenantAvailability: knowledge => !!(knowledge?.notifications?.enabled),
    handler: deliverFn || ((args, context) => {
      if (context?.signal?.aborted) throw new Error('aborted');
      return {
        queued: true,
        adapter: 'mock',
        recipient: args.recipient,
        subject: args.subject,
        idempotencyKey: context?.idempotencyKey ?? null
      };
    })
  };
}

/**
 * Build the default registry for a request lifecycle.
 * @param {object} [opts] - { notificationDeliverer } injectable adapters.
 */
function buildToolRegistry(opts = {}) {
  const registry = new ToolRegistry();
  registry.register(calculatorTool());
  registry.register(knowledgeLookupTool());
  registry.register(entityLookupTool());
  registry.register(contentSearchTool());
  registry.register(sendNotificationTool(opts.notificationDeliverer));
  return registry;
}

module.exports = {
  buildToolRegistry,
  calculatorTool,
  knowledgeLookupTool,
  entityLookupTool,
  contentSearchTool,
  sendNotificationTool,
  KNOWLEDGE_SECTIONS
};
