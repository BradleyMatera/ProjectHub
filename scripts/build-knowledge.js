// build-knowledge.js
// Scans available source material (blog posts, site pages, project docs, resumes)
// and writes an enriched recruiter-knowledge.json with a `sourceMaterial` array.
// Run from repo root: node scripts/build-knowledge.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'recruiter-knowledge.json');

const SOURCE_DIRS = [
  // Gatsby site pages and blog posts
  '/Users/bradleymatera/Desktop/gatsby-starter-minimal-blog/content/posts',
  '/Users/bradleymatera/Desktop/gatsby-starter-minimal-blog/content/pages',
  // Resume facts (canonical source-of-truth guardrails)
  '/Users/bradleymatera/Desktop/Resumes/99_AI_Context',
  // Project docs / READMEs from the same Git workspace
  '/Users/bradleymatera/Desktop/Projects/Git/Interactive-Pokedex',
  '/Users/bradleymatera/Desktop/Projects/Git/ProjectHub',
  '/Users/bradleymatera/Desktop/Projects/Git/TriangleDemo'
];

// Extra files to always include even if dir scanning missed them
const EXTRA_FILES = [
  '/Users/bradleymatera/Desktop/Resumes/99_AI_Context/Resume_Facts_Do_Not_Exaggerate.md'
];

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const IGNORE = [
  'node_modules', '.git', 'public', 'out', 'cache', 'package-lock.json', 'package.json',
  'aichat.md', 'aichat', 'aichat.md', 'Screenshot', 'test_suite.txt', 'conversational_ai_test_suite_projecthub.pdf'
];

function listFiles(dir, exts, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (IGNORE.some(i => full.includes(i))) continue;
    if (entry.isDirectory()) listFiles(full, exts, files);
    else if (entry.isFile() && exts.some(e => entry.name.endsWith(e)) && fs.statSync(full).size < MAX_FILE_SIZE) {
      files.push(full);
    }
  }
  return files;
}

function titleFromPath(file) {
  const base = path.basename(file, path.extname(file));
  const dir = path.basename(path.dirname(file));
  if (base === 'index') return dir.replace(/-/g, ' ');
  return base.replace(/-/g, ' ');
}

function extractText(file) {
  const raw = fs.readFileSync(file, 'utf8');
  // Strip MDX JSX tags and markdown brackets
  return raw
    .replace(/---[\s\S]*?---/g, '') // frontmatter
    .replace(/import\s+.*?from\s+['"].*?['"];?/g, '')
    .replace(/<\/?[A-Za-z][^>]*?>/g, ' ')
    .replace(/\{[\s\S]*?\}/g, ' ')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_`>~|\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkText(text, maxLen = 800) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).length > maxLen && current) {
      chunks.push(current.trim());
      current = w;
    } else {
      current = current ? current + ' ' + w : w;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

function main() {
  const knowledge = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const materials = [];

  const seen = new Set();
  for (const extra of EXTRA_FILES) {
    if (fs.existsSync(extra) && !seen.has(extra)) {
      seen.add(extra);
      const text = extractText(extra);
      for (const chunk of chunkText(text)) {
        materials.push({ title: 'Resume facts', source: 'file://' + extra, tags: ['resume', 'guardrails'], content: chunk });
      }
    }
  }

  for (const dir of SOURCE_DIRS) {
    for (const file of listFiles(dir, ['.md', '.mdx'])) {
      if (seen.has(file)) continue;
      seen.add(file);
      const text = extractText(file);
      const title = titleFromPath(file);
      const tags = [];
      if (file.includes('/posts/')) tags.push('blog');
      if (file.includes('/pages/')) tags.push('website');
      if (file.includes('/Resumes/')) tags.push('resume');
      if (file.includes('/Projects/Git/')) tags.push('project');
      if (file.includes('/docs/')) tags.push('docs');
      for (const chunk of chunkText(text)) {
        materials.push({ title, source: 'file://' + file, tags: tags.length ? tags : ['source'], content: chunk });
      }
    }
  }

  knowledge.sourceMaterial = materials;
  knowledge.lastUpdated = new Date().toISOString().slice(0, 10);

  fs.writeFileSync(OUT, JSON.stringify(knowledge, null, 2));
  console.log(`Wrote ${materials.length} sourceMaterial chunks to ${OUT}`);
}

main();
