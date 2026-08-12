'use strict';

const { execFileSync } = require('node:child_process');

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
  console.error(`\nCANNOT PUBLISH WORKSPACE: ${message}`);
  process.exit(1);
}

function main() {
  try {
    git(['rev-parse', '--show-toplevel']);
  } catch {
    fail('Run this command inside the ProjectHub Git repository.');
  }

  const branch = git(['branch', '--show-current']);
  if (!branch) fail('Detached HEAD cannot be published as a portable workspace.');
  if (branch === 'master' || branch === 'develop') fail(`${branch} is protected. Publish only feature branches.`);

  const origin = git(['remote', 'get-url', 'origin']);
  if (!/github\.com[:/]BradleyMatera\/ProjectHub(?:\.git)?$/i.test(origin)) {
    fail(`origin is not BradleyMatera/ProjectHub: ${origin}`);
  }

  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    console.error('\nUncommitted changes are still machine-local:');
    console.error(dirty);
    fail('Commit the work you want to carry to another machine before publishing.');
  }

  try {
    runGit(['fetch', 'origin', '--prune']);
  } catch {
    fail('Could not fetch GitHub. Do not publish without checking remote state first.');
  }

  let remoteExists = false;
  try {
    git(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    remoteExists = true;
  } catch {
    remoteExists = false;
  }

  if (remoteExists) {
    const [behind, ahead] = git(['rev-list', '--left-right', '--count', `origin/${branch}...${branch}`])
      .split(/\s+/)
      .map(Number);

    if (behind > 0 && ahead > 0) {
      fail(`${branch} diverged from origin/${branch}. Do not overwrite another machine's work. Reconcile deliberately first.`);
    }
    if (behind > 0) {
      fail(`${branch} is ${behind} commit(s) behind origin/${branch}. Pull/rebase safely before publishing.`);
    }
  }

  try {
    runGit(['push', '-u', 'origin', branch]);
  } catch {
    fail(`GitHub rejected the push for feature branch ${branch}.`);
  }

  const sha = git(['rev-parse', '--short=12', 'HEAD']);
  console.log(`\nPUBLISHED: ${branch} @ ${sha}`);
  console.log('This committed workspace is now on GitHub and can be opened from another PC/IDE with:');
  console.log(`  npm run workspace:start -- ${branch}`);
}

main();
