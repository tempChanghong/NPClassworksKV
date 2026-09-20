import {readFileSync} from 'node:fs';
import {UUID, fail} from './wire.js';

// Read on every request: closing the external gate does not require restarting
// the backend, and a restored database cannot reopen it. Never auto-initialize.
export function readDeployment(env = process.env) {
  if (env.NPEP_ENABLED !== 'true' || !env.NPEP_DEPLOYMENT_FILE) fail(503, 'TEMPORARILY_UNAVAILABLE');
  try {
    const value = JSON.parse(readFileSync(env.NPEP_DEPLOYMENT_FILE, 'utf8'));
    if (value.enabled !== true || !UUID.test(value.serverInstanceId) || !UUID.test(value.deploymentEpoch)) throw new Error();
    return {serverInstanceId: value.serverInstanceId, deploymentEpoch: value.deploymentEpoch};
  } catch { fail(503, 'TEMPORARILY_UNAVAILABLE'); }
}
export async function assertDeployment(tx, config) {
  const stored = await tx.npepDeployment.findUnique({where: {id: 'current'}});
  if (!stored || stored.serverInstanceId !== config.serverInstanceId || stored.deploymentEpoch !== config.deploymentEpoch) fail(503, 'TEMPORARILY_UNAVAILABLE');
}
export function assertInstance(body, config) {
  if (body.serverInstanceId !== config.serverInstanceId || body.deploymentEpoch !== config.deploymentEpoch) fail(409, 'INSTANCE_MISMATCH');
}
