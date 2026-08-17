'use strict';

/**
 * Tenant Portability Tests: Accountant, Mechanic, and Bradley
 *
 * Proves the Scout engine works with completely different tenants
 * without any server code changes. The server and Scout modules must
 * be tenant-agnostic — all tenant specifics come from the KB.
 *
 * Tests:
 * 1. Synthetic accountant tenant (John Smith, CPA)
 * 2. Synthetic mechanic tenant (Maria Garcia, auto repair)
 * 3. Bradley tenant (existing production KB)
 * 4. KB mutation test — answer content changes when KB changes, no code changes
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const knowledgeAccess = require('../lib/knowledge-access');
const { detectAdversarialCaveat } = require('../lib/lite-agent');
const { buildRecoveryContract, detectAdversarialContract } = require('../lib/recovery-contract');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const { validateAnswer } = require('../lib/grounding-validator');
const { classifyTopic, isRelevant, normalizeQuery } = require('../lib/query-understanding');
const { findDirectAnswer } = require('../lib/knowledge-access');

// === Synthetic Accountant KB ===
const accountantKb = {
  identity: {
    name: 'John Smith',
    preferredName: 'John',
    title: 'Certified Public Accountant',
    location: 'Austin, TX',
    pronouns: { subject: 'he', object: 'him', possessive: 'his' }
  },
  summary: {
    whoIAm: 'John is a CPA with 8 years of experience in tax accounting and audit services.',
    level: 'senior'
  },
  education: {
    school: 'University of Texas at Austin',
    degree: 'B.B.A. Accounting'
  },
  certifications: [
    { name: 'Certified Public Accountant' },
    { name: 'Certified Management Accountant' }
  ],
  skills: {
    core: ['QuickBooks', 'Excel', 'Tax Preparation', 'Audit'],
    software: ['SAP', 'Oracle Financials']
  },
  experience: [
    { company: 'Deloitte', role: 'Senior Auditor', skills: ['Audit', 'Excel'] },
    { company: 'Local Tax Partners', role: 'Tax Manager', skills: ['Tax Preparation', 'QuickBooks'] }
  ],
  projects: [
    { name: 'TaxFlow App', tech: ['Excel', 'QuickBooks'], description: 'Automated tax workflow for small businesses.' }
  ],
  subjectAliases: ['John', 'Smith'],
  boundaries: [
    { category: 'seniority', triggerPattern: 'partner|managing director', correction: 'John is a senior accountant, not a partner or managing director.' }
  ],
  claimCorrections: [
    { triggerPattern: 'worked at (google|amazon|microsoft)', correction: 'John has not worked at Google, Amazon, or Microsoft. His experience includes Deloitte and Local Tax Partners.' }
  ],
  directAnswers: [
    { id: 'da-cpa', intents: ['certification'], questionPatterns: ['cpa', 'certified public accountant'], answer: 'Yes, John is a licensed CPA.', sourceIds: ['cert-cpa'] }
  ],
  knowledgeCompleteness: {
    employment: { complete: true, authoritative: true }
  }
};

// === Synthetic Mechanic KB ===
const mechanicKb = {
  identity: {
    name: 'Maria Garcia',
    preferredName: 'Maria',
    title: 'Automotive Technician',
    location: 'Phoenix, AZ',
    pronouns: { subject: 'she', object: 'her', possessive: 'her' }
  },
  summary: {
    whoIAm: 'Maria is an ASE-certified automotive technician specializing in engine diagnostics and transmission repair.',
    level: 'mid-level'
  },
  education: {
    school: 'Lincoln Technical Institute',
    degree: 'Automotive Technology Certificate'
  },
  certifications: [
    { name: 'ASE Master Technician' },
    { name: 'EPA 609 Refrigerant Certification' }
  ],
  skills: {
    core: ['Engine Diagnostics', 'Transmission Repair', 'Brake Systems', 'Electrical Systems'],
    tools: ['OBD-II Scanner', 'Multimeter', 'Hydraulic Lift']
  },
  experience: [
    { company: 'AutoZone Service Center', role: 'Lead Technician', skills: ['Engine Diagnostics', 'Electrical Systems'] },
    { company: 'Desert Auto Repair', role: 'Technician', skills: ['Transmission Repair', 'Brake Systems'] }
  ],
  projects: [
    { name: 'Fleet Maintenance Tracker', tech: ['Excel'], description: 'Spreadsheet system for tracking fleet maintenance schedules.' }
  ],
  subjectAliases: ['Maria', 'Garcia'],
  boundaries: [
    { category: 'seniority', triggerPattern: 'shop owner|business owner', correction: 'Maria is a technician, not a shop owner.' }
  ],
  claimCorrections: [
    { triggerPattern: 'worked at (tesla|ford|gm|chevrolet)', correction: 'Maria has not worked at Tesla, Ford, or GM. Her experience includes AutoZone Service Center and Desert Auto Repair.' }
  ],
  directAnswers: [
    { id: 'da-ase', intents: ['certification'], questionPatterns: ['ase', 'master technician'], answer: 'Yes, Maria is an ASE Master Technician.', sourceIds: ['cert-ase'] }
  ],
  knowledgeCompleteness: {
    employment: { complete: false, authoritative: false }
  }
};

// === Bradley KB (loaded from production data) ===
let bradleyKb;
try {
  bradleyKb = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'recruiter-knowledge.json'), 'utf8'));
} catch {
  bradleyKb = null;
}

// === Helper: check no cross-tenant leakage ===
function checkNoCrossLeakage(text, otherTenantName) {
  if (!text || !otherTenantName) return [];
  const lower = typeof text === 'string' ? text.toLowerCase() : JSON.stringify(text).toLowerCase();
  const otherName = otherTenantName.toLowerCase();
  return lower.includes(otherName) ? [otherTenantName] : [];
}

// ============ ACCOUNTANT TENANT TESTS ============

test('TENANT-ACCT-1: Identity uses John Smith, not Bradley', () => {
  const pattern = knowledgeAccess.getSubjectNamePattern(accountantKb);
  const re = new RegExp(pattern, 'i');
  assert.ok(re.test('John Smith'), 'Should match John Smith');
  assert.ok(!re.test('Bradley Matera'), 'Should not match Bradley Matera');
});

test('TENANT-ACCT-2: Known companies are accountant-specific', () => {
  const companies = knowledgeAccess.getKnownCompanies(accountantKb);
  assert.ok(companies.some(c => c.toLowerCase().includes('deloitte')), 'Should include Deloitte');
  assert.ok(companies.some(c => c.toLowerCase().includes('local tax partners')), 'Should include Local Tax Partners');
  assert.ok(!companies.some(c => c.toLowerCase().includes('ciris')), 'Should not include CIRIS');
});

test('TENANT-ACCT-3: Skills are accountant-specific', () => {
  const techs = knowledgeAccess.getKnownTechnologies(accountantKb);
  assert.ok(techs.some(t => t.toLowerCase() === 'quickbooks'), 'Should include QuickBooks');
  assert.ok(techs.some(t => t.toLowerCase() === 'excel'), 'Should include Excel');
  assert.ok(!techs.some(t => t.toLowerCase() === 'react'), 'Should not include React');
});

test('TENANT-ACCT-4: Certifications are accountant-specific', () => {
  const certs = knowledgeAccess.getKnownCertifications(accountantKb);
  assert.ok(certs.some(c => c.toLowerCase().includes('cpa') || c.toLowerCase().includes('certified public accountant')), 'Should include CPA');
  assert.ok(!certs.some(c => c.toLowerCase().includes('aws')), 'Should not include AWS cert');
});

test('TENANT-ACCT-5: classifyTopic works for accountant questions', () => {
  assert.strictEqual(classifyTopic('What certifications does John have?', accountantKb), 'education');
  assert.strictEqual(classifyTopic('Tell me about his experience', accountantKb), 'experience');
  assert.strictEqual(classifyTopic('What are his strengths?', accountantKb), 'strengths');
});

test('TENANT-ACCT-6: isRelevant works for accountant questions', () => {
  assert.ok(isRelevant('What is John\'s experience with QuickBooks?', accountantKb), 'Should be relevant');
  assert.ok(isRelevant('What skills does the candidate have?', accountantKb), 'Generic recruiter terms should be relevant');
  assert.ok(!isRelevant('What\'s the weather in Austin?', accountantKb), 'Weather should not be relevant');
});

test('TENANT-ACCT-7: No Bradley leakage in accountant responses', () => {
  const caveat = detectAdversarialCaveat('Did John work at Google?', '', accountantKb);
  if (caveat) {
    assert.ok(checkNoCrossLeakage(caveat, 'Bradley Matera'), 'Caveat should not mention Bradley');
  }
  const fallback = detectAdversarialContract('Did John work at Google?', accountantKb, '');
  if (fallback) {
    const leakage = checkNoCrossLeakage(fallback, 'Bradley Matera');
    assert.deepEqual(leakage, [], `Fallback should not mention Bradley: ${leakage.join(', ')}`);
  }
});

test('TENANT-ACCT-8: Direct answer from KB for accountant', () => {
  const da = findDirectAnswer(accountantKb, 'Is John a CPA?');
  assert.ok(da, 'Should find direct answer for CPA question');
  assert.ok(da.answer.toLowerCase().includes('cpa'), 'Answer should mention CPA');
  assert.ok(!da.answer.toLowerCase().includes('bradley'), 'Answer should not mention Bradley');
});

test('TENANT-ACCT-9: Closed-world employment boundary works', () => {
  assert.ok(knowledgeAccess.isCategoryComplete(accountantKb, 'employment'), 'Employment should be complete');
  assert.ok(knowledgeAccess.isCategoryAuthoritative(accountantKb, 'employment'), 'Employment should be authoritative');
  // Closed-world: no evidence + no explicit boundary + complete+authoritative → FALSE
  const factState = knowledgeAccess.resolveFactState(accountantKb, 'employment', false, false);
  assert.strictEqual(factState, 'false', 'Unknown company should resolve to FALSE (closed-world)');
});

test('TENANT-ACCT-10: normalizeQuery with KB-driven typos', () => {
  const kbWithTypos = {
    ...accountantKb,
    commonPatterns: { typos: { 'quikbooks': 'quickbooks', 'exel': 'excel' } }
  };
  const normalized = normalizeQuery('Does he know quikbooks and exel?', kbWithTypos);
  assert.ok(normalized.includes('quickbooks'), 'Should correct quikbooks → quickbooks');
  assert.ok(normalized.includes('excel'), 'Should correct exel → excel');
});

// ============ MECHANIC TENANT TESTS ============

test('TENANT-MECH-1: Identity uses Maria Garcia, not Bradley', () => {
  const pattern = knowledgeAccess.getSubjectNamePattern(mechanicKb);
  const re = new RegExp(pattern, 'i');
  assert.ok(re.test('Maria Garcia'), 'Should match Maria Garcia');
  assert.ok(!re.test('Bradley Matera'), 'Should not match Bradley Matera');
});

test('TENANT-MECH-2: Known companies are mechanic-specific', () => {
  const companies = knowledgeAccess.getKnownCompanies(mechanicKb);
  assert.ok(companies.some(c => c.toLowerCase().includes('autozone')), 'Should include AutoZone');
  assert.ok(companies.some(c => c.toLowerCase().includes('desert auto repair')), 'Should include Desert Auto Repair');
  assert.ok(!companies.some(c => c.toLowerCase().includes('deloitte')), 'Should not include Deloitte');
});

test('TENANT-MECH-3: Skills are mechanic-specific', () => {
  const techs = knowledgeAccess.getKnownTechnologies(mechanicKb);
  assert.ok(techs.some(t => t.toLowerCase().includes('engine diagnostics')), 'Should include Engine Diagnostics');
  assert.ok(techs.some(t => t.toLowerCase().includes('transmission repair')), 'Should include Transmission Repair');
  assert.ok(!techs.some(t => t.toLowerCase() === 'quickbooks'), 'Should not include QuickBooks');
});

test('TENANT-MECH-4: Certifications are mechanic-specific', () => {
  const certs = knowledgeAccess.getKnownCertifications(mechanicKb);
  assert.ok(certs.some(c => c.toLowerCase().includes('ase')), 'Should include ASE');
  assert.ok(!certs.some(c => c.toLowerCase().includes('cpa')), 'Should not include CPA');
});

test('TENANT-MECH-5: classifyTopic works for mechanic questions', () => {
  assert.strictEqual(classifyTopic('What certifications does Maria have?', mechanicKb), 'education');
  assert.strictEqual(classifyTopic('Tell me about her experience', mechanicKb), 'experience');
});

test('TENANT-MECH-6: isRelevant works for mechanic questions', () => {
  assert.ok(isRelevant('What is Maria\'s experience with engine diagnostics?', mechanicKb), 'Should be relevant');
  assert.ok(isRelevant('What are the candidate\'s skills?', mechanicKb), 'Generic recruiter terms should be relevant');
  assert.ok(!isRelevant('Tell me a joke', mechanicKb), 'Jokes should not be relevant');
});

test('TENANT-MECH-7: No Bradley leakage in mechanic responses', () => {
  const caveat = detectAdversarialCaveat('Did Maria work at Tesla?', '', mechanicKb);
  if (caveat) {
    assert.ok(checkNoCrossLeakage(caveat, 'Bradley Matera'), 'Caveat should not mention Bradley');
  }
  const fallback = detectAdversarialContract('Did Maria work at Tesla?', mechanicKb, '');
  if (fallback) {
    const leakage = checkNoCrossLeakage(fallback, 'Bradley Matera');
    assert.deepEqual(leakage, [], `Fallback should not mention Bradley: ${leakage.join(', ')}`);
  }
});

test('TENANT-MECH-8: Direct answer from KB for mechanic', () => {
  const da = findDirectAnswer(mechanicKb, 'Is Maria an ASE Master Technician?');
  assert.ok(da, 'Should find direct answer for ASE question');
  assert.ok(da.answer.toLowerCase().includes('ase'), 'Answer should mention ASE');
  assert.ok(!da.answer.toLowerCase().includes('bradley'), 'Answer should not mention Bradley');
});

test('TENANT-MECH-9: Open-world employment — unknown company is UNKNOWN, not FALSE', () => {
  assert.ok(!knowledgeAccess.isCategoryComplete(mechanicKb, 'employment'), 'Employment should NOT be complete (open-world)');
  // Open-world: no evidence + no explicit boundary + not complete → UNKNOWN
  const factState = knowledgeAccess.resolveFactState(mechanicKb, 'employment', false, false);
  assert.strictEqual(factState, 'unknown', 'Tesla should resolve to UNKNOWN (open-world)');
});

// ============ BRADLEY TENANT TESTS (existing KB) ============

test('TENANT-BRADLEY-1: Bradley KB loads successfully', () => {
  assert.ok(bradleyKb, 'Bradley KB should load from data/recruiter-knowledge.json');
  assert.ok(bradleyKb.identity, 'Should have identity section');
  assert.ok(bradleyKb.identity.name, 'Should have a name');
});

test('TENANT-BRADLEY-2: Bradley identity is used correctly', () => {
  const pattern = knowledgeAccess.getSubjectNamePattern(bradleyKb);
  const re = new RegExp(pattern, 'i');
  assert.ok(re.test('Bradley Matera'), 'Should match Bradley Matera');
});

test('TENANT-BRADLEY-3: Bradley KB has expected structure', () => {
  assert.ok(Array.isArray(bradleyKb.experience), 'Should have experience array');
  assert.ok(Array.isArray(bradleyKb.projects), 'Should have projects array');
  assert.ok(bradleyKb.skills && typeof bradleyKb.skills === 'object', 'Should have skills object');
});

test('TENANT-BRADLEY-4: No accountant or mechanic leakage in Bradley KB', () => {
  const bradleyText = JSON.stringify(bradleyKb).toLowerCase();
  assert.ok(!bradleyText.includes('quickbooks'), 'Bradley KB should not contain QuickBooks');
  assert.ok(!bradleyText.includes('engine diagnostics'), 'Bradley KB should not contain Engine Diagnostics');
  assert.ok(!bradleyText.includes('maria garcia'), 'Bradley KB should not contain Maria Garcia');
});

test('TENANT-BRADLEY-5: classifyTopic works for Bradley questions', () => {
  assert.strictEqual(classifyTopic('What projects has Bradley built?', bradleyKb), 'projects');
  assert.strictEqual(classifyTopic('What are his skills?', bradleyKb), 'skills');
});

// ============ KB MUTATION TESTS ============

test('KB-MUTATION-1: Adding a skill to KB changes known technologies', () => {
  const original = knowledgeAccess.getKnownTechnologies(accountantKb);
  assert.ok(!original.some(t => t.toLowerCase() === 'python'), 'Should not know Python initially');

  const mutated = JSON.parse(JSON.stringify(accountantKb));
  mutated.skills.core.push('Python');
  const after = knowledgeAccess.getKnownTechnologies(mutated);
  assert.ok(after.some(t => t.toLowerCase() === 'python'), 'Should know Python after KB mutation');
});

test('KB-MUTATION-2: Removing a certification from KB removes it from known certs', () => {
  const original = knowledgeAccess.getKnownCertifications(accountantKb);
  assert.ok(original.some(c => c.toLowerCase().includes('certified public accountant')), 'Should have CPA initially');

  const mutated = JSON.parse(JSON.stringify(accountantKb));
  mutated.certifications = mutated.certifications.filter(c => !c.name.toLowerCase().includes('certified public accountant'));
  const after = knowledgeAccess.getKnownCertifications(mutated);
  assert.ok(!after.some(c => c.toLowerCase().includes('certified public accountant')), 'Should NOT have CPA after removal');
});

test('KB-MUTATION-3: Adding a direct answer to KB makes it findable', () => {
  const mutated = JSON.parse(JSON.stringify(mechanicKb));
  mutated.directAnswers = (mutated.directAnswers || []);
  mutated.directAnswers.push({
    id: 'da-tesla',
    intents: ['experience'],
    questionPatterns: ['tesla', 'electric vehicle'],
    answer: 'Maria has not worked at Tesla. Her experience is with conventional vehicles.',
    sourceIds: ['exp-autozone']
  });
  const da = findDirectAnswer(mutated, 'Did Maria work at Tesla?');
  assert.ok(da, 'Should find new direct answer after KB mutation');
  assert.ok(da.answer.toLowerCase().includes('tesla'), 'Answer should mention Tesla');
});

test('KB-MUTATION-4: Changing identity in KB changes name pattern', () => {
  const mutated = JSON.parse(JSON.stringify(accountantKb));
  mutated.identity.name = 'Robert Johnson';
  mutated.identity.preferredName = 'Robert';
  mutated.subjectAliases = ['Robert', 'Johnson'];
  const pattern = knowledgeAccess.getSubjectNamePattern(mutated);
  const re = new RegExp(pattern, 'i');
  assert.ok(re.test('Robert Johnson'), 'Should match new name');
  assert.ok(!re.test('John Smith'), 'Should not match old name');
});

test('KB-MUTATION-5: Adding a boundary to KB changes fact resolution', () => {
  const mutated = JSON.parse(JSON.stringify(mechanicKb));
  // Initially open-world — no evidence, no boundary, not complete → UNKNOWN
  assert.strictEqual(knowledgeAccess.resolveFactState(mutated, 'employment', false, false), 'unknown');

  // Add completeness boundary
  mutated.knowledgeCompleteness = {
    employment: { complete: true, authoritative: true }
  };
  // Now closed-world — no evidence, no boundary, but complete+authoritative → FALSE
  assert.strictEqual(knowledgeAccess.resolveFactState(mutated, 'employment', false, false), 'false');
});

test('KB-MUTATION-6: No server code changes needed for KB mutations', () => {
  // This is a structural test — verify that all tenant-specific data
  // flows through knowledge-access functions, not hardcoded in server code.
  // If these functions work with arbitrary KBs, no code changes are needed.

  const tenants = [accountantKb, mechanicKb];
  if (bradleyKb) tenants.push(bradleyKb);

  for (const kb of tenants) {
    // These are the functions the server calls — they must work with any KB
    assert.doesNotThrow(() => knowledgeAccess.getKnownCompanies(kb), 'getKnownCompanies should work');
    assert.doesNotThrow(() => knowledgeAccess.getKnownTechnologies(kb), 'getKnownTechnologies should work');
    assert.doesNotThrow(() => knowledgeAccess.getKnownCertifications(kb), 'getKnownCertifications should work');
    assert.doesNotThrow(() => knowledgeAccess.getSubjectPronouns(kb), 'getSubjectPronouns should work');
    assert.doesNotThrow(() => knowledgeAccess.getSubjectNamePattern(kb), 'getSubjectNamePattern should work');
    assert.doesNotThrow(() => classifyTopic('What are the candidate\'s skills?', kb), 'classifyTopic should work');
    assert.doesNotThrow(() => isRelevant('What are the candidate\'s skills?', kb), 'isRelevant should work');
    assert.doesNotThrow(() => normalizeQuery('What are the candidate\'s skills?', kb), 'normalizeQuery should work');
  }
});

test('KB-MUTATION-7: Relationship graph builds for all tenants', () => {
  const tenants = [
    { kb: accountantKb, name: 'John Smith' },
    { kb: mechanicKb, name: 'Maria Garcia' },
  ];
  if (bradleyKb) tenants.push({ kb: bradleyKb, name: 'Bradley Matera' });

  for (const { kb, name } of tenants) {
    assert.doesNotThrow(() => {
      const graph = buildRelationshipGraph(kb);
      assert.ok(graph, `Relationship graph should build for ${name}`);
    }, `Building relationship graph for ${name} should not throw`);
  }
});
