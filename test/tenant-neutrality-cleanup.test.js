'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildRagEvidence } = require('../lib/rag-agent');
const { validateAnswer } = require('../lib/grounding-validator');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const { buildResponseContract } = require('../lib/response-contract');

function synthKnowledge(overrides = {}) {
  return {
    identity: { name: overrides.name || 'Morgan Vale', title: overrides.title || '' },
    summary: overrides.summary || {},
    experience: overrides.experience || [],
    skills: overrides.skills || {},
    projects: overrides.projects || [],
    products: overrides.products || [],
    services: overrides.services || [],
    relationships: overrides.relationships || [],
    ...overrides.extra
  };
}

describe('Tenant-neutrality cleanup', () => {

  describe('experience classification uses only structured metadata', () => {
    it('prioritises nontechnical roles when asking for non-technical experience', () => {
      const knowledge = synthKnowledge({
        experience: [
          { role: 'Platform Engineer', company: 'Orbit Systems', classification: 'technical' },
          { role: 'Marine Biologist', company: 'Tide Research', classification: 'nontechnical' }
        ]
      });
      const { selected } = buildRagEvidence([], 2000, 10, 'EXPERIENCE', knowledge, 'What non-technical experience does the subject have?');
      assert.ok(selected.length >= 2, 'expected at least two experience chunks');
      const first = selected[0].description || selected[0].text || '';
      assert.ok(first.includes('Marine Biologist'), `first chunk should be Marine Biologist, got: ${first}`);
    });

    it('does not silently infer classification when no metadata is present', () => {
      const knowledge = synthKnowledge({
        experience: [
          { role: 'Marine Biologist', company: 'Tide Research' },
          { role: 'Platform Engineer', company: 'Orbit Systems' }
        ]
      });
      const { selected } = buildRagEvidence([], 2000, 10, 'EXPERIENCE', knowledge, 'What non-technical experience does the subject have?');
      assert.ok(selected.length >= 2);
      const first = selected[0].description || selected[0].text || '';
      // Source order must be preserved because no structured label exists.
      assert.ok(first.includes('Marine Biologist'), `source order should be preserved, got: ${first}`);
    });
  });

  describe('occupation validation is structural, not a static blacklist', () => {
    it('accepts an arbitrary documented role with a documented company', () => {
      const knowledge = synthKnowledge({
        experience: [{ role: 'Quantum Cartographer', company: 'Helix Research' }]
      });
      const graph = buildRelationshipGraph(knowledge);
      const result = validateAnswer(
        'Morgan worked as a Quantum Cartographer at Helix Research.',
        'Morgan worked as a Quantum Cartographer at Helix Research.',
        'What jobs has Morgan had?',
        knowledge,
        [],
        graph
      );
      assert.equal(result.valid, true, JSON.stringify(result.reasons));
      assert.ok(!result.reasons.some(r => r.startsWith('fabricated_occupation:')), JSON.stringify(result.reasons));
    });

    it('rejects an arbitrary unsupported role even at a documented company', () => {
      const knowledge = synthKnowledge({
        experience: [{ role: 'Quantum Cartographer', company: 'Helix Research' }]
      });
      const graph = buildRelationshipGraph(knowledge);
      const result = validateAnswer(
        'Morgan worked as an Acoustic Systems Curator at Helix Research.',
        'Morgan worked as a Quantum Cartographer at Helix Research.',
        'What jobs has Morgan had?',
        knowledge,
        [],
        graph
      );
      assert.equal(result.valid, false, 'expected a fabricated role to be rejected');
      assert.ok(result.reasons.some(r => r.startsWith('fabricated_occupation:') || r.startsWith('unsupported_relationship:')),
        JSON.stringify(result.reasons));
    });

    it('does not reject a negated unsupported role', () => {
      const knowledge = synthKnowledge({
        experience: [{ role: 'Quantum Cartographer', company: 'Helix Research' }]
      });
      const graph = buildRelationshipGraph(knowledge);
      const result = validateAnswer(
        'Morgan was not an Acoustic Systems Curator.',
        'Morgan worked as a Quantum Cartographer at Helix Research.',
        'Was Morgan an Acoustic Systems Curator?',
        knowledge,
        [],
        graph
      );
      assert.ok(!result.reasons.some(r => r.startsWith('fabricated_occupation:')), JSON.stringify(result.reasons));
    });

    it('rejects a positive arbitrary role claim with no company', () => {
      const knowledge = synthKnowledge({
        experience: [{ role: 'Quantum Cartographer', company: 'Helix Research' }]
      });
      const graph = buildRelationshipGraph(knowledge);
      const result = validateAnswer(
        'Morgan is an Acoustic Systems Curator.',
        'Morgan worked as a Quantum Cartographer at Helix Research.',
        'What is Morgan?',
        knowledge,
        [],
        graph
      );
      assert.equal(result.valid, false, 'expected unsupported type assertion to fail');
      assert.ok(result.reasons.some(r => r.startsWith('unsupported_relationship:') || r.startsWith('fabricated_occupation:')),
        JSON.stringify(result.reasons));
    });

    it('no longer hardcodes neurosurgeon as a forbidden term', () => {
      const knowledge = synthKnowledge({
        experience: [{ role: 'Quantum Cartographer', company: 'Helix Research' }]
      });
      const graph = buildRelationshipGraph(knowledge);
      const negatedResult = validateAnswer(
        'Morgan is not a neurosurgeon.',
        'Morgan worked as a Quantum Cartographer at Helix Research.',
        'Is Morgan a neurosurgeon?',
        knowledge,
        [],
        graph
      );
      assert.equal(negatedResult.valid, true, JSON.stringify(negatedResult.reasons));
      const positiveResult = validateAnswer(
        'Morgan is a neurosurgeon.',
        'Morgan worked as a Quantum Cartographer at Helix Research.',
        'Is Morgan a neurosurgeon?',
        knowledge,
        [],
        graph
      );
      assert.equal(positiveResult.valid, false, 'expected unsupported neurosurgeon claim to fail');
    });

    it('allows non-person entity type assertions to use entity/type semantics', () => {
      const knowledge = synthKnowledge({
        services: [{ name: 'Panel Upgrade', category: 'Electrical Service', description: 'Home electrical panel replacement' }]
      });
      const graph = buildRelationshipGraph(knowledge);
      const result = validateAnswer(
        'Panel Upgrade is an electrical service for home electrical panel replacement.',
        'Panel Upgrade is an electrical service.',
        'What is Panel Upgrade?',
        knowledge,
        [],
        graph
      );
      assert.equal(result.valid, true, JSON.stringify(result.reasons));
      assert.ok(!result.reasons.some(r => r.startsWith('fabricated_occupation:')), JSON.stringify(result.reasons));
    });
  });

  describe('learning-platform relationships come only from explicit tenant relationships', () => {
    it('does not infer uses_platform from gap prose', () => {
      const knowledge = synthKnowledge({
        summary: {
          honestGaps: ['Data structures and algorithms, with Udemy courses and math discussions but no production mentorship.']
        }
      });
      const graph = buildRelationshipGraph(knowledge);
      const platformTriples = graph.triples.filter(t => t.relation === 'uses_platform');
      assert.equal(platformTriples.length, 0, `unexpected platform triples: ${JSON.stringify(platformTriples)}`);
    });

    it('honours explicit generic uses_platform relationships', () => {
      const knowledge = synthKnowledge({
        relationships: [
          { subject: 'Atlas', relation: 'uses_platform', object: 'StudySphere' }
        ]
      });
      const graph = buildRelationshipGraph(knowledge);
      const supported = graph.triples.some(t =>
        t.subject === 'Atlas' && t.relation === 'uses_platform' && t.object === 'StudySphere'
      );
      assert.ok(supported, 'expected Atlas uses_platform StudySphere triple');

      const valid = validateAnswer(
        'Atlas uses StudySphere.',
        'Atlas uses StudySphere.',
        'What platform does Atlas use?',
        knowledge,
        [],
        graph
      );
      assert.equal(valid.valid, true, JSON.stringify(valid.reasons));

      const invalid = validateAnswer(
        'Atlas uses Coursera.',
        'Atlas uses StudySphere.',
        'What platform does Atlas use?',
        knowledge,
        [],
        graph
      );
      assert.equal(invalid.valid, false, 'expected unsupported platform claim to fail');
      assert.ok(invalid.reasons.some(r => r.startsWith('unsupported_relationship:')), JSON.stringify(invalid.reasons));
    });
  });

  describe('negative-assessment contract is subject-neutral', () => {
    it('does not include Bradley/DSA/Udemy/LeetCode exemplars in generated packet', () => {
      const knowledge = synthKnowledge({
        summary: {
          honestGaps: ['Spanish language acquisition through conversation practice, with no immersion program.']
        },
        skills: {
          learningOrAdjacent: ['Spanish language acquisition']
        }
      });
      const contract = buildResponseContract(
        'What is the subject bad at?',
        'Spanish language acquisition through conversation practice, with no immersion program.',
        knowledge
      );
      const allText = [
        contract.naturalInstructions || '',
        ...(contract.keyFacts || []),
        contract.boundary || ''
      ].join('\n');
      assert.ok(!allText.includes('Bradley'), 'packet should not mention Bradley');
      assert.ok(!allText.includes('DSA'), 'packet should not mention DSA');
      assert.ok(!allText.includes('Udemy'), 'packet should not mention Udemy');
      assert.ok(!allText.includes('LeetCode'), 'packet should not mention LeetCode');
      assert.ok(allText.includes('Spanish language acquisition'), 'packet should name the actual documented gap');
      assert.ok(allText.includes('documented'), 'packet should use neutral documented language');
    });
  });
});
