import express from 'express';
import {prisma} from '../../utils/prisma.js';
import {verifyAccessToken} from '../../utils/tokenManager.js';
import {createNpepService} from '../../services/npepService.js';
import {readDeployment} from '../../domain/npep/deployment.js';
import {NpepError, UUID, OPAQUE_ID, validate, parseStrictJson, bearer, envelope, fail, hash as hashScreenToken} from '../../domain/npep/wire.js';
import {createNpepNotificationService, notificationCursor} from '../../services/npepNotificationService.js';
import {validateNotification} from '../../domain/npep/notifications.js';
import {validateRuntime} from '../../domain/npep/runtimeControl.js';
import {createNpepRuntimeService} from '../../services/npepRuntimeService.js';
import {createNpepExamPlanService} from '../../services/npepExamPlanService.js';
import {validateExamPlan} from '../../domain/npep/examPlans.js';
import {validateNoise} from '../../domain/npep/noise.js';
import {createNpepNoiseService} from '../../services/npepNoiseService.js';
import {createNpepNoiseScheduleService} from '../../services/npepNoiseScheduleService.js';
import {validateScheduleQuery, validateScheduleWrite} from '../../domain/npep/noiseSchedules.js';
import {createNpepNoiseScheduleRuntime} from '../../services/npepNoiseScheduleRuntime.js';
import {validateNoiseScheduleWire} from '../../domain/npep/noiseScheduleWire.js';
import {validateDisplayReturn, validateDisplaySetting} from '../../domain/npep/noiseDisplay.js';
import {createNpepNoiseDisplayService} from '../../services/npepNoiseDisplayService.js';
import {validateNoiseManagement} from '../../domain/npep/noiseManagement.js';
import {createNpepNoiseManagementService} from '../../services/npepNoiseManagementService.js';
import {authenticateClassroomScreen} from '../../services/classroomScreenService.js';

export function createNpepRouter({client = prisma, deployment = readDeployment, authenticate = verifyAccessToken, rateLimits = true} = {}) {
  const router = express.Router();
  const service = createNpepService(client, deployment);
  const notifications = createNpepNotificationService(service);
  const runtime = createNpepRuntimeService(service);
  const plans = createNpepExamPlanService(service);
  const noise = createNpepNoiseService(service);
  const schedules = createNpepNoiseScheduleService(service);
  const scheduleRuntime = createNpepNoiseScheduleRuntime(service);
  const noiseDisplay = createNpepNoiseDisplayService(service);
  const noiseManagement = createNpepNoiseManagementService(service, noise);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Early protocol/parser errors must still correlate with the caller's request.
    const headerId = req.get('X-Request-Id');
    if (UUID.test(headerId || '')) req.npepRequestId = headerId;
    try {
      req.npepVersion = /^\/(?:device\/runtime-(?:control-policy|status|operations(?:\/[^/]+\/(?:start|resolve))?|operation-events)|schools\/[^/]+\/devices\/[^/]+\/runtime-(?:status|operations(?:\/[^/]+\/cancel)?))\/?$/i.test(req.path) ? '0.4'
        : /^\/device\/(notifications|notification-receipts)\/?$/i.test(req.path) ? '0.2' : '0.1';
      if (/^\/(?:device\/exam-plan(?:-status|s(?:\/[^/]+\/(?:grant|result))?)|schools\/[^/]+\/devices\/[^/]+\/exam-plans(?:\/[^/]+\/(?:start|cancel))?)\/?$/i.test(req.path)) req.npepVersion='0.5';
      if (/^\/(?:device\/noise-exchange|screen\/noise(?:\/commands)?|schools\/[^/]+\/devices\/[^/]+\/noise)\/?$/i.test(req.path)) req.npepVersion = '0.6';
      if (/^\/schools\/[^/]+\/noise-schedules(?:\/preview)?\/?$/i.test(req.path)) req.npepVersion = '0.7';
      if (/^\/(?:device\/noise-schedule|screen\/noise-schedule(?:\/resume)?|schools\/[^/]+\/devices\/[^/]+\/noise-schedule)\/?$/i.test(req.path)) req.npepVersion = '0.7';
      if (/^\/(?:screen\/noise-display(?:\/return)?|schools\/[^/]+\/noise-display-settings|device\/noise-management\/(?:status|authorize)|screen\/noise-management\/commands)\/?$/i.test(req.path)) req.npepVersion = '0.8';
      if (req.get('X-NPEP-Version') !== req.npepVersion) fail(426, 'PROTOCOL_UNSUPPORTED');
      if (req.method === 'POST' && !req.is('application/json')) fail(400, 'INVALID_REQUEST');
      next();
    } catch (error) { next(error); }
  });
  router.use((req, res, next) => express.raw({type: 'application/json', limit: req.npepVersion !== '0.1' ? 65536 : 16384, inflate: false})(req, res, next));
  router.use((req, _res, next) => {
    try {
      if (req.method === 'POST') req.body = parseStrictJson(req.body);
      const bodyId = req.body?.requestId, headerId = req.get('X-Request-Id');
      req.npepRequestId = req.method === 'GET' ? headerId : bodyId;
      if (!UUID.test(req.npepRequestId || '') || (headerId && headerId !== req.npepRequestId)) fail(400, 'INVALID_REQUEST');
      // POST callers may carry their request ID only in the parsed JSON body.
      // Unpaired classroom screens must retain browser monitoring even when NPEP is disabled.
      if (!(req.method === 'GET' && req.path === '/screen/noise')) deployment();
      next();
    } catch (error) { next(error); }
  });
  const rate = async (...args) => { if (rateLimits) await service.rate(...args); };
  const deviceRate = async (auth, scope, limit, seconds) => {
    await service.preflightDevice(auth);
    await rate(scope, auth.id, limit, seconds);
  };
  const body = name => (req, _res, next) => {
    if (validate(name, req.body)) return next();
    const caps = req.body?.requestedCapabilities || req.body?.capabilities;
    next(new NpepError(caps && Array.isArray(caps) && caps.some(cap => cap !== 'device.status') ? 403 : 400,
      caps && Array.isArray(caps) && caps.some(cap => cap !== 'device.status') ? 'CAPABILITY_DENIED' : 'INVALID_REQUEST'));
  };
  router.param('id', (req, _res, next, id) => next(UUID.test(id) ? undefined : new NpepError(400, 'INVALID_REQUEST')));
  router.param('operationId', (req, _res, next, id) => next(UUID.test(id) ? undefined : new NpepError(400, 'INVALID_REQUEST')));
  router.param('schoolId', (req, _res, next, id) => next(OPAQUE_ID.test(id) ? undefined : new NpepError(400, 'INVALID_REQUEST')));
  const admin = async (req, _res, next) => {
    try {
      const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.get('Authorization') || '')?.[1];
      if (!token) fail(401, 'AUTH_INVALID');
      try { req.npepClaims = authenticate(token); } catch { fail(401, 'AUTH_INVALID'); }
      if (!req.npepClaims.sessionId || !req.npepClaims.accountId) fail(401, 'AUTH_INVALID');
      if (req.method === 'POST') await rate('management', req.npepClaims.sessionId, 30, 60);
      next();
    } catch (error) { next(error); }
  };
  const deviceAuth = req => bearer(req.get('Authorization'), 'npep1');
  const pairAuth = req => bearer(req.get('Authorization'), 'npepp1');
  const send = operation => async (req, res, next) => {
    try {
      const result = await operation(req);
      const wrapped = Object.hasOwn(result, 'created');
      res.status(wrapped && result.created ? 201 : 200).json({...envelope(req.npepRequestId, wrapped ? result.data : result), protocolVersion: req.npepVersion});
    } catch (error) { next(error); }
  };
  router.get('/info', send(() => service.info()));
  const runtimeBody = name => (req, _res, next) => next(validateRuntime(name, req.body) ? undefined : new NpepError(400, 'INVALID_REQUEST'));
  const noQuery = (req, _res, next) => next(Object.keys(req.query).length ? new NpepError(400, 'INVALID_REQUEST') : undefined);
  const noiseBody = name => (req, _res, next) => next(validateNoise(name, req.body) ? undefined : new NpepError(400, 'INVALID_REQUEST'));
  const screenToken = req => req.get('X-Classworks-Screen-Token') || '';
  router.get('/screen/pairing', noQuery, send(req => service.screenPairingStatus(screenToken(req))));
  router.post('/screen/pairing', noQuery, body('issueScreenPairing'), send(async req => {
    const token = screenToken(req);
    // Validate the screen before charging its bucket; no token is ever logged.
    await service.screenPairingStatus(token);
    await rate('screen-pairing', hashScreenToken(token), 10, 60);
    return service.issueScreenPairing(token, req.body);
  }));
  router.post('/pairings/claim', noQuery, body('claimScreenPairing'), send(async req => {
    await rate('screen-claim-ip', req.ip, 20, 60);
    await rate('screen-claim-global', 'all', 300, 60);
    return service.claimScreenPairing(req.body);
  }));
  router.get('/schools/:schoolId/pairing-access', admin, noQuery, send(req => service.pairingAccess(req.npepClaims, req.params.schoolId)));
  router.post('/schools/:schoolId/pairing-access/preview', admin, noQuery, body('previewPairingAccessBatch'),
    send(req => service.previewPairingAccessBatch(req.npepClaims, req.params.schoolId, req.body)));
  router.post('/schools/:schoolId/pairing-access/batch', admin, noQuery, body('setPairingAccessBatch'),
    send(req => service.setPairingAccessBatch(req.npepClaims, req.params.schoolId, req.body)));
  router.post('/schools/:schoolId/screen-bindings/:bindingId/pairing-access', admin, noQuery, body('setScreenPairingAccess'), send(req => {
    if (!OPAQUE_ID.test(req.params.bindingId)) fail(400, 'INVALID_REQUEST');
    return service.setPairingAccess(req.npepClaims, req.params.schoolId, req.params.bindingId, req.body);
  }));
  const scheduleWire = name => (req,_res,next) => next(validateNoiseScheduleWire(name,req.body)?undefined:new NpepError(400,'INVALID_REQUEST'));
  router.get('/screen/noise-schedule',noQuery,send(req=>scheduleRuntime.screen(screenToken(req))));
  router.get('/screen/noise-display', noQuery, send(req => noiseDisplay.screen(screenToken(req))));
  router.post('/screen/noise-display/return', noQuery,
    (req, _res, next) => next(validateDisplayReturn(req.body) ? undefined : new NpepError(400, 'INVALID_REQUEST')),
    send(req => noiseDisplay.startReturn(screenToken(req), req.body)));
  router.get('/schools/:schoolId/noise-display-settings', admin,
    (req, _res, next) => next(Object.keys(req.query).every(key => key === 'termId')
      && (!req.query.termId || OPAQUE_ID.test(req.query.termId)) ? undefined : new NpepError(400, 'INVALID_REQUEST')),
    send(req => noiseDisplay.listSettings(req.npepClaims, req.params.schoolId, req.query.termId)));
  router.post('/schools/:schoolId/noise-display-settings', admin, noQuery,
    (req, _res, next) => next(validateDisplaySetting(req.body) ? undefined : new NpepError(400, 'INVALID_REQUEST')),
    send(req => noiseDisplay.saveSetting(req.npepClaims, req.params.schoolId, req.body)));
  router.post('/screen/noise-schedule/resume',noQuery,scheduleWire('resumeRequest'),send(req=>scheduleRuntime.resume(screenToken(req),req.body)));
  router.get('/schools/:schoolId/devices/:id/noise-schedule',admin,noQuery,send(req=>scheduleRuntime.management(req.npepClaims,req.params.schoolId,req.params.id)));
  router.post('/device/noise-schedule',noQuery,scheduleWire('exchangeRequest'),send(async req=>{
    const auth=deviceAuth(req); await deviceRate(auth,'noise-schedule',40,60); await service.me(auth);
    return scheduleRuntime.exchange(auth,req.body);
  }));
  router.get('/schools/:schoolId/noise-schedules', admin, (req, _res, next) => next(validateScheduleQuery(req.query) ? undefined : new NpepError(400, 'INVALID_REQUEST')),
    send(req => schedules.list(req.npepClaims, req.params.schoolId, req.query.termId)));
  const scheduleBody = (req, _res, next) => next(validateScheduleWrite(req.body) ? undefined : new NpepError(400, 'INVALID_REQUEST'));
  router.post('/schools/:schoolId/noise-schedules/preview', admin, noQuery, scheduleBody, send(req => schedules.preview(req.npepClaims, req.params.schoolId, req.body)));
  router.post('/schools/:schoolId/noise-schedules', admin, noQuery, scheduleBody, send(req => schedules.save(req.npepClaims, req.params.schoolId, req.body)));
  router.get('/screen/noise', noQuery, send(req => noise.screen(screenToken(req))));
  router.post('/screen/noise/commands', noiseBody('createRequest'), send(req => noise.create(screenToken(req), req.body)));
  const managementBody = name => (req, _res, next) => next(validateNoiseManagement(name, req.body)
    ? undefined : new NpepError(400, 'INVALID_REQUEST'));
  router.post('/screen/noise-management/commands', managementBody('screenStop'), send(async req => {
    const token = screenToken(req);
    let binding;
    try { binding = await authenticateClassroomScreen(token); }
    catch { fail(401, 'SCREEN_TOKEN_INVALID'); }
    await rate('screen-noise-management', binding.id, 10, 60);
    return noiseManagement.screenStop(token, req.body);
  }));
  router.post('/device/noise-management/status', managementBody('status'), send(async req => {
    const auth = deviceAuth(req);
    await deviceRate(auth, 'noise-management-status', 40, 60);
    return noiseManagement.status(auth, req.body);
  }));
  router.post('/device/noise-management/authorize', managementBody('authorize'), send(async req => {
    const auth = deviceAuth(req);
    await deviceRate(auth, 'noise-management-authorize', 40, 60);
    return noiseManagement.authorize(auth, req.body);
  }));
  router.get('/schools/:schoolId/devices/:id/noise', admin, noQuery, send(req => noise.management(req.npepClaims, req.params.schoolId, req.params.id)));
  router.post('/device/noise-exchange', noiseBody('exchangeRequest'), send(async req => {
    const auth = deviceAuth(req);
    await deviceRate(auth, 'noise-exchange', 40, 60); await service.me(auth);
    return noise.exchange(auth, req.body);
  }));
  const runtimeSend = work => send(async req => {
    const auth = deviceAuth(req);
    await deviceRate(auth, 'runtime-device', 60, 60);
    await service.me(auth);
    return work(req, auth);
  });
  router.post('/device/runtime-control-policy', runtimeBody('policyRequest'), runtimeSend((req, auth) => runtime.policy(auth, req.body)));
  const planBody = name => (req,_res,next) => next(validateExamPlan(name,req.body)?undefined:new NpepError(400,'INVALID_REQUEST'));
  router.post('/device/exam-plan-status', planBody('reportRequest'), runtimeSend((req,auth)=>plans.report(auth,req.body)));
  router.get('/device/exam-plans', noQuery, runtimeSend((_req,auth)=>plans.poll(auth)));
  router.post('/device/exam-plans/:operationId/grant', planBody('deviceRequest'), runtimeSend((req,auth)=>plans.grant(auth,req.params.operationId,req.body)));
  router.post('/device/exam-plans/:operationId/result', planBody('resultRequest'), runtimeSend((req,auth)=>plans.result(auth,req.params.operationId,req.body)));
  router.get('/schools/:schoolId/devices/:id/exam-plans', admin, noQuery, send(req=>plans.management(req.npepClaims,req.params.schoolId,req.params.id)));
  router.post('/schools/:schoolId/devices/:id/exam-plans', admin, planBody('createRequest'), send(req=>plans.create(req.npepClaims,req.params.schoolId,req.params.id,req.body)));
  router.post('/schools/:schoolId/devices/:id/exam-plans/:operationId/start', admin, planBody('startRequest'), send(req=>plans.start(req.npepClaims,req.params.schoolId,req.params.id,req.params.operationId,req.body)));
  router.post('/schools/:schoolId/devices/:id/exam-plans/:operationId/cancel', admin, planBody('cancelRequest'), send(req=>plans.cancel(req.npepClaims,req.params.schoolId,req.params.id,req.params.operationId)));
  router.post('/device/runtime-status', runtimeBody('statusRequest'), runtimeSend((req, auth) => runtime.status(auth, req.body)));
  router.get('/device/runtime-operations', noQuery, runtimeSend((_req, auth) => runtime.poll(auth)));
  router.post('/device/runtime-operations/:operationId/start', runtimeBody('startRequest'), runtimeSend((req, auth) => runtime.start(auth, req.params.operationId, req.body)));
  router.post('/device/runtime-operation-events', runtimeBody('eventsRequest'), runtimeSend((req, auth) => runtime.events(auth, req.body)));
  router.post('/device/runtime-operations/:operationId/resolve', runtimeBody('resolveRequest'), runtimeSend((req, auth) => runtime.resolve(auth, req.params.operationId, req.body)));
  router.get('/schools/:schoolId/devices/:id/runtime-status', admin, noQuery, send(req => runtime.managementStatus(req.npepClaims, req.params.schoolId, req.params.id)));
  router.get('/schools/:schoolId/devices/:id/runtime-operations', admin, noQuery, send(req => runtime.list(req.npepClaims, req.params.schoolId, req.params.id)));
  router.post('/schools/:schoolId/devices/:id/runtime-operations', admin, runtimeBody('createRequest'), send(req => runtime.create(req.npepClaims, req.params.schoolId, req.params.id, req.body)));
  router.post('/schools/:schoolId/devices/:id/runtime-operations/:operationId/cancel', admin, runtimeBody('cancelRequest'), send(req => runtime.cancel(req.npepClaims, req.params.schoolId, req.params.id, req.params.operationId)));
  router.post('/pairings', body('createPairing'), send(async req => {
    // Express only honors forwarded addresses according to configured trust proxy.
    await rate('create-minute', req.ip, 5, 60);
    await rate('create-hour', req.ip, 30, 3600);
    return service.create(req.body);
  }));
  router.get('/pairings/:id', send(async req => {
    const auth = pairAuth(req);
    // Rate-limit authenticated queries only; random callers cannot lock a known id.
    const result = await service.poll(req.params.id, auth);
    if (rateLimits) await service.pollRate(auth.id);
    return result;
  }));
  router.post('/pairings/:id/confirm', body('confirmPairing'), send(req => service.confirm(req.params.id, pairAuth(req), req.body)));
  router.post('/pairings/:id/cancel', body('cancelPairing'), send(req => service.cancel(req.params.id, pairAuth(req))));
  router.post('/schools/:schoolId/pairings/resolve', admin, body('resolvePairing'), send(async req => {
    await rate('resolve-minute', req.npepClaims.accountId, 10, 60);
    await rate('resolve-hour', req.npepClaims.accountId, 100, 3600);
    await rate('resolve-global', 'global', 1000, 60);
    return service.resolve(req.npepClaims, req.params.schoolId, req.body);
  }));
  router.post('/schools/:schoolId/pairings/:id/approve', admin, body('approvePairing'), send(req => service.approve(req.npepClaims, req.params.schoolId, req.params.id, req.body)));
  router.post('/schools/:schoolId/pairings/:id/cancel', admin, body('cancelPairing'), send(req => service.cancel(req.params.id, null, req.npepClaims, req.params.schoolId)));
  router.get('/schools/:schoolId/devices', admin, send(req => {
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (Object.keys(req.query).some(key => !['limit', 'cursor'].includes(key)) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (req.query.cursor !== undefined && !UUID.test(req.query.cursor))) fail(400, 'INVALID_REQUEST');
    return service.list(req.npepClaims, req.params.schoolId, {limit, cursor: req.query.cursor});
  }));
  router.post('/schools/:schoolId/devices/:id/revoke', admin, body('revokeDevice'), send(req => service.revoke(null, req.npepClaims, req.params.schoolId, req.params.id, req.body)));
  router.get('/device/me', send(async req => {
    const auth = deviceAuth(req);
    await deviceRate(auth, 'device-me', 60, 60);
    return service.me(auth);
  }));
  router.get('/device/notifications', send(async req => {
    const auth = deviceAuth(req);
    if (Object.keys(req.query).some(key => key !== 'cursor') ||
        (req.query.cursor !== undefined && (typeof req.query.cursor !== 'string' || !notificationCursor.test(req.query.cursor)))) fail(400, 'INVALID_REQUEST');
    await deviceRate(auth, req.query.cursor ? 'notification-pages' : 'notifications', req.query.cursor ? 180 : 12, 60);
    await service.me(auth);
    return notifications.snapshot(auth, req.query.cursor);
  }));
  router.post('/device/notification-receipts', send(async req => {
    if (!validateNotification('receiptRequest', req.body)) fail(400, 'INVALID_REQUEST');
    const auth = deviceAuth(req);
    await deviceRate(auth, 'notification-receipts', 30, 60);
    await service.me(auth);
    return notifications.receipts(auth, req.body.events);
  }));
  router.post('/device/sessions', body('openSession'), send(async req => {
    const auth = deviceAuth(req);
    await deviceRate(auth, 'session', 30, 60);
    await service.me(auth);
    return service.session(auth, req.body);
  }));
  router.post('/device/status', body('reportStatus'), send(async req => {
    const auth = deviceAuth(req);
    await deviceRate(auth, 'status', 12, 60);
    await service.me(auth);
    return service.status(auth, req.body);
  }));
  router.post('/device/revoke', body('revokeDevice'), send(req => service.revoke(deviceAuth(req), null, null, null, req.body)));
  router.use((_req, _res, next) => next(new NpepError(404, 'NOT_FOUND')));
  router.use((error, req, res, _next) => {
    // Never serialize DB errors, Prisma arguments, request objects or auth headers.
    let safe = error instanceof NpepError ? error : new NpepError(503, 'TEMPORARILY_UNAVAILABLE');
    if (error.type === 'entity.too.large') safe = new NpepError(413, 'PAYLOAD_TOO_LARGE');
    else if (error.status === 415 || error.type === 'request.aborted') safe = new NpepError(400, 'INVALID_REQUEST');
    else if (error.code === 'P2002') safe = new NpepError(409, 'CREDENTIAL_ID_CONFLICT');
    if (safe.retryAfterSeconds) res.set('Retry-After', String(safe.retryAfterSeconds));
    const {data: unused, ...base} = envelope(req.npepRequestId);
    res.status(safe.status).json({...base, protocolVersion: req.npepVersion || '0.1', error: {code: safe.code, message: safe.code, retryAfterSeconds: safe.retryAfterSeconds}});
  });
  return router;
}

export default createNpepRouter();
