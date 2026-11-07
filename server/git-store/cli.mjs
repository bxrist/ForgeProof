#!/usr/bin/env node
// Independent offline verifier/migrator: only Node built-ins and the local Git CLI.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitAppStateService } from './store.mjs';
import { canonical, exact, identifier } from './schema.mjs';

export async function main(args) {
  const [command, directory, configPath, outputPath, inputPath, signerModule] = args;
  if (!['verify','restore','migrate'].includes(command) || !directory || !configPath || !outputPath) throw new Error('Usage: node server/git-store/cli.mjs verify|restore STORE CONFIG OUTPUT; migrate STORE CONFIG CHECKPOINT INPUT SIGNER_MODULE');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  exact(config, ['tenant','repository','trust','checkpoint']);
  let signer;
  if (command === 'migrate') {
    if (!inputPath || !signerModule) throw new Error('Migration requires fixture/export and external signer module');
    signer = (await import(pathToFileURL(resolve(signerModule)).href)).signer;
  }
  const service = new GitAppStateService({ ...config, directory: resolve(directory), signer });
  if (command === 'migrate') {
    const migration = JSON.parse(await readFile(inputPath, 'utf8'));
    exact(migration, ['version','transactions']);
    if (migration.version !== 1 || !Array.isArray(migration.transactions)) throw new Error('Unsupported migration format');
    // Preflight the entire export, so invalid later records cannot partially import.
    const state = await service.replay();
    const seen = new Map(state.events.map(e => [e.body.idempotencyKey, e.body]));
    let seq = state.checkpoint?.sequence ?? 0;
    for (const tx of migration.transactions) {
      exact(tx, ['idempotencyKey','operations']);
      identifier(tx.idempotencyKey);
      const old = seen.get(tx.idempotencyKey);
      if (old) {
        if (old.actor !== signer.actor || canonical(old.operations) !== canonical(tx.operations)) throw new Error('Migration idempotency conflict');
        continue;
      }
      service.apply(state, tx.operations, ++seq);
      seen.set(tx.idempotencyKey, { actor: signer.actor, operations: tx.operations });
    }
    for (const tx of migration.transactions) await service.append(tx);
  }
  const state = await service.replay();
  const result = command === 'restore'
    ? { version: 1, tenant: config.tenant, repository: config.repository, checkpoint: state.checkpoint, records: state.records, versions: state.versions, receiptHead: state.receiptHead }
    : { version: 1, checkpoint: state.checkpoint, verifiedEvents: state.events.length };
  // Exclusive output prevents accidentally overwriting a trusted checkpoint or existing recovery file.
  await writeFile(outputPath, canonical(result) + '\n', { mode: 0o600, flag: 'wx' });
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(r => console.log(JSON.stringify({ checkpoint: r.checkpoint, verified: true }))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
