// Scan the current tracked working tree without printing candidate secret values.
// This deliberately does not claim to replace a full history/credential audit.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const patterns = [
  /(?:PDS_SIGNING_KEY|AGG_SIGNING_KEY)\s*[:=]\s*["']?[a-f0-9]{64}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,}\b/,
];
const findings = [];
for (const file of files) {
  let bytes;
  try { bytes = await readFile(file); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
  const content = bytes.toString('utf8');
  if (patterns.some((pattern) => pattern.test(content))) findings.push(resolve(file));
}
if (findings.length) {
  console.error('Potential credentials found; values withheld:\n' + findings.join('\n'));
  process.exitCode = 1;
} else console.log(`Checked ${files.length} tracked paths; no matching credential patterns. Git history is not covered.`);
