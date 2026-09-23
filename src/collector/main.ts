/**
 * Local agent-log collector CLI. One idempotent run, then exit - the OS does the
 * scheduling (`deploy/org.peertelemetry.collector.plist` on macOS, the systemd
 * timer or crontab line in the README).
 *
 *   node dist/src/collector/main.js --config ~/.peertelemetry/collector.json
 *   node dist/src/collector/main.js --config ./collector.json --dry-run
 *   node dist/src/collector/main.js --config ./collector.json --status
 *
 * Exit 0 = the run completed, including when the CLIs recorded provider errors
 * (that is the data) and including when another run held the lock. Exit 1 = the
 * operator must intervene: bad config, missing credential, or a record that
 * failed lexicon validation.
 */
import { ProberConfigError } from '../prober/config.js';
import { loadCollectorConfig, type CollectorConfig } from './config.js';
import { runOnce, ADAPTERS } from './run.js';
import { log } from '../log.js';
import { homedir } from 'node:os';

interface Args {
  configPath?: string;
  dryRun: boolean;
  status: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, status: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') {
      const next = argv[i + 1];
      if (next === undefined) throw new ProberConfigError('--config requires a path');
      args.configPath = next;
      i++;
    } else if (a !== undefined && a.startsWith('--config=')) {
      args.configPath = a.slice('--config='.length);
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--status') {
      args.status = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      throw new ProberConfigError(`unknown argument "${a}"`);
    }
  }
  return args;
}

const USAGE = `peertelemetry collector - scrape local agent-CLI logs for provider errors and publish aggregate counts

  --config, -c <path>   collector config JSON (required)
  --dry-run             build and validate records, publish nothing
  --status              report which agent CLIs are installed, then exit
  --help, -h            this message

Reads ONLY error, status and model fields. Prompt and response text is never
read, buffered, written to disk, or published.
`;

/** Which CLIs are present, without reading a single log line. */
function printStatus(cfg: CollectorConfig, home: string): void {
  const lines: string[] = ['source        installed  root'];
  for (const sc of cfg.sources) {
    const adapter = ADAPTERS[sc.id];
    if (adapter === undefined) continue;
    const root = sc.root ?? adapter.defaultRoot(home);
    const installed = sc.enabled && adapter.detect(root);
    lines.push(`${sc.id.padEnd(13)} ${installed ? 'yes' : 'no '}        ${root}`);
  }
  lines.push('');
  lines.push(`state dir: ${cfg.stateDir}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.configPath === undefined) {
    process.stderr.write(`--config is required\n\n${USAGE}`);
    process.exit(1);
  }

  let cfg: CollectorConfig;
  try {
    cfg = loadCollectorConfig(args.configPath);
  } catch (err) {
    log.error('collector config rejected', { reason: (err as Error).message });
    process.exit(1);
  }
  if (args.status) {
    printStatus(cfg, homedir());
    return;
  }
  // `--dry-run` overrides whatever the file says, so an operator can always see
  // what a config would publish without editing it.
  if (args.dryRun) cfg = { ...cfg, publish: { kind: 'dryrun' } };

  const summary = await runOnce(cfg);
  process.exit(summary.exitCode);
}

main().catch((err: unknown) => {
  // An unexpected throw is an operator problem, not telemetry.
  log.error('collector run failed', { reason: (err as Error).message });
  process.exit(1);
});
