'use strict';

const { execFileSync } = require('node:child_process');

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function setConfig(key, value) {
  git(['config', '--local', key, value]);
}

function main() {
  const installOnly = process.argv.includes('--install-only');

  if (installOnly && process.env.CI) {
    console.log('Skipping local Git workspace setup in CI.');
    return;
  }

  try {
    git(['rev-parse', '--show-toplevel']);
  } catch {
    if (installOnly) {
      console.log('No Git worktree detected; skipping ProjectHub local Git safety setup.');
      return;
    }
    console.error('Not inside a Git repository.');
    process.exit(1);
  }

  setConfig('core.hooksPath', '.githooks');
  setConfig('pull.ff', 'only');
  setConfig('merge.ff', 'only');
  setConfig('fetch.prune', 'true');
  setConfig('fetch.pruneTags', 'true');
  setConfig('push.default', 'simple');
  setConfig('push.autoSetupRemote', 'true');
  setConfig('remote.pushDefault', 'origin');
  setConfig('branch.master.remote', 'origin');
  setConfig('branch.master.merge', 'refs/heads/master');
  setConfig('branch.develop.remote', 'origin');
  setConfig('branch.develop.merge', 'refs/heads/develop');

  console.log('Installed ProjectHub Git safety settings:');
  console.log('  - GitHub/origin is authoritative');
  console.log('  - pulls and local merges are fast-forward only');
  console.log('  - stale remote refs/tags are pruned');
  console.log('  - new feature branches auto-track origin on first push');
  console.log('  - .githooks/pre-push blocks direct pushes to master/develop');

  if (installOnly) return;

  try {
    console.log('\nFetching latest GitHub state...');
    execFileSync('git', ['fetch', 'origin', '--prune'], { stdio: 'inherit' });
  } catch {
    console.warn('Fetch failed. Check network/authentication before doing any work.');
    process.exitCode = 1;
    return;
  }

  let branch = '';
  try {
    branch = git(['branch', '--show-current']);
  } catch {
    // Detached HEAD is fine; just do not auto-pull.
  }

  if (branch !== 'master' && branch !== 'develop') {
    console.log(`\nCurrent branch: ${branch || '(detached HEAD)'}`);
    console.log('No protected branch pull needed. Run `npm run workspace:check` before editing.');
    return;
  }

  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    console.warn(`\n${branch} has local changes. NOT pulling automatically.`);
    console.warn('Preserve or move that work first, then sync from GitHub. Do not merge stale local history into the protected branch.');
    return;
  }

  try {
    console.log(`\nFast-forwarding ${branch} from origin/${branch}...`);
    execFileSync('git', ['pull', '--ff-only', 'origin', branch], { stdio: 'inherit' });
    console.log(`\n${branch} is synchronized with GitHub.`);
  } catch {
    console.error(`\nSTOP: local ${branch} has diverged from origin/${branch}.`);
    console.error('Do NOT merge the histories and do NOT push this branch. Preserve any needed local work on a new branch, then restore the protected branch from GitHub.');
    process.exitCode = 2;
  }
}

main();
