import {randomUUID, randomInt} from 'node:crypto';
import {Prisma} from '../generated/prisma/client.ts';
import {assertDeployment, assertInstance} from '../domain/npep/deployment.js';
import {NpepError, fail, capabilities, secretHash, hashMatches, digest, displayText, hash} from '../domain/npep/wire.js';

const DAY = 86400000;
const expired = date => new Date(date).getTime() <= Date.now();
const jsonNull = Prisma.DbNull;
const conflict = (ok, code) => { if (!ok) fail(409, code); };

export function createNpepService(prisma, deploymentProvider) {
  async function transaction(operation) {
    const config = deploymentProvider();
    return prisma.$transaction(async tx => {
      await assertDeployment(tx, config);
      const result = await operation(tx, config);
      // A gate closed during lock waits must also fail before commit.
      const current = deploymentProvider();
      if (current.deploymentEpoch !== config.deploymentEpoch || current.serverInstanceId !== config.serverInstanceId) fail(503, 'TEMPORARILY_UNAVAILABLE');
      return result;
    }, {timeout: 9000, maxWait: 5000});
  }
  async function audit(tx, action, objectId, schoolId = null, actorId = null) {
    await tx.npepAudit.create({data: {id: randomUUID(), action, objectId, schoolId, actorId}});
  }
  async function schoolLock(tx, schoolId) {
    const rows = await tx.$queryRaw`SELECT id FROM "School" WHERE id = ${schoolId} FOR UPDATE`;
    if (!rows.length) fail(404, 'NOT_FOUND');
  }
  async function administrator(tx, claims, schoolId, approver = false) {
    const errorCode = approver ? 'APPROVER_NO_LONGER_AUTHORIZED' : 'AUTH_INVALID';
    if (!claims?.accountId || !claims.sessionId) fail(approver ? 403 : 401, errorCode);
    await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${claims.accountId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "AccountSession" WHERE id = ${claims.sessionId} FOR SHARE`;
    const account = await tx.account.findUnique({where: {id: claims.accountId}});
    const session = await tx.accountSession.findUnique({where: {id: claims.sessionId}});
    if (!account || account.localDisabled || account.tokenVersion !== claims.tokenVersion || !session ||
        session.accountId !== account.id || session.revokedAt || expired(session.expiresAt) || (claims.exp && claims.exp * 1000 <= Date.now())) fail(approver ? 403 : 401, errorCode);
    const member = await tx.schoolMember.findUnique({where: {schoolId_accountId: {schoolId, accountId: account.id}}});
    if (!member || !['OWNER', 'ADMIN'].includes(member.role)) fail(403, approver ? errorCode : 'SCHOOL_ADMIN_REQUIRED');
    return session;
  }
  async function binding(tx, bindingId, schoolId, revision) {
    const initial = await tx.classroomScreenBinding.findUnique({where: {id: bindingId}, include: {administrativeClass: true}});
    if (!initial || initial.schoolId !== schoolId) fail(404, 'NOT_FOUND');
    const termId = initial.administrativeClass?.termId;
    if (!termId) fail(409, 'BINDING_CHANGED');
    await tx.$queryRaw`SELECT id FROM "AcademicTerm" WHERE id = ${termId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${initial.administrativeClassId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "ClassroomScreenBinding" WHERE id = ${bindingId} FOR UPDATE`;
    const current = await tx.classroomScreenBinding.findUnique({where: {id: bindingId}, include: {administrativeClass: {include: {term: true}}, school: true}});
    const workspace = current?.administrativeClass;
    if (!current?.isActive || current.schoolId !== schoolId || !workspace?.isActive || workspace.type !== 'ADMIN_CLASS' ||
        workspace.termId !== termId || workspace.id !== initial.administrativeClassId || workspace.term?.status !== 'ACTIVE' ||
        workspace.term.schoolId !== schoolId || (revision !== undefined && current.npepBindingRevision !== revision)) fail(409, 'BINDING_CHANGED');
    return current;
  }
  function context(pair) {
    return {accountId: pair.approverId, sessionId: pair.approverSessionId, tokenVersion: pair.approverTokenVersion};
  }
  function pairValid(pair, config) {
    if (!pair || pair.serverInstanceId !== config.serverInstanceId || pair.deploymentEpoch !== config.deploymentEpoch) fail(401, 'AUTH_INVALID');
    if (expired(pair.expiresAt)) fail(410, 'PAIRING_EXPIRED');
  }
  async function pairing(tx, id, auth, config, lock = true) {
    if (auth.id !== id) fail(401, 'AUTH_INVALID');
    if (lock) await tx.$queryRaw`SELECT id FROM "NpepPairing" WHERE id = ${id}::uuid FOR UPDATE`;
    const pair = await tx.npepPairing.findUnique({where: {id}});
    if (!hashMatches(auth.hash, pair?.secretHash)) fail(401, 'AUTH_INVALID');
    pairValid(pair, config);
    return pair;
  }
  function registration(device) {
    return {
      deviceId: device.id, installationId: device.installationId, serverInstanceId: device.serverInstanceId,
      deploymentEpoch: device.deploymentEpoch, schoolId: device.schoolId, administrativeClassId: device.administrativeClassId,
      screenBindingId: device.screenBindingId, bindingRevision: device.bindingRevision, credentialGeneration: 1,
      capabilities, credentialExpiresAt: device.credentialExpiresAt.toISOString(), statusEpoch: device.statusEpoch,
    };
  }
  function deviceValid(device, config, currentBinding) {
    if (!device || device.state !== 'ACTIVE' || device.deploymentEpoch !== config.deploymentEpoch || device.serverInstanceId !== config.serverInstanceId ||
        (currentBinding && (device.bindingRevision !== currentBinding.npepBindingRevision || device.administrativeClassId !== currentBinding.administrativeClassId))) fail(401, 'AUTH_INVALID');
    if (expired(device.credentialExpiresAt)) fail(401, 'CREDENTIAL_EXPIRED');
  }
  async function device(tx, auth, config) {
    const initial = await tx.npepDevice.findUnique({where: {credentialId: auth.id}});
    if (!hashMatches(auth.hash, initial?.secretHash)) fail(401, 'AUTH_INVALID');
    deviceValid(initial, config);
    await schoolLock(tx, initial.schoolId);
    let currentBinding;
    try { currentBinding = await binding(tx, initial.screenBindingId, initial.schoolId, initial.bindingRevision); }
    catch (error) { if (error instanceof NpepError) fail(401, 'AUTH_INVALID'); throw error; }
    await tx.$queryRaw`SELECT id FROM "NpepDevice" WHERE id = ${initial.id}::uuid FOR UPDATE`;
    const current = await tx.npepDevice.findUnique({where: {id: initial.id}});
    deviceValid(current, config, currentBinding);
    return current;
  }
  async function available(tx, bindingId) {
    // Fixed expiry also frees the unique ACTIVE slot. Expired secrets never revive.
    await tx.npepDevice.updateMany({where: {screenBindingId: bindingId, state: 'ACTIVE', credentialExpiresAt: {lte: new Date()}}, data: {state: 'EXPIRED', sessionId: null}});
    if (await tx.npepDevice.findFirst({where: {screenBindingId: bindingId, state: 'ACTIVE'}})) fail(409, 'BINDING_OCCUPIED');
  }
  const approved = pair => ({pairingId: pair.id, state: 'APPROVED', expiresAt: pair.expiresAt.toISOString(), pollAfterSeconds: 5, approvalId: pair.approvalId, ...pair.approvalSnapshot});

  return {
    async pollRate(identity) {
      const key = `poll:${hash(identity)}`;
      const rows = await prisma.$queryRaw`INSERT INTO "NpepRateLimit" (key, count, "expiresAt")
        VALUES (${key}, 1, clock_timestamp() + interval '5 seconds') ON CONFLICT (key)
        DO UPDATE SET "expiresAt"=clock_timestamp() + interval '5 seconds'
        WHERE "NpepRateLimit"."expiresAt"<=clock_timestamp() RETURNING key`;
      if (!rows.length) throw new NpepError(429, 'RATE_LIMITED', 5);
    },
    async rate(scope, identity, limit, seconds) {
      const time = Date.now(), bucket = Math.floor(time / (seconds * 1000));
      const key = `${scope}:${hash(String(identity))}:${bucket}`;
      const expiresAt = new Date((bucket + 1) * seconds * 1000);
      const [row] = await prisma.$queryRaw`INSERT INTO "NpepRateLimit" (key, count, "expiresAt")
        VALUES (${key}, 1, ${expiresAt}) ON CONFLICT (key)
        DO UPDATE SET count = "NpepRateLimit".count + 1 RETURNING count`;
      if (row.count > limit) throw new NpepError(429, 'RATE_LIMITED', Math.max(1, Math.ceil((expiresAt.getTime() - time) / 1000)));
    },
    info: () => transaction(async (tx, config) => ({...config, supportedCapabilities: capabilities})),
    create: body => transaction(async (tx, config) => {
      assertInstance(body, config);
      // Shared across processes, including the pending cap and short-code allocation.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(781001)::text`;
      const existing = await tx.npepPairing.findUnique({where: {installationId_requestId: {installationId: body.installationId, requestId: body.requestId}}});
      if (existing) {
        conflict(existing.createDigest === digest(body), 'IDEMPOTENCY_CONFLICT');
        pairValid(existing, config);
        return {created: false, data: {pairingId: existing.id, userCode: existing.userCode, state: 'PENDING', expiresAt: existing.expiresAt.toISOString(), pollAfterSeconds: 5}};
      }
      if (await tx.npepPairing.count({where: {expiresAt: {gt: new Date()}, state: {in: ['PENDING', 'APPROVED']}}}) >= 10000) throw new NpepError(429, 'RATE_LIMITED', 60);
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let userCode;
      do { userCode = Array.from({length: 8}, () => alphabet[randomInt(alphabet.length)]).join(''); }
      while (await tx.npepPairing.findUnique({where: {userCode}}));
      const pair = await tx.npepPairing.create({data: {
        id: randomUUID(), installationId: body.installationId, requestId: body.requestId, createDigest: digest(body),
        secretHash: secretHash(body.pairingSecret), userCode, deviceName: displayText(body.deviceName, 64), appVersion: displayText(body.appVersion, 64),
        ...config, expiresAt: new Date(Date.now() + 600000),
      }});
      await audit(tx, 'PAIRING_CREATED', pair.id);
      return {created: true, data: {pairingId: pair.id, userCode, state: 'PENDING', expiresAt: pair.expiresAt.toISOString(), pollAfterSeconds: 5}};
    }),
    resolve: (claims, schoolId, body) => transaction(async (tx, config) => {
      await schoolLock(tx, schoolId);
      await administrator(tx, claims, schoolId);
      const pair = await tx.npepPairing.findUnique({where: {userCode: body.userCode}});
      if (!pair || expired(pair.expiresAt) || pair.serverInstanceId !== config.serverInstanceId || pair.deploymentEpoch !== config.deploymentEpoch ||
          !['PENDING', 'APPROVED'].includes(pair.state) || (pair.schoolId && pair.schoolId !== schoolId)) fail(404, 'NOT_FOUND');
      return {pairingId: pair.id, deviceName: pair.deviceName, appVersion: pair.appVersion, expiresAt: pair.expiresAt.toISOString(), requestedCapabilities: capabilities};
    }),
    approve: (claims, schoolId, id, body) => transaction(async (tx, config) => {
      await schoolLock(tx, schoolId);
      await administrator(tx, claims, schoolId);
      const currentBinding = await binding(tx, body.screenBindingId, schoolId);
      await tx.$queryRaw`SELECT id FROM "NpepPairing" WHERE id = ${id}::uuid FOR UPDATE`;
      const pair = await tx.npepPairing.findUnique({where: {id}});
      if (!pair || (pair.schoolId && pair.schoolId !== schoolId)) fail(404, 'NOT_FOUND');
      pairValid(pair, config);
      if (pair.state !== 'PENDING') {
        conflict(pair.state === 'APPROVED' && pair.approverId === claims.accountId && pair.approverSessionId === claims.sessionId && pair.approvalRequestId === body.requestId, 'PAIRING_STATE_CONFLICT');
        conflict(pair.approvalDigest === digest(body), 'IDEMPOTENCY_CONFLICT');
        conflict(pair.approvalSnapshot.bindingRevision === currentBinding.npepBindingRevision, 'BINDING_CHANGED');
        return approved(pair);
      }
      await available(tx, currentBinding.id);
      await administrator(tx, claims, schoolId);
      pairValid(pair, config);
      const snapshot = {
        schoolId, schoolName: displayText(currentBinding.school.name), administrativeClassId: currentBinding.administrativeClassId,
        administrativeClassName: displayText(currentBinding.administrativeClass.name), screenBindingId: currentBinding.id,
        screenBindingName: displayText(currentBinding.name), bindingRevision: currentBinding.npepBindingRevision, capabilities,
      };
      const result = await tx.npepPairing.update({where: {id}, data: {state: 'APPROVED', schoolId, screenBindingId: currentBinding.id,
        approvalId: randomUUID(), approvalRequestId: body.requestId, approvalDigest: digest(body), approverId: claims.accountId,
        approverSessionId: claims.sessionId, approverTokenVersion: claims.tokenVersion, approvalSnapshot: snapshot}});
      await audit(tx, 'PAIRING_APPROVED', id, schoolId, claims.accountId);
      return approved(result);
    }),
    poll: (id, auth) => transaction(async (tx, config) => {
      const pair = await pairing(tx, id, auth, config, false);
      if (pair.state === 'APPROVED') return approved(pair);
      if (pair.state === 'ACTIVATED') return {pairingId: id, state: 'ACTIVATED', deviceId: pair.deviceId};
      if (pair.state === 'CANCELLED') return {pairingId: id, state: 'CANCELLED'};
      return {pairingId: id, state: 'PENDING', expiresAt: pair.expiresAt.toISOString(), pollAfterSeconds: 5};
    }),
    confirm: (id, auth, body) => transaction(async (tx, config) => {
      assertInstance(body, config);
      const initial = await pairing(tx, id, auth, config, false);
      conflict(['APPROVED', 'ACTIVATED'].includes(initial.state), 'PAIRING_STATE_CONFLICT');
      await schoolLock(tx, initial.schoolId);
      if (initial.state === 'APPROVED') await administrator(tx, context(initial), initial.schoolId, true);
      const currentBinding = await binding(tx, initial.screenBindingId, initial.schoolId, initial.approvalSnapshot.bindingRevision);
      const pair = await pairing(tx, id, auth, config);
      conflict(pair.approvalId === body.approvalId, 'PAIRING_STATE_CONFLICT');
      if (pair.state === 'ACTIVATED') {
        conflict(pair.confirmRequestId === body.requestId && pair.confirmDigest === digest(body), 'IDEMPOTENCY_CONFLICT');
        const existing = await tx.npepDevice.findUnique({where: {id: pair.deviceId}});
        deviceValid(existing, config, currentBinding);
        return {created: false, data: registration(existing)};
      }
      conflict(pair.state === 'APPROVED', 'PAIRING_STATE_CONFLICT');
      conflict(secretHash(body.deviceSecret) !== pair.secretHash, 'IDEMPOTENCY_CONFLICT');
      await available(tx, currentBinding.id);
      if (await tx.npepDevice.findUnique({where: {credentialId: body.credentialId}})) fail(409, 'CREDENTIAL_ID_CONFLICT');
      await administrator(tx, context(pair), pair.schoolId, true);
      pairValid(pair, config);
      const created = await tx.npepDevice.create({data: {
        id: randomUUID(), installationId: pair.installationId, credentialId: body.credentialId, secretHash: secretHash(body.deviceSecret),
        ...config, schoolId: pair.schoolId, administrativeClassId: currentBinding.administrativeClassId,
        screenBindingId: currentBinding.id, bindingRevision: currentBinding.npepBindingRevision, deviceName: pair.deviceName,
        credentialExpiresAt: new Date(Date.now() + 90 * DAY),
      }});
      await tx.npepPairing.update({where: {id}, data: {state: 'ACTIVATED', deviceId: created.id, confirmRequestId: body.requestId, confirmDigest: digest(body)}});
      await audit(tx, 'DEVICE_ACTIVATED', created.id, pair.schoolId, pair.approverId);
      pairValid(pair, config);
      return {created: true, data: registration(created)};
    }),
    cancel: (id, auth, claims, schoolId) => transaction(async (tx, config) => {
      if (claims) {
        await schoolLock(tx, schoolId);
        await administrator(tx, claims, schoolId);
        await tx.$queryRaw`SELECT id FROM "NpepPairing" WHERE id = ${id}::uuid FOR UPDATE`;
      }
      const pair = claims ? await tx.npepPairing.findUnique({where: {id}}) : await pairing(tx, id, auth, config);
      if (claims && (!pair || pair.schoolId !== schoolId || pair.approverId !== claims.accountId)) fail(404, 'NOT_FOUND');
      pairValid(pair, config);
      conflict(pair.state !== 'ACTIVATED', 'PAIRING_STATE_CONFLICT');
      if (pair.state !== 'CANCELLED') {
        await tx.npepPairing.update({where: {id}, data: {state: 'CANCELLED'}});
        await audit(tx, 'PAIRING_CANCELLED', id, pair.schoolId, claims?.accountId);
      }
      return {pairingId: id, state: 'CANCELLED'};
    }),
    me: auth => transaction(async (tx, config) => registration(await device(tx, auth, config))),
    session: (auth, body) => transaction(async (tx, config) => {
      assertInstance(body, config);
      const current = await device(tx, auth, config);
      const existing = await tx.npepSessionReceipt.findFirst({where: {deviceId: current.id, OR: [{requestId: body.requestId}, {runId: body.runId}]}});
      if (existing) {
        conflict(existing.digest === digest(body), 'IDEMPOTENCY_CONFLICT');
        conflict(existing.sessionId === current.sessionId, 'SESSION_SUPERSEDED');
        return {created: false, data: {sessionId: existing.sessionId, runId: existing.runId, statusEpoch: existing.statusEpoch, nextPollSeconds: 20}};
      }
      conflict(current.statusEpoch === body.expectedStatusEpoch, 'SESSION_SUPERSEDED');
      conflict(current.statusEpoch < Number.MAX_SAFE_INTEGER, 'REVISION_CONFLICT');
      if (await tx.npepSessionReceipt.count({where: {deviceId: current.id}}) >= 10000) throw new NpepError(429, 'RATE_LIMITED', 3600);
      const sessionId = randomUUID(), statusEpoch = current.statusEpoch + 1;
      await tx.npepSessionReceipt.create({data: {deviceId: current.id, requestId: body.requestId, runId: body.runId, sessionId, statusEpoch, digest: digest(body), expiresAt: current.credentialExpiresAt}});
      await tx.npepDevice.update({where: {id: current.id}, data: {sessionId, statusEpoch, lastSequence: 0, lastStatusDigest: null, lastSeenAt: null, status: jsonNull}});
      await audit(tx, 'SESSION_OPENED', current.id, current.schoolId);
      return {created: true, data: {sessionId, runId: body.runId, statusEpoch, nextPollSeconds: 20}};
    }),
    status: (auth, body) => transaction(async (tx, config) => {
      assertInstance(body, config);
      const current = await device(tx, auth, config);
      conflict(current.sessionId === body.sessionId && current.statusEpoch === body.statusEpoch, 'SESSION_SUPERSEDED');
      conflict(body.sequence >= current.lastSequence, 'STALE_SEQUENCE');
      const duplicate = body.sequence === current.lastSequence;
      if (duplicate) conflict(current.lastStatusDigest === digest(body), 'SEQUENCE_CONFLICT');
      const receivedAt = duplicate ? current.lastSeenAt : new Date();
      if (!duplicate) {
        const status = structuredClone(body.status);
        status.appVersion = displayText(status.appVersion, 64);
        for (const name of ['classIsland', 'examAware']) if (status[name].bridgeVersion) status[name].bridgeVersion = displayText(status[name].bridgeVersion, 64);
        await tx.npepDevice.update({where: {id: current.id}, data: {lastSequence: body.sequence, lastStatusDigest: digest(body), lastSeenAt: receivedAt, status}});
      }
      deviceValid(current, config);
      return {disposition: duplicate ? 'DUPLICATE' : 'APPLIED', acceptedSequence: body.sequence, receivedAt: receivedAt.toISOString(), nextPollSeconds: 20};
    }),
    revoke: (auth, claims, schoolId, id, body) => transaction(async (tx, config) => {
      let current;
      if (claims) {
        await schoolLock(tx, schoolId);
        await administrator(tx, claims, schoolId);
        const initial = await tx.npepDevice.findUnique({where: {id}});
        if (!initial || initial.schoolId !== schoolId) fail(404, 'NOT_FOUND');
        await tx.$queryRaw`SELECT id FROM "ClassroomScreenBinding" WHERE id = ${initial.screenBindingId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "NpepDevice" WHERE id = ${id}::uuid FOR UPDATE`;
        current = await tx.npepDevice.findUnique({where: {id}});
      } else current = await device(tx, auth, config);
      conflict(current.bindingRevision === body.expectedBindingRevision, 'REVISION_CONFLICT');
      if (current.state !== 'REVOKED') {
        await tx.npepDevice.update({where: {id: current.id}, data: {state: 'REVOKED', revokedAt: new Date(), sessionId: null}});
        await audit(tx, 'DEVICE_REVOKED', current.id, current.schoolId, claims?.accountId);
      }
      return {deviceId: current.id, state: 'REVOKED'};
    }),
    list: (claims, schoolId, {limit, cursor}) => transaction(async (tx, config) => {
      await schoolLock(tx, schoolId);
      await administrator(tx, claims, schoolId);
      const records = await tx.npepDevice.findMany({where: {schoolId, ...(cursor ? {id: {gt: cursor}} : {})}, orderBy: {id: 'asc'}, take: limit + 1});
      const items = records.slice(0, limit).map(row => {
        const {statusEpoch: unused, ...base} = registration(row);
        const state = row.state !== 'ACTIVE' ? row.state : row.deploymentEpoch !== config.deploymentEpoch || row.serverInstanceId !== config.serverInstanceId ? 'INVALIDATED' : expired(row.credentialExpiresAt) ? 'EXPIRED' : 'ACTIVE';
        return {...base, deviceName: row.deviceName, state,
          connectivity: !row.lastSeenAt ? 'UNKNOWN' : state === 'ACTIVE' && Date.now() - row.lastSeenAt.getTime() <= 60000 ? 'ONLINE' : 'OFFLINE',
          lastSeenAt: row.lastSeenAt?.toISOString() || null, status: row.status};
      });
      return {items, nextCursor: records.length > limit ? items.at(-1).deviceId : null};
    }),
  };
}
