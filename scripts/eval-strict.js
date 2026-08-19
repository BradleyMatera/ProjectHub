'use strict';

/**
 * Offline strict rescoring of committed evaluation artifacts.
 *
 * Reads the pre-strict raw JSON files from data/evals and re-scores them using
 * lib/acceptance-scorer.js. Does NOT touch the original files; writes new
 * `*-strict.json` artifacts and a combined summary.
 */

const fs = require('fs');
const path = require('path');
const { scoreArtifact, loadDefaultKnowledge, QUALITY } = require('../lib/acceptance-scorer');
const { cases, focusedCases } = require('../lib/eval-cases');

const EVALS_DIR = path.join(__dirname, '..', 'data', 'evals');

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function readArtifact(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function scoreFile(file, caseSet) {
  const artifact = readArtifact(file);
  const scored = scoreArtifact(artifact, caseSet, { knowledge: loadDefaultKnowledge() });
  return { scored, artifact };
}

function main() {
  const knowledge = loadDefaultKnowledge();
  const files = [];

  // 5 live 23-case runs plus the current consolidated run
  for (let i = 1; i <= 5; i++) {
    const f = path.join(EVALS_DIR, `live-acceptance-run-${i}.json`);
    if (fs.existsSync(f)) files.push({ file: f, label: `live-run-${i}`, caseSet: cases });
  }

  const current = path.join(EVALS_DIR, 'current-live-acceptance.json');
  if (fs.existsSync(current)) files.push({ file: current, label: 'current-live', caseSet: cases });

  const focused = path.join(EVALS_DIR, 'focused-10x.json');
  if (fs.existsSync(focused)) files.push({ file: focused, label: 'focused-10x', caseSet: focusedCases });

  const perFile = [];
  let totalRuns = 0;
  let totalGood = 0;
  let totalCases = 0;
  let totalFailed = 0;

  for (const { file, label, caseSet } of files) {
    console.error(`[rescoring] ${label} ...`);
    const { scored, artifact } = scoreFile(file, caseSet, knowledge);
    const outFile = file.replace(/\.json$/, '-strict.json');
    ensureDir(outFile);
    fs.writeFileSync(outFile, JSON.stringify({
      ...artifact,
      strict: {
        total: scored.total,
        good: scored.good,
        passRate: scored.passRate,
        byQuality: scored.byQuality,
        failedIds: scored.failedIds,
        scoredAt: new Date().toISOString()
      },
      results: scored.results
    }, null, 2));

    totalRuns += 1;
    totalCases += scored.total;
    totalGood += scored.good;
    totalFailed += (scored.total - scored.good);

    perFile.push({
      label,
      inputFile: path.basename(file),
      outputFile: path.basename(outFile),
      oldPassRate: artifact.passRate || null,
      oldGood: artifact.good || null,
      oldTotal: artifact.total || null,
      strictGood: scored.good,
      strictTotal: scored.total,
      strictPassRate: scored.passRate,
      byQuality: scored.byQuality,
      failedIds: scored.failedIds,
      failedCases: scored.results.filter(r => r.strictQuality !== QUALITY.GOOD).map(r => ({
        id: r.id,
        oldQuality: r.quality || null,
        strictQuality: r.strictQuality,
        strictReason: r.strictReason,
        reply: r.reply?.slice(0, 240) || ''
      }))
    });
  }

  const combined = {
    generatedAt: new Date().toISOString(),
    strictScorerVersion: '1.0.0',
    note: 'Re-scored pre-strict raw artifacts. The old pass rates are NOT a valid release gate.',
    totalFiles: totalRuns,
    totalCases,
    totalGood,
    totalFailed,
    combinedPassRate: totalCases ? Math.round((totalGood / totalCases) * 1000) / 10 : 0,
    perFile
  };

  const summaryFile = path.join(EVALS_DIR, 'pre-strict-rescore-summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(combined, null, 2));

  console.log(JSON.stringify({
    totalCases,
    totalGood,
    totalFailed,
    combinedPassRate: `${combined.combinedPassRate}%`,
    summaryFile: path.basename(summaryFile),
    perFile: perFile.map(p => ({ label: p.label, outputFile: p.outputFile, strictPassRate: p.strictPassRate, oldPassRate: p.oldPassRate, failedIds: p.failedIds }))
  }, null, 2));
}

main();
