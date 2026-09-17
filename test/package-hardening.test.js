'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  GENERAL_PACKAGE, LEGACY_CAPABILITY_POLICY, INVALID_PACKAGE_MANIFEST,
  validateDomainPackage, loadDomainPackage, transitionPackageState,
  isCapabilityAllowed, publicActionRuntimeSummary, resolveKnowledgeSource
} = require('../lib/domain-package');
const { buildToolRegistry } = require('../lib/tool-capabilities');
const { ToolRegistry } = require('../lib/tool-registry');
const { ToolExecutor, PermissionPolicy } = require('../lib/tool-executor');
const { normalizeKnowledgeEntities } = require('../lib/knowledge-entities');
const { buildRagChunks } = require('../lib/rag-chunks');
const { BM25Index } = require('../lib/bm25');

const PACKAGES_DIR = path.join(__dirname, '..', 'data', 'packages');
const registry = buildToolRegistry();
const knownCapabilities = new Map(registry.list().map(d => [d.id, d]));
const readPolicy = () => new PermissionPolicy({ scopes: ['compute', 'knowledge:read', 'search:read', 'entity:read'] });

const tenantKnowledge = (name, company, thing) => ({
  identity: { name, company },
  services: [{ name: thing, description: `${thing} by ${company}` }]
});
const pkg = (id, name, knowledge) => ({ packageVersion: 1, kind: 'domain-package', id, name, knowledge });
const validPkg = () => ({
  packageVersion: 1, kind: 'domain-package', id: 'test-tenant', name: 'Test Tenant',
  capabilities: { allow: ['calculator'] },
  knowledge: { identity: { name: 'Pat Doe' }, services: [{ name: 'Thing One', description: 'A service' }] }
});

// ──────────────────────────────────────────────────────────────────────────
// Fail-closed capability semantics (blocker 1)
// ──────────────────────────────────────────────────────────────────────────

describe('Fail-closed capability gate', () => {
  const M = caps => ({ id: 't', name: 'T', ...(caps === undefined ? {} : { capabilities: caps }) });
  const ALL_CAPS = ['calculator', 'knowledge_lookup', 'entity_lookup', 'content_search', 'send_notification'];

  it('capabilities omitted entirely → nothing enabled', () => {
    for (const cap of ALL_CAPS) assert.equal(isCapabilityAllowed(M(undefined), cap), false, cap);
  });
  it('capabilities: {} → nothing enabled', () => {
    assert.equal(isCapabilityAllowed(M({}), 'calculator'), false);
  });
  it('allow omitted → nothing enabled', () => {
    assert.equal(isCapabilityAllowed(M({ deny: [] }), 'calculator'), false);
  });
  it('allow: [] → nothing enabled', () => {
    assert.equal(isCapabilityAllowed(M({ allow: [] }), 'calculator'), false);
  });
  it('deny only → nothing enabled (deny cannot grant)', () => {
    assert.equal(isCapabilityAllowed(M({ deny: ['send_notification'] }), 'calculator'), false);
  });
  it('allow one → only that one', () => {
    const m = M({ allow: ['calculator'] });
    assert.equal(isCapabilityAllowed(m, 'calculator'), true);
    assert.equal(isCapabilityAllowed(m, 'knowledge_lookup'), false);
  });
  it('allow several → each enabled, others denied', () => {
    const m = M({ allow: ['calculator', 'knowledge_lookup', 'entity_lookup'] });
    for (const cap of ['calculator', 'knowledge_lookup', 'entity_lookup']) {
      assert.equal(isCapabilityAllowed(m, cap), true, cap);
    }
    assert.equal(isCapabilityAllowed(m, 'content_search'), false);
    assert.equal(isCapabilityAllowed(m, 'send_notification'), false);
  });
  it('deny always wins over allow', () => {
    assert.equal(isCapabilityAllowed(M({ allow: ['calculator'], deny: ['calculator'] }), 'calculator'), false);
  });
  it('unknown allowed id never becomes executable', async () => {
    const m = M({ allow: ['totally_made_up_tool'] });
    // Declared in allow, but the registry does not know it and the executor
    // refuses unknown tools — it can never actually run.
    assert.equal(registry.get('totally_made_up_tool'), null);
    const executor = new ToolExecutor(registry, { policy: readPolicy() });
    const r = await executor.execute('totally_made_up_tool', {}, { knowledge: {} });
    assert.equal(r.ok, false);
    assert.equal(r.errorType, 'UNKNOWN_TOOL');
  });
  it('null/undefined manifest → nothing enabled', () => {
    assert.equal(isCapabilityAllowed(null, 'calculator'), false);
    assert.equal(isCapabilityAllowed(undefined, 'calculator'), false);
  });
  it('validator rejects unknown capability ids when the registry is known', () => {
    const p = validPkg();
    p.capabilities = { allow: ['does_not_exist'] };
    const r = validateDomainPackage(p, { knownCapabilities });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /unknown capability/.test(e.message)));
  });
  it('General Scout: calculator only', () => {
    assert.equal(isCapabilityAllowed(GENERAL_PACKAGE, 'calculator'), true);
    for (const cap of ['knowledge_lookup', 'entity_lookup', 'content_search', 'send_notification']) {
      assert.equal(isCapabilityAllowed(GENERAL_PACKAGE, cap), false, cap);
    }
  });
  it('legacy bare-knowledge uses the explicit LEGACY_CAPABILITY_POLICY', () => {
    const r = loadDomainPackage({ identity: { name: 'X Y' }, skills: ['a'] });
    assert.equal(r.manifest.legacy, true);
    assert.deepEqual([...r.manifest.capabilities.allow], [...LEGACY_CAPABILITY_POLICY.allow]);
    assert.equal(isCapabilityAllowed(r.manifest, 'calculator'), true);
    assert.equal(isCapabilityAllowed(r.manifest, 'knowledge_lookup'), true);
    assert.equal(isCapabilityAllowed(r.manifest, 'send_notification'), false);
    assert.equal(isCapabilityAllowed(r.manifest, 'undeclared_tool'), false);
  });
  it('all shipped packages allow read-only set and deny send_notification', () => {
    for (const id of ['recruiter-alpha', 'rivera-home-electric', 'northstar-desk']) {
      const { manifest } = loadDomainPackage(path.join(PACKAGES_DIR, `${id}.package.json`));
      for (const cap of ['calculator', 'knowledge_lookup', 'entity_lookup', 'content_search']) {
        assert.equal(isCapabilityAllowed(manifest, cap), true, `${id}:${cap}`);
      }
      assert.equal(isCapabilityAllowed(manifest, 'send_notification'), false, id);
    }
  });
  it('package allow alone cannot execute a side effect (scope + confirmation still required)', async () => {
    const p = validPkg();
    p.capabilities = { allow: ['send_notification'] };
    const m = { ...p };
    assert.equal(isCapabilityAllowed(m, 'send_notification'), true); // gate open…
    const executor = new ToolExecutor(registry, { policy: readPolicy() });
    const r = await executor.execute('send_notification', { to: 'a@b.c', message: 'x' }, { knowledge: p.knowledge });
    assert.equal(r.ok, false); // …but scope/availability still refuse
    assert.ok(['PERMISSION_DENIED', 'TENANT_UNAVAILABLE', 'CONFIRMATION_REQUIRED'].includes(r.errorType));
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Package identity-bound cache transitions (blocker 2)
// ──────────────────────────────────────────────────────────────────────────

// Mini runtime mirroring fetchKnowledge semantics: knowledge snapshot, RAG
// index, response cache, readiness, tool manifest — driven by the real
// transitionPackageState decisions.
function makeMiniRuntime(baseDir) {
  const state = {
    active: null, knowledge: null, manifest: null, ready: false,
    responseCache: new Set(), chunks: [], bm25: null
  };
  state.refresh = (source) => {
    const result = loadDomainPackage(source, { baseDir, packageRoots: [baseDir] });
    const decision = transitionPackageState(state.active, result);
    if (decision.action === 'retain-stale') {
      state.active = decision.active;
      return { decision, state };
    }
    state.active = decision.active;
    state.manifest = decision.manifest;
    state.knowledge = decision.knowledge || {};
    state.chunks = buildRagChunks(state.knowledge);
    state.bm25 = new BM25Index(state.chunks);
    state.responseCache.clear();
    state.ready = decision.action === 'publish';
    return { decision, state };
  };
  return state;
}

describe('Package identity-bound cache transitions', () => {
  let dir;
  const write = (name, obj) => fs.writeFileSync(path.join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));

  function setup() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-pkg-'));
    write('alpha-k.json', tenantKnowledge('Ana Sol', 'Atlas Bakery', 'Sourdough Subscription'));
    write('alpha.package.json', pkg('atlas-bakery', 'Atlas Bakery', { source: 'alpha-k.json' }));
    write('beta.package.json', pkg('copperline-gym', 'Copperline Gym', tenantKnowledge('Bo Kim', 'Copperline Gym', 'Climbing Membership')));
    write('bad.package.json', pkg('broken', 'Broken', 'not-an-object'));
    write('legacy.json', tenantKnowledge('Lee Okafor', 'Meridian Drygoods', 'Restock Service'));
    write('k1.json', tenantKnowledge('Ana Sol', 'Atlas Bakery', 'Catering V1'));
    write('k2.json', tenantKnowledge('Ana Sol', 'Atlas Bakery', 'Catering V2'));
    write('switchable.package.json', pkg('switchable', 'Switchable', { source: 'k1.json' }));
  }

  it('A valid → same package file malformed → drop, NOT retain (identity unprovable)', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    rt.refresh('alpha.package.json');
    write('alpha.package.json', 'this is not json{{{');
    const r = rt.refresh('alpha.package.json');
    assert.equal(r.decision.action, 'drop');
    assert.deepEqual(r.state.knowledge, {});
    assert.equal(r.state.ready, false);
    assert.equal(r.state.manifest.id, 'package-error');
  });

  it('A valid → same pathname but different tenant + invalid → drop with zero A evidence', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    rt.refresh('alpha.package.json');
    // Tenant B written over the same package pathname, but invalid
    write('alpha.package.json', pkg('copperline-gym', 'Copperline Gym', 'not-an-object'));
    const r = rt.refresh('alpha.package.json');
    assert.equal(r.decision.action, 'drop');
    const flat = JSON.stringify(r.state.chunks);
    assert.ok(!flat.includes('Atlas Bakery'));
    assert.ok(!flat.includes('Ana Sol'));
  });

  it('A valid external-source package → same config, knowledge temporarily corrupt → retain-stale', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    let r = rt.refresh('alpha.package.json');
    assert.equal(r.decision.action, 'publish');
    const snapshot = r.state.knowledge;
    // Package file bytes unchanged; only the backing knowledge file breaks
    write('alpha-k.json', '{corrupt json[');
    r = rt.refresh('alpha.package.json');
    assert.equal(r.decision.action, 'retain-stale');
    assert.equal(r.state.knowledge, snapshot); // last validated snapshot retained
    assert.equal(r.state.active.stale, true);
    assert.equal(r.state.active.status, 'stale');
  });

  it('A valid → same path, changed manifest id + invalid config → drop', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    rt.refresh('alpha.package.json');
    write('alpha.package.json', { packageVersion: 1, id: 'different-tenant', name: 'Different', knowledge: 'bad' });
    const r = rt.refresh('alpha.package.json');
    assert.equal(r.decision.action, 'drop');
    assert.equal(r.state.ready, false);
  });

  it('inline package valid → invalid edit → drop (config fingerprint changed)', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    const inline = { packageVersion: 1, kind: 'domain-package', id: 'inl', name: 'Inline', knowledge: tenantKnowledge('Ro Ban', 'Kite School', 'Lessons') };
    let r = rt.refresh(inline);
    assert.equal(r.decision.action, 'publish');
    const edited = { ...inline, knowledge: 'broken' };
    r = rt.refresh(edited);
    assert.equal(r.decision.action, 'drop');
    assert.equal(r.state.ready, false);
  });

  it('A valid → B invalid switch → drop (no tenant leak)', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    rt.refresh('alpha.package.json');
    rt.responseCache.add('cached-reply');
    const r = rt.refresh('bad.package.json');
    assert.equal(r.decision.action, 'drop');
    assert.deepEqual(r.state.knowledge, {});
    assert.equal(r.state.ready, false);
    assert.equal(r.state.manifest.id, 'package-error');
    assert.equal(r.state.responseCache.size, 0);
    // RAG index rebuilt from empty knowledge — no tenant facts survive
    assert.ok(!JSON.stringify(r.state.chunks).includes('Atlas Bakery'));
    assert.ok(!JSON.stringify(r.state.chunks).includes('Ana Sol'));
    assert.equal(isCapabilityAllowed(r.state.manifest, 'calculator'), false);
  });

  it('A valid → B valid switch → publish B only, cache cleared', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    rt.refresh('alpha.package.json');
    rt.responseCache.add('cached-reply');
    const r = rt.refresh('beta.package.json');
    assert.equal(r.decision.action, 'publish');
    assert.equal(r.state.knowledge.identity.company, 'Copperline Gym');
    const flat = JSON.stringify(r.state.chunks);
    assert.ok(flat.includes('Copperline Gym'));
    assert.ok(!flat.includes('Atlas Bakery'));
    assert.equal(r.state.responseCache.size, 0);
  });

  it('B → general → publish empty knowledge explicitly', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    rt.refresh('beta.package.json');
    const r = rt.refresh('general');
    assert.equal(r.decision.action, 'publish');
    assert.deepEqual(r.state.knowledge, {});
    assert.equal(r.state.manifest.id, 'general-scout');
    assert.equal(r.state.ready, true); // general is a valid ready state
    // Remaining chunks are deployment-neutral runtime facts only — no
    // prior-tenant entities, names, or scope claims survive the switch.
    const flat = JSON.stringify(r.state.chunks);
    for (const banned of ['Copperline Gym', 'Bo Kim', 'Climbing Membership', 'the candidate']) {
      assert.ok(!flat.includes(banned), `stale tenant fact leaked: ${banned}`);
    }
  });

  it('general → A → publish A', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    rt.refresh('general');
    const r = rt.refresh('alpha.package.json');
    assert.equal(r.decision.action, 'publish');
    assert.equal(r.state.knowledge.identity.company, 'Atlas Bakery');
  });

  it('legacy → package → publish package', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    let r = rt.refresh('legacy.json');
    assert.equal(r.decision.action, 'publish');
    assert.equal(r.state.manifest.legacy, true);
    r = rt.refresh('alpha.package.json');
    assert.equal(r.decision.action, 'publish');
    assert.equal(r.state.manifest.id, 'atlas-bakery');
  });

  it('package → legacy → publish legacy with explicit compat policy', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    rt.refresh('alpha.package.json');
    const r = rt.refresh('legacy.json');
    assert.equal(r.decision.action, 'publish');
    assert.equal(r.state.manifest.legacy, true);
    assert.equal(isCapabilityAllowed(r.state.manifest, 'calculator'), true);
    assert.equal(isCapabilityAllowed(r.state.manifest, 'send_notification'), false);
  });

  it('same package id, knowledge source changed + valid → publish new knowledge', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    rt.refresh('switchable.package.json');
    assert.ok(JSON.stringify(rt.chunks).includes('Catering V1'));
    write('switchable.package.json', pkg('switchable', 'Switchable', { source: 'k2.json' }));
    const r = rt.refresh('switchable.package.json');
    assert.equal(r.decision.action, 'publish');
    const flat = JSON.stringify(rt.chunks);
    assert.ok(flat.includes('Catering V2'));
    assert.ok(!flat.includes('Catering V1'));
  });

  it('same package id, knowledge source changed + missing → drop not retain', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    rt.refresh('switchable.package.json');
    write('switchable.package.json', pkg('switchable', 'Switchable', { source: 'missing.json' }));
    const r = rt.refresh('switchable.package.json');
    assert.equal(r.decision.action, 'drop');
    assert.deepEqual(r.state.knowledge, {});
    assert.equal(r.state.ready, false);
  });

  it('invalid initial load → drop, never falls into other knowledge', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    const r = rt.refresh('bad.package.json');
    assert.equal(r.decision.action, 'drop');
    assert.deepEqual(r.state.knowledge, {});
    assert.equal(r.state.manifest.id, 'package-error');
  });

  it('drop → later valid package publishes cleanly', () => {
    setup();
    const rt = makeMiniRuntime(dir);
    rt.refresh('bad.package.json');
    const r = rt.refresh('beta.package.json');
    assert.equal(r.decision.action, 'publish');
    assert.equal(r.state.knowledge.identity.company, 'Copperline Gym');
    assert.equal(r.state.ready, true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// knowledge.source path security
// ──────────────────────────────────────────────────────────────────────────

describe('knowledge.source path security', () => {
  let dir;
  let siblingDir; // outside the package root — the traversal target
  const write = (base, name, obj) => fs.writeFileSync(path.join(base, name), JSON.stringify(obj));

  function setup() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-path-'));
    write(dir, 'inside.json', tenantKnowledge('Nia Park', 'Harbor Fleet', 'Engine Overhaul'));
    fs.mkdirSync(path.join(dir, 'sub'));
    write(dir, path.join('sub', 'nested.json'), tenantKnowledge('Nia Park', 'Harbor Fleet', 'Hull Survey'));
    siblingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-out-'));
    write(siblingDir, 'secret.json', tenantKnowledge('Eve', 'Outside Corp', 'Secrets'));
  }
  const escapeRef = file => `../${path.basename(siblingDir)}/${file}`;
  const load = name => loadDomainPackage(path.join(dir, name), { packageRoots: [dir] });

  it('rejects ../ traversal outside approved roots', () => {
    setup();
    write(dir, 'evil.package.json', pkg('evil', 'Evil', { source: escapeRef('secret.json') }));
    const r = load('evil.package.json');
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /outside the approved roots/.test(e.message)), JSON.stringify(r.errors));
  });

  it('rejects absolute knowledge.source', () => {
    setup();
    write(dir, 'abs.package.json', pkg('abs', 'Abs', { source: path.join(dir, 'inside.json') }));
    const r = load('abs.package.json');
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /absolute/.test(e.message)));
  });

  it('accepts a nested source inside the package root', () => {
    setup();
    write(dir, 'nested.package.json', pkg('harbor-fleet', 'Harbor Fleet', { source: 'sub/nested.json' }));
    const r = load('nested.package.json');
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.knowledge.identity.company, 'Harbor Fleet');
  });

  it('rejects doubled traversal that exits and re-enters', () => {
    setup();
    write(dir, 'evil2.package.json', pkg('evil2', 'Evil2', { source: `sub/../../${path.basename(siblingDir)}/secret.json` }));
    const r = load('evil2.package.json');
    assert.equal(r.ok, false);
  });

  it('rejects backslash traversal (Windows-style separators)', () => {
    setup();
    write(dir, 'evil3.package.json', pkg('evil3', 'Evil3', { source: `..\\${path.basename(siblingDir)}\\secret.json` }));
    const r = load('evil3.package.json');
    // On Windows this resolves outside the root (confinement error); on
    // POSIX the literal filename does not exist (read error). Either fails.
    assert.equal(r.ok, false);
  });

  it('approves an explicitly configured extra root', () => {
    setup();
    write(dir, 'evil.package.json', pkg('evil', 'Evil', { source: escapeRef('secret.json') }));
    const denied = loadDomainPackage(path.join(dir, 'evil.package.json'), { packageRoots: [dir] });
    assert.equal(denied.ok, false);
    const allowed = loadDomainPackage(path.join(dir, 'evil.package.json'), { packageRoots: [dir], approvedRoots: [dir, siblingDir] });
    assert.equal(allowed.ok, true, JSON.stringify(allowed.errors));
    assert.equal(allowed.knowledge.identity.company, 'Outside Corp');
  });

  it('resolveKnowledgeSource confines to package dir + data root by default', () => {
    setup();
    const r = resolveKnowledgeSource(dir, 'inside.json', { baseDir: dir });
    assert.ok(r.path && r.path.endsWith('inside.json'));
    const bad = resolveKnowledgeSource(dir, escapeRef('secret.json'), { baseDir: dir });
    assert.ok(bad.error);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Package-file source confinement (blocker 7 — runtime trust boundary)
// ──────────────────────────────────────────────────────────────────────────

describe('package-file source security', () => {
  let dir;
  let outsideDir;
  const write = (base, name, obj) => fs.writeFileSync(path.join(base, name), JSON.stringify(obj));

  function setup() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-pkgsrc-'));
    write(dir, 'ok.package.json', pkg('harbor-fleet', 'Harbor Fleet', tenantKnowledge('Nia Park', 'Harbor Fleet', 'Hull Survey')));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-outside-'));
    write(outsideDir, 'outside.package.json', pkg('outside-tenant', 'Outside', tenantKnowledge('Eve', 'Outside Corp', 'Secrets')));
  }

  it('rejects a package file outside the default data root', () => {
    setup();
    const r = loadDomainPackage(path.join(dir, 'ok.package.json'), { baseDir: dir });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /outside the approved package roots/.test(e.message)), JSON.stringify(r.errors));
  });

  it('accepts a package file inside an explicitly approved root', () => {
    setup();
    const r = loadDomainPackage(path.join(dir, 'ok.package.json'), { baseDir: dir, packageRoots: [dir] });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.manifest.id, 'harbor-fleet');
  });

  it('rejects ../ traversal to a package file outside approved roots', () => {
    setup();
    const rel = path.join('..', path.basename(outsideDir), 'outside.package.json');
    const r = loadDomainPackage(rel, { baseDir: dir, packageRoots: [dir] });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /outside the approved package roots/.test(e.message)));
  });

  it('rejects a package symlink escaping approved roots', () => {
    setup();
    const link = path.join(dir, 'linked.package.json');
    try {
      fs.symlinkSync(path.join(outsideDir, 'outside.package.json'), link);
    } catch {
      return; // platform without symlink permission — nothing to prove here
    }
    const r = loadDomainPackage(link, { baseDir: dir, packageRoots: [dir] });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /symlink|outside/.test(e.message)), JSON.stringify(r.errors));
  });

  it('shipped packages load under the default data root from the repo', () => {
    const r = loadDomainPackage(path.join(PACKAGES_DIR, 'rivera-home-electric.package.json'), { baseDir: path.join(__dirname, '..') });
    assert.equal(r.ok, true);
    assert.equal(r.manifest.id, 'rivera-home-electric');
  });

  it('trustedOperator bypasses confinement for operator-selected files', () => {
    setup();
    const r = loadDomainPackage(path.join(outsideDir, 'outside.package.json'), { trustedOperator: true });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.manifest.id, 'outside-tenant');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// runtime key rejection (blocker 4 — removed from V1 contract)
// ──────────────────────────────────────────────────────────────────────────

describe('package.runtime rejected from V1 contract', () => {
  for (const runtime of [{}, { deadlineMs: 14999 }, { deadlineMs: 15000 }, { deadlineMs: 15001 }, { deadlineMs: '15000' }, { deadlineMs: -1 }, { deadlineMs: null }, { deadlineMs: 999999 }, 'anything', 42]) {
    it(`rejects runtime=${JSON.stringify(runtime)}`, () => {
      const p = validPkg(); p.runtime = runtime;
      const r = validateDomainPackage(p);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some(e => e.path === 'runtime'));
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Public health projection + audit redaction (blocker 3)
// ──────────────────────────────────────────────────────────────────────────

describe('Public health projection', () => {
  it('publicActionRuntimeSummary exposes safe aggregates only', () => {
    const { manifest } = loadDomainPackage(path.join(PACKAGES_DIR, 'rivera-home-electric.package.json'));
    const summary = publicActionRuntimeSummary({
      registry, manifest, auditEntries: [{ a: 1 }, { a: 2 }], configured: true
    });
    assert.deepEqual(Object.keys(summary).sort(),
      ['auditBuffered', 'enabled', 'enabledCapabilities', 'registeredCapabilities'].sort());
    assert.equal(summary.enabled, true);
    assert.equal(summary.registeredCapabilities, registry.list().length);
    assert.equal(summary.enabledCapabilities, 4);
    assert.equal(summary.auditBuffered, 2);
    const serialized = JSON.stringify(summary);
    for (const banned of ['recentActions', 'args', 'arguments', 'to:', 'message', 'email', 'token', 'result']) {
      assert.ok(!serialized.includes(banned), `leaked "${banned}" in ${serialized}`);
    }
  });

  it('audit entries record arg KEYS only — never values, tokens, or payloads', async () => {
    const executor = new ToolExecutor(registry, {
      policy: new PermissionPolicy({ scopes: ['compute'], canConfirm: true })
    });
    await executor.execute('calculator', { expression: 'secret-token-123 + 1' }, { confirmationToken: 'tok-abc' });
    const entries = executor.audit.entries();
    const last = entries[entries.length - 1];
    assert.deepEqual(last.args, ['expression']); // key only
    const flat = JSON.stringify(entries);
    assert.ok(!flat.includes('secret-token-123'));
    assert.ok(!flat.includes('tok-abc'));
    assert.ok(!('confirmationToken' in last));
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Non-recruiter schema fixtures (contract tests, not shipped apps)
// ──────────────────────────────────────────────────────────────────────────

describe('Non-recruiter package schema fixtures', () => {
  it('equipment-maintenance package with custom sections validates', () => {
    const p = {
      packageVersion: 1, kind: 'domain-package', id: 'harbor-fleet-maintenance', name: 'Harbor Fleet Maintenance',
      knowledge: {
        identity: { name: 'Dock Ops Desk', company: 'Harbor Fleet' },
        services: [{ name: 'Engine Overhaul', description: 'Diesel engine overhaul', attributes: { intervalHours: 2000 } }],
        vessels: [{ hull: 'HF-104', class: 'tug', status: 'active' }],
        maintenanceWindows: { next: '2026-10-01', slip: 'B3' },
        complianceFlags: ['solas-2024']
      },
      capabilities: { allow: ['calculator', 'knowledge_lookup', 'entity_lookup'] }
    };
    const r = validateDomainPackage(p, { knownCapabilities });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const loaded = loadDomainPackage(p);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.knowledge.vessels[0].hull, 'HF-104');
  });

  it('academic/research package validates; entity collisions still caught', () => {
    const p = {
      packageVersion: 1, kind: 'domain-package', id: 'meridian-archives', name: 'Meridian Archives',
      knowledge: {
        identity: { name: 'Dr. Imre Voss', title: 'Curator' },
        publications: [
          { name: 'Tidal Cartography', description: 'Paper on coastal mapping', aliases: ['the mapping paper'] },
          { name: 'Signal Decay', description: 'Paper on archival media loss' }
        ],
        collections: { open: ['maps', 'letters'], restricted: ['estate-1890'] },
        readingRoomHours: 'Tue-Fri 10-16'
      },
      capabilities: { allow: ['knowledge_lookup', 'entity_lookup'] }
    };
    const r = validateDomainPackage(p, { knownCapabilities });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const entities = normalizeKnowledgeEntities(p.knowledge);
    assert.equal(entities.length, 2);
    assert.ok(entities.every(e => e.type === 'publication'));
    const dup = JSON.parse(JSON.stringify(p));
    dup.knowledge.products = [{ name: 'tidal cartography', description: 'x' }];
    const bad = validateDomainPackage(dup, { knownCapabilities });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some(e => /duplicate entity name/i.test(e.message)));
  });
});

// ──────────────────────────────────────────────────────────────────────────
// General Scout as a first-class empty-knowledge mode
// ──────────────────────────────────────────────────────────────────────────

describe('General Scout proof', () => {
  it('general package carries no tenant identity or knowledge', () => {
    const r = loadDomainPackage('general');
    assert.equal(r.ok, true);
    const flat = JSON.stringify(r.knowledge) + JSON.stringify(r.manifest);
    for (const banned of ['Bradley', 'Matera', 'recruiter', 'ProjectHub', 'Rivera', 'Northstar']) {
      assert.ok(!flat.includes(banned), `leaked ${banned}`);
    }
    assert.equal(r.manifest.capabilities.allow.length, 1);
    assert.equal(r.manifest.capabilities.allow[0], 'calculator');
  });

  it('general mode: compute available with typed provenance, tenant tools denied', async () => {
    const executor = new ToolExecutor(registry, { policy: readPolicy() });
    const calc = await executor.execute('calculator', { expression: '7*8' }, { knowledge: {} });
    assert.equal(calc.ok, true);
    assert.equal(calc.provenance, 'COMPUTED_FACT');
    for (const cap of ['knowledge_lookup', 'entity_lookup', 'content_search']) {
      assert.equal(isCapabilityAllowed(GENERAL_PACKAGE, cap), false, cap);
    }
  });

  it('package → general switch leaves no prior-tenant evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-gen-'));
    fs.writeFileSync(path.join(dir, 't.package.json'), JSON.stringify(
      pkg('atlas-bakery', 'Atlas Bakery', tenantKnowledge('Ana Sol', 'Atlas Bakery', 'Sourdough Subscription'))));
    const rt = makeMiniRuntime(dir);
    rt.refresh('t.package.json');
    assert.ok(JSON.stringify(rt.chunks).includes('Atlas Bakery'));
    const r = rt.refresh('general');
    assert.equal(r.decision.action, 'publish');
    assert.deepEqual(rt.knowledge, {});
    assert.equal(rt.manifest.id, 'general-scout');
    assert.equal(normalizeKnowledgeEntities(rt.knowledge).length, 0);
    const flat = JSON.stringify(rt.chunks);
    for (const banned of ['Atlas Bakery', 'Ana Sol', 'Sourdough', 'the candidate', 'recruiter', 'Bradley']) {
      assert.ok(!flat.includes(banned), `stale fact leaked into general mode: ${banned}`);
    }
  });

  it('general mode: no entities, no tenant chunks, no direct-KB surface', () => {
    const r = loadDomainPackage('general');
    assert.equal(normalizeKnowledgeEntities(r.knowledge).length, 0);
    const chunks = buildRagChunks(r.knowledge);
    const flat = JSON.stringify(chunks);
    // Only deployment-neutral runtime facts remain — zero tenant claims.
    for (const banned of ['Bradley', 'Matera', 'recruiter', 'ProjectHub', 'the candidate', 'Rivera', 'Northstar']) {
      assert.ok(!flat.includes(banned), `tenant claim in general-mode chunks: ${banned}`);
    }
    assert.ok(chunks.every(c => c.runtimeFact === true), 'general mode may only carry neutral runtime facts');
    assert.equal(r.knowledge.directAnswers, undefined);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Executor-enforced capability policy (blocker 1 — boundary, not call-site)
// ──────────────────────────────────────────────────────────────────────────

describe('Executor-level capability policy', () => {
  const KB2 = tenantKnowledge('Test User', 'Test Co', 'Test Service');
  const allowOnly = (...ids) => id => ids.includes(id);
  const ex = (capabilityPolicy, opts = {}) => new ToolExecutor(registry, {
    policy: readPolicy(), capabilityPolicy, ...opts
  });

  it('CAP-NOT-ALLOWED: direct executor call to a package-denied capability refuses', async () => {
    // A caller that skips lite-agent entirely still cannot execute a denied
    // capability — the executor enforces the package policy itself.
    const e = ex(allowOnly('knowledge_lookup'));
    const r = await e.execute('calculator', { expression: '2+2' }, { knowledge: KB2 });
    assert.equal(r.status, 'refused');
    assert.equal(r.errorType, 'CAPABILITY_NOT_ALLOWED');
  });

  it('allowed capability executes through the injected policy', async () => {
    const e = ex(allowOnly('calculator'));
    const r = await e.execute('calculator', { expression: '2+2' }, { knowledge: KB2 });
    assert.equal(r.ok, true);
  });

  it('deny wins when a policy allows then denies', async () => {
    // Simulate manifest allow+deny on the same id through the real gate
    const manifest = { capabilities: { allow: ['calculator'], deny: ['calculator'] } };
    const e = ex(id => isCapabilityAllowed(manifest, id));
    const r = await e.execute('calculator', { expression: '2+2' }, {});
    assert.equal(r.errorType, 'CAPABILITY_NOT_ALLOWED');
  });

  it('missing capabilities / allow:[] refuse everything', async () => {
    for (const manifest of [{}, { capabilities: {} }, { capabilities: { allow: [] } }]) {
      const e = ex(id => isCapabilityAllowed(manifest, id));
      const r = await e.execute('calculator', { expression: '2+2' }, {});
      assert.equal(r.errorType, 'CAPABILITY_NOT_ALLOWED', JSON.stringify(manifest));
    }
  });

  it('General Scout policy permits calculator only, at the executor', async () => {
    const e = ex(id => isCapabilityAllowed(GENERAL_PACKAGE, id));
    assert.equal((await e.execute('calculator', { expression: '2+2' }, {})).ok, true);
    assert.equal((await e.execute('knowledge_lookup', { section: 'skills' }, { knowledge: KB2 })).errorType, 'CAPABILITY_NOT_ALLOWED');
  });

  it('legacy policy at the executor: read-only set enabled, notification refused', async () => {
    const e = ex(id => isCapabilityAllowed({ capabilities: LEGACY_CAPABILITY_POLICY }, id));
    assert.equal((await e.execute('calculator', { expression: '2+2' }, {})).ok, true);
    assert.equal((await e.execute('send_notification', { recipient: 'a', subject: 'b', body: 'c' }, { knowledge: KB2 })).errorType, 'CAPABILITY_NOT_ALLOWED');
  });

  it('invalid package manifest (deny-all) refuses everything', async () => {
    const e = ex(id => isCapabilityAllowed(INVALID_PACKAGE_MANIFEST, id));
    for (const cap of ['calculator', 'knowledge_lookup', 'send_notification']) {
      const r = await e.execute(cap, cap === 'calculator' ? { expression: '1+1' } : {}, {});
      assert.equal(r.errorType, 'CAPABILITY_NOT_ALLOWED', cap);
    }
  });

  it('a throwing policy gate fails closed', async () => {
    const e = ex(() => { throw new Error('policy boom'); });
    const r = await e.execute('calculator', { expression: '2+2' }, {});
    assert.equal(r.errorType, 'CAPABILITY_NOT_ALLOWED');
  });

  it('denied attempts are audited and do not silently return []', async () => {
    const e = ex(allowOnly('knowledge_lookup'));
    const r = await e.execute('calculator', { expression: '2+2' }, {});
    assert.equal(r.ok, false);
    assert.equal(r.errorType, 'CAPABILITY_NOT_ALLOWED');
    const last = e.audit.entries().at(-1);
    assert.equal(last.status, 'refused');
    assert.equal(last.errorType, 'CAPABILITY_NOT_ALLOWED');
    assert.equal(last.tool, 'calculator');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Confirmation grants (blocker 2 — no truthy-string bypass)
// ──────────────────────────────────────────────────────────────────────────

describe('ConfirmationGrantVerifier', () => {
  const { ConfirmationGrantVerifier } = require('../lib/confirmation-grants');
  const writeArgs = { recipient: 'a@b.co', subject: 's', body: 'b' };
  const writer = () => {
    const reg = new ToolRegistry();
    reg.register(require('../lib/tool-capabilities').sendNotificationTool(() => ({ queued: true })));
    return reg;
  };
  const exWith = (verifier, opts = {}) => new ToolExecutor(writer(), {
    policy: new PermissionPolicy({ scopes: ['action:write'], canConfirm: true }),
    confirmationVerifier: verifier, ...opts
  });

  it('missing grant rejected', async () => {
    const r = await exWith(new ConfirmationGrantVerifier()).execute('send_notification', writeArgs, {});
    assert.equal(r.errorType, 'CONFIRMATION_REQUIRED');
  });

  it('arbitrary string rejected — no truthy bypass', async () => {
    const e = exWith(new ConfirmationGrantVerifier());
    for (const fake of ['yes', 'confirm-1', 'true', { id: 'forged' }]) {
      const r = await e.execute('send_notification', writeArgs, { confirmationGrant: fake });
      assert.equal(r.errorType, 'CONFIRMATION_REQUIRED', JSON.stringify(fake));
    }
  });

  it('no verifier injected at all → side effects always refused', async () => {
    const e = new ToolExecutor(writer(), {
      policy: new PermissionPolicy({ scopes: ['action:write'], canConfirm: true })
    });
    const r = await e.execute('send_notification', writeArgs, { confirmationToken: 'anything' });
    assert.equal(r.errorType, 'CONFIRMATION_REQUIRED');
  });

  it('grant for tool A cannot authorize tool B', async () => {
    const v = new ConfirmationGrantVerifier();
    const grant = v.issue({ toolId: 'other_tool', args: writeArgs });
    const r = await exWith(v).execute('send_notification', writeArgs, { confirmationGrant: grant });
    assert.equal(r.errorType, 'CONFIRMATION_REQUIRED');
  });

  it('grant for args A cannot authorize args B', async () => {
    const v = new ConfirmationGrantVerifier();
    const grant = v.issue({ toolId: 'send_notification', args: { ...writeArgs, body: 'original' } });
    const r = await exWith(v).execute('send_notification', { ...writeArgs, body: 'changed' }, { confirmationGrant: grant });
    assert.equal(r.errorType, 'CONFIRMATION_REQUIRED');
  });

  it('expired grant rejected', async () => {
    let now = 1000000;
    const v = new ConfirmationGrantVerifier({ now: () => now, ttlMs: 1000 });
    const grant = v.issue({ toolId: 'send_notification', args: writeArgs });
    now += 2000;
    const r = await exWith(v).execute('send_notification', writeArgs, { confirmationGrant: grant });
    assert.equal(r.errorType, 'CONFIRMATION_REQUIRED');
  });

  it('consumed grant cannot replay', async () => {
    const v = new ConfirmationGrantVerifier();
    const e = exWith(v);
    const grant = v.issue({ toolId: 'send_notification', args: writeArgs });
    const first = await e.execute('send_notification', writeArgs, { confirmationGrant: grant });
    assert.equal(first.ok, true);
    const replay = await e.execute('send_notification', writeArgs, { confirmationGrant: grant });
    assert.equal(replay.errorType, 'CONFIRMATION_REQUIRED');
  });

  it('principal binding: grant issued for session A fails for session B', async () => {
    const v = new ConfirmationGrantVerifier();
    const grant = v.issue({ toolId: 'send_notification', args: writeArgs, principal: 'session-a' });
    const wrong = await exWith(v).execute('send_notification', writeArgs, { confirmationGrant: grant, sessionId: 'session-b' });
    assert.equal(wrong.errorType, 'CONFIRMATION_REQUIRED');
    const right = await exWith(v).execute('send_notification', writeArgs, { confirmationGrant: grant, sessionId: 'session-a' });
    assert.equal(right.ok, true);
  });

  it('no confirmation value appears in audit or model output', async () => {
    const v = new ConfirmationGrantVerifier();
    const e = exWith(v);
    const grant = v.issue({ toolId: 'send_notification', args: writeArgs });
    const res = await e.execute('send_notification', writeArgs, { confirmationGrant: grant });
    const flat = JSON.stringify(e.audit.entries()) + JSON.stringify(res.forModel());
    assert.ok(!flat.includes(grant.id), 'grant id must not leak');
    assert.ok(!flat.includes('confirmationGrant'));
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Handler error sanitization (blocker 3)
// ──────────────────────────────────────────────────────────────────────────

describe('Handler error sanitization', () => {
  it('SUPER_SECRET_MARKER never reaches model, audit, or public projection', async () => {
    const reg = new ToolRegistry();
    reg.register({
      id: 'leaky', name: 'Leaky', permissionScope: 'compute',
      handler: () => { throw new Error('SUPER_SECRET_MARKER_123'); }
    });
    const diagnostics = [];
    const e = new ToolExecutor(reg, {
      policy: new PermissionPolicy({ scopes: ['compute'] }),
      diagnostics: entry => diagnostics.push(entry)
    });
    const res = await e.execute('leaky', {}, {});
    assert.equal(res.status, 'error');
    assert.ok(!JSON.stringify(res.forModel()).includes('SUPER_SECRET_MARKER_123'));
    assert.ok(!JSON.stringify(e.audit.entries()).includes('SUPER_SECRET_MARKER_123'));
    const pub = publicActionRuntimeSummary({ registry: reg, manifest: null, auditEntries: e.audit.entries(), configured: true });
    assert.ok(!JSON.stringify(pub).includes('SUPER_SECRET_MARKER_123'));
    // operator sink may hold the internal detail — deliberately separate
    assert.equal(diagnostics.length, 1);
    assert.ok(diagnostics[0].message.includes('SUPER_SECRET_MARKER_123'));
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Invalid-state cache fast path (blocker 5)
// ──────────────────────────────────────────────────────────────────────────

describe('Invalid-state cache behavior', () => {
  const { packageCacheUsable } = require('../lib/domain-package');

  it('packageCacheUsable requires active + non-stale + ready', () => {
    const active = { status: 'active', stale: false };
    assert.equal(packageCacheUsable(active, true), true);
    assert.equal(packageCacheUsable({ status: 'active', stale: true }, true), false);
    assert.equal(packageCacheUsable({ status: 'invalid', stale: false }, false), false);
    assert.equal(packageCacheUsable({ status: 'stale', stale: true }, true), false);
    assert.equal(packageCacheUsable(null, true), false);
    assert.equal(packageCacheUsable(active, false), false);
  });

  it('invalid B switch → fix B → next fetch publishes B with B evidence only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-recover-'));
    const write = (name, obj) => fs.writeFileSync(path.join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));
    write('a.package.json', pkg('atlas-bakery', 'Atlas Bakery', tenantKnowledge('Ana Sol', 'Atlas Bakery', 'Sourdough Subscription')));
    write('b.package.json', pkg('broken', 'Broken', 'not-an-object'));
    const rt = makeMiniRuntime(dir);
    rt.refresh('a.package.json');
    assert.equal(rt.ready, true);
    // Switch to invalid B → drop; invalid state is NOT cache-usable
    let r = rt.refresh('b.package.json');
    assert.equal(r.decision.action, 'drop');
    assert.equal(packageCacheUsable(rt.active, rt.ready), false);
    // Operator fixes B; the next refresh republishes promptly
    write('b.package.json', pkg('copperline-gym', 'Copperline Gym', tenantKnowledge('Bo Kim', 'Copperline Gym', 'Climbing Membership')));
    r = rt.refresh('b.package.json');
    assert.equal(r.decision.action, 'publish');
    assert.equal(rt.ready, true);
    assert.equal(rt.knowledge.identity.company, 'Copperline Gym');
    const flat = JSON.stringify(rt.chunks);
    assert.ok(flat.includes('Copperline Gym'));
    assert.ok(!flat.includes('Atlas Bakery'));
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Runtime registry validation (blocker 6)
// ──────────────────────────────────────────────────────────────────────────

describe('Runtime known-capability validation', () => {
  it('ToolRegistry (not just Map) is accepted as knownCapabilities', () => {
    const p = validPkg();
    p.capabilities = { allow: ['calculator', 'nonexistent_cap'] };
    const r = validateDomainPackage(p, { knownCapabilities: registry });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /unknown capability/.test(e.message)));
  });

  it('unknown-capability package does not publish through the loading path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-caps-'));
    fs.writeFileSync(path.join(dir, 'bad.package.json'), JSON.stringify({
      ...validPkg(), capabilities: { allow: ['made_up_capability'] }
    }));
    const rt = makeMiniRuntime(dir);
    const result = loadDomainPackage(path.join(dir, 'bad.package.json'), {
      baseDir: dir, packageRoots: [dir], knownCapabilities: registry
    });
    assert.equal(result.ok, false);
    const decision = transitionPackageState(rt.active, result);
    assert.equal(decision.action, 'drop');
    const manifest = INVALID_PACKAGE_MANIFEST;
    assert.equal(isCapabilityAllowed(manifest, 'made_up_capability'), false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Core vs deployment runtime facts (blocker 8)
// ──────────────────────────────────────────────────────────────────────────

describe('Runtime facts architecture', () => {
  const { buildDeploymentFacts } = require('../lib/deployment-facts');
  const coreFacts = require('../data/scout-runtime-knowledge.json');

  it('core facts are architecture-only: no RAG-first, no provider claims', () => {
    const flat = JSON.stringify(coreFacts);
    assert.ok(!/RAG-first/i.test(flat));
    for (const banned of ['@cf/meta', 'GitHub Pages', 'GCP', 'Bradley', 'Matera', 'recruiter', 'ProjectHub']) {
      assert.ok(!flat.includes(banned), `deployment/tenant claim in core facts: ${banned}`);
    }
  });

  it('General Scout + Ollama config produces no Cloudflare model claim', () => {
    const facts = buildDeploymentFacts({ provider: 'ollama', model: 'qwen2.5:1.5b', deadlineMs: 15000 });
    const chunks = buildRagChunks({}, { deploymentFacts: facts });
    const flat = JSON.stringify(chunks);
    assert.ok(!flat.includes('@cf/meta'), 'Cloudflare model leaked into an ollama deployment');
    assert.ok(flat.includes('ollama'), 'configured provider absent');
  });

  it('Cloudflare deployment exposes its configured model and gated facts', () => {
    const declared = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'deployment-facts.json'), 'utf8')).facts;
    const facts = buildDeploymentFacts({
      provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fast', deadlineMs: 15000, rateLimitPerMinute: 20
    }, declared);
    const flat = JSON.stringify(facts);
    assert.ok(flat.includes('@cf/meta/llama-3.1-8b-instruct-fast'));
    assert.ok(flat.includes('10,000 neurons'));
    const ollamaFacts = buildDeploymentFacts({ provider: 'ollama', model: 'qwen2.5:1.5b' }, declared);
    assert.ok(!JSON.stringify(ollamaFacts).includes('Cloudflare Workers AI'));
  });
});
