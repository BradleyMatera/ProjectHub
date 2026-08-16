'use strict';

// Case 4 Source-of-Truth Regression Tests
//
// Interactive Pokedex is a GitHub Pages project, NOT a CodePen.
// This test verifies the data model and prevents future misclassification.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Load the actual data sources
const fs = require('fs');
const path = require('path');
const dataContent = fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8');
// data.js uses top-level const declarations; wrap in a function that returns them
const dataModule = new Function(dataContent + '\nreturn { projects, codePens, suggestions };');
const { projects, codePens } = dataModule();

test('Interactive Pokedex is in the projects array, not codePens', () => {
  assert.ok(projects, 'projects array must exist');
  assert.ok(codePens, 'codePens array must exist');

  const pokedex = projects.find(p => p.name && p.name.toLowerCase().includes('pokedex'));
  assert.ok(pokedex, 'Interactive Pokedex must be in projects array');
  assert.equal(pokedex.platform, 'GitHub Pages');
  assert.ok(pokedex.url && pokedex.url.includes('github.io'), 'Pokedex URL must be a GitHub Pages URL');

  const pokedexInCodePens = codePens.find(cp => cp.name && cp.name.toLowerCase().includes('pokedex'));
  assert.equal(pokedexInCodePens, undefined, 'Interactive Pokedex must NOT be in codePens array');
});

test('CodePens array does not contain project names', () => {
  const projectNames = projects.map(p => p.name.toLowerCase());
  for (const cp of codePens) {
    const cpName = cp.name.toLowerCase();
    for (const pn of projectNames) {
      assert.ok(
        !cpName.includes(pn) && !pn.includes(cpName),
        `CodePen "${cp.name}" must not match project "${pn}" — they are separate artifacts`
      );
    }
  }
});

test('Interactive Pokedex URL is github.io, not codepen.io', () => {
  const pokedex = projects.find(p => p.name && p.name.toLowerCase().includes('pokedex'));
  assert.ok(pokedex, 'Interactive Pokedex must exist in projects');
  assert.ok(!pokedex.url.includes('codepen.io'), 'Pokedex URL must not be codepen.io');
  assert.ok(pokedex.url.includes('github.io'), 'Pokedex URL must be github.io');
});

test('all CodePen URLs point to codepen.io', () => {
  for (const cp of codePens) {
    assert.ok(cp.url.includes('codepen.io'), `CodePen "${cp.name}" URL must point to codepen.io, got: ${cp.url}`);
  }
});

test('all project URLs do not point to codepen.io (unless explicitly a CodePen project)', () => {
  for (const p of projects) {
    if (p.url) {
      assert.ok(
        !p.url.includes('codepen.io'),
        `Project "${p.name}" URL must not point to codepen.io, got: ${p.url}`
      );
    }
  }
});
