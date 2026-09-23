import { Pds } from '../pds-websub/app.js';
import { pdsConfigFromEnv } from '../pds-websub/config.js';
import { createServer } from './http.js';
import { log } from '../log.js';

/** Start the configured PDS behind an HTTPS reverse proxy. */
async function main(): Promise<void> {
  if (!process.env.SELF_ENDPOINT?.trim()) throw new Error('Set SELF_ENDPOINT to this deployment’s public HTTPS origin.');
  const config = pdsConfigFromEnv();
  const pds = await Pds.create(config);
  const server = createServer(pds);
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  server.listen(port, host, () => {
    log.info('listening', { host, port, selfEndpoint: config.selfEndpoint });
  });
}

main().catch((err) => {
  log.error('fatal boot error', { err: (err as Error).message, stack: (err as Error).stack });
  process.exitCode = 1;
});
