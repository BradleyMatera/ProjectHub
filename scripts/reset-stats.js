#!/usr/bin/env node
/**
 * Reset ProjectHub persistent stats and learning stash to a clean baseline.
 *
 * Usage:
 *   node scripts/reset-stats.js              # reset local repo files
 *   node scripts/reset-stats.js --remote     # reset files on the GCP VM
 *
 * This script is intentionally CLI-only (no HTTP endpoint) to avoid exposing
 * a destructive operation on the public internet.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const isRemote = process.argv.includes('--remote');
const repoRoot = path.resolve(__dirname, '..');

const VM_NAME = 'ollama-api-gate';
const VM_ZONE = 'us-central1-a';
const VM_PROJECT = 'ollamaapi-501903';
const REMOTE_DIR = '/opt/recruiter-chat-api';

const defaultStats = {
  totalRequestsAllTime: 0,
  groundedCount: 0,
  llmCount: 0,
  cachedCount: 0,
  providerBreakdown: {},
  // deployCount and firstDeployAt are intentionally preserved; they are real deployment history.
  deployCount: 0,
  firstDeployAt: 0,
  recentRequests: [],
  referrerBreakdown: {},
  topicBreakdown: {},
  hourlyRequests: {},
  lastPipeline: [],
  sessions: [],
  providerHealth: {},
};

const defaultLearned = { stashed: [], learned: [], learnedCount: 0, lastThinkAt: 0, scoredHistory: [] };

function backupAndReset(localDir) {
  const statsPath = path.join(localDir, 'stats.json');
  const learnedPath = path.join(localDir, 'learned.json');
  const now = Date.now();

  // Preserve existing deployCount / firstDeployAt if present
  let deployCount = 0;
  let firstDeployAt = 0;
  if (fs.existsSync(statsPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
      deployCount = existing.deployCount || 0;
      firstDeployAt = existing.firstDeployAt || 0;
    } catch (e) {
      console.warn('Could not read existing stats.json, using zero defaults:', e.message);
    }
    const backup = `${statsPath}.backup.${now}`;
    fs.copyFileSync(statsPath, backup);
    console.log(`Backed up ${statsPath} -> ${backup}`);
  }

  if (fs.existsSync(learnedPath)) {
    const backup = `${learnedPath}.backup.${now}`;
    fs.copyFileSync(learnedPath, backup);
    console.log(`Backed up ${learnedPath} -> ${backup}`);
  }

  const stats = {
    ...defaultStats,
    deployCount,
    firstDeployAt,
  };
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  console.log(`Reset ${statsPath}`);

  fs.writeFileSync(learnedPath, JSON.stringify(defaultLearned, null, 2));
  console.log(`Reset ${learnedPath}`);
}

if (isRemote) {
  console.log('Resetting stats on GCP VM...');
  // Copy the reset script to the VM and run it there to avoid complex shell escaping.
  const remoteScriptPath = '/tmp/reset-stats.js';
  const remoteCommand = `sudo cp ${REMOTE_DIR}/stats.json ${REMOTE_DIR}/stats.json.backup.$(date +%Y%m%d_%H%M%S) || true; sudo cp ${REMOTE_DIR}/learned.json ${REMOTE_DIR}/learned.json.backup.$(date +%Y%m%d_%H%M%S) || true; sudo cp /tmp/reset-stats.js ${REMOTE_DIR}/reset-stats.js && cd ${REMOTE_DIR} && sudo node reset-stats.js`;
  execSync(
    `gcloud compute scp ${__filename} ${VM_NAME}:${remoteScriptPath} --zone=${VM_ZONE} --project=${VM_PROJECT}`,
    { stdio: 'inherit', cwd: repoRoot }
  );
  execSync(
    `gcloud compute ssh ${VM_NAME} --zone=${VM_ZONE} --project=${VM_PROJECT} --command='${remoteCommand}'`,
    { stdio: 'inherit', cwd: repoRoot }
  );
  console.log('Remote reset complete. Restart the service if needed:');
  console.log(`  gcloud compute ssh ${VM_NAME} --zone=${VM_ZONE} --project=${VM_PROJECT} --command="sudo systemctl restart recruiter-chat-api"`);
} else {
  const targetDir = process.cwd();
  console.log(`Resetting stats in ${targetDir}...`);
  backupAndReset(targetDir);
  console.log('Reset complete.');
}
