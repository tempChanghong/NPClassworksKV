import {readFile, writeFile, rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {UUID} from '../domain/npep/wire.js';

async function writeAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  await rename(temporary, path);
}
export async function closeBeforeRestore(path) {
  const original = JSON.parse(await readFile(path, 'utf8'));
  if (!UUID.test(original.serverInstanceId) || !UUID.test(original.deploymentEpoch)) throw new Error('Invalid NPEP deployment identity');
  const closed = {...original, enabled: false, deploymentEpoch: randomUUID()};
  await writeAtomic(path, closed);
  return closed;
}
export async function activateDeployment(client, path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (config.enabled !== false || !UUID.test(config.serverInstanceId) || !UUID.test(config.deploymentEpoch)) throw new Error('Close/rotate the external NPEP gate before activation');
  await client.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(781001)::text`;
    const previous = await tx.npepDeployment.findUnique({where: {id: 'current'}});
    if (previous && previous.deploymentEpoch === config.deploymentEpoch) throw new Error('Recovery requires a newly rotated external epoch');
    await tx.npepDevice.updateMany({where: {state: 'ACTIVE'}, data: {state: 'INVALIDATED', revokedAt: new Date(), sessionId: null}});
    await tx.npepPairing.updateMany({data: {state: 'CANCELLED', secretHash: null}});
    await tx.npepSessionReceipt.deleteMany({});
    await tx.npepAudit.create({data: {id: randomUUID(), objectId: config.serverInstanceId, action: 'DEPLOYMENT_EPOCH_ACTIVATED'}});
    await tx.npepDeployment.upsert({where: {id: 'current'}, create: {id: 'current', serverInstanceId: config.serverInstanceId, deploymentEpoch: config.deploymentEpoch}, update: {serverInstanceId: config.serverInstanceId, deploymentEpoch: config.deploymentEpoch}});
  }, {timeout: 30000});
  // DB commit before opening. If writing fails, the external gate stays closed.
  const current = JSON.parse(await readFile(path, 'utf8'));
  if (current.deploymentEpoch !== config.deploymentEpoch || current.enabled !== false) throw new Error('External deployment gate changed concurrently');
  await writeAtomic(path, {...config, enabled: true});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2], path = process.env.NPEP_DEPLOYMENT_FILE;
  if (command === 'prepare-restore' && process.env.NPEP_ENABLED !== 'true') process.exit(0);
  if (!path) throw new Error('NPEP_DEPLOYMENT_FILE must be outside database backups');
  if (command === 'prepare-restore') await closeBeforeRestore(path);
  else if (command === 'activate' && process.argv.includes('--invalidate-all-old-devices')) {
    const {prisma} = await import('../utils/prisma.js');
    try { await activateDeployment(prisma, path); } finally { await prisma.$disconnect(); }
  } else throw new Error('Use prepare-restore, or activate --invalidate-all-old-devices');
  console.log('NPEP deployment gate operation completed');
}
