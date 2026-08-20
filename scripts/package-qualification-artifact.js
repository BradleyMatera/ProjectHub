// Package live 23-case harness result(s) into canonical tracked artifacts.
//
// Usage:
//   node scripts/package-qualification-artifact.js \
//     --runtime-sha b1529108d560bb8164303406d0fdd9818299170e \
//     --source-repo BradleyMatera/ProjectHub \
//     --source-branch develop \
//     --canonical data/eval-1787107855062.json \
//     --runs data/eval-1787107476813.json,data/eval-1787107572245.json,data/eval-1787107608559.json,data/eval-1787107690608.json,data/eval-1787107773696.json,data/eval-1787107855062.json \
//     --out-dir data/evals

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith('--')) {
      args[key.replace(/^--/, '').replace(/-/g, '_')] = argv[i + 1] ?? '';
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv);

const canonicalPath = args.canonical;
const runtimeSHA = args.runtime_sha;
const sourceRepo = args.source_repo || 'BradleyMatera/ProjectHub';
const sourceBranch = args.source_branch || 'develop';
const outDir = args.out_dir || 'data/evals';
const runPaths = (args.runs || canonicalPath || '').split(',').filter(Boolean).map(s => s.trim());

if (!canonicalPath || !runtimeSHA || runPaths.length === 0) {
  console.error('Usage: node scripts/package-qualification-artifact.js --runtime-sha <sha> --canonical <file> --runs <csv> [--out-dir dir]');
  process.exit(1);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const canonical = readJson(canonicalPath);

const caseFields = r => ({
  id: r.id,
  message: r.message,
  reply: r.reply,
  status: r.status,
  latencyMs: r.latencyMs,
  provider: r.provider,
  model: r.model,
  proseSource: r.proseSource,
  quality: r.quality,
  reason: r.reason || null,
  contract: r.contract
});

const canonicalArtifact = {
  runtimeSHA,
  sourceRepository: sourceRepo,
  sourceBranch,
  baseUrl: canonical.baseUrl,
  evaluatedAt: canonical.completedAt,
  provider: canonical.results?.[0]?.provider,
  model: canonical.results?.[0]?.model,
  total: canonical.total,
  good: canonical.good,
  passRate: canonical.passRate,
  resultFile: path.relative('.', canonicalPath),
  results: canonical.results.map(caseFields)
};

const runs = runPaths.map(p => {
  const run = readJson(p);
  return {
    resultFile: path.relative('.', p),
    evaluatedAt: run.completedAt,
    total: run.total,
    good: run.good,
    passRate: run.passRate,
    byQuality: run.byQuality,
    failedIds: run.failedIds,
    latencyMs: run.latencyMs
  };
});

const allRunResults = runPaths.map(readJson);
const allCaseIds = [...new Set(allRunResults.flatMap(r => r.results.map(c => c.id)))];

const stabilityMatrix = {};
for (const id of allCaseIds) {
  const qualities = allRunResults.map(run => {
    const c = run.results.find(x => x.id === id);
    return c ? c.quality : 'MISSING';
  });
  const counts = qualities.reduce((acc, q) => { acc[q] = (acc[q] || 0) + 1; return acc; }, {});
  const values = Object.entries(counts).map(([quality, count]) => `${quality}:${count}`).join(' ');
  stabilityMatrix[id] = {
    qualities,
    counts,
    summary: values,
    stable: Object.keys(counts).length === 1
  };
}

const summaryArtifact = {
  runtimeSHA,
  sourceRepository: sourceRepo,
  sourceBranch,
  baseUrl: canonical.baseUrl,
  canonicalEvaluatedAt: canonical.completedAt,
  canonicalGood: canonical.good,
  canonicalPassRate: canonical.passRate,
  canonicalResultFile: path.relative('.', canonicalPath),
  runCount: runs.length,
  runs,
  stabilityMatrix,
  consistentlyGood: allCaseIds.filter(id => stabilityMatrix[id].stable && stabilityMatrix[id].counts.GOOD === runs.length),
  consistentlyFailing: allCaseIds.filter(id => !stabilityMatrix[id].stable || !stabilityMatrix[id].counts.GOOD)
};

fs.mkdirSync(outDir, { recursive: true });
const canonicalOut = path.join(outDir, 'current-live-acceptance.json');
const summaryOut = path.join(outDir, 'current-live-acceptance-summary.json');

fs.writeFileSync(canonicalOut, JSON.stringify(canonicalArtifact, null, 2) + '\n');
fs.writeFileSync(summaryOut, JSON.stringify(summaryArtifact, null, 2) + '\n');

console.log(`Wrote ${canonicalOut}`);
console.log(`Wrote ${summaryOut}`);
