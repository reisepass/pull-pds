/**
 * Prober CLI. One idempotent run, then exit - the OS does the scheduling
 * (`deploy/peertelemetry-prober.timer`, or the crontab line in the README).
 *
 *   node dist/src/prober/main.js --config /etc/peertelemetry/prober.json
 *   node dist/src/prober/main.js --config ./prober.json --dry-run
 *
 * Exit 0 = the run completed, including when providers returned errors (that is
 * the data). Exit 1 = the operator must intervene: bad config, missing
 * credential, or a record that failed lexicon validation.
 */
import { loadProberConfig, ProberConfigError, type ProberConfig } from './config.js';
import { runOnce } from './run.js';
import { log } from '../log.js';

interface Args {
  configPath?: string;
  dryRun: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, help: false };
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
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      throw new ProberConfigError(`unknown argument "${a}"`);
    }
  }
  return args;
}

const USAGE = `peertelemetry prober - probe LLM endpoints once and publish an errorMetrics record

  --config, -c <path>   prober config JSON (required)
  --dry-run             build and validate records, publish nothing
  --help, -h            this message
`;

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

  let cfg: ProberConfig;
  try {
    cfg = loadProberConfig(args.configPath);
  } catch (err) {
    log.error('prober config rejected', { reason: (err as Error).message });
    process.exit(1);
  }
  // `--dry-run` overrides whatever the file says, so an operator can always
  // check what a config would publish without editing it.
  if (args.dryRun) cfg = { ...cfg, publish: { kind: 'dryrun' } };

  const summary = await runOnce(cfg);
  process.exit(summary.exitCode);
}

main().catch((err: unknown) => {
  // An unexpected throw is an operator problem, not telemetry. Log the message
  // (never the stack's surrounding state, which could hold a header) and fail.
  log.error('prober run failed', { reason: (err as Error).message });
  process.exit(1);
});
