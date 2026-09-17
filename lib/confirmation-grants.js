'use strict';

/**
 * ConfirmationGrantVerifier — the confirmation-grant contract for
 * side-effecting capabilities.
 *
 * A grant is issued BY the verifier and held as server-side state; the
 * caller receives only an opaque grant id. A grant is bound to:
 *   - the capability/tool id it authorizes
 *   - a digest of the normalized arguments it was issued for
 *   - the principal (caller/session identity) when one exists
 *   - an issuance time and an expiry
 *   - a unique nonce (grant id)
 *
 * Grants are one-time: a successful verify consumes the grant so the same
 * id cannot be replayed. The grant object and digest never contain raw
 * argument values — only their hash — so no user-sensitive payload becomes
 * a bearer token.
 *
 * The default ToolExecutor does NOT construct a verifier implicitly: a
 * deployment that wants executable side effects must inject one. Without an
 * injected verifier every side-effecting call is refused, regardless of
 * package allow-lists or scopes.
 */

const crypto = require('crypto');

/** Recursively sort object keys so logically identical argument sets
 *  produce identical digests regardless of property order. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function argsDigest(args) {
  return crypto.createHash('sha256').update(stableStringify(args ?? {})).digest('hex');
}

class ConfirmationGrantVerifier {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] — clock injection for tests
   * @param {number} [opts.ttlMs] — default grant lifetime (60 s)
   * @param {number} [opts.maxGrants] — bounded live-grant storage (1000)
   */
  constructor({ now = () => Date.now(), ttlMs = 60000, maxGrants = 1000 } = {}) {
    this._now = now;
    this._ttlMs = ttlMs;
    this._maxGrants = maxGrants;
    this._grants = new Map(); // id -> { toolId, argsDigest, principal, issuedAt, expiresAt, consumed }
  }

  /**
   * Issue a one-time grant for an exact capability+arguments+principal.
   * Returns { id, expiresAt } — the only values a caller needs to present.
   */
  issue({ toolId, args, principal = null, ttlMs } = {}) {
    if (!toolId || typeof toolId !== 'string') throw new Error('grant requires a toolId');
    const now = this._now();
    const ttl = Number.isFinite(ttlMs) ? ttlMs : this._ttlMs;
    const grant = {
      id: crypto.randomBytes(16).toString('hex'),
      toolId,
      argsDigest: argsDigest(args),
      principal: principal ?? null,
      issuedAt: now,
      expiresAt: now + Math.max(0, ttl),
      consumed: false
    };
    this._grants.set(grant.id, grant);
    if (this._grants.size > this._maxGrants) {
      // Evict oldest — storage stays bounded; expired entries go first.
      for (const [id, g] of this._grants) {
        if (g.consumed || g.expiresAt <= now) { this._grants.delete(id); if (this._grants.size <= this._maxGrants) break; }
      }
      while (this._grants.size > this._maxGrants) {
        this._grants.delete(this._grants.keys().next().value);
      }
    }
    return { id: grant.id, expiresAt: grant.expiresAt };
  }

  /**
   * Verify a presented grant for this exact execution. Consumes the grant
   * on success (one-time). Never throws — returns { ok, reason }.
   */
  verify(presented, { toolId, args, principal = null } = {}) {
    const id = presented && (typeof presented === 'string' ? presented : presented.id);
    const grant = id ? this._grants.get(id) : null;
    if (!grant) return { ok: false, reason: 'unknown grant' };
    if (grant.consumed) return { ok: false, reason: 'grant already consumed' };
    if (this._now() > grant.expiresAt) return { ok: false, reason: 'grant expired' };
    if (grant.toolId !== toolId) return { ok: false, reason: 'grant is not valid for this capability' };
    if (grant.argsDigest !== argsDigest(args)) return { ok: false, reason: 'grant is not valid for these arguments' };
    if (grant.principal !== null && grant.principal !== (principal ?? null)) {
      return { ok: false, reason: 'grant is not valid for this principal' };
    }
    grant.consumed = true;
    return { ok: true };
  }
}

module.exports = { ConfirmationGrantVerifier, argsDigest };
