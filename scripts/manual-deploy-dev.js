#!/usr/bin/env node
'use strict';

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { builtinModules } = require('module');

const production = process.argv.includes('--production');
if (process.argv.slice(2).some(arg => arg !== '--production')) throw new Error('Unsupported deploy argument');
const VM_NAME = production ? 'ollama-api-gate' : 'projecthub-dev-vm';
const ZONE = 'us-central1-a';
const PROJECT = 'ollamaapi-501903';
const REMOTE_DIR = production ? '/opt/recruiter-chat-api' : '/opt/recruiter-chat-api-dev';
const SERVICE_NAME = production ? 'recruiter-chat-api' : 'recruiter-chat-api-dev';
const HEALTH_URL = `https://${production ? '' : 'dev.'}projecthub-chat.bradleymatera.dev/health`;
const CHAT_URL = HEALTH_URL.replace('/health', '/api/chat');
const root = path.resolve(__dirname, '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitSha = git(['rev-parse', 'HEAD']);
const shortSha = commitSha.slice(0, 12);
const tag = `release-${new Date().toISOString().replace(/[:.]/g, '-')}-${shortSha}-${crypto.randomBytes(6).toString('hex')}`;

// Verify clean, committed, pushed source before deploying
if (git(['status', '--porcelain', '--untracked-files=all'])) {
  throw new Error('Working tree is not clean. Preserve and publish changes before deploy.');
}
const currentBranch = git(['branch', '--show-current']);
if (!currentBranch || (production && currentBranch !== 'master') || (!production && currentBranch === 'master')) {
  throw new Error('Production requires master; dev requires a named non-master branch.');
}
if (!/github\.com[:/]BradleyMatera\/ProjectHub(?:\.git)?$/i.test(git(['remote', 'get-url', 'origin']))) {
  throw new Error('origin must be BradleyMatera/ProjectHub.');
}
git(['fetch', '--no-tags', 'origin', `refs/heads/${currentBranch}:refs/remotes/origin/${currentBranch}`]);
if (commitSha !== git(['rev-parse', `refs/remotes/origin/${currentBranch}`])) {
  throw new Error('HEAD does not match the freshly fetched origin branch.');
}
if (process.env.DEPLOY_APPROVED_COMMIT !== commitSha) {
  throw new Error('After the environment release gate and operator approval, set DEPLOY_APPROVED_COMMIT to the full approved commit.');
}

const runtimeInputs = [
  'data/free-tier-limits.json',
  'data/recruiter-knowledge.json',
  'data/scout-runtime-knowledge.json',
  'data/scout-identity.json'
];
const files = new Map();
const dependencies = new Set();
function collect(file) {
  if (files.has(file)) return;
  if (!/^(server-gemini\.js|lib\/[a-z0-9-]+\.js|data\/[a-z0-9-]+\.json)$/.test(file)) {
    throw new Error(`Unaudited runtime path: ${file}`);
  }
  const entry = git(['ls-tree', commitSha, '--', file]);
  if (!/^100(644|755) blob /.test(entry)) throw new Error(`Missing or nonregular runtime file: ${file}`);
  const source = execFileSync('git', ['show', `${commitSha}:${file}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  files.set(file, source);
  if (file.endsWith('.json')) {
    JSON.parse(source.toString('utf8'));
    return;
  }
  execFileSync(process.execPath, ['--check'], { input: source, stdio: ['pipe', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  for (const match of source.toString('utf8').matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const name = match[1];
    if (name.startsWith('.')) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
      collect(path.posix.extname(resolved) ? resolved : `${resolved}.js`);
    } else if (!builtinModules.includes(name) && !name.startsWith('node:')) {
      dependencies.add(name);
    }
  }
}
collect('server-gemini.js');
for (const file of runtimeInputs) collect(file);
const buildInfo = {
  sourceRepository: 'BradleyMatera/ProjectHub',
  sourceBranch: currentBranch,
  sourceCommit: commitSha,
  deployedAt: new Date().toISOString(),
  generatedBy: production ? 'deploy-gcp' : 'manual-deploy-dev'
};
const marker = Buffer.from(JSON.stringify(buildInfo, null, 2) + '\n');
const manifest = Object.fromEntries([...files].map(([file, bytes]) => [
  file === 'server-gemini.js' ? 'server.js' : file,
  crypto.createHash('sha256').update(bytes).digest('hex')
]));
manifest['data/deploy-source.json'] = crypto.createHash('sha256').update(marker).digest('hex');
const config = {
  root: REMOTE_DIR, health: HEALTH_URL, chat: CHAT_URL, build: buildInfo, manifest,
  dependencies: [...dependencies], provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fast', deadlineMs: 15000
};
const verifier = `const cfg = ${JSON.stringify(config)};\n` + String.raw`
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');
const mode = process.argv[2];
const transaction = process.argv[3];
function assert(ok) { if (!ok) throw new Error('Deployment verification failed'); }
async function json(url, options = {}, timeout = 5000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout), redirect: 'error' });
  assert(response.ok);
  return response.json();
}
function projection(h) {
  return { ok: h.ok, status: h.status, build: { sourceRepository: h.build?.sourceRepository,
    sourceBranch: h.build?.sourceBranch, sourceCommit: h.build?.sourceCommit },
    buildEnv: { sourceRepository: h.buildEnv?.sourceRepository, sourceBranch: h.buildEnv?.sourceBranch,
      sourceCommit: h.buildEnv?.sourceCommit, provider: h.buildEnv?.provider,
      primaryModel: h.buildEnv?.primaryModel, deadlineMs: h.buildEnv?.deadlineMs } };
}
async function health(expected) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const actual = projection(await json(cfg.health));
      assert(actual.ok === true && actual.status === 'online');
      if (expected) assert(JSON.stringify(actual) === JSON.stringify(expected));
      const ready = await json(cfg.health + '/ready');
      assert(ready.ok === true && ready.modelVerified === true && ready.knowledgeReady === true);
      return actual;
    } catch {
      if (attempt === 9) throw new Error('Health/readiness verification failed');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}
async function main() {
  if (mode === 'files') {
    const target = process.argv[4];
    for (const [file, hash] of Object.entries(cfg.manifest)) {
      const name = path.join(target, file);
      assert(fs.lstatSync(name).isFile());
      const bytes = fs.readFileSync(name);
      assert(crypto.createHash('sha256').update(bytes).digest('hex') === hash);
      if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', name], { stdio: 'ignore' });
      if (file.endsWith('.json')) JSON.parse(bytes.toString('utf8'));
    }
    const resolve = createRequire(path.join(cfg.root, 'server.js'));
    for (const name of cfg.dependencies) resolve.resolve(name);
    return;
  }
  if (mode === 'baseline') {
    fs.writeFileSync(path.join(transaction, 'baseline.json'), JSON.stringify(await health()), { flag: 'wx' });
    return;
  }
  if (mode === 'rollback') {
    await health(JSON.parse(fs.readFileSync(path.join(transaction, 'baseline.json'), 'utf8')));
    return;
  }
  assert(mode === 'release');
  const source = { sourceRepository: cfg.build.sourceRepository, sourceBranch: cfg.build.sourceBranch,
    sourceCommit: cfg.build.sourceCommit };
  await health({ ok: true, status: 'online', build: source, buildEnv: { ...source,
    provider: cfg.provider, primaryModel: cfg.model, deadlineMs: cfg.deadlineMs } });
  const started = Date.now();
  const reply = await json(cfg.chat, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Origin: 'https://bradleymatera.github.io' }, body: JSON.stringify({
      message: "What is Bradley's strongest technical background?", history: [],
      sessionId: 'deploy-' + crypto.randomBytes(12).toString('hex') }) }, cfg.deadlineMs);
  assert(Date.now() - started <= cfg.deadlineMs);
  assert(reply.ok === true && !reply.error && typeof reply.reply === 'string' && reply.reply.trim().length > 20);
  assert(['MODEL_GENERATION', 'DIRECT_KB'].includes(reply.proseSource));
  assert(reply.proseSource === 'DIRECT_KB' ? reply.provider === 'knowledge-base' :
    reply.provider === cfg.provider && reply.model === cfg.model && reply.fallback === false);
  assert(/front[ -]?end|javascript|web development/i.test(reply.reply));
  console.log('Source, provider, model, 15s budget, readiness and supported-reply smoke verified.');
}
main().catch(() => { console.error('Deployment verification failed (response bodies suppressed).'); process.exitCode = 1; });
`;
const replaced = ['server.js', 'lib', ...runtimeInputs, 'data/deploy-source.json'];
const swapScript = `#!/bin/bash
set -Eeuo pipefail
umask 077
ROOT='${REMOTE_DIR}'
SERVICE='${SERVICE_NAME}'
UPLOAD='/tmp/${tag}'
[ -d "$ROOT" ] && [ ! -L "$ROOT" ]
[ -d "$ROOT/data" ] && [ ! -L "$ROOT/data" ]
[ -d "$ROOT/lib" ] && [ ! -L "$ROOT/lib" ]
[ -f "$ROOT/server.js" ] && [ ! -L "$ROOT/server.js" ]
exec 9<"$ROOT"
flock -n 9
systemctl is-active --quiet "$SERVICE"
execStart=$(systemctl show "$SERVICE" --property=ExecStart --value)
case "$execStart" in
  *"$ROOT/server.js"*) ;;
  *) exit 1 ;;
esac
mkdir -p "$ROOT/backups"
[ ! -L "$ROOT/backups" ]
TX=$(mktemp -d "$ROOT/backups/${tag}-XXXXXX")
mkdir "$TX/next" "$TX/backup" "$TX/retired" "$TX/failed" "$TX/restore"
mkdir "$TX/backup/data" "$TX/retired/data" "$TX/failed/data" "$TX/restore/data"
cp "$UPLOAD/verify.js" "$TX/verify.js"
tar -xf "$UPLOAD/release.tar" -C "$TX/next"
mv -T "$TX/next/server-gemini.js" "$TX/next/server.js"
cp "$UPLOAD/deploy-source.json" "$TX/next/data/deploy-source.json"
chmod -R u=rwX,go=rX "$TX/next"
node "$TX/verify.js" files "$TX" "$TX/next"
node "$TX/verify.js" baseline "$TX"
paths=(${replaced.map(p => `'${p}'`).join(' ')})
for item in "\${paths[@]}"; do
  [ ! -L "$ROOT/$item" ]
  if [ -e "$ROOT/$item" ]; then cp -a "$ROOT/$item" "$TX/backup/$item"; fi
done
touched=()
rollback() {
  result=$1
  trap - ERR INT TERM HUP
  set +e
  rollback_failed=0
  echo "Deployment failed; restoring immutable backup at $TX/backup"
  systemctl stop "$SERVICE" || rollback_failed=1
  for ((i=\${#touched[@]}-1; i>=0; i--)); do
    item=\${touched[$i]}
    if [ -e "$ROOT/$item" ] || [ -L "$ROOT/$item" ]; then
      mv -T "$ROOT/$item" "$TX/failed/$item" || { rollback_failed=1; continue; }
    fi
    if [ -e "$TX/backup/$item" ]; then
      cp -a "$TX/backup/$item" "$TX/restore/$item" &&
        mv -T "$TX/restore/$item" "$ROOT/$item" || rollback_failed=1
    fi
  done
  for item in "\${paths[@]}"; do
    if [ -e "$TX/backup/$item" ]; then
      diff -qr "$TX/backup/$item" "$ROOT/$item" >/dev/null 2>&1 || rollback_failed=1
    elif [ -e "$ROOT/$item" ] || [ -L "$ROOT/$item" ]; then rollback_failed=1; fi
  done
  systemctl start "$SERVICE" || rollback_failed=1
  systemctl is-active --quiet "$SERVICE" || rollback_failed=1
  node "$TX/verify.js" rollback "$TX" || rollback_failed=1
  if [ "$rollback_failed" -ne 0 ]; then
    echo "CRITICAL: Rollback verification failed; operator recovery required from $TX/backup" >&2
  else
    echo 'Previous files and service health restored; deployment remains failed.' >&2
  fi
  exit "$result"
}
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM
trap 'rollback 129' HUP
systemctl stop "$SERVICE"
for item in "\${paths[@]}"; do
  touched+=("$item")
  if [ -e "$ROOT/$item" ]; then mv -T "$ROOT/$item" "$TX/retired/$item"; fi
  mv -T "$TX/next/$item" "$ROOT/$item"
done
node "$TX/verify.js" files "$TX" "$ROOT"
systemctl start "$SERVICE"
systemctl is-active --quiet "$SERVICE"
node "$TX/verify.js" release "$TX"
trap - ERR INT TERM HUP
echo "Deploy complete. Immutable backup and transaction retained: $TX"
`;

const pack = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
execFileSync('git', ['archive', '--format=tar', `--output=${path.join(pack, 'release.tar')}`, commitSha, '--', ...files.keys()], { cwd: root, stdio: 'inherit' });
fs.writeFileSync(path.join(pack, 'deploy-source.json'), marker, { flag: 'wx' });
fs.writeFileSync(path.join(pack, 'verify.js'), verifier, { flag: 'wx' });
fs.writeFileSync(path.join(pack, 'swap.sh'), swapScript, { flag: 'wx' });
execFileSync(process.execPath, ['--check', path.join(pack, 'verify.js')], { stdio: 'inherit' });
const quote = value => process.platform === 'win32' ? `"${value.replace(/"/g, '\\"')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
function gcloud(args) {
  return execSync(['gcloud', ...args.map(quote), `--zone=${ZONE}`, `--project=${PROJECT}`].join(' '), { cwd: root, stdio: 'inherit' });
}
console.log(`Deploying ${production ? 'production' : 'dev'} commit ${commitSha}; ${files.size} runtime files plus source marker.`);
console.log(`Local immutable pack retained: ${pack}`);
gcloud(['compute', 'ssh', VM_NAME, '--command', `umask 077 && mkdir /tmp/${tag}`]);
for (const file of ['release.tar', 'deploy-source.json', 'verify.js', 'swap.sh']) {
  gcloud(['compute', 'scp', path.join(pack, file), `${VM_NAME}:/tmp/${tag}/${file}`]);
}
gcloud(['compute', 'ssh', VM_NAME, '--command', `bash -n /tmp/${tag}/swap.sh && node --check /tmp/${tag}/verify.js && sudo -n bash /tmp/${tag}/swap.sh`]);
console.log(`Deployment verified for ${commitSha}: ${HEALTH_URL}`);
