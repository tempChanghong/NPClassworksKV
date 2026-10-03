import {randomUUID, randomInt} from 'node:crypto';
import {assertInstance} from '../domain/npep/deployment.js';
import {fail, hash, digest, secretHash, displayText, capabilities} from '../domain/npep/wire.js';
import {createPairingBatch} from './npepPairingBatch.js';

export function assertScreenAdmission(binding, candidate = null) {
  if (!binding.npepPairingEnabled) fail(403, 'SCREEN_PAIRING_DISABLED');
  if (candidate && (candidate.preauthorizationRevision !== binding.npepPairingRevision ||
      candidate.screenCredentialVersion !== binding.credentialVersion)) fail(409, 'PREAUTHORIZATION_CHANGED');
}

export function createScreenPairing({transaction, schoolLock, administrator, binding, available, audit, pairValid}) {
  const conflict = (ok, code) => { if (!ok) fail(409, code); };
  async function screen(tx, token) {
    if (!token || token.length > 512) fail(401, 'SCREEN_TOKEN_INVALID');
    const initial = await tx.classroomScreenBinding.findUnique({where: {tokenHash: hash(token)}});
    if (!initial) fail(401, 'SCREEN_TOKEN_INVALID');
    await schoolLock(tx, initial.schoolId);
    const current = await binding(tx, initial.id, initial.schoolId);
    if (current.tokenHash !== hash(token) || current.credentialVersion !== initial.credentialVersion) fail(401, 'SCREEN_TOKEN_INVALID');
    return current;
  }
  const ticketData = ticket => ({userCode: ticket.userCode, expiresAt: ticket.expiresAt.toISOString(), state: ticket.state});
  const randomCode = () => Array.from({length: 8}, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('');
  const createdPair = pair => ({pairingId: pair.id, userCode: pair.userCode, state: 'PENDING', expiresAt: pair.expiresAt.toISOString(), pollAfterSeconds: 5});
  return {
    ...createPairingBatch({transaction, schoolLock, administrator, audit}),
    pairingAccess: (claims, schoolId) => transaction(async tx => {
      await schoolLock(tx, schoolId); await administrator(tx, claims, schoolId);
      const items = await tx.classroomScreenBinding.findMany({where: {schoolId}, select: {id: true, npepPairingEnabled: true, npepPairingRevision: true}});
      return {items: items.map(b => ({screenBindingId: b.id, enabled: b.npepPairingEnabled, revision: b.npepPairingRevision}))};
    }),
    setPairingAccess: (claims, schoolId, bindingId, body) => transaction(async tx => {
      await schoolLock(tx, schoolId); await administrator(tx, claims, schoolId);
      const current = await binding(tx, bindingId, schoolId);
      conflict(current.npepPairingRevision === body.expectedRevision, 'REVISION_CONFLICT');
      conflict(current.npepPairingRevision < Number.MAX_SAFE_INTEGER, 'REVISION_CONFLICT');
      const changed = await tx.classroomScreenBinding.update({where: {id: current.id}, data: {npepPairingEnabled: body.enabled, npepPairingRevision: {increment: 1}}});
      // Any policy change invalidates previously issued or claimed-but-unconfirmed codes.
      await tx.npepScreenPairingTicket.updateMany({where: {screenBindingId: current.id, state: 'READY'}, data: {state: 'CANCELLED'}});
      await audit(tx, body.enabled ? 'SCREEN_PAIRING_ENABLED' : 'SCREEN_PAIRING_DISABLED', current.id, schoolId, claims.accountId);
      return {screenBindingId: current.id, enabled: changed.npepPairingEnabled, revision: changed.npepPairingRevision};
    }),
    screenPairingStatus: token => transaction(async tx => {
      const current = await screen(tx, token);
      const linked = await tx.npepDevice.findFirst({where: {screenBindingId: current.id, state: 'ACTIVE', credentialExpiresAt: {gt: new Date()}}});
      return {enabled: current.npepPairingEnabled, occupied: !!linked, screenBindingId: current.id,
        schoolName: displayText(current.school.name), administrativeClassName: displayText(current.administrativeClass.name), screenBindingName: displayText(current.name)};
    }),
    issueScreenPairing: (token, body) => transaction(async (tx, config) => {
      const current = await screen(tx, token); assertScreenAdmission(current); await available(tx, current.id);
      const previous = await tx.npepScreenPairingTicket.findUnique({where: {screenBindingId_requestId: {screenBindingId: current.id, requestId: body.requestId}}});
      if (previous) {
        assertInstance(previous, config);
        conflict(previous.state === 'READY' && previous.expiresAt > new Date(), 'PAIRING_CODE_UNAVAILABLE');
        conflict(previous.authorizationRevision === current.npepPairingRevision && previous.credentialVersion === current.credentialVersion && previous.bindingRevision === current.npepBindingRevision, 'PREAUTHORIZATION_CHANGED');
        return {created: false, data: ticketData(previous)};
      }
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(781001)::text`;
      let userCode;
      do { userCode = randomCode(); } while (await tx.npepScreenPairingTicket.findUnique({where: {userCode}}));
      await tx.npepScreenPairingTicket.updateMany({where: {screenBindingId: current.id, state: 'READY'}, data: {state: 'CANCELLED'}});
      const ticket = await tx.npepScreenPairingTicket.create({data: {id: randomUUID(), requestId: body.requestId, userCode,
        schoolId: current.schoolId, screenBindingId: current.id, bindingRevision: current.npepBindingRevision,
        authorizationRevision: current.npepPairingRevision, credentialVersion: current.credentialVersion, ...config,
        expiresAt: new Date(Date.now() + 600000)}});
      await audit(tx, 'SCREEN_PAIRING_CODE_CREATED', ticket.id, current.schoolId);
      return {created: true, data: ticketData(ticket)};
    }),
    claimScreenPairing: body => transaction(async (tx, config) => {
      assertInstance(body, config);
      const initial = await tx.npepScreenPairingTicket.findUnique({where: {userCode: body.userCode}});
      if (!initial) fail(404, 'PAIRING_CODE_UNAVAILABLE');
      await schoolLock(tx, initial.schoolId);
      const current = await binding(tx, initial.screenBindingId, initial.schoolId, initial.bindingRevision);
      assertScreenAdmission(current, {preauthorizationRevision: initial.authorizationRevision, screenCredentialVersion: initial.credentialVersion});
      assertInstance(initial, config);
      await tx.$queryRaw`SELECT id FROM "NpepScreenPairingTicket" WHERE id = ${initial.id}::uuid FOR UPDATE`;
      const ticket = await tx.npepScreenPairingTicket.findUnique({where: {id: initial.id}});
      const previous = await tx.npepPairing.findUnique({where: {installationId_requestId: {installationId: body.installationId, requestId: body.requestId}}});
      if (previous) {
        conflict(previous.approvalSource === 'SCREEN' && previous.id === ticket.claimedPairingId && previous.createDigest === digest(body), 'IDEMPOTENCY_CONFLICT');
        pairValid(previous, config);
        conflict(['APPROVED', 'ACTIVATED'].includes(previous.state), 'PAIRING_STATE_CONFLICT');
        return {created: false, data: createdPair(previous)};
      }
      if (ticket.state !== 'READY' || ticket.expiresAt <= new Date()) fail(410, 'PAIRING_CODE_UNAVAILABLE');
      await available(tx, current.id);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(781001)::text`;
      let userCode;
      do { userCode = randomCode(); } while (await tx.npepPairing.findUnique({where: {userCode}}));
      const pair = await tx.npepPairing.create({data: {id: randomUUID(), userCode, ...config, state: 'APPROVED', approvalSource: 'SCREEN',
        installationId: body.installationId, requestId: body.requestId, createDigest: digest(body), secretHash: secretHash(body.pairingSecret),
        deviceName: displayText(body.deviceName, 64), appVersion: displayText(body.appVersion, 64), expiresAt: ticket.expiresAt,
        schoolId: current.schoolId, screenBindingId: current.id, approvalId: randomUUID(),
        preauthorizationRevision: current.npepPairingRevision, screenCredentialVersion: current.credentialVersion,
        approvalSnapshot: {schoolId: current.schoolId, schoolName: displayText(current.school.name), administrativeClassId: current.administrativeClassId,
          administrativeClassName: displayText(current.administrativeClass.name), screenBindingId: current.id,
          screenBindingName: displayText(current.name), bindingRevision: current.npepBindingRevision, capabilities}}});
      await tx.npepScreenPairingTicket.update({where: {id: ticket.id}, data: {state: 'CLAIMED', claimedPairingId: pair.id}});
      await audit(tx, 'SCREEN_PAIRING_CODE_CLAIMED', pair.id, current.schoolId);
      return {created: true, data: createdPair(pair)};
    }),
  };
}
