#!/usr/bin/env node
'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VM_NAME = 'projecthub-dev-vm';
const ZONE = 'us-central1-a';
const PROJECT = 'ollamaapi-501903';
const REMOTE_DIR = '/opt/recruiter-chat-api-dev';
const SERVICE_NAME = 'recruiter-chat-api-dev';
const HEALTH_URL = 'https://dev.projecthub-chat.bradleymatera.dev/health';
const CHAT_URL = 'https://dev.projecthub-chat.bradleymatera.dev/api/chat';

const commitSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
const shortSha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const tag = `release-${shortSha}`;

// Verify clean, committed, pushed source before deploying
const status = execSync('git status --short', { encoding: 'utf8' }).trim();
if (status) {
  console.error('ERROR: Working tree is not clean. Commit all changes before deploy.');
  console.error(status);
  process.exit(1);
}
const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
const remoteBranchSha = execSync(`git rev-parse origin/${currentBranch}`, { encoding: 'utf8' }).trim();
if (commitSha !== remoteBranchSha) {
  console.error(`ERROR: Local HEAD ${commitSha} does not match origin/${currentBranch} ${remoteBranchSha}. Push first.`);
  process.exit(1);
}

const buildInfo = {
  sourceRepository: 'BradleyMatera/ProjectHub',
  sourceBranch: currentBranch,
  sourceCommit: commitSha,
  deployedAt: new Date().toISOString(),
  generatedBy: 'manual-deploy-dev'
};
const buildInfoPath = path.join(__dirname, '..', `${tag}-deploy-source.json`);
fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2) + '\n', 'utf8');

console.log('=== Manual Dev GCP Deploy ===');
console.log(`Commit: ${commitSha}`);
console.log(`Tag: ${tag}`);
console.log();

console.log('Checking syntax...');
execSync('node --check server-gemini.js', { stdio: 'inherit' });
console.log('Syntax OK');

console.log('Packing lib directory...');
const libTar = path.join(__dirname, '..', `${tag}-lib.tar.gz`);
execSync(`tar -czf "${libTar}" lib`, { cwd: path.join(__dirname, '..'), stdio: 'inherit' });

function gcloud(args) {
  const cmd = ['gcloud', ...args, `--zone=${ZONE}`, `--project=${PROJECT}`].join(' ');
  console.log(`> ${cmd}`);
  return execSync(cmd, { stdio: 'inherit' });
}

console.log('Uploading files...');
gcloud(['compute', 'scp', 'server-gemini.js', `${VM_NAME}:/tmp/${tag}-server.js`]);
gcloud(['compute', 'scp', libTar, `${VM_NAME}:/tmp/${tag}-lib.tar.gz`]);
gcloud(['compute', 'scp', 'data/free-tier-limits.json', `${VM_NAME}:/tmp/${tag}-free-tier.json`]);
gcloud(['compute', 'scp', 'data/recruiter-knowledge.json', `${VM_NAME}:/tmp/${tag}-knowledge.json`]);
gcloud(['compute', 'scp', 'data/scout-runtime-knowledge.json', `${VM_NAME}:/tmp/${tag}-runtime-knowledge.json`]);
gcloud(['compute', 'scp', buildInfoPath, `${VM_NAME}:/tmp/${tag}-deploy-source.json`]);

console.log('Building remote swap script...');
const swapScript = `#!/bin/bash
set -e
sudo mkdir -p "${REMOTE_DIR}/data"
if [ -f "${REMOTE_DIR}/server-gemini.js" ]; then
  sudo cp "${REMOTE_DIR}/server-gemini.js" "${REMOTE_DIR}/server-gemini.js.bak.$(date +%s)"
fi
if [ -d "${REMOTE_DIR}/lib" ]; then
  sudo mv "${REMOTE_DIR}/lib" "${REMOTE_DIR}/lib.bak.$(date +%s)"
fi
if [ -f "${REMOTE_DIR}/data/free-tier-limits.json" ]; then
  sudo cp "${REMOTE_DIR}/data/free-tier-limits.json" "${REMOTE_DIR}/data/free-tier-limits.json.bak.$(date +%s)"
fi
if [ -f "${REMOTE_DIR}/data/recruiter-knowledge.json" ]; then
  sudo cp "${REMOTE_DIR}/data/recruiter-knowledge.json" "${REMOTE_DIR}/data/recruiter-knowledge.json.bak.$(date +%s)"
fi
if [ -f "${REMOTE_DIR}/data/scout-runtime-knowledge.json" ]; then
  sudo cp "${REMOTE_DIR}/data/scout-runtime-knowledge.json" "${REMOTE_DIR}/data/scout-runtime-knowledge.json.bak.$(date +%s)"
fi
sudo mv "/tmp/${tag}-server.js" "${REMOTE_DIR}/server.js"
sudo tar -xzf "/tmp/${tag}-lib.tar.gz" -C "${REMOTE_DIR}"
sudo rm -rf "${REMOTE_DIR}/lib.bak."*
sudo mv "/tmp/${tag}-free-tier.json" "${REMOTE_DIR}/data/free-tier-limits.json"
sudo mv "/tmp/${tag}-knowledge.json" "${REMOTE_DIR}/data/recruiter-knowledge.json"
sudo mv "/tmp/${tag}-runtime-knowledge.json" "${REMOTE_DIR}/data/scout-runtime-knowledge.json"
sudo mv "/tmp/${tag}-deploy-source.json" "${REMOTE_DIR}/data/deploy-source.json"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl stop ${SERVICE_NAME} || true
  sleep 2
  sudo systemctl start ${SERVICE_NAME}
  echo 'Service restarted via systemd'
elif command -v pm2 >/dev/null 2>&1; then
  pm2 restart ${SERVICE_NAME}
  echo 'Service restarted via pm2'
else
  echo 'No service manager found; manual restart required'
  exit 1
fi
`;
const swapPath = path.join(__dirname, '..', `${tag}-swap.sh`);
fs.writeFileSync(swapPath, swapScript);
gcloud(['compute', 'scp', swapPath, `${VM_NAME}:/tmp/${tag}-swap.sh`]);

console.log('Running remote swap script...');
const remoteCmd = `chmod +x /tmp/${tag}-swap.sh && sudo /tmp/${tag}-swap.sh`;
gcloud(['compute', 'ssh', VM_NAME, '--command', `"${remoteCmd}"`]);

console.log('Cleaning up local pack...');
fs.unlinkSync(libTar);
fs.unlinkSync(swapPath);
fs.unlinkSync(buildInfoPath);

console.log('Health check...');
let health = '000';
for (let i = 0; i < 10; i++) {
  try {
    const out = execSync(`curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}"`, { encoding: 'utf8', timeout: 5000 }).trim();
    health = out || '000';
    if (health === '200') break;
  } catch (e) {
    health = '000';
  }
  console.log(`  health=${health} (attempt ${i + 1})`);
  if (i < 9) {
    spawnSync(process.platform === 'win32' ? 'powershell' : 'sleep', process.platform === 'win32' ? ['-Command', 'Start-Sleep -Seconds 2'] : ['2'], { stdio: 'ignore' });
  }
}

if (health !== '200') {
  console.error('ERROR: Health check failed.');
  process.exit(1);
}

console.log('Smoke test...');
const smokeBody = JSON.stringify({ message: 'What is ProjectHub?', history: [] });
const smokeRes = execSync(`curl -s -X POST "${CHAT_URL}" -H "Content-Type: application/json" -H "Origin: https://bradleymatera.github.io" -d @-`, { input: smokeBody, encoding: 'utf8' });
const smokeJson = JSON.parse(smokeRes || '{}');
if (smokeJson.reply) {
  console.log('Smoke test passed.');
} else {
  console.error('Smoke test failed:', smokeRes);
  process.exit(1);
}

console.log('Dev deploy complete!');
console.log(`  Commit: ${shortSha}`);
console.log(`  Health: ${HEALTH_URL}`);
