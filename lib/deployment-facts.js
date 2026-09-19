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
 *
 * Declared-fact FILES are additionally gated by an explicit deployment
 * profile: the file declares `profile` (e.g. "projecthub-hosted") and is
 * loaded only when the deployment explicitly selects that profile via
 * SCOUT_DEPLOYMENT_PROFILE, a stamped deploy-source.json
 * `deploymentProfile`, or an explicit SCOUT_DEPLOYMENT_FACTS_FILE path.
 * With no profile selected, only generated config facts are emitted — a
 * bare checkout never inherits hosted topology claims.
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

/**
 * Resolve which declared deployment facts this deployment may emit.
 *
 * Selection precedence (explicit opt-in only):
 *   1. env.SCOUT_DEPLOYMENT_FACTS_FILE — an operator-picked file; its
 *      declared facts load regardless of profile match (explicit selection
 *      IS the trust decision).
 *   2. selectedProfile — env.SCOUT_DEPLOYMENT_PROFILE, else
 *      buildInfo.deploymentProfile (stamped by the deploy pipeline into
 *      deploy-source.json). The default file loads only when its declared
 *      `profile` matches — a mismatch fails closed.
 *   3. No selection → []: only generated config facts are emitted.
 *
 * @param {object} opts
 * @param {object} [opts.env] — environment (default process.env)
 * @param {object|null} [opts.buildInfo] — deploy-source.json contents
 * @param {string} [opts.defaultFile] — path to the packaged facts file
 * @param {function} [opts.readFile] — file reader injection for tests
 * @returns {{ profile: string|null, facts: Array }}
 */
function resolveDeclaredFacts({ env = process.env, buildInfo = null, defaultFile = null, readFile = null } = {}) {
  const read = readFile || ((p) => JSON.parse(require('node:fs').readFileSync(p, 'utf8')));
  // 1. Explicit file selection — the operator chose these facts directly.
  if (env.SCOUT_DEPLOYMENT_FACTS_FILE) {
    try {
      const doc = read(env.SCOUT_DEPLOYMENT_FACTS_FILE);
      return { profile: doc?.profile || 'explicit-file', facts: doc?.facts || [] };
    } catch {
      return { profile: null, facts: [] }; // unreadable explicit file fails closed
    }
  }
  // 2. Selected profile must match the packaged file's declared profile.
  const selectedProfile = env.SCOUT_DEPLOYMENT_PROFILE || buildInfo?.deploymentProfile || null;
  if (selectedProfile && defaultFile) {
    try {
      const doc = read(defaultFile);
      if (doc?.profile === selectedProfile) {
        return { profile: selectedProfile, facts: doc?.facts || [] };
      }
      return { profile: selectedProfile, facts: [] }; // mismatch fails closed
    } catch {
      return { profile: selectedProfile, facts: [] };
    }
  }
  // 3. No explicit selection — generated config facts only.
  return { profile: null, facts: [] };
}

module.exports = { buildDeploymentFacts, resolveDeclaredFacts };
