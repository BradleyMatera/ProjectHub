'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  PACKAGE_SCHEMA_VERSION, GENERAL_PACKAGE,
  validateDomainPackage, loadDomainPackage, isCapabilityAllowed
} = require('../lib/domain-package');
const { buildToolRegistry } = require('../lib/tool-capabilities');
const { ToolExecutor, PermissionPolicy } = require('../lib/tool-executor');
const { normalizeKnowledgeEntities } = require('../lib/knowledge-entities');

const PACKAGES_DIR = path.join(__dirname, '..', 'data', 'packages');
const registry = buildToolRegistry();
const knownCapabilities = new Map(registry.list().map(d => [d.id, d]));

const validPkg = () => ({
  packageVersion: 1,
  kind: 'domain-package',
  id: 'test-tenant',
  name: 'Test Tenant',
  capabilities: { allow: ['calculator'] },
  knowledge: {
    identity: { name: 'Pat Doe' },
    services: [{ name: 'Thing One', description: 'A service' }]
  }
});

describe('Domain package validator', () => {
  it('accepts a minimal valid package', () => {
    const r = validateDomainPackage(validPkg(), { knownCapabilities });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it('rejects missing packageVersion', () => {
    const p = validPkg(); delete p.packageVersion;
    const r = validateDomainPackage(p);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.path === 'packageVersion'));
  });

  it('rejects a bad package id', () => {
    const p = validPkg(); p.id = 'Bad ID!';
    const r = validateDomainPackage(p);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.path === 'id'));
  });

  it('rejects a missing name', () => {
    const p = validPkg(); delete p.name;
    const r = validateDomainPackage(p);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.path === 'name'));
  });

  it('rejects a capability in both allow and deny', () => {
    const p = validPkg();
    p.capabilities = { allow: ['calculator'], deny: ['calculator'] };
    const r = validateDomainPackage(p);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /both allowed and denied/.test(e.message)));
  });

  it('rejects duplicate capability ids', () => {
    const p = validPkg();
    p.capabilities = { allow: ['calculator', 'calculator'] };
    const r = validateDomainPackage(p);
    assert.equal(r.ok, false);
  });

  it('warns on unknown capability ids', () => {
    const p = validPkg();
    p.capabilities = { allow: ['does_not_exist'] };
    const r = validateDomainPackage(p, { knownCapabilities });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some(w => /unknown capability/.test(w.message)));
  });

  it('warns on side-effecting capability without a confirmation policy', () => {
    const p = validPkg();
    p.capabilities = { allow: ['send_notification'] };
    const r = validateDomainPackage(p, { knownCapabilities });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some(w => /side-effecting/.test(w.message)));
  });

  it('rejects non-object knowledge', () => {
    const p = validPkg(); p.knowledge = 'not an object';
    const r = validateDomainPackage(p);
    assert.equal(r.ok, false);
  });

  it('rejects mixing knowledge.source with inline sections', () => {
    const p = validPkg(); p.knowledge = { source: './k.json', identity: {} };
    const r = validateDomainPackage(p);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.path === 'knowledge'));
  });

  it('rejects non-array collection sections', () => {
    const p = validPkg(); p.knowledge.services = 'not-an-array';
    const r = validateDomainPackage(p);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.path === 'knowledge.services'));
  });

  it('rejects duplicate entity names across collections', () => {
    const p = validPkg();
    p.knowledge.products = [{ name: 'Thing One', description: 'same name' }];
    const r = validateDomainPackage(p);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /duplicate entity name/i.test(e.message)));
  });

  it('rejects a subject alias that collides with an entity name', () => {
    const p = validPkg();
    p.knowledge.subjectAliases = ['thing one'];
    const r = validateDomainPackage(p);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /collides/.test(e.message)));
  });

  it('warns on unknown workflow steps', () => {
    const p = validPkg();
    p.workflows = [{ id: 'wf', steps: ['retrieve', 'not_a_step'] }];
    const r = validateDomainPackage(p, { knownCapabilities });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some(w => /not a builtin step/.test(w.message)));
  });

  it('accepts a package with no knowledge section (empty application)', () => {
    const p = validPkg(); delete p.knowledge;
    const r = validateDomainPackage(p);
    assert.equal(r.ok, true);
  });
});

describe('loadDomainPackage', () => {
  it("'general' resolves to the built-in General Scout package", () => {
    const r = loadDomainPackage('general');
    assert.equal(r.ok, true);
    assert.equal(r.manifest.id, 'general-scout');
    assert.deepEqual(r.knowledge, {});
  });

  it('null resolves to General Scout mode', () => {
    const r = loadDomainPackage(null);
    assert.equal(r.ok, true);
    assert.equal(r.manifest.id, 'general-scout');
  });

  it('loads the Recruiter Alpha package and resolves its knowledge source', () => {
    const r = loadDomainPackage(path.join(PACKAGES_DIR, 'recruiter-alpha.package.json'));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.manifest.id, 'recruiter-alpha');
    assert.equal(r.knowledge.identity.name, 'Bradley Matera');
  });

  it('loads the Rivera Home Electric package with inline knowledge', () => {
    const r = loadDomainPackage(path.join(PACKAGES_DIR, 'rivera-home-electric.package.json'));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.manifest.id, 'rivera-home-electric');
    assert.equal(r.knowledge.identity.company, 'Rivera Home Electric');
    assert.equal(r.knowledge.services.length, 4);
  });

  it('loads the Northstar Desk product package', () => {
    const r = loadDomainPackage(path.join(PACKAGES_DIR, 'northstar-desk.package.json'));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.manifest.id, 'northstar-desk');
    assert.equal(r.knowledge.products.length, 2);
  });

  it('treats a bare knowledge file as a legacy package', () => {
    const r = loadDomainPackage(path.join(__dirname, '..', 'data', 'recruiter-knowledge.json'));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.manifest.legacy, true);
    assert.equal(r.knowledge.identity.name, 'Bradley Matera');
  });

  it('fails closed on a missing package file', () => {
    const r = loadDomainPackage(path.join(PACKAGES_DIR, 'does-not-exist.package.json'));
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  });

  it('fails closed on an unresolvable knowledge.source', () => {
    const r = loadDomainPackage({
      packageVersion: 1, id: 'broken', name: 'Broken',
      knowledge: { source: './nonexistent.json' }
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /knowledge\.source/.test(e.path)));
  });
});

describe('Cross-package isolation', () => {
  const loaded = {};
  for (const id of ['recruiter-alpha', 'rivera-home-electric', 'northstar-desk']) {
    loaded[id] = loadDomainPackage(path.join(PACKAGES_DIR, `${id}.package.json`));
  }

  it('no package contains another package\'s identity facts', () => {
    const alpha = JSON.stringify(loaded['recruiter-alpha'].knowledge);
    const rivera = JSON.stringify(loaded['rivera-home-electric'].knowledge);
    const northstar = JSON.stringify(loaded['northstar-desk'].knowledge);
    assert.ok(!rivera.includes('Bradley Matera'));
    assert.ok(!rivera.includes('Northstar'));
    assert.ok(!northstar.includes('Jordan Rivera'));
    assert.ok(!northstar.includes('Bradley Matera'));
    assert.ok(!alpha.includes('Jordan Rivera'));
    assert.ok(!alpha.includes('Northstar Desk'));
  });

  it('entity names are local to each package', () => {
    const alphaEntities = new Set(normalizeKnowledgeEntities(loaded['recruiter-alpha'].knowledge).map(e => e.name));
    const riveraEntities = new Set(normalizeKnowledgeEntities(loaded['rivera-home-electric'].knowledge).map(e => e.name));
    const northstarEntities = new Set(normalizeKnowledgeEntities(loaded['northstar-desk'].knowledge).map(e => e.name));
    for (const name of riveraEntities) {
      assert.ok(!alphaEntities.has(name), `rivera entity ${name} leaked into alpha`);
      assert.ok(!northstarEntities.has(name), `rivera entity ${name} leaked into northstar`);
    }
    assert.ok(riveraEntities.has('Panel Upgrade'));
    assert.ok(northstarEntities.has('Northstar Desk'));
  });
});

const READ_SCOPES = ['compute', 'knowledge:read', 'search:read', 'entity:read'];
const readPolicy = () => new PermissionPolicy({ scopes: READ_SCOPES });

describe('Package capability gating + executor integration', () => {
  const load = id => loadDomainPackage(path.join(PACKAGES_DIR, `${id}.package.json`));

  it('denies send_notification for all shipped packages', () => {
    for (const id of ['recruiter-alpha', 'rivera-home-electric', 'northstar-desk']) {
      const { manifest } = load(id);
      assert.equal(isCapabilityAllowed(manifest, 'send_notification'), false, id);
      assert.equal(isCapabilityAllowed(manifest, 'calculator'), true, id);
    }
  });

  it('General Scout allows compute but not knowledge tools', () => {
    assert.equal(isCapabilityAllowed(GENERAL_PACKAGE, 'calculator'), true);
    assert.equal(isCapabilityAllowed(GENERAL_PACKAGE, 'knowledge_lookup'), false);
    assert.equal(isCapabilityAllowed(GENERAL_PACKAGE, 'send_notification'), false);
  });

  it('a manifest with no capabilities section permits registry defaults', () => {
    assert.equal(isCapabilityAllowed({ id: 'x', name: 'X' }, 'calculator'), true);
  });

  it('calculator executes identically under every package', async () => {
    const executor = new ToolExecutor(registry, { policy: readPolicy() });
    for (const id of ['recruiter-alpha', 'rivera-home-electric', 'northstar-desk']) {
      const { manifest, knowledge } = load(id);
      assert.ok(isCapabilityAllowed(manifest, 'calculator'));
      const result = await executor.execute('calculator', { expression: '2+2' }, { knowledge });
      assert.equal(result.ok, true, id);
      assert.ok(result.data.facts.length >= 1, id);
      assert.ok(String(result.data.formatted).includes('4'), id);
    }
  });

  it('knowledge_lookup returns package-local facts only', async () => {
    const executor = new ToolExecutor(registry, { policy: readPolicy() });
    const rivera = load('rivera-home-electric');
    const result = await executor.execute('knowledge_lookup', { section: 'boundaries' }, { knowledge: rivera.knowledge });
    assert.equal(result.ok, true);
    assert.equal(result.data.found, true);
    const claims = JSON.stringify(result.data.data);
    assert.ok(claims.includes('residential-only'));
    assert.ok(!claims.includes('Northstar'));
  });

  it('denied capabilities are gated before execution', async () => {
    const executor = new ToolExecutor(registry, { policy: readPolicy() });
    const rivera = load('rivera-home-electric');
    // Package-level gate must refuse before the executor even runs.
    assert.equal(isCapabilityAllowed(rivera.manifest, 'send_notification'), false);
    // And the executor's own permission gate also refuses it (knowledge lacks notifications.enabled).
    const result = await executor.execute('send_notification', { to: 'x@y.z', message: 'hi' }, { knowledge: rivera.knowledge });
    assert.equal(result.ok, false);
  });
});

describe('General Scout mode', () => {
  it('empty knowledge is valid and safe', () => {
    const r = loadDomainPackage('general');
    assert.equal(r.ok, true);
    assert.deepEqual(r.knowledge, {});
    assert.equal(normalizeKnowledgeEntities(r.knowledge).length, 0);
  });

  it('empty knowledge does not produce entities or facts', async () => {
    const executor = new ToolExecutor(registry, { policy: readPolicy() });
    const r = loadDomainPackage('general');
    const result = await executor.execute('knowledge_lookup', { section: 'skills' }, { knowledge: r.knowledge });
    assert.equal(result.data.found, false);
    assert.equal(result.data.data, null);
  });
});
