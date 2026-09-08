'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildRagEvidence } = require('../lib/rag-agent');
const { validateAnswer } = require('../lib/grounding-validator');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const { buildResponseContract } = require('../lib/response-contract');
const { buildLitePacket } = require('../lib/lite-agent');
const { buildRecoveryContract } = require('../lib/recovery-contract');

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

    it('ranks nontechnical before unclassified before technical and preserves source order for ties', () => {
      const knowledge = synthKnowledge({
        experience: [
          { role: 'Unclassified Role', company: 'First Place' },
          { role: 'Explicit Nontechnical Role', company: 'Second Place', classification: 'nontechnical' },
          { role: 'Explicit Technical Role', company: 'Third Place', classification: 'technical' }
        ]
      });
      const { selected } = buildRagEvidence([], 2000, 10, 'EXPERIENCE', knowledge, 'What non-technical experience does the subject have?');
      assert.ok(selected.length >= 3, 'expected three experience chunks');
      const order = selected.map(s => s.description || s.text || '');
      assert.ok(order[0].includes('Explicit Nontechnical Role'), `first should be nontechnical, got: ${order[0]}`);
      assert.ok(order[1].includes('Unclassified Role'), `second should be unclassified, got: ${order[1]}`);
      assert.ok(order[2].includes('Explicit Technical Role'), `third should be technical, got: ${order[2]}`);
    });

    it('preserves source order for all-unclassified experience records', () => {
      const knowledge = synthKnowledge({
        experience: [
          { role: 'First Role', company: 'Alpha' },
          { role: 'Second Role', company: 'Beta' },
          { role: 'Third Role', company: 'Gamma' }
        ]
      });
      const { selected } = buildRagEvidence([], 2000, 10, 'EXPERIENCE', knowledge, 'What non-technical experience does the subject have?');
      assert.ok(selected.length >= 3);
      const order = selected.map(s => s.description || s.text || '');
      assert.ok(order[0].includes('First Role'), `first should be First Role, got: ${order[0]}`);
      assert.ok(order[1].includes('Second Role'), `second should be Second Role, got: ${order[1]}`);
      assert.ok(order[2].includes('Third Role'), `third should be Third Role, got: ${order[2]}`);
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

    it('rejects a stronger asserted role that adds modifiers to a documented role', () => {
      const knowledge = synthKnowledge({
        experience: [{ role: 'Quantum Cartographer', company: 'Helix Research' }]
      });
      const graph = buildRelationshipGraph(knowledge);
      const senior = validateAnswer(
        'Morgan worked as a Senior Quantum Cartographer at Helix Research.',
        'Morgan worked as a Senior Quantum Cartographer at Helix Research.',
        'What jobs has Morgan had?',
        knowledge,
        [],
        graph
      );
      assert.equal(senior.valid, false, JSON.stringify(senior.reasons));
      assert.ok(senior.reasons.some(r => r.startsWith('fabricated_occupation:')), JSON.stringify(senior.reasons));

      const lead = validateAnswer(
        'Morgan worked as a Lead Quantum Cartographer at Helix Research.',
        'Morgan worked as a Lead Quantum Cartographer at Helix Research.',
        'What jobs has Morgan had?',
        knowledge,
        [],
        graph
      );
      assert.equal(lead.valid, false, JSON.stringify(lead.reasons));
      assert.ok(lead.reasons.some(r => r.startsWith('fabricated_occupation:')), JSON.stringify(lead.reasons));
    });

    it('supports worked_at triples that carry role metadata', () => {
      const knowledge = synthKnowledge({
        relationships: [
          { subject: 'Morgan Vale', relation: 'worked_at', object: 'Helix Research', meta: { role: 'Quantum Cartographer' } }
        ]
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
    });

    it('does not treat a bare worked_at relation without role metadata as role evidence', () => {
      const knowledge = synthKnowledge({
        relationships: [
          { subject: 'Morgan Vale', relation: 'worked_at', object: 'Helix Research' }
        ]
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
      assert.equal(result.valid, false, JSON.stringify(result.reasons));
      assert.ok(result.reasons.some(r => r.startsWith('fabricated_occupation:')), JSON.stringify(result.reasons));
    });

    it('rejects a documented role at the wrong company', () => {
      const knowledge = synthKnowledge({
        relationships: [
          { subject: 'Morgan Vale', relation: 'worked_at', object: 'Helix Research', meta: { role: 'Quantum Cartographer' } }
        ]
      });
      const graph = buildRelationshipGraph(knowledge);
      const result = validateAnswer(
        'Morgan worked as a Quantum Cartographer at Nova Labs.',
        'Morgan worked as a Quantum Cartographer at Nova Labs.',
        'What jobs has Morgan had?',
        knowledge,
        [],
        graph
      );
      assert.equal(result.valid, false, JSON.stringify(result.reasons));
      assert.ok(result.reasons.some(r => r.startsWith('fabricated_occupation:')), JSON.stringify(result.reasons));
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

  describe('deployment/platform facts come from explicit tenant metadata', () => {
    it('does not infer deployed_at from a raw URL', () => {
      const knowledge = synthKnowledge({
        projects: [
          { name: 'Orchid Console', url: 'https://orchid.example/' }
        ]
      });
      const graph = buildRelationshipGraph(knowledge);
      const deployed = graph.triples.filter(t => t.subject === 'Orchid Console' && t.relation === 'deployed_at');
      assert.equal(deployed.length, 0, `expected no URL-inferred deployment, got: ${JSON.stringify(deployed)}`);
    });

    it('honours explicit project platform metadata', () => {
      const knowledge = synthKnowledge({
        projects: [
          { name: 'Orchid Console', url: 'https://orchid.example/', platform: 'NebulaHost' }
        ]
      });
      const graph = buildRelationshipGraph(knowledge);
      const supported = graph.triples.some(t =>
        t.subject === 'Orchid Console' && t.relation === 'deployed_at' && t.object === 'NebulaHost'
      );
      assert.ok(supported, 'expected Orchid Console deployed_at NebulaHost');
    });

    it('honours explicit deployed_at relationships', () => {
      const knowledge = synthKnowledge({
        relationships: [
          { subject: 'Orchid Console', relation: 'deployed_at', object: 'NebulaHost' }
        ]
      });
      const graph = buildRelationshipGraph(knowledge);
      const supported = graph.triples.some(t =>
        t.subject === 'Orchid Console' && t.relation === 'deployed_at' && t.object === 'NebulaHost'
      );
      assert.ok(supported, 'expected Orchid Console deployed_at NebulaHost');
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

  describe('pronoun handling is tenant-configurable and gender-neutral', () => {
    it('lite-agent packet does not force masculine pronouns', () => {
      const knowledge = synthKnowledge();
      const packet = buildLitePacket({
        question: 'What is Morgan good at?',
        compressedEvidence: 'FACT: Morgan knows JavaScript',
        operation: 'answer',
        maxTokens: 400,
        structuredFacts: 'FACT: Morgan knows JavaScript',
        plan: { tools: [], toolResults: [] },
        planText: 'Use the JavaScript skill fact.',
        responseContract: { intent: 'SKILL', subject: 'Morgan Vale', tenantSubject: 'Morgan Vale' },
        knowledge
      });
      const prompt = `${packet.systemPrompt} ${packet.userPrompt}`;
      // Reject the old forced form, but allow pronouns listed as options.
      assert.ok(!prompt.includes('Use third person (he/his).'), `should not force he/his, got: ${prompt}`);
      assert.ok(!/\bhe\s+knows\b/i.test(prompt), `should not say "he knows", got: ${prompt}`);
      // The prompt should mention the subject by name or use neutral fallback language.
      assert.ok(/Morgan|subject|they\/them|configured subject pronouns/i.test(prompt), `expected neutral subject language, got: ${prompt}`);
    });

    it('lite-agent packet preserves an explicit subject pronoun configuration', () => {
      const knowledge = synthKnowledge({
        extra: {
          identity: { name: 'Morgan Vale', preferredName: 'Morgan', pronouns: { subject: 'they', object: 'them', possessive: 'their' } }
        }
      });
      // Normalize pronouns into the shape knowledge-access expects.
      knowledge.identity.pronouns = { subject: 'they', object: 'them', possessive: 'their' };
      const packet = buildLitePacket({
        question: 'What is Morgan good at?',
        compressedEvidence: 'FACT: Morgan knows JavaScript',
        operation: 'answer',
        maxTokens: 400,
        structuredFacts: 'FACT: Morgan knows JavaScript',
        plan: { tools: [], toolResults: [] },
        planText: 'Use the JavaScript skill fact.',
        responseContract: { intent: 'SKILL', subject: 'Morgan Vale', tenantSubject: 'Morgan Vale' },
        knowledge
      });
      const prompt = `${packet.systemPrompt} ${packet.userPrompt}`;
      assert.ok(!/\bhe\s+knows\b/i.test(prompt), `should not say "he knows", got: ${prompt}`);
      assert.ok(/they\/them|their|configured subject pronouns/i.test(prompt), `expected configured neutral language, got: ${prompt}`);
    });

    it('recovery contract does not force masculine pronouns for an unknown skill', () => {
      const knowledge = synthKnowledge();
      const contract = buildRecoveryContract(
        { factState: 'UNKNOWN', directAnswer: 'UNKNOWN', evidence: 'unknown' },
        { operation: 'no_tool' },
        'Does Morgan know ZebraLang?',
        '',
        knowledge,
        'Does Morgan know ZebraLang?'
      );
      const text = JSON.stringify(contract);
      assert.ok(!/\bhe\s+knows\b/i.test(text), `should not say "he knows", got: ${text}`);
      assert.ok(!/\bDo not claim he\b/i.test(text), `should not say "Do not claim he", got: ${text}`);
      assert.ok(/Morgan/.test(text), `should refer to subject by name, got: ${text}`);
    });

    it('recovery contract preserves explicit subject pronouns', () => {
      const knowledge = synthKnowledge({
        extra: {
          identity: { name: 'Morgan Vale', pronouns: { subject: 'ze', object: 'zir', possessive: 'zir' } }
        }
      });
      knowledge.identity.pronouns = { subject: 'ze', object: 'zir', possessive: 'zir' };
      const contract = buildRecoveryContract(
        { factState: 'UNKNOWN', directAnswer: 'UNKNOWN', evidence: 'unknown' },
        { operation: 'no_tool' },
        'Does Morgan know ZebraLang?',
        '',
        knowledge,
        'Does Morgan know ZebraLang?'
      );
      const text = JSON.stringify(contract);
      assert.ok(!/\bhe\s+knows\b/i.test(text), `should not say "he knows", got: ${text}`);
      assert.ok(!/\bDo not claim he\b/i.test(text), `should not say "Do not claim he", got: ${text}`);
      // It should use the subject name, not overwrite the configured pronouns.
      assert.ok(/Morgan/.test(text), `should use subject name, got: ${text}`);
    });
  });
});
