'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildEntityRegistry, normalizeEntity } = require('../lib/canonical-entities');

// =========================================================
// Synthetic fixtures — Maria Lopez lives in Austin, Texas,
// has a LinkedIn URL and GitHub URL, and has FAQ entries
// mentioning specific technologies.
// =========================================================

const syntheticKnowledge = {
  identity: {
    name: 'Maria Lopez',
    location: 'Austin, Texas',
    linkedInUrl: 'https://linkedin.com/in/marialopez',
    githubUrl: 'https://github.com/marialopez',
  },
  summary: {
    name: 'Maria Lopez',
    whoIAm: 'An entry-level developer who builds rendering engines.',
  },
  projects: [
    {
      name: 'Nebula Engine',
      category: 'Rendering engine',
      tech: ['Rust', 'WebGPU'],
      url: 'https://example.github.io/nebula',
      description: 'A real-time rendering engine built with Rust and WebGPU.',
      aliases: ['Nebula'],
    },
  ],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Software Engineering Intern',
      type: 'internship',
      skills: ['Rust', 'C++'],
    },
  ],
  education: {
    school: 'Stanford University',
    degree: 'BS Computer Science',
  },
  skills: {
    languages: ['Rust', 'C++', 'JavaScript'],
    frameworks: ['WebGPU'],
  },
  certifications: [],
  faq: [
    {
      question: 'What technologies does Maria use?',
      answer: 'Maria primarily uses Rust and WebGPU for the Nebula Engine project, and she is learning Kubernetes.',
    },
    {
      question: 'Is Maria available for hire?',
      answer: 'Yes, Maria is based in Austin and open to remote opportunities.',
    },
  ],
};

// --- Entity registry tests ---

test('entity registry includes identity.location parts', () => {
  const registry = buildEntityRegistry(syntheticKnowledge, '');
  assert.ok(registry.has(normalizeEntity('Austin')), 'Registry should include "Austin" from identity.location');
  assert.ok(registry.has(normalizeEntity('Texas')), 'Registry should include "Texas" from identity.location');
});

test('entity registry includes full identity.location', () => {
  const registry = buildEntityRegistry(syntheticKnowledge, '');
  assert.ok(registry.has(normalizeEntity('Austin, Texas')), 'Registry should include full location string');
});

test('entity registry includes LinkedIn from linkedInUrl', () => {
  const registry = buildEntityRegistry(syntheticKnowledge, '');
  assert.ok(registry.has(normalizeEntity('LinkedIn')), 'Registry should include "LinkedIn" from linkedInUrl');
});

test('entity registry includes GitHub from githubUrl', () => {
  const registry = buildEntityRegistry(syntheticKnowledge, '');
  assert.ok(registry.has(normalizeEntity('GitHub')), 'Registry should include "GitHub" from githubUrl');
});

test('entity registry includes capitalized entities from FAQ answers', () => {
  const registry = buildEntityRegistry(syntheticKnowledge, '');
  // "Kubernetes" appears in the FAQ answer but not in skills/projects
  assert.ok(registry.has(normalizeEntity('Kubernetes')), 'Registry should include "Kubernetes" from FAQ answer');
});

test('entity registry includes Nebula Engine from FAQ answer', () => {
  const registry = buildEntityRegistry(syntheticKnowledge, '');
  assert.ok(registry.has(normalizeEntity('Nebula Engine')), 'Registry should include "Nebula Engine" from FAQ answer');
});

test('entity registry does NOT include entities not in knowledge', () => {
  const registry = buildEntityRegistry(syntheticKnowledge, '');
  assert.ok(!registry.has(normalizeEntity('Quantum Computing')), 'Registry should NOT include unknown tech');
  assert.ok(!registry.has(normalizeEntity('Netflix')), 'Registry should NOT include unknown company');
});

// --- Test with minimal knowledge (no identity.location) ---

test('entity registry handles missing identity.location gracefully', () => {
  const minimalKnowledge = {
    identity: { name: 'Jane Doe' },
    projects: [],
  };
  const registry = buildEntityRegistry(minimalKnowledge, '');
  // Should not throw, should still have common words
  assert.ok(registry.has(normalizeEntity('React')), 'Common words should still be present');
});

// --- Test with no FAQ ---

test('entity registry handles missing FAQ gracefully', () => {
  const noFaqKnowledge = {
    identity: { name: 'Jane Doe', location: 'Portland, Oregon' },
    projects: [],
  };
  const registry = buildEntityRegistry(noFaqKnowledge, '');
  assert.ok(registry.has(normalizeEntity('Portland')), 'Should include location parts even without FAQ');
  assert.ok(registry.has(normalizeEntity('Oregon')), 'Should include location parts even without FAQ');
});
