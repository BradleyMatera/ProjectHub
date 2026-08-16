'use strict';

const { execFileSync } = require('node:child_process');

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fail(message, code = 1) {
  console.error(`\nNOT READY: ${message}`);
  process.exit(code);
}

function aheadBehind(localRef, remoteRef) {
  const out = git(['rev-list', '--left-right', '--count', `${remoteRef}...${localRef}`]);
  const [behind, ahead] = out.split(/\s+/).map(Number);
  return { ahead, behind };
}

function upstreamFor() {
  try {
    return git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    return '';
  }
}

function main() {
  try {
    git(['rev-parse', '--show-toplevel']);
  } catch {
    fail('Run this command from inside the ProjectHub Git repository.');
  }

  const origin = git(['remote', 'get-url', 'origin']);
  if (!/github\.com[:/]BradleyMatera\/ProjectHub(?:\.git)?$/i.test(origin)) {
    fail(`origin is not BradleyMatera/ProjectHub: ${origin}`);
  }

  console.log('ProjectHub workspace preflight');
  console.log(`origin: ${origin}`);

  try {
    execFileSync('git', ['fetch', 'origin', '--prune'], { stdio: 'inherit' });
  } catch {
    fail('Could not fetch GitHub. Do not start work from an unverified local copy.');
  }

  const branch = git(['branch', '--show-current']);
  if (!branch) fail('Detached HEAD. Switch to a named feature branch before editing.');

  const dirty = git(['status', '--porcelain']);
  const protectedBranch = branch === 'master' || branch === 'develop';

  if (protectedBranch) {
    if (dirty) {
      fail(`${branch} has local changes. Preserve them on a feature branch before syncing the protected branch.`);
    }

    const remoteRef = `origin/${branch}`;
    const { ahead, behind } = aheadBehind(branch, remoteRef);

    if (ahead > 0) {
      fail(`local ${branch} is ${ahead} commit(s) ahead of GitHub. Do not push or merge it. Preserve needed work on a feature branch, then restore ${branch} from ${remoteRef}.`);
    }

    if (behind > 0) {
      console.log(`${branch} is ${behind} commit(s) behind GitHub. Fast-forwarding...`);
      try {
        execFileSync('git', ['merge', '--ff-only', remoteRef], { stdio: 'inherit' });
      } catch {
        fail(`${branch} could not fast-forward from ${remoteRef}. Stop and inspect the divergence.`);
      }
    }

    fail(`You are on protected branch ${branch}. It is synchronized, but feature work must start on a feature branch. Run: npm run workspace:start -- <branch-name>`, 2);
  }

  const upstream = upstreamFor();
  let portability = 'NOT PUBLISHED';

  if (upstream) {
    const { ahead, behind } = aheadBehind(branch, upstream);
    if (behind > 0 && ahead > 0) {
      fail(`${branch} has diverged from ${upstream}. Sync deliberately before editing so another machine does not see a different history.`);
    }
    if (behind > 0) {
      fail(`${branch} is ${behind} commit(s) behind ${upstream}. Pull/rebase the feature branch before editing.`);
    }
    portability = ahead > 0 ? `LOCAL AHEAD BY ${ahead}` : 'SYNCED TO GITHUB';
  }

  console.log(`branch: ${branch}`);
  console.log(`working tree: ${dirty ? 'DIRTY' : 'clean'}`);
  console.log(`upstream: ${upstream || '(none)'}`);
  console.log(`portability: ${portability}`);

  if (!upstream) {
    console.warn('\nThis feature branch is not on GitHub yet. Before switching machines/IDEs, publish it with:');
    console.warn('  npm run workspace:publish');
  } else if (portability.startsWith('LOCAL AHEAD')) {
    console.warn('\nThis workspace has commits that are not on GitHub yet. Before switching machines/IDEs, run:');
    console.warn('  npm run workspace:publish');
  }

  if (dirty) {
    console.warn('\nThere are uncommitted changes. They exist only on this machine until committed and pushed.');
  }

  console.log('\nREADY: GitHub state was fetched and this feature workspace is safe to continue.');
}

main();
