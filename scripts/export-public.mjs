// Copy an explicit public source selection from the committed tree. Never copy
// .git or source history. The destination must not exist; initialize Git there
// only after reviewing and checking the exported source.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const destinationArg = process.argv[2];
if (!destinationArg) throw new Error('Pass an absolute destination directory for the public export.');
const destination = resolve(destinationArg);
try { await lstat(destination); throw new Error('Destination already exists; use a new empty export location.'); }
catch (err) { if (err.code !== 'ENOENT') throw err; }
const rootFiles = new Set(['README.md', 'QUICKSTART.md', 'SPEC.md', 'SECURITY.md', 'LICENSE', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', '.gitignore']);
const prefixes = ['src/', 'test/', 'lexicons/', 'examples/', 'scripts/', '.github/'];
const extras = new Set(['deploy/pull-pds.env.example', 'docs/EVIDENCE.md', 'docs/COMMUNITY-POST.md', 'experiments/results/relay-propagation/bsky-network-firehose-hits.jsonl']);
const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { encoding: 'utf8' }).split('\0').filter(Boolean);
let count = 0;
for (const file of paths) {
  if (!rootFiles.has(file) && !extras.has(file) && !prefixes.some((prefix) => file.startsWith(prefix))) continue;
  const target = resolve(destination, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, execFileSync('git', ['show', `HEAD:${file}`], { maxBuffer: 32 * 1024 * 1024 }));
  count++;
}
console.log(JSON.stringify({ destination, files: count, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), historyCopied: false }, null, 2));
