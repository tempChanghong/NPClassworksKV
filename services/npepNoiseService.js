import {randomUUID} from 'node:crypto';
import {digest, fail} from '../domain/npep/wire.js';
import {identityOf, requireSame} from '../domain/npep/runtimeControl.js';
import {noiseRepository} from './npepNoiseRepository.js';

const active = s => ['Starting', 'Active', 'Stopping'].includes(s?.state);
const now = () => new Date().toISOString();
export function createNpepNoiseService(base, repo = noiseRepository) {
  const online = (a, d) => !!a.status && a.context.sessionId === d.sessionId && a.context.statusEpoch === d.statusEpoch && Date.now() - Date.parse(a.receivedAt) < 15000;
  function clean(a) {
    for (const c of a.commands) if (!c.receipt && Date.parse(c.command.expiresAt) <= Date.now()) c.receipt = {commandId: c.command.commandId, outcome: 'UNKNOWN', reason: 'COMMAND_EXPIRED'};
    a.commands = a.commands.slice(-64);
    a.reports = a.reports.filter(r => Date.now() - Date.parse(r.receivedAt) < 30 * 86400000).slice(-200);
  }
  async function view(tx, d) {
    if (!d) return {provider: 'browser', online: false, status: null, receivedAt: null, commands: [], reports: []};
    const a = await repo.read(tx, d.id); clean(a); await repo.save(tx, d.id, a);
    return {provider: a.status ? 'native' : 'browser', online: online(a, d), status: a.status,
      receivedAt: a.receivedAt ?? null, commands: a.commands.slice(-5), reports: a.reports.slice(-20).reverse()};
  }
  return {
    screen: token => base.withNoiseScreen(token, view),
    management: (claims, school, id) => base.withRuntimeAdmin(claims, school, id, view),
    create: (token, b) => base.withNoiseScreen(token, async (tx, d) => {
      if (!d) fail(409, 'NO_NATIVE_DEVICE');
      const a = await repo.read(tx, d.id); clean(a);
      const old = a.commands.find(c => c.requestId === b.requestId);
      if (old) { requireSame(old.digest, digest(b), 'IDEMPOTENCY_CONFLICT'); return old; }
      if (!online(a, d)) fail(409, 'DEVICE_OFFLINE');
      requireSame([b.instanceId, b.revision, b.sessionId], [a.status.instanceId, a.status.revision, a.status.sessionId]);
      if (b.action === 'START' && (active(a.status) || !a.status.configured)) fail(409, active(a.status) ? 'NOISE_BUSY' : 'MICROPHONE_NOT_CONFIGURED');
      if (b.action === 'STOP' && (!b.sessionId || !active(a.status))) fail(409, 'STATE_CHANGED');
      if (a.commands.some(c => !c.receipt)) fail(409, 'COMMAND_PENDING');
      const command = {commandId: randomUUID(), action: b.action, instanceId: b.instanceId, revision: b.revision,
        sessionId: b.sessionId, durationSeconds: b.durationSeconds, expiresAt: new Date(Date.now() + 30000).toISOString()};
      const record = {command, requestId: b.requestId, digest: digest(b), receipt: null, context: a.context};
      a.commands.push(record); await repo.save(tx, d.id, a); return record;
    }),
    exchange: (auth, b) => base.withRuntimeDevice(auth, async (tx, d) => {
      requireSame(b.context.identity, identityOf(d), 'AUTH_INVALID');
      const receipt = await tx.npepSessionReceipt.findUnique({where: {sessionId: b.context.sessionId}});
      if (!receipt || receipt.deviceId !== d.id || receipt.runId !== b.context.runId || receipt.statusEpoch !== b.context.statusEpoch || d.sessionId !== b.context.sessionId || d.statusEpoch !== b.context.statusEpoch) fail(409, 'SESSION_SUPERSEDED');
      const a = await repo.read(tx, d.id); clean(a);
      if (a.context && digest(a.context) === digest(b.context) && b.sequence <= a.sequence) {
        if (b.sequence !== a.sequence || a.digest !== digest(b)) fail(409, 'SEQUENCE_CONFLICT');
        // Duplicate delivery must not refresh a stale sample or an expired command.
        return {...a.reply, command: null, serverTime: now()};
      }
      for (const r of b.receipts) {
        const c = a.commands.find(c => c.command.commandId === r.commandId);
        if (!c) continue;
        requireSame(c.context.identity, b.context.identity, 'AUTH_INVALID');
        // A late actual result may replace the server's timeout, but not a prior actual result.
        if (c.receipt && c.receipt.reason !== 'COMMAND_EXPIRED') requireSame(c.receipt, r, 'IDEMPOTENCY_CONFLICT');
        c.receipt = r;
      }
      for (const report of b.reports) {
        const previous = a.reports.find(r => r.sessionId === report.sessionId);
        if (previous) requireSame(previous.digest, digest(report), 'IDEMPOTENCY_CONFLICT');
        else {
          if (Date.parse(report.endedAt) < Date.parse(report.startedAt)) fail(400, 'INVALID_REPORT');
          a.reports.push({...report, digest: digest(report), receivedAt: now()});
        }
      }
      Object.assign(a, {status: b.status, context: b.context, sequence: b.sequence, digest: digest(b), receivedAt: now()});
      // A command belongs to the Host session observed by the screen. Never replay it into a restarted Host.
      for (const c of a.commands) if (!c.receipt && digest(c.context) !== digest(b.context)) c.receipt = {commandId: c.command.commandId, outcome: 'UNKNOWN', reason: 'SESSION_CHANGED'};
      clean(a);
      a.reply = {serverTime: now(), command: a.commands.find(c => !c.receipt)?.command ?? null,
        acceptedReports: b.reports.map(r => r.sessionId), acceptedReceipts: b.receipts.map(r => r.commandId)};
      await repo.save(tx, d.id, a); return a.reply;
    }),
  };
}
