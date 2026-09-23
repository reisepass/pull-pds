import { Secp256k1Keypair } from '@atproto/crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const destination = resolve(process.argv[2] ?? '.env');
const kp = await Secp256k1Keypair.create({ exportable: true });
await writeFile(destination, `PDS_SIGNING_KEY=${Buffer.from(await kp.export()).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ savedTo: destination, publicKeyMultibase: kp.did().slice(8) }, null, 2));
