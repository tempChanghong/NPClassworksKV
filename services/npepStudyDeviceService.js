import {randomUUID} from 'node:crypto';
import {digest, fail} from '../domain/npep/wire.js';
import {identityOf, requireSame} from '../domain/npep/runtimeControl.js';
import {resolveStudyPolicy, validateStudyPolicy, studyWindowsForDate, STUDY_LIMITS} from '../domain/npep/studySettings.js';
import {studySettingsRepository} from './npepStudySettingsRepository.js';
import {validateStudyDevice} from '../domain/npep/studyDevice.js';
import {readStudyHomework, homeworkChunk} from './npepStudyHomework.js';

export const studyDeviceRepository = {
  settings: studySettingsRepository.settings,
  async receipt(tx, id) {
    const rows = await tx.$queryRaw`SELECT data FROM "NpepStudyDevice" WHERE "deviceId"=${id}::uuid`;
    return rows[0]?.data ?? null;
  },
  async saveReceipt(tx, id, data) {
    await tx.$executeRaw`INSERT INTO "NpepStudyDevice" ("deviceId",data) VALUES (${id}::uuid,${JSON.stringify(data)}::jsonb)
      ON CONFLICT ("deviceId") DO UPDATE SET data=EXCLUDED.data`;
  },
  async scope(tx, device) {
    // withRuntimeDevice has locked and rechecked the exact current screen binding.
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${device.administrativeClassId} FOR SHARE`;
    const classroom = await tx.workspace.findUnique({where: {id: device.administrativeClassId}});
    if (!classroom?.isActive || classroom.type !== 'ADMIN_CLASS') fail(409, 'BINDING_CHANGED');
    const term = await tx.academicTerm.findUnique({where: {id: classroom.termId}});
    if (!term || term.schoolId !== device.schoolId || term.status !== 'ACTIVE') fail(409, 'BINDING_CHANGED');
    if (classroom.gradeId) {
      await tx.$queryRaw`SELECT id FROM "Grade" WHERE id=${classroom.gradeId} FOR SHARE`;
      const grade = await tx.grade.findUnique({where: {id: classroom.gradeId}});
      if (grade?.termId !== classroom.termId) fail(409, 'BINDING_CHANGED');
    }
    return {schoolId: device.schoolId, termId: classroom.termId,
      classId: classroom.id, gradeId: classroom.gradeId ?? null};
  },
};

// Configuration reads grant no execution. A separate, current-session exchange grants
// the established one-day monotonic capture lease; neither exchange grants camera permission.
export function createNpepStudyDeviceService(base, repo = studyDeviceRepository) {
  async function configuration(tx, device) {
    const scope = await repo.scope(tx, device);
    const rows = await repo.settings(tx, scope.schoolId, scope.termId);
    const grade = rows.find(row => row.targetType === 'GRADE' && row.targetId === scope.gradeId);
    const local = rows.find(row => row.targetType === 'CLASS' && row.targetId === scope.classId);
    if ((grade && validateStudyPolicy(grade.policy, true)) || (local && validateStudyPolicy(local.policy))) fail(503, 'INVALID_STUDY_POLICY');
    const effective = resolveStudyPolicy(grade?.policy, local?.policy);
    const identity = identityOf(device);
    const revisions = {grade: grade?.revision ?? 0, classroom: local?.revision ?? 0};
    const result = {identity, scope, revisions, effective,
      version: digest({identity, scope, revisions, effective, presentationRevision: 2}),
      executionState: 'NOT_VERIFIED', limits: STUDY_LIMITS,
      presentationTiming: {prepareSeconds: 120, preparationUntilStart: false, startNoticeSeconds: 5, endNoticeSeconds: 5,
        displayLeadSeconds: STUDY_LIMITS.displayLeadSeconds, preparationNoticeSeconds: 10, seatingDismissAfterStartSeconds: 120}};
    if (!validateStudyDevice('configuration', result)) fail(503, 'INVALID_STUDY_POLICY');
    return result;
  }
  function presentationWindowMatches(current, status) {
    const settings = current.effective.settings;
    if (!settings || !status.window || !status.schoolNow) return false;
    const carrier = new Date(`${status.schoolNow.slice(0, 10)}T00:00:00Z`);
    const spans = [-1, 0, 1].flatMap(offset => {
      const date = new Date(carrier); date.setUTCDate(date.getUTCDate() + offset);
      return studyWindowsForDate(settings, date.toISOString().slice(0, 10), status.mode ?? "Daily");
    }).map(window => ({start: Date.parse(`${window.start}Z`), end: Date.parse(`${window.end}Z`)})).sort((a, b) => a.start - b.start);
    const merged = [];
    for (const window of spans) {
      const previous = merged.at(-1);
      if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
      else merged.push({...window});
    }
    const start = Date.parse(`${status.window.start}Z`), end = Date.parse(`${status.window.end}Z`);
    const now = Date.parse(`${status.schoolNow}Z`);
    const inStage = status.phase === 'Preparing' ? now >= start - STUDY_LIMITS.displayLeadSeconds * 1000 && now < start
      : status.phase === 'Ended' ? now >= end && now < end + 5000 : now >= start && now < end;
    return inStage && merged.some(window => window.start === start && window.end === end && end - start <= 180 * 60000);
  }
  function captureWindowMatches(current, status, requireWindow = false) {
    if (!status.signalFresh && !requireWindow) return true;
    return current.effective.settings?.noise.enabled === true && presentationWindowMatches(current, {...status, phase: 'Active'});
  }
  async function currentContext(tx, device, context) {
    requireSame(context.identity, identityOf(device), 'AUTH_INVALID');
    const session = await tx.npepSessionReceipt.findUnique({where: {sessionId: context.sessionId}});
    if (!session || session.deviceId !== device.id || session.runId !== context.runId || session.statusEpoch !== context.statusEpoch
      || session.expiresAt <= new Date() || device.sessionId !== context.sessionId || device.statusEpoch !== context.statusEpoch) fail(409, 'SESSION_SUPERSEDED');
  }
  const recent = stamp => Number.isFinite(Date.parse(stamp)) && Date.now() - Date.parse(stamp) >= 0 && Date.now() - Date.parse(stamp) < 15000;
  const remainingMs = record => Math.max(0, Date.parse(record.expiresAt) - Date.now());
  function applied(receipt, current, context) {
    return receipt && recent(receipt.receivedAt) && digest(receipt.context) === digest(context)
      && receipt.status.version === current.version && receipt.status.policyState === 'APPLIED';
  }
  function cleanCommands(receipt, current, context) {
    receipt.commands ??= [];
    for (const record of receipt.commands) if (!record.receipt && (Date.parse(record.expiresAt) <= Date.now()
      || digest(record.context) !== digest(context) || record.command.version !== current.version))
      record.receipt = {commandId: record.command.commandId, outcome: 'UNKNOWN'};
    receipt.commands = receipt.commands.slice(-32);
  }
  function supportsResume(receipt, current) {
    return !!receipt?.resume && recent(receipt.resume.receivedAt) && receipt.resume.version === current.version
      && digest(receipt.resume.context) === digest(receipt.context);
  }
  function presentationView(receipt, current, fresh) {
    const p = receipt?.presentation, age = p ? Date.now() - Date.parse(p.receivedAt) : Infinity;
    const remaining = p ? Date.parse(p.expiresAt) - Date.now() : 0;
    const s = p?.status;
    const stageMatches = !['Visible', 'Hidden'].includes(s?.state) || (s.phase === 'Ended'
      ? receipt.status.phase === 'Outside' && receipt.status.schoolNow >= s.window.end
        && Date.parse(`${receipt.status.schoolNow}Z`) - Date.parse(`${s.window.end}Z`) < 5000
      : receipt.status.phase === s.phase && digest(receipt.status.window) === digest(s.window));
    const currentClaim = (s?.mode ?? "Daily") === (receipt?.status?.mode ?? "Daily") && fresh && receipt.status.version === current.version && p?.version === current.version
      && digest(p.context) === digest(receipt.context);
    const presentationFresh = !!currentClaim && stageMatches && age >= 0 && age < 5000 && remaining > 0 && remaining <= 5000;
    return {presentation: s ?? null, presentationVersion: p?.version ?? null,
      presentationReceivedAt: p?.receivedAt ?? null, presentationAgeMs: Number.isFinite(age) && age >= 0 ? age : null,
      presentationRemainingMs: presentationFresh ? Math.max(0, Math.floor(remaining)) : 0,
      presentationFresh, presentationVerified: presentationFresh && s.state === 'Visible'};
  }
  return {
    presentation: (auth, body, startedAt = performance.now()) => base.withRuntimeDevice(auth, async (tx, device) => {
      await currentContext(tx, device, body.context);
      const current = await configuration(tx, device);
      requireSame(body.version, current.version, 'POLICY_CHANGED');
      const receipt = await repo.receipt(tx, device.id);
      if (!applied(receipt, current, body.context)) fail(409, 'STUDY_NOT_APPLIED');
      if (['Visible', 'Hidden'].includes(body.status.state) && !presentationWindowMatches(current, body.status)) fail(409, 'STATE_CHANGED');
      const old = receipt.presentation, sameContext = old && digest(old.context) === digest(body.context);
      if (sameContext && body.sequence <= old.sequence) {
        if (body.sequence !== old.sequence || old.digest !== digest(body)) fail(409, 'SEQUENCE_CONFLICT');
        return {confirmed: false, version: current.version};
      }
      const receivedAt = new Date().toISOString();
      // Remove transaction/rate-limit waiting from the source's validity budget.
      let expiresAt = Date.now() + Math.max(0, body.status.remainingMs - Math.max(0, performance.now() - startedAt));
      const samePulse = sameContext && old.version === body.version && old.status.hostInstanceId === body.status.hostInstanceId
        && old.status.appInstanceId === body.status.appInstanceId && old.status.pulse === body.status.pulse;
      if (sameContext && old.version === body.version && body.status.appInstanceId !== null
        && old.status.hostInstanceId === body.status.hostInstanceId && old.status.appInstanceId === body.status.appInstanceId
        && (body.status.pulse < old.status.pulse || samePulse && ['Visible', 'Hidden'].includes(body.status.state) && body.status.state !== old.status.state))
        fail(409, 'SEQUENCE_CONFLICT');
      if (samePulse && ['Visible', 'Hidden'].includes(body.status.state)) expiresAt = Math.min(expiresAt, Date.parse(old.expiresAt));
      receipt.presentation = {context: body.context, sequence: body.sequence, digest: digest(body), version: body.version,
        status: body.status, receivedAt, expiresAt: new Date(expiresAt).toISOString()};
      await repo.saveReceipt(tx, device.id, receipt);
      return {confirmed: true, version: current.version};
    }),
    configurationForDevice: configuration,
    read: auth => base.withRuntimeDevice(auth, configuration),
    homework: (auth, body) => base.withRuntimeDevice(auth, async (tx, device) => {
      await currentContext(tx, device, body.context);
      const current = await configuration(tx, device);
      requireSame(body.version, current.version, 'POLICY_CHANGED');
      const receipt = await repo.receipt(tx, device.id);
      if (!applied(receipt, current, body.context) || !receipt.status.clockReady ||
          !['Preparing', 'Active'].includes(receipt.status.phase) || receipt.status.schoolNow?.slice(0, 10) !== body.date)
        fail(409, 'STUDY_NOT_APPLIED');
      return homeworkChunk(await readStudyHomework(tx, current, body.date), body.index, body.snapshotId);
    }),
    receipt: (auth, body) => base.withRuntimeDevice(auth, async (tx, device) => {
      requireSame(body.context.identity, identityOf(device), 'AUTH_INVALID');
      const session = await tx.npepSessionReceipt.findUnique({where: {sessionId: body.context.sessionId}});
      if (!session || session.deviceId !== device.id || session.runId !== body.context.runId || session.statusEpoch !== body.context.statusEpoch
        || session.expiresAt <= new Date() || device.sessionId !== body.context.sessionId || device.statusEpoch !== body.context.statusEpoch) fail(409, 'SESSION_SUPERSEDED');
      const current = await configuration(tx, device);
      requireSame(body.status.version, current.version, 'POLICY_CHANGED');
      const old = await repo.receipt(tx, device.id);
      if (old && digest(old.context) === digest(body.context) && body.sequence <= old.sequence) {
        if (body.sequence !== old.sequence || old.digest !== digest(body)) fail(409, 'SEQUENCE_CONFLICT');
        return {confirmed: false, version: current.version}; // Replay never renews observed freshness.
      }
      const state = {...old, execution: (old?.status?.mode ?? "Daily") === (body.status.mode ?? "Daily") ? old?.execution ?? null : null, context: body.context, sequence: body.sequence, digest: digest(body), status: body.status, receivedAt: new Date().toISOString()};
      await repo.saveReceipt(tx, device.id, state);
      return {confirmed: true, version: current.version};
    }),
    execution: (auth, body) => base.withRuntimeDevice(auth, async (tx, device) => {
      requireSame(body.context.identity, identityOf(device), 'AUTH_INVALID');
      const session = await tx.npepSessionReceipt.findUnique({where: {sessionId: body.context.sessionId}});
      if (!session || session.deviceId !== device.id || session.runId !== body.context.runId || session.statusEpoch !== body.context.statusEpoch
        || session.expiresAt <= new Date() || device.sessionId !== body.context.sessionId || device.statusEpoch !== body.context.statusEpoch) fail(409, 'SESSION_SUPERSEDED');
      const current = await configuration(tx, device);
      requireSame(body.version, current.version, 'POLICY_CHANGED');
      if (current.effective.source === 'None') fail(409, 'STUDY_NOT_CONFIGURED');
      if (!captureWindowMatches(current, body.status)) fail(409, 'STATE_CHANGED');
      const receipt = await repo.receipt(tx, device.id);
      if (!receipt || !Number.isFinite(Date.parse(receipt.receivedAt)) || digest(receipt.context) !== digest(body.context) || receipt.status.version !== current.version
        || Date.now() - Date.parse(receipt.receivedAt) < 0 || Date.now() - Date.parse(receipt.receivedAt) >= 15000) fail(409, 'STUDY_NOT_APPLIED');
      if ((receipt.status.mode ?? 'Daily') !== (body.status.mode ?? 'Daily')) fail(409, 'STATE_CHANGED');
      const old = receipt.execution;
      if (old && digest(old.context) === digest(body.context) && body.sequence <= old.sequence) {
        if (body.sequence !== old.sequence || old.digest !== digest(body)) fail(409, 'SEQUENCE_CONFLICT');
        return {confirmed: false, version: current.version, leaseSeconds: 86400, ...(body.status.mode === 'Exam' ? {mode: 'Exam'} : {})};
      }
      receipt.execution = {context: body.context, sequence: body.sequence, digest: digest(body), version: body.version,
        status: body.status, receivedAt: new Date().toISOString()};
      await repo.saveReceipt(tx, device.id, receipt);
      return {confirmed: true, version: current.version, leaseSeconds: 86400, ...(body.status.mode === 'Exam' ? {mode: 'Exam'} : {})};
    }),
    resume: (claims, schoolId, id, body) => base.withRuntimeAdmin(claims, schoolId, id, async (tx, device) => {
      const current = await configuration(tx, device), receipt = await repo.receipt(tx, device.id);
      if (!receipt) fail(409, 'STUDY_NOT_APPLIED');
      await currentContext(tx, device, receipt.context);
      cleanCommands(receipt, current, receipt.context);
      const old = receipt.commands.find(record => record.requestId === body.requestId);
      if (old) {
        requireSame(old.digest, digest(body), 'IDEMPOTENCY_CONFLICT');
        requireSame(old.context, receipt.context, 'SESSION_SUPERSEDED');
        return {...old, remainingMs: remainingMs(old)};
      }
      requireSame(body.version, current.version, 'POLICY_CHANGED');
      if (!applied(receipt, current, receipt.context) || !supportsResume(receipt, current)) fail(409, 'STUDY_RESUME_UNAVAILABLE');
      const execution = receipt.execution;
      if (!execution || !recent(execution.receivedAt) || execution.version !== current.version
        || digest(execution.context) !== digest(receipt.context)) fail(409, 'STATE_CHANGED');
      const status = execution.status;
      if (status.owner !== 'None' || !['Idle', 'Stopped', 'Faulted'].includes(status.state)
        || !['WINDOW_SKIPPED', 'WINDOW_FAILED'].includes(status.reason) || !status.clockReady
        || !captureWindowMatches(current, status, true)) fail(409, 'STATE_CHANGED');
      requireSame(body.window, status.window, 'STATE_CHANGED');
      if (receipt.commands.some(record => !record.receipt)) fail(409, 'COMMAND_PENDING');
      const record = {requestId: body.requestId, actorId: claims.accountId, digest: digest(body), context: receipt.context,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        command: {commandId: randomUUID(), version: body.version, window: body.window, ...(status.mode === "Exam" ? {mode: "Exam"} : {})}, receipt: null};
      receipt.commands.push(record); receipt.commands = receipt.commands.slice(-32);
      await repo.saveReceipt(tx, device.id, receipt);
      return {...record, remainingMs: remainingMs(record)}; // Request acceptance is not device application or capture.
    }),
    resumeExchange: (auth, body) => base.withRuntimeDevice(auth, async (tx, device) => {
      await currentContext(tx, device, body.context);
      const current = await configuration(tx, device);
      requireSame(body.version, current.version, 'POLICY_CHANGED');
      const receipt = await repo.receipt(tx, device.id);
      if (!applied(receipt, current, body.context)) fail(409, 'STUDY_NOT_APPLIED');
      const old = receipt.resume;
      if (old && digest(old.context) === digest(body.context) && body.sequence <= old.sequence) {
        if (body.sequence !== old.sequence || old.digest !== digest(body)) fail(409, 'SEQUENCE_CONFLICT');
        return {confirmed: false, version: current.version, command: null};
      }
      cleanCommands(receipt, current, body.context);
      const record = receipt.commands.find(record => record.command.commandId === body.receipt?.commandId
        && digest(record.context) === digest(body.context));
      if (record) {
        if (record.receipt && record.receipt.outcome !== 'UNKNOWN') requireSame(record.receipt, body.receipt, 'IDEMPOTENCY_CONFLICT');
        record.receipt = body.receipt;
      }
      receipt.resume = {context: body.context, sequence: body.sequence, digest: digest(body), version: body.version, receivedAt: new Date().toISOString()};
      await repo.saveReceipt(tx, device.id, receipt);
      return {confirmed: true, version: current.version, command: receipt.commands.find(record => !record.receipt)?.command ?? null};
    }),
    management: (claims, schoolId, id) => base.withRuntimeAdmin(claims, schoolId, id, async (tx, device) => {
      const current = await configuration(tx, device), receipt = await repo.receipt(tx, device.id);
      const age = receipt ? Date.now() - Date.parse(receipt.receivedAt) : Infinity;
      const session = receipt ? await tx.npepSessionReceipt.findUnique({where: {sessionId: receipt.context.sessionId}}) : null;
      const fresh = age >= 0 && age < 15000 && receipt.context.sessionId === device.sessionId && receipt.context.statusEpoch === device.statusEpoch
        && digest(receipt.context.identity) === digest(identityOf(device)) && session?.deviceId === device.id
        && session.runId === receipt.context.runId && session.statusEpoch === device.statusEpoch && session.expiresAt > new Date();
      const execution = receipt?.execution;
      const executionAge = execution ? Date.now() - Date.parse(execution.receivedAt) : Infinity;
      const executionFresh = fresh && executionAge >= 0 && executionAge < 15000
        && digest(execution.context) === digest(receipt.context) && execution.version === current.version
        && (execution.status.mode ?? "Daily") === (receipt.status.mode ?? "Daily");
      const captureVerified = executionFresh && current.effective.settings?.noise.enabled === true
        && execution.status.owner === 'Schedule' && execution.status.state === 'Active' && execution.status.signalFresh === true
        && execution.status.reason === 'WINDOW_ACTIVE';
      return {execution: execution?.status ?? null, executionReceivedAt: execution?.receivedAt ?? null, executionFresh,
        executionAgeMs: Number.isFinite(executionAge) && executionAge >= 0 ? executionAge : null,
        executionVersion: execution?.version ?? null, current, observation: receipt?.status ?? null, receivedAt: receipt?.receivedAt ?? null,
        observationAgeMs: Number.isFinite(age) && age >= 0 ? age : null, fresh,
        configurationApplied: fresh && receipt.status.version === current.version && receipt.status.policyState === 'APPLIED',
        ...presentationView(receipt, current, fresh), captureVerified,
        resumeSupported: fresh && receipt.status.version === current.version && supportsResume(receipt, current),
        resumeAgeMs: receipt?.resume && recent(receipt.resume.receivedAt) ? Date.now() - Date.parse(receipt.resume.receivedAt) : null,
        resumeCommands: receipt?.commands?.slice(-5).map(record => {
          const invalid = Date.parse(record.expiresAt) <= Date.now() || record.command.version !== current.version
            || digest(record.context) !== digest(receipt.context);
          return {requestId: record.requestId, command: record.command, expiresAt: record.expiresAt, remainingMs: remainingMs(record),
            receipt: record.receipt ?? (invalid ? {commandId: record.command.commandId, outcome: 'UNKNOWN'} : null)};
        }) ?? []};
    }),
  };
}
