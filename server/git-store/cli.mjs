#!/usr/bin/env node
// Independent offline verifier/migrator: only Node built-ins and the local Git CLI.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitAppStateService } from './store.mjs';
import { reviewedSnapshotTransactions } from './snapshot.mjs';
import { canonical, exact } from './schema.mjs';

export async function main(args, { maxEventBytes } = {}) {
  const [command, directory, configPath, outputPath, inputPath, signerModule] = args;
  if (!['verify','restore','migrate','migrate-reviewed'].includes(command) || !directory || !configPath || !outputPath) throw new Error('Usage: node server/git-store/cli.mjs verify|restore STORE CONFIG OUTPUT; migrate STORE CONFIG CHECKPOINT INPUT SIGNER_MODULE');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  exact(config, ['tenant','repository','trust','checkpoint']);
  let signer;
  if (['migrate','migrate-reviewed'].includes(command)) {
    if (!inputPath || !signerModule) throw new Error('Migration requires fixture/export and external signer module');
    signer = (await import(pathToFileURL(resolve(signerModule)).href)).signer;
  }
  const service = new GitAppStateService({ ...config, directory: resolve(directory), signer, maxEventBytes });
  if (['migrate','migrate-reviewed'].includes(command)) {
    const input = JSON.parse(await readFile(inputPath, 'utf8'));
    const migration = command === 'migrate-reviewed' ? reviewedSnapshotTransactions(input) : input;
    exact(migration, ['version','transactions']);
    if (migration.version !== 1 || !Array.isArray(migration.transactions)) throw new Error('Unsupported migration format');
    // Includes exact signed envelope sizes and all records, before the first durable append.
    await service.preflight(migration.transactions);
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
