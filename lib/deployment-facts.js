'use strict';

/**
 * deployment-facts — runtime facts that describe THIS deployment, generated
 * from actual runtime configuration plus an optional deployment-declared
 * fact file (data/deployment-facts.json).
 *
 * Core facts (tenant-neutral architecture: model writes prose, capabilities
 * are optional, validation architecture, telemetry categories) live in
 * data/scout-runtime-knowledge.json and ship in every configuration.
 *
 * Deployment facts are different: provider, model, deadline, hosting
 * topology, and provider-specific cost/allocation claims. They are emitted
 * only from real configuration — a General Scout instance running Ollama
 * must never retrieve a fact claiming its model is hosted on Cloudflare.
 * Declared facts may carry a `provider` gate: the fact is emitted only when
 * the deployment's configured provider matches.
 */

/**
 * @param {object} config — resolved runtime configuration:
 *   { provider, model, deadlineMs, rateLimitPerMinute }
 * @param {Array}  declared — deployment-declared facts; each may carry
 *   `provider` to gate emission to that provider.
 * @returns {Array<{id:string, tag:string, text:string}>}
 */
function buildDeploymentFacts(config = {}, declared = []) {
  const facts = [];
  const provider = config.provider || null;
  const model = config.model || null;

  if (provider || model) {
    facts.push({
      id: 'deployment-inference',
      tag: 'scout-deployment',
      text: `This Scout deployment's configured generative inference provider is "${provider || 'unspecified'}"` +
        `${model ? ` using model "${model}"` : ''}. Provider and model are deployment configuration, not Scout Core identity — other deployments may use different providers or models.`
    });
  }
  if (Number.isFinite(config.deadlineMs)) {
    facts.push({
      id: 'deployment-deadline',
      tag: 'scout-deployment',
      text: `This deployment enforces a ${config.deadlineMs} ms end-to-end request deadline for chat answers.`
    });
  }
  if (Number.isFinite(config.rateLimitPerMinute)) {
    facts.push({
      id: 'deployment-rate-limit',
      tag: 'scout-deployment',
      text: `This deployment applies an application-level request-rate control of ${config.rateLimitPerMinute} chat requests per minute per IP address (unless overridden by configuration). This is an application control, separate from any provider allocation.`
    });
  }
  for (const fact of declared) {
    if (!fact || typeof fact.text !== 'string' || !fact.text.trim()) continue;
    if (fact.provider && fact.provider !== provider) continue; // provider-gated
    facts.push({ id: fact.id || 'deployment-fact', tag: fact.tag || 'scout-deployment', text: fact.text });
  }
  return facts;
}

module.exports = { buildDeploymentFacts };
