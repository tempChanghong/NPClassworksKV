import {randomUUID} from 'node:crypto';
import {fail, digest, displayText} from '../domain/npep/wire.js';
import {identityOf, requireSame, requireReady, operationView, fresh, applyRuntimeEvent} from '../domain/npep/runtimeControl.js';
import {runtimeRepository} from './npepRuntimeRepository.js';

export function createNpepRuntimeService(service, repo = runtimeRepository) {
  const now = () => new Date().toISOString();
  async function context(tx, device, c) {
    requireSame(c.identity, identityOf(device), 'AUTH_INVALID');
    const session = await tx.npepSessionReceipt.findUnique({where: {sessionId: c.sessionId}});
    if (!session || session.deviceId !== device.id || session.runId !== c.runId || session.statusEpoch !== c.statusEpoch ||
        device.sessionId !== c.sessionId || device.statusEpoch !== c.statusEpoch) fail(409, 'SESSION_SUPERSEDED');
  }
  async function get(tx, device, id) {
    const op = await repo.operation(tx, id);
    if (!op || op.view.deviceId !== device.id) fail(404, 'NOT_FOUND');
    requireSame(op.view.identity, identityOf(device), 'AUTH_INVALID');
    return op;
  }
  async function pending(tx, device) {
    const [op] = await repo.list(tx, device.id, true);
    if (!op) return null;
    const p = await repo.policy(tx, device.id);
    // A reported terminal result or a new Host epoch is evidence that the old execution is no longer active.
    // Keep its history, but do not require a local 'clear pause' ritual before another target request.
    if (p?.policy.pairedExamControl === true && (['PARTIAL', 'UNKNOWN', 'FAILED'].includes(op.view.state) ||
        op.view.grant && op.view.controlEpoch !== p.context.controlEpoch)) {
      op.retiredByEpoch = !!op.view.grant && op.view.controlEpoch !== p.context.controlEpoch;
      Object.assign(op.view, {resolvedAt: now(), state: ['PARTIAL', 'UNKNOWN', 'FAILED'].includes(op.view.state) ? op.view.state : 'UNKNOWN',
        reasonCode: op.view.reasonCode || 'SESSION_SUPERSEDED'});
      await repo.saveOperation(tx, op); return null;
    }
    // Expiry only applies before a grant. Never infer rollback or success from silence.
    if (!op.view.grant && Date.parse(op.view.expiresAt) <= Date.now()) {
      Object.assign(op.view, {state: 'EXPIRED', reasonCode: 'EXPIRED', resolvedAt: now()});
      await repo.saveOperation(tx, op); return null;
    }
    return op;
  }
  async function policyFor(tx, device, c) {
    await context(tx, device, c);
    const p = await repo.policy(tx, device.id);
    if (!p) fail(409, 'CLIENT_UNSUPPORTED');
    requireSame(p.context, c, 'POLICY_CHANGED');
    return p;
  }
  const admin = (claims, school, id, work) => service.withRuntimeAdmin(claims, school, id, work);
  const dev = (auth, work, initiator) => service.withRuntimeDevice(auth, work, initiator);
  return {
    policy: (auth, body) => dev(auth, async (tx, device) => {
      await context(tx, device, body.context);
      const previous = await repo.policy(tx, device.id);
      if (previous && body.policy.policyRevision < previous.policy.policyRevision) fail(409, 'POLICY_STALE');
      const same = previous && body.policy.policyRevision === previous.policy.policyRevision;
      if (same) requireSame([previous.policy, previous.context], [body.policy, body.context], 'POLICY_CHANGED');
      const receivedAt = same ? previous.policyReceivedAt : now();
      if (!same) {
        const op = await pending(tx, device);
        if (op && !op.view.grant) {
          Object.assign(op.view, {state: 'REJECTED', reasonCode: 'POLICY_CHANGED', resolvedAt: now()});
          await repo.saveOperation(tx, op);
        }
        await repo.savePolicy(tx, device.id, {policy: body.policy, context: body.context, policyReceivedAt: receivedAt,
          status: null, sequence: 0, statusDigest: null, receivedAt: null, sampleAsOf: null});
      }
      return {disposition: same ? 'DUPLICATE' : 'APPLIED', consentId: body.policy.consentId, policyRevision: body.policy.policyRevision, receivedAt};
    }),
    status: (auth, body) => dev(auth, async (tx, device) => {
      const p = await policyFor(tx, device, body.context);
      requireSame([p.policy.consentId, p.policy.policyRevision], [body.status.consentId, body.status.policyRevision], 'POLICY_CHANGED');
      if (body.sequence < p.sequence) fail(409, 'SEQUENCE_CONFLICT');
      const same = body.sequence === p.sequence;
      if (same && p.statusDigest !== digest(body)) fail(409, 'SEQUENCE_CONFLICT');
      if (!same) {
        Object.assign(p, {sequence: body.sequence, status: body.status, statusDigest: digest(body), receivedAt: now(), sampleAsOf: new Date(Date.now() - body.sampleAgeMs).toISOString()});
        await repo.savePolicy(tx, device.id, p);
      }
      return {disposition: same ? 'DUPLICATE' : 'APPLIED', acceptedSequence: p.sequence, receivedAt: p.receivedAt, nextPollSeconds: 10};
    }),
    managementStatus: (claims, school, id) => admin(claims, school, id, async (tx, device) => {
      const p = await repo.policy(tx, id), op = await pending(tx, device);
      const current = p && p.context.sessionId === device.sessionId && p.context.statusEpoch === device.statusEpoch;
      return {policy: p?.policy ?? null, status: p?.status ?? null, receivedAt: p?.receivedAt ?? null,
        sampleAsOf: p?.sampleAsOf ?? null, connectivity: !p ? 'UNKNOWN' : current && fresh(p) ? 'ONLINE' : 'OFFLINE',
        unresolvedOperationId: op?.view.operationId ?? null, controlEpoch: p?.context.controlEpoch ?? null};
    }),
    create: (claims, school, id, body) => admin(claims, school, id, async (tx, device) => {
      if (body.scope !== 'EXAM_MODE' || !['EXAM', 'DAILY'].includes(body.target)) fail(400, 'UNSUPPORTED_SCOPE');
      const previous = await repo.byRequest(tx, id, body.requestId);
      if (previous) {
        requireSame([previous.createDigest, previous.claims.accountId, previous.claims.sessionId], [digest(body), claims.accountId, claims.sessionId], 'IDEMPOTENCY_CONFLICT');
        return {created: false, data: operationView(previous)};
      }
      const p = await repo.policy(tx, id);
      if (p) await context(tx, device, p.context);
      requireReady(p, body);
      if (body.target === 'DAILY' && p.policy.remoteDailyControl !== true) fail(409, 'CLIENT_UNSUPPORTED');
      const active = await pending(tx, device);
      if (active) {
        if (active.view.target !== body.target) fail(409, 'OPERATION_BUSY');
        return {created: false, data: operationView(active)};
      }
      if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) fail(401, 'AUTH_INVALID');
      const account = await tx.account.findUnique({where: {id: claims.accountId}});
      const op = {createDigest: digest(body), claims: {accountId: claims.accountId, sessionId: claims.sessionId, tokenVersion: claims.tokenVersion, exp: claims.exp}, events: [],
        view: {operationId: randomUUID(), deviceId: id, requestId: body.requestId, identity: identityOf(device), schoolId: school,
          administrativeClassId: device.administrativeClassId, screenBindingId: device.screenBindingId,
          target: body.target, scope: 'EXAM_MODE', consentId: body.consentId, policyRevision: body.policyRevision, controlEpoch: body.controlEpoch,
          expectedRuntimeRevision: body.expectedRuntimeRevision, expectedModeRevision: body.expectedModeRevision, expectedConfigurationRevision: body.expectedConfigurationRevision,
          initiator: {displayName: displayText(account?.name || '学校管理员', 60)}, createdAt: now(), expiresAt: new Date(Date.now() + 300000).toISOString(),
          state: 'QUEUED', step: null, reasonCode: null, lastEventSequence: 0, progressReceivedAt: null, grant: null, evidence: null,
          resolvedAt: null, resolutionId: null, localEndedAt: null, freshness: 'UNKNOWN'}};
      await repo.saveOperation(tx, op);
      return {created: true, data: operationView(op)};
    }),
    list: (claims, school, id) => admin(claims, school, id, async (tx, device) => {
      await pending(tx, device);
      return {items: (await repo.list(tx, id)).map(op => operationView(op)), nextCursor: null};
    }),
    cancel: (claims, school, id, operationId) => admin(claims, school, id, async (tx, device) => {
      await pending(tx, device);
      const op = await get(tx, device, operationId);
      if (op.view.grant) fail(409, 'START_ALREADY_AUTHORIZED');
      if (!op.view.resolvedAt) {
        Object.assign(op.view, {state: 'CANCELLED', resolvedAt: now()}); await repo.saveOperation(tx, op);
      }
      return operationView(op);
    }),
    poll: auth => dev(auth, async (tx, device) => {
      const op = await pending(tx, device);
      return {items: op ? [operationView(op)] : [], pollAfterSeconds: 10};
    }),
    start: (auth, id, body) => dev(auth, async (tx, device) => {
      const op = await get(tx, device, id), p = await policyFor(tx, device, body.context);
      if (op.view.scope !== 'EXAM_MODE') fail(409, 'UNSUPPORTED_SCOPE');
      if (op.view.target === 'DAILY' && p.policy.remoteDailyControl !== true) fail(409, 'CLIENT_UNSUPPORTED');
      if (op.view.resolvedAt || Date.parse(op.view.expiresAt) <= Date.now()) fail(409, 'EXPIRED');
      requireReady(p, {...body, controlEpoch: body.context.controlEpoch});
      for (const key of ['consentId', 'policyRevision', 'expectedRuntimeRevision', 'expectedModeRevision', 'expectedConfigurationRevision']) requireSame(body[key], op.view[key]);
      requireSame(body.context.controlEpoch, op.view.controlEpoch, 'POLICY_CHANGED');
      if (!op.view.grant) {
        op.view.grant = {grantId: randomUUID(), operationId: id, ...body.context,
          consentId: body.consentId, policyRevision: body.policyRevision,
          expectedRuntimeRevision: body.expectedRuntimeRevision, expectedModeRevision: body.expectedModeRevision, expectedConfigurationRevision: body.expectedConfigurationRevision,
          authorizedAt: now(), startNotAfter: new Date(Math.min(Date.parse(op.view.expiresAt), Date.now() + 30000)).toISOString()};
        op.view.state = 'START_AUTHORIZED'; await repo.saveOperation(tx, op);
      }
      if (Date.parse(op.view.grant.startNotAfter) <= Date.now()) fail(409, 'EXPIRED');
      return {grant: op.view.grant, serverTime: now()};
    }, async (tx, device) => (await get(tx, device, id)).claims),
    events: (auth, body) => dev(auth, async (tx, device) => {
      await context(tx, device, body.context); // Current uploader may differ from the original execution session.
      const results = [];
      for (const event of body.events) {
        const op = await get(tx, device, event.operationId);
        const status = applyRuntimeEvent(op, event);
        if (status !== 'DUPLICATE') await repo.saveOperation(tx, op);
        results.push({eventId: event.eventId, status, code: null, acceptedSequence: op.view.lastEventSequence});
      }
      return {results};
    }),
    resolve: (auth, id, body) => dev(auth, async (tx, device) => {
      await context(tx, device, body.context);
      const op = await get(tx, device, id);
      if (op.resolution) { requireSame(op.resolution, {...body, requestId: op.resolution.requestId, context: op.resolution.context}, 'IDEMPOTENCY_CONFLICT'); return operationView(op); }
      if (!['SUCCEEDED', 'PARTIAL', 'UNKNOWN'].includes(op.view.state) || body.expectedLastEventSequence !== op.view.lastEventSequence || body.evidence.remoteExamPause) fail(409, 'STATE_CHANGED');
      op.resolution = body;
      Object.assign(op.view, {resolvedAt: op.view.resolvedAt || now(), resolutionId: body.resolutionId, localEndedAt: now()});
      await repo.saveOperation(tx, op); return operationView(op);
    }),
  };
}
