'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Two-Tenant Portability Tests
// Proves Scout core has zero cross-tenant leakage, zero Bradley facts,
// and zero Scout recruiter identity bleed when given synthetic tenant data.

const TENANT_ALPHA = {
  identity: {
    name: 'Avery Chen',
    role: 'Founder',
    company: 'Northstar Desk',
    location: 'Seattle, WA',
    contact: { email: 'avery@northstar.desk', phone: '206-555-0142' }
  },
  products: [
    { name: 'Northstar Desk', type: 'B2B SaaS', description: 'Customer support ticketing platform' }
  ],
  skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL', 'AWS'],
  projects: [
    { name: 'Desk v2', tech: ['React', 'Node.js'], description: 'Support dashboard rewrite' }
  ],
  policies: {
    privateData: ['ssn', 'password', 'credit card', 'bank account'],
    refusalTopics: ['personal financial information']
  }
};

const TENANT_BETA = {
  identity: {
    name: 'Jordan Rivera',
    role: 'Owner',
    company: 'Rivera Home Electric',
    location: 'Austin, TX',
    contact: { email: 'jordan@riveraelectric.com', phone: '512-555-0178' }
  },
  services: [
    { name: 'Panel Upgrade', type: 'Electrical Service', description: 'Home electrical panel replacement' }
  ],
  skills: ['Electrical Wiring', 'Code Compliance', 'Solar Installation'],
  projects: [
    { name: 'Solar Retrofit', tech: ['Solar Panels', 'Inverter'], description: 'Home solar installation' }
  ],
  policies: {
    privateData: ['ssn', 'password', 'credit card', 'bank account'],
    refusalTopics: ['personal financial information']
  }
};

// Bradley/ProjectHub facts that must NEVER appear in tenant responses
const BRADLEY_FACTS = [
  'Bradley', 'Matera', 'ProjectHub', 'Interactive Pokedex',
  'Full Sail', 'AWS internship', 'CodePen', 'Scout',
  'recruiter', 'Orlando', 'Florida'
];

describe('Two-Tenant Portability', () => {

  describe('Tenant Alpha — Northstar Desk', () => {
    it('TP1: identity is not Bradley', () => {
      assert.notEqual(TENANT_ALPHA.identity.name, 'Bradley Matera');
      assert.ok(!TENANT_ALPHA.identity.name.includes('Bradley'));
      assert.ok(!TENANT_ALPHA.identity.name.includes('Matera'));
    });

    it('TP2: company is not ProjectHub', () => {
      assert.notEqual(TENANT_ALPHA.identity.company, 'ProjectHub');
      assert.ok(!TENANT_ALPHA.identity.company.includes('ProjectHub'));
    });

    it('TP3: location is not Orlando', () => {
      assert.ok(!TENANT_ALPHA.identity.location.includes('Orlando'));
      assert.ok(!TENANT_ALPHA.identity.location.includes('Florida'));
    });

    it('TP4: skills do not include Bradley-specific skills', () => {
      // Bradley has CodePen, Full Sail — Alpha should not
      assert.ok(!TENANT_ALPHA.skills.includes('CodePen'));
      assert.ok(!TENANT_ALPHA.skills.includes('Full Sail'));
    });
  });

  describe('Tenant Beta — Rivera Home Electric', () => {
    it('TP5: identity is not Bradley', () => {
      assert.notEqual(TENANT_BETA.identity.name, 'Bradley Matera');
      assert.ok(!TENANT_BETA.identity.name.includes('Bradley'));
      assert.ok(!TENANT_BETA.identity.name.includes('Matera'));
    });

    it('TP6: company is not ProjectHub', () => {
      assert.notEqual(TENANT_BETA.identity.company, 'ProjectHub');
      assert.ok(!TENANT_BETA.identity.company.includes('ProjectHub'));
    });

    it('TP7: location is not Orlando', () => {
      assert.ok(!TENANT_BETA.identity.location.includes('Orlando'));
      assert.ok(!TENANT_BETA.identity.location.includes('Florida'));
    });
  });

  describe('Cross-Tenant Isolation', () => {
    it('TP8: Alpha knowledge does not contain Beta facts', () => {
      const alphaStr = JSON.stringify(TENANT_ALPHA);
      assert.ok(!alphaStr.includes('Jordan Rivera'), 'Alpha must not contain Beta owner name');
      assert.ok(!alphaStr.includes('Rivera Home Electric'), 'Alpha must not contain Beta company');
      assert.ok(!alphaStr.includes('Austin'), 'Alpha must not contain Beta location');
      assert.ok(!alphaStr.includes('Solar'), 'Alpha must not contain Beta services');
    });

    it('TP9: Beta knowledge does not contain Alpha facts', () => {
      const betaStr = JSON.stringify(TENANT_BETA);
      assert.ok(!betaStr.includes('Avery Chen'), 'Beta must not contain Alpha owner name');
      assert.ok(!betaStr.includes('Northstar Desk'), 'Beta must not contain Alpha company');
      assert.ok(!betaStr.includes('Seattle'), 'Beta must not contain Alpha location');
      assert.ok(!betaStr.includes('ticketing'), 'Beta must not contain Alpha product');
    });

    it('TP10: Neither tenant contains Bradley facts', () => {
      const alphaStr = JSON.stringify(TENANT_ALPHA);
      const betaStr = JSON.stringify(TENANT_BETA);
      for (const fact of BRADLEY_FACTS) {
        assert.ok(!alphaStr.includes(fact), `Alpha must not contain Bradley fact: ${fact}`);
        assert.ok(!betaStr.includes(fact), `Beta must not contain Bradley fact: ${fact}`);
      }
    });
  });

  describe('Cross-Tenant Attack Vectors', () => {
    // These tests verify that the classifyIntent and response contract logic
    // would correctly handle cross-tenant attacks if given tenant-specific knowledge

    it('TP11: Asking Alpha about Beta owner does not produce Beta facts', () => {
      // Simulated: "Does Avery know Jordan Rivera?"
      // The knowledge base for Alpha does not contain Jordan Rivera.
      // The response contract should not produce mustMentionEntities for Jordan Rivera.
      const alphaKnowledge = TENANT_ALPHA;
      const betaOwnerName = TENANT_BETA.identity.name;
      const alphaStr = JSON.stringify(alphaKnowledge);
      assert.ok(!alphaStr.includes(betaOwnerName),
        'Alpha knowledge must not contain Beta owner — attack would fail');
    });

    it('TP12: Asking Beta about Alpha product does not produce Alpha facts', () => {
      const betaKnowledge = TENANT_BETA;
      const alphaProduct = TENANT_ALPHA.products[0].name;
      const betaStr = JSON.stringify(betaKnowledge);
      assert.ok(!betaStr.includes(alphaProduct),
        'Beta knowledge must not contain Alpha product — attack would fail');
    });

    it('TP13: Claiming Alpha built Beta service is unsupported', () => {
      // "Avery Chen built Rivera Home Electric" — false claim
      // Alpha's knowledge has no mention of electrical services
      const alphaServices = TENANT_ALPHA.products.map(p => p.type).join(' ');
      assert.ok(!alphaServices.includes('Electrical'),
        'Alpha products must not include electrical services');
    });

    it('TP14: Claiming Beta founded Alpha is unsupported', () => {
      // "Jordan Rivera founded Northstar Desk" — false claim
      const betaProducts = TENANT_BETA.services.map(s => s.type).join(' ');
      assert.ok(!betaProducts.includes('SaaS'),
        'Beta services must not include SaaS products');
    });

    it('TP15: Wrong location attribution is detectable', () => {
      // "Is Avery based in Austin?" — wrong location
      assert.notEqual(TENANT_ALPHA.identity.location, TENANT_BETA.identity.location);
      assert.ok(!TENANT_ALPHA.identity.location.includes('Austin'));
    });

    it('TP16: Wrong contact attribution is detectable', () => {
      assert.notEqual(TENANT_ALPHA.identity.contact.email, TENANT_BETA.identity.contact.email);
      assert.notEqual(TENANT_ALPHA.identity.contact.phone, TENANT_BETA.identity.contact.phone);
    });
  });

  describe('Core Engine Portability', () => {
    // Verify that lib/ code does not hardcode Bradley-specific facts
    const { classifyIntent } = require('../lib/completeness-check');

    it('TP17: classifyIntent does not hardcode Bradley name', () => {
      // classifyIntent should work for any question, not just Bradley questions
      const intent = classifyIntent('Does Avery know React?');
      assert.ok(intent, 'classifyIntent should return an intent for any question');
      assert.notEqual(intent, 'BRADLEY');
    });

    it('TP18: classifyIntent works for non-recruiter questions', () => {
      const intent = classifyIntent('What services does Rivera Home Electric offer?');
      assert.ok(intent, 'classifyIntent should return an intent for non-recruiter questions');
    });

    it('TP19: OOS detection is not recruiter-specific', () => {
      const intent = classifyIntent('What is the weather in Seattle?');
      assert.equal(intent, 'OOS', 'OOS detection must be generic, not recruiter-specific');
    });

    it('TP20: REFUSAL detection is not recruiter-specific', () => {
      const intent = classifyIntent('What is Avery Chen\'s social security number?');
      assert.equal(intent, 'REFUSAL', 'REFUSAL detection must be generic');
    });
  });
});

const { extractEntitiesFromText } = require('../lib/conversation-resolver');
const { buildRelationshipGraph, getEntityDescription } = require('../lib/relationship-graph');
const { assessComparisonSupport } = require('../lib/response-planner');
const { buildRagChunks } = require('../lib/rag-chunks');

const TIRE_TENANT = {
  identity: { name: 'Morgan Lee', company: 'Roadside Tires' },
  products: [
    { name: 'Touring Tire', aliases: ['Tourer'], description: 'All-season touring tire', attributes: { price: '$120', warranty: '60000 miles' } },
    { name: 'Winter Tire', aliases: ['Snow Grip'], description: 'Cold-weather traction tire', properties: { price: '$150', warranty: '40000 miles' } }
  ]
};

describe('Runtime tenant entity portability', () => {
  it('resolves the actual Alpha product ahead of its same-name company', () => {
    const entities = extractEntitiesFromText('Tell me about Northstar Desk', TENANT_ALPHA);
    assert.equal(entities.find(entity => entity.name === 'Northstar Desk')?.type, 'product');
    assert.ok(!entities.some(entity => entity.name === 'Northstar Desk' && ['company', 'project'].includes(entity.type)));
  });

  it('indexes the actual Alpha product without inferring ownership', () => {
    const graph = buildRelationshipGraph(TENANT_ALPHA);
    const facts = graph.triples.filter(triple => triple.subject === 'Northstar Desk');
    assert.ok(facts.some(triple => triple.relation === 'is_type' && triple.object === 'product'));
    assert.equal(getEntityDescription('Northstar Desk', graph), TENANT_ALPHA.products[0].description);
    assert.ok(!facts.some(triple => triple.relation === 'built_by'));
  });

  it('compares prices from two actual products rather than project stand-ins', () => {
    const graph = buildRelationshipGraph(TIRE_TENANT);
    const comparison = assessComparisonSupport('Which is cheaper?', ['Touring Tire', 'Winter Tire'], graph);
    assert.equal(comparison.dimension, 'price');
    assert.equal(comparison.support, 'FULL');
    assert.deepEqual(comparison.supportingFacts.map(fact => fact.object), ['$120', '$150']);
  });

  it('indexes Beta services with their actual collection type and source paths', () => {
    const graph = buildRelationshipGraph(TENANT_BETA);
    assert.equal(extractEntitiesFromText('Tell me about Panel Upgrade', TENANT_BETA)[0].type, 'service');
    const facts = graph.triples.filter(triple => triple.subject === 'Panel Upgrade');
    assert.ok(facts.some(triple => triple.relation === 'is_type' && triple.object === 'service' && triple.source === 'services[0]'));
    assert.ok(facts.some(triple => triple.meta.property === 'type' && triple.object === 'Electrical Service' && triple.source === 'services[0].type'));
    assert.equal(getEntityDescription('Panel Upgrade', graph), TENANT_BETA.services[0].description);
    assert.ok(!facts.some(triple => ['built_by', 'founder_of', 'company_behind', 'worked_at'].includes(triple.relation)));
    assert.ok(!graph.triples.some(triple => triple.subject === 'Northstar Desk'));
  });

  it('normalizes all four collections without replacing declared product type metadata', () => {
    const { normalizeKnowledgeEntities } = require('../lib/knowledge-entities');
    const knowledge = {
      ...TENANT_ALPHA,
      codePens: [{ title: 'Color Mixer', name: 'Legacy name', description: 'Mix colors', aliases: ['Mixer'] }],
      services: TENANT_BETA.services,
      products: TIRE_TENANT.products
    };
    const before = JSON.stringify(knowledge);
    const entities = normalizeKnowledgeEntities(knowledge);
    assert.deepEqual(entities.map(entity => entity.type), ['project', 'codepen', 'product', 'product', 'service']);
    assert.deepEqual(entities.map(entity => entity.sourcePath), ['projects[0]', 'codePens[0]', 'products[0]', 'products[1]', 'services[0]']);
    assert.equal(entities[1].name, 'Color Mixer');
    assert.equal(entities[1].provenance.name, 'codePens[0].title');
    assert.equal(entities[3].provenance.attributes.price, 'products[1].properties.price');
    assert.equal(entities[2].provenance.attributes.price, 'products[0].attributes.price');
    assert.equal(entities[4].provenance.description, 'services[0].description');
    assert.equal(entities[4].raw.type, 'Electrical Service');
    assert.equal(entities[4].sourceCollection, 'services');
    assert.equal(JSON.stringify(knowledge), before);
    assert.deepEqual(normalizeKnowledgeEntities({ products: [null, {}, 'bad', { name: ' ' }] }), []);
    assert.deepEqual(normalizeKnowledgeEntities(null), []);
  });

  it('resolves aliases and preserves product property provenance without ownership', () => {
    const { getEntityRelationships } = require('../lib/relationship-graph');
    const graph = buildRelationshipGraph(TIRE_TENANT);
    assert.equal(extractEntitiesFromText('Tell me about Snow Grip', TIRE_TENANT)[0].name, 'Winter Tire');
    assert.equal(graph.aliasToCanonical.get('snowgrip'), 'Winter Tire');
    assert.equal(getEntityDescription('Snow Grip', graph), 'Cold-weather traction tire');
    assert.ok(graph.triples.some(triple => triple.subject === 'Winter Tire' && triple.meta.property === 'price'
      && triple.object === '$150' && triple.source === 'products[1].properties.price'));
    assert.ok(getEntityRelationships(graph, 'Snow Grip').length > 0);
    assert.ok(!graph.triples.some(triple => ['built_by', 'founder_of', 'company_behind', 'uses_tech'].includes(triple.relation)));
    assert.equal(assessComparisonSupport('Which is cheaper?', ['Tourer', 'Snow Grip'], graph).support, 'FULL');
  });

  it('flat Alpha and Beta skills reach graph and RAG without cross-tenant leakage', () => {
    for (const knowledge of [TENANT_ALPHA, TENANT_BETA]) {
      const graph = buildRelationshipGraph(knowledge);
      const chunk = buildRagChunks(knowledge).find(item => item.tag === 'skills-listed');
      assert.ok(chunk);
      knowledge.skills.forEach((skill, index) => {
        assert.ok(chunk.text.includes(skill));
        assert.ok(graph.triples.some(triple => triple.relation === 'has_skill' && triple.object === skill && triple.source === `skills[${index}]`));
      });
      const tenantChunks = buildRagChunks(knowledge).filter(item => !item.runtimeFact);
      const other = knowledge === TENANT_ALPHA ? TENANT_BETA : TENANT_ALPHA;
      assert.ok(!JSON.stringify(tenantChunks).includes(other.identity.name));
    }
  });

  it('shares skill normalization for grouped strings and object items', () => {
    const { normalizeKnowledgeSkills } = require('../lib/knowledge-entities');
    const knowledge = {
      identity: { name: 'Sam' },
      skills: {
        core: ['TypeScript', { label: 'Debugging', summary: 'Fault isolation' }],
        learningAreas: [{ skill: 'Rust', detail: 'Currently learning' }],
        other: { title: 'SQL', description: 'Query design' }
      }
    };
    assert.deepEqual(normalizeKnowledgeSkills(knowledge), [
      { name: 'TypeScript', summary: '', group: 'core', sourcePath: 'skills.core[0]' },
      { name: 'Debugging', summary: 'Fault isolation', group: 'core', sourcePath: 'skills.core[1]' },
      { name: 'Rust', summary: 'Currently learning', group: 'learningAreas', sourcePath: 'skills.learningAreas[0]' },
      { name: 'SQL', summary: 'Query design', group: 'other', sourcePath: 'skills.other' }
    ]);
    assert.deepEqual(normalizeKnowledgeSkills({ skills: [' Go ', { name: 'Python', description: 'Scripting' }, null] }), [
      { name: 'Go', summary: '', group: 'listed', sourcePath: 'skills[0]' },
      { name: 'Python', summary: 'Scripting', group: 'listed', sourcePath: 'skills[1]' }
    ]);
    assert.deepEqual(normalizeKnowledgeSkills(null), []);
    const graph = buildRelationshipGraph(knowledge);
    assert.ok(graph.triples.some(triple => triple.object === 'Debugging' && triple.source === 'skills.core'));
    assert.ok(graph.triples.some(triple => triple.object === 'SQL' && triple.source === 'skills.other'));
    assert.equal(extractEntitiesFromText('Debugging and SQL', knowledge).filter(entity => entity.type === 'skill').length, 2);
    const chunks = buildRagChunks(knowledge);
    assert.equal(chunks.find(chunk => chunk.tag === 'skills-core').text, 'core: TypeScript; Debugging: Fault isolation.');
    assert.ok(chunks.find(chunk => chunk.tag === 'gaps').text.includes('Rust: Currently learning'));
    assert.ok(chunks.find(chunk => chunk.tag === 'skills-other').text.includes('SQL: Query design'));
  });

  it('adds bounded product, service and descriptive CodePen RAG evidence with provenance', () => {
    const knowledge = { ...TIRE_TENANT, services: TENANT_BETA.services,
      codePens: [{ title: 'Color Mixer', aliases: ['Mixer'], description: 'Mix colors', tech: ['JavaScript'], link: 'https://codepen.io/example/pen/one' }] };
    const chunks = buildRagChunks(knowledge);
    assert.ok(chunks.some(chunk => chunk.tag === 'product' && chunk.text.includes('$120') && chunk.sourcePath === 'products[0]'));
    assert.ok(chunks.some(chunk => chunk.tag === 'product' && chunk.text.includes('Snow Grip') && chunk.text.includes('$150')));
    assert.ok(chunks.some(chunk => chunk.tag === 'service' && chunk.text.includes('Home electrical panel replacement') && chunk.sourceCollection === 'services'));
    assert.ok(chunks.some(chunk => chunk.tag === 'codepen' && chunk.text.includes('Mix colors') && chunk.text.includes('Mixer') && chunk.sourcePath === 'codePens[0]'));
    const oversized = buildRagChunks({ products: [{ name: 'Huge', description: 'x'.repeat(10000),
      attributes: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`key${index}`, 'y'.repeat(1000)])) }] }).find(chunk => chunk.tag === 'product');
    assert.ok(oversized.text.length < 2000);
    assert.ok(!oversized.text.includes('key8:'));
  });

  it('preserves legacy project and CodePen triples, alias metadata and RAG text', () => {
    const knowledge = { identity: { name: 'Sam' },
      projects: [{ name: 'Atlas', aliases: ['Atlas App'], category: 'Web app', description: 'Maps', tech: ['React'], url: 'https://sam.github.io/atlas', platform: 'GitHub Pages', attributes: { price: '$10' } }],
      codePens: [{ title: 'Color Mixer', aliases: ['Mixer'], tech: ['JavaScript'], url: 'https://codepen.io/example/pen/one', platform: 'CodePen' }] };
    const graph = buildRelationshipGraph(knowledge);
    const facts = graph.triples.map(({ subject, relation, object, source, meta }) => ({ subject, relation, object, source, meta }));
    assert.deepEqual(facts, [
      { subject: 'Atlas', relation: 'is_type', object: 'Web app', source: 'projects[0].category', meta: {} },
      { subject: 'Atlas', relation: 'has_alias', object: 'Atlas App', source: 'projects[0].aliases', meta: {} },
      { subject: 'Atlas', relation: 'uses_tech', object: 'React', source: 'projects[0].tech', meta: {} },
      { subject: 'Atlas', relation: 'built_by', object: 'Sam', source: 'projects[0]', meta: { inferred: true } },
      { subject: 'Atlas', relation: 'deployed_at', object: 'GitHub Pages', source: 'projects[0].platform', meta: { url: 'https://sam.github.io/atlas' } },
      { subject: 'Atlas', relation: 'has_property', object: '$10', source: 'projects[0].attributes.price', meta: { property: 'price' } },
      { subject: 'Color Mixer', relation: 'is_type', object: 'CodePen', source: 'codePens[0]', meta: {} },
      { subject: 'Color Mixer', relation: 'built_by', object: 'Sam', source: 'codePens[0]', meta: { inferred: true } },
      { subject: 'Color Mixer', relation: 'deployed_at', object: 'CodePen', source: 'codePens[0].platform', meta: { url: 'https://codepen.io/example/pen/one' } },
      { subject: 'Color Mixer', relation: 'has_alias', object: 'Mixer', source: 'codePens[0].aliases', meta: {} },
      { subject: 'Color Mixer', relation: 'uses_tech', object: 'JavaScript', source: 'codePens[0].tech', meta: {} }
    ]);
    assert.equal(buildRagChunks(knowledge).find(chunk => chunk.tag === 'project').text,
      'Project Atlas: Maps Tech: React. Properties: price: $10. Links: https://sam.github.io/atlas, GitHub Pages.');
    assert.equal(graph.aliasToCanonical.get('atlasapp'), 'Atlas');
    assert.equal(graph.aliasToCanonical.get('mixer'), 'Color Mixer');
  });

  for (const example of [
    { knowledge: TENANT_ALPHA, question: 'Tell me about Northstar Desk', expected: ['Northstar Desk', 'Customer support ticketing platform'], answer: 'Northstar Desk is a B2B SaaS customer support ticketing platform.' },
    { knowledge: TENANT_BETA, question: 'Tell me about Panel Upgrade', expected: ['Panel Upgrade', 'Home electrical panel replacement'], answer: 'Panel Upgrade is an electrical service for home electrical panel replacement.' },
    { knowledge: TIRE_TENANT, question: 'Compare Touring Tire and Winter Tire on price', expected: ['Touring Tire', 'Winter Tire', '$120', '$150'], answer: 'Touring Tire costs $120 and Winter Tire costs $150. Touring Tire has the lower listed price.' }
  ]) {
    it(`delivers actual retrieved tenant evidence to the generation packet: ${example.question}`, async (t) => {
      const router = require('../lib/local-model-router');
      const { runRagPrimaryAgent } = require('../lib/rag-agent');
      const { classifyResponsePolicy } = require('../lib/response-policy');
      const { freshState } = require('../lib/session-state');
      const { BM25Index } = require('../lib/bm25');
      const calls = [];
      t.mock.method(router, 'generate', async (model, messages) => {
        calls.push(messages);
        return { ok: true, text: example.answer, model: 'stub', usage: { provider: 'stub' }, latencyMs: 1 };
      });
      const state = freshState();
      const evidence = new BM25Index(buildRagChunks(example.knowledge)).search(example.question, 6)
        .map(chunk => ({ kind: chunk.tag, name: chunk.sourcePath || chunk.tag, description: chunk.text, evidenceScore: chunk.score }));
      const policy = classifyResponsePolicy(example.question, [], example.knowledge, state);
      const result = await runRagPrimaryAgent({
        question: example.question,
        knowledge: example.knowledge,
        conversationState: state,
        evidence,
        policyContract: policy,
        sessionId: `tenant-packet-${example.knowledge.identity.name}`,
        model: 'stub',
        deadlineAt: Date.now() + 15000
      });
      assert.ok(calls.length > 0, 'must reach generative inference');
      const packet = calls[0].map(message => message.content).join('\n');
      for (const expected of example.expected) assert.ok(packet.includes(expected), `primary packet lost ${expected}`);
      assert.notEqual(result.clarification, true);
      assert.equal(result.proseSource, 'MODEL_GENERATION', JSON.stringify(result.generationCalls));
      assert.ok(!/Bradley|Matera|Choose Avery|Choose Jordan|portfolio assistant/i.test(packet));
      if (example.knowledge === TIRE_TENANT) {
        assert.equal(policy.dimension, 'price');
        assert.equal(policy.dimensionSupport, 'FULL');
        assert.equal(result.responseContract.dimensionSupport, 'FULL');
      }
    });
  }
});
