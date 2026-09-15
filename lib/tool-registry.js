'use strict';

/**
 * ToolRegistry — tenant-neutral capability catalog for the Scout action
 * runtime.
 *
 * A "capability" (tool) is a deterministic, audited operation the runtime
 * may execute on the model's behalf: read, search, calculate, lookup, and
 * eventually side-effecting actions (create/send/schedule) gated by
 * permission policy. The MODEL never executes code; it only proposes
 * structured tool intent. This registry holds the descriptors the
 * ToolExecutor validates against before executing anything.
 *
 * CapabilityDescriptor fields:
 *   id                 unique tool id (snake_case)
 *   name               human-readable name
 *   description        what the tool does (model-facing)
 *   inputSchema        JSON-Schema-ish { type:'object', properties, required }
 *   outputSchema       optional declared shape of the result data
 *   readOnly           true when the tool cannot mutate anything
 *   sideEffect         true when execution changes external state
 *   requiresConfirmation  true when a human must confirm before execution
 *   tenantAvailability boolean | (knowledge) => boolean — tenant gate
 *   timeoutMs          per-execution budget
 *   permissionScope    scope token a caller must hold (e.g. 'knowledge:read')
 *   handler            async (args, context) => result data
 */

const REQUIRED_DESCRIPTOR_FIELDS = ['id', 'name', 'handler'];
const KNOWN_SCOPES = new Set([
  'compute',        // pure computation, no data access
  'knowledge:read', // read tenant knowledge base
  'search:read',    // search tenant content
  'entity:read',    // resolve/lookup entities
  'action:write',   // side-effecting actions (email, CRM, schedule)
  'admin'
]);

const VALID_PROVENANCE = new Set([
  'TENANT_EVIDENCE', 'USER_INPUT', 'TOOL_RESULT', 'COMPUTED_FACT', 'GENERAL_REASONING'
]);

class ToolRegistry {
  constructor() {
    this._tools = new Map();
  }

  /**
   * Register a capability descriptor. Throws on malformed descriptors —
   * a broken tool definition must fail at registration time, never at
   * execution time inside a request.
   */
  register(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
      throw new Error('ToolRegistry: descriptor must be an object');
    }
    for (const field of REQUIRED_DESCRIPTOR_FIELDS) {
      if (!descriptor[field]) throw new Error(`ToolRegistry: descriptor missing "${field}"`);
    }
    if (typeof descriptor.handler !== 'function') {
      throw new Error(`ToolRegistry: "${descriptor.id}" handler must be a function`);
    }
    if (descriptor.permissionScope && !KNOWN_SCOPES.has(descriptor.permissionScope)) {
      throw new Error(`ToolRegistry: "${descriptor.id}" unknown permissionScope "${descriptor.permissionScope}"`);
    }
    if (descriptor.resultProvenance && !VALID_PROVENANCE.has(descriptor.resultProvenance)) {
      throw new Error(`ToolRegistry: "${descriptor.id}" invalid resultProvenance "${descriptor.resultProvenance}"`);
    }
    if (descriptor.sideEffect && !descriptor.requiresConfirmation) {
      // Side-effecting tools must opt into the confirmation gate by design;
      // a side-effecting tool without the gate is a policy violation.
      throw new Error(`ToolRegistry: side-effecting tool "${descriptor.id}" must declare requiresConfirmation`);
    }
    const normalized = {
      inputSchema: { type: 'object', properties: {}, required: [] },
      readOnly: true,
      sideEffect: false,
      requiresConfirmation: false,
      tenantAvailability: true,
      timeoutMs: 5000,
      permissionScope: 'knowledge:read',
      resultProvenance: 'TOOL_RESULT',
      ...descriptor
    };
    this._tools.set(normalized.id, Object.freeze(normalized));
    return this;
  }

  get(id) { return this._tools.get(id) || null; }

  has(id) { return this._tools.has(id); }

  /** All descriptors, optionally filtered to those available for a tenant. */
  list(knowledge = null) {
    const all = [...this._tools.values()];
    if (!knowledge) return all;
    return all.filter(d => this.isAvailableForTenant(d, knowledge));
  }

  isAvailableForTenant(descriptor, knowledge) {
    const gate = descriptor.tenantAvailability;
    if (typeof gate === 'function') return !!gate(knowledge);
    return gate !== false;
  }

  /** Model-facing catalog: only fields the model needs to choose a tool. */
  describeForModel(knowledge = null) {
    return this.list(knowledge).map(d => ({
      id: d.id,
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      readOnly: d.readOnly,
      requiresConfirmation: d.requiresConfirmation
    }));
  }
}

module.exports = { ToolRegistry, KNOWN_SCOPES, VALID_PROVENANCE };
