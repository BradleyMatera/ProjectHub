'use strict';

/**
 * Focused response-contract tests for the DIRECT_KB cleanup addendum.
 *
 * These cases verify that determineDirectAnswer / buildResponseContract
 * produce semantic labels and data-driven boundaries, not hardcoded
 * customer-specific final answers.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildResponseContract } = require('../lib/response-contract');

const bradleyKB = require('../data/recruiter-knowledge.json');
const evidence = `Bradley Matera is a Software Developer based in Eau Claire, WI.
He completed an AWS Cloud Support Engineer internship at Amazon Web Services (AWS), practicing customer support, cloud troubleshooting, and monitoring in guided training labs.
He holds a Bachelor of Science in Web Development (B.S.) from Full Sail University.
He has project experience with ProjectHub and CIRIS Ethical AI.`;

const HARDENED_STRINGS = [
  'is worth interviewing because his AWS support training',
  "'s real-world experience comes from an AWS Cloud Support Engineer internship",
  'is a Software Developer based in Eau Claire, WI',
  "No, his IT degree is in",
  'Yes, the AWS role was production support training, though not live customer-ticket work'
];

function noHardcodedProse(contract) {
  const haystack = `${String(contract.naturalInstructions || '')} ${contract.boundary || ''}`.toLowerCase();
  for (const s of HARDENED_STRINGS) {
    if (haystack.includes(s.toLowerCase())) return s;
  }
  return null;
}

test('false employer claim (Google) stays UNKNOWN in open-world tenant', () => {
  const c = buildResponseContract('Bradley worked at Google, right?', evidence, bradleyKB);
  assert.equal(c.intent, 'ADVERSARIAL');
  assert.equal(c.directAnswer, 'UNKNOWN');
  assert.equal(c.factState, 'UNKNOWN');
  assert.equal(noHardcodedProse(c), null, 'contract must not contain hardcoded final prose');
});

test('false seniority at known employer gets NO', () => {
  const c = buildResponseContract('I heard he was a senior engineer at Amazon, right?', evidence, bradleyKB);
  assert.equal(c.intent, 'ADVERSARIAL');
  assert.equal(c.directAnswer, 'NO');
  assert.equal(c.factState, 'FALSE');
  assert.ok(c.boundary, 'boundary should surface the seniority limit');
  assert.ok(String(c.boundary).toLowerCase().includes('senior') || String(c.boundary).toLowerCase().includes('expert'));
});

test('known employer without false seniority gets YES', () => {
  const c = buildResponseContract('Bradley worked at Amazon, right?', evidence, bradleyKB);
  assert.equal(c.intent, 'ADVERSARIAL');
  assert.equal(c.directAnswer, 'YES');
  assert.equal(c.factState, 'TRUE');
});

test('recruiter recommendation does not force YES from evidence length', () => {
  const c = buildResponseContract('Is he someone worth interviewing?', evidence, bradleyKB);
  assert.equal(c.intent, 'RECRUITER');
  assert.equal(c.subIntent, 'RECRUITER_RECOMMENDATION');
  assert.equal(c.directAnswer, null);
  assert.equal(noHardcodedProse(c), null, 'contract must not contain hardcoded recommendation prose');
});

test('YES_NO degree question gets NO with actual-degree boundary', () => {
  const c = buildResponseContract('Does he have a computer science degree?', evidence, bradleyKB);
  assert.equal(c.intent, 'YES_NO');
  assert.equal(c.subIntent, 'YES_NO');
  assert.equal(c.directAnswer, 'NO');
  assert.ok(c.boundary, 'boundary should surface the degree correction');
  assert.ok(String(c.boundary).toLowerCase().includes('cs program') || String(c.boundary).toLowerCase().includes('not a cs'));
  assert.equal(noHardcodedProse(c), null, 'contract must not contain hardcoded degree prose');
});

test('YES_NO live production work gets NO with AWS boundary', () => {
  const c = buildResponseContract('Was that live production work?', evidence, bradleyKB);
  assert.equal(c.intent, 'YES_NO');
  assert.equal(c.subIntent, 'YES_NO');
  assert.equal(c.directAnswer, 'NO');
  assert.ok(c.boundary, 'boundary should surface the production scope');
  assert.ok(String(c.boundary).toLowerCase().includes('not live production') || String(c.boundary).toLowerCase().includes('no customer data'));
});

test('YES_NO production support gets YES with AWS boundary', () => {
  const c = buildResponseContract('Was that production support?', evidence, bradleyKB);
  assert.equal(c.intent, 'YES_NO');
  assert.equal(c.subIntent, 'YES_NO');
  assert.equal(c.directAnswer, 'YES');
  assert.ok(c.boundary, 'boundary should surface the production scope');
  assert.ok(String(c.boundary).toLowerCase().includes('not live production') || String(c.boundary).toLowerCase().includes('no customer data'));
  assert.equal(noHardcodedProse(c), null, 'contract must not contain hardcoded production prose');
});

test('EXPERIENCE question gets no forced direct answer', () => {
  const c = buildResponseContract('What real-world experience does he have?', evidence, bradleyKB);
  assert.equal(c.subIntent, 'EXPERIENCE');
  assert.equal(c.directAnswer, null);
  assert.ok(c.factState === 'TRUE' || c.factState === 'UNKNOWN', `expected TRUE or UNKNOWN factState, got ${c.factState}`);
  assert.equal(noHardcodedProse(c), null, 'contract must not contain hardcoded experience prose');
});
