'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runGit(args) {
  execFileSync('git', args, { stdio: 'inherit' });
}

function fail(message) {
  console.error(`\nCANNOT START WORKSPACE: ${message}`);
  process.exit(1);
}

function refExists(ref) {
  try {
    git(['show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

function getWorkspaceReservation(branch) {
  try {
    const root = git(['rev-parse', '--show-toplevel']);
    const registryPath = path.join(root, '.github', 'ACTIVE_WORKSPACES.json');
    if (!fs.existsSync(registryPath)) return null;
    const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!Array.isArray(data.workspaces)) return null;
    return data.workspaces.find((entry) => entry && entry.branch === branch) || null;
  } catch {
    return null;
  }
}

function main() {
  const branch = process.argv[2];
  if (!branch) fail('Provide a feature branch name. Example: npm run workspace:start -- feat/scout-conversation');
  if (branch === 'master' || branch === 'develop') fail(`${branch} is protected. Use a feature branch.`);

  try {
    git(['check-ref-format', '--branch', branch]);
    git(['rev-parse', '--show-toplevel']);
  } catch {
    fail(`Invalid branch name or not inside a Git repository: ${branch}`);
  }

  const origin = git(['remote', 'get-url', 'origin']);
  if (!/github\.com[:/]BradleyMatera\/ProjectHub(?:\.git)?$/i.test(origin)) {
    fail(`origin is not BradleyMatera/ProjectHub: ${origin}`);
  }

  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    fail('Current workspace has uncommitted changes. Commit/stash/preserve them before switching branches.');
  }

  try {
    runGit(['fetch', 'origin', '--prune']);
  } catch {
    fail('Could not fetch GitHub. Do not start from stale local state.');
  }

  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/origin/${branch}`;
  const hasLocal = refExists(localRef);
  const hasRemote = refExists(remoteRef);

  try {
    if (hasLocal) {
      runGit(['switch', branch]);
      if (hasRemote) {
        const counts = git(['rev-list', '--left-right', '--count', `origin/${branch}...${branch}`]).split(/\s+/).map(Number);
        const [behind, ahead] = counts;
        if (behind > 0 && ahead > 0) {
          fail(`${branch} diverged from origin/${branch}. Stop and reconcile deliberately before editing.`);
        }
        if (behind > 0) runGit(['merge', '--ff-only', `origin/${branch}`]);
      }
    } else if (hasRemote) {
      runGit(['switch', '--track', '-c', branch, `origin/${branch}`]);
    } else {
      const reservation = getWorkspaceReservation(branch);
      if (reservation && reservation.status === 'local-unpublished') {
        fail(`${branch} is RESERVED for an existing local workspace that has not been published to GitHub yet. Do not create a replacement branch here. Return to the original machine/IDE, commit the intended work, and run npm run workspace:publish there first.`);
      }

      // New portable workspaces are based on current GitHub production history.
      // Do NOT use origin/develop here: develop is intentionally preserved while
      // its older staging-only history is reconciled with current master.
      if (!refExists('refs/remotes/origin/master')) fail('origin/master does not exist.');
      runGit(['switch', '-c', branch, 'origin/master']);
      runGit(['push', '-u', 'origin', branch]);
    }
  } catch (error) {
    if (error && error.status === 1) process.exit(1);
    fail(`Git could not open ${branch}.`);
  }

  console.log(`\nWorkspace branch ready: ${branch}`);
  console.log('GitHub is authoritative. Run `npm run workspace:check` before editing and `npm run workspace:publish` before switching machines.');
}

main();
