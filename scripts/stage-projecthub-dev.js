#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKTREE = '.tmp-staging';
const STAGING_REMOTE = 'projecthub-dev';
const STAGING_BRANCH = 'main';

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'inherit', ...opts });
}

function shOut(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

function bail(msg) {
  console.error('FATAL:', msg);
  try { execSync('git worktree remove -f .tmp-staging', { encoding: 'utf8', stdio: 'pipe' }); } catch (_) {}
  process.exit(1);
}

console.log('=== Stage ProjectHub-dev ===');

console.log('Fetching origin...');
sh('git fetch origin');

const sourceSha = shOut('git rev-parse origin/develop');
const shortSha = shOut('git rev-parse --short origin/develop');
console.log(`Source SHA: ${sourceSha}`);

// Remove any existing worktree
if (fs.existsSync(WORKTREE)) {
  sh(`git worktree remove -f ${WORKTREE}`);
}

console.log('Creating worktree...');
sh(`git worktree add ${WORKTREE} ${sourceSha}`);

const wt = path.resolve(WORKTREE);

console.log('Applying staging transformations...');
const stagingAgents = path.join(wt, '.github', 'staging-AGENTS.md');
const stagingPages = path.join(wt, '.github', 'staging-pages.yml');
const destAgents = path.join(wt, 'AGENTS.md');
const destPages = path.join(wt, '.github', 'workflows', 'pages.yml');

fs.copyFileSync(stagingAgents, destAgents);
fs.copyFileSync(stagingPages, destPages);

console.log('Writing STAGING-SOURCE.json...');
const marker = {
  sourceRepository: 'BradleyMatera/ProjectHub',
  sourceBranch: 'develop',
  sourceCommit: sourceSha,
  generatedBy: 'projecthub-staging-deployer',
};
const markerPath = path.join(wt, 'STAGING-SOURCE.json');
fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf8');

console.log('Validating STAGING-SOURCE.json...');
const raw = fs.readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, '');
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  bail(`STAGING-SOURCE.json is not valid JSON: ${e.message}`);
}
if (!parsed.sourceRepository || !parsed.sourceBranch || !parsed.sourceCommit || !parsed.generatedBy) {
  bail('STAGING-SOURCE.json is missing required fields.');
}
if (parsed.sourceCommit !== sourceSha) {
  bail(`sourceCommit ${parsed.sourceCommit} does not match intended ${sourceSha}.`);
}

console.log('Creating wrapper commit...');
sh('git add -f AGENTS.md .github/workflows/pages.yml STAGING-SOURCE.json', { cwd: wt });
const wrapperMsg = `staging: mirror from ProjectHub/develop ${sourceSha}`;
const tree = shOut('git write-tree', { cwd: wt });
const parent = shOut(`git rev-parse ${sourceSha}`);
const commitSha = shOut(`git commit-tree ${tree} -p ${parent} -m ${JSON.stringify(wrapperMsg)}`, { cwd: wt });
console.log(`Wrapper commit: ${commitSha}`);

console.log(`Force-pushing wrapper to ${STAGING_REMOTE}/${STAGING_BRANCH}...`);
sh(`git push ${STAGING_REMOTE} ${commitSha}:${STAGING_BRANCH} --force`);

console.log('Verifying remote staging marker...');
const remoteText = shOut(`git show ${STAGING_REMOTE}/${STAGING_BRANCH}:STAGING-SOURCE.json`);
let remoteParsed;
try {
  remoteParsed = JSON.parse(remoteText.replace(/^\uFEFF/, ''));
} catch (e) {
  bail(`Remote STAGING-SOURCE.json is not valid JSON: ${e.message}`);
}
if (remoteParsed.sourceCommit !== sourceSha) {
  bail(`Remote sourceCommit ${remoteParsed.sourceCommit} does not match ${sourceSha}.`);
}
if (remoteParsed.sourceRepository !== 'BradleyMatera/ProjectHub' ||
    remoteParsed.sourceBranch !== 'develop' ||
    remoteParsed.generatedBy !== 'projecthub-staging-deployer') {
  bail('Remote STAGING-SOURCE.json has unexpected field values.');
}

const pagesYml = shOut(`git show ${STAGING_REMOTE}/${STAGING_BRANCH}:.github/workflows/pages.yml`);
if (!/branches:\s*\[\s*['"]?main['"]?\s*\]/.test(pagesYml)) {
  bail('Remote pages.yml does not trigger on main.');
}

const remoteAgents = shOut(`git show ${STAGING_REMOTE}/${STAGING_BRANCH}:AGENTS.md`);
if (!/Staging/.test(remoteAgents)) {
  bail('Remote AGENTS.md does not appear to be staging-specific.');
}

console.log('Cleaning up worktree...');
sh(`git worktree remove -f ${WORKTREE}`);

console.log('Staging mirror complete.');
console.log(`ProjectHub/develop: ${sourceSha}`);
console.log(`ProjectHub-dev/main:  (force-pushed wrapper)`);
