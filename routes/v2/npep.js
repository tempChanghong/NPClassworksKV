import express from 'express';
import {prisma} from '../../utils/prisma.js';
import {verifyAccessToken} from '../../utils/tokenManager.js';
import {createNpepService} from '../../services/npepService.js';
import {readDeployment} from '../../domain/npep/deployment.js';
import {NpepError, UUID, OPAQUE_ID, validate, parseStrictJson, bearer, envelope, fail} from '../../domain/npep/wire.js';
import {createNpepNotificationService, notificationCursor} from '../../services/npepNotificationService.js';
import {validateNotification} from '../../domain/npep/notifications.js';

export function createNpepRouter({client = prisma, deployment = readDeployment, authenticate = verifyAccessToken, rateLimits = true} = {}) {
  const router = express.Router();
  const service = createNpepService(client, deployment);
  const notifications = createNpepNotificationService(service);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      req.npepVersion = /^\/device\/(notifications|notification-receipts)\/?$/i.test(req.path) ? '0.2' : '0.1';
      if (req.get('X-NPEP-Version') !== req.npepVersion) fail(426, 'PROTOCOL_UNSUPPORTED');
      deployment();
      if (req.method === 'POST' && !req.is('application/json')) fail(400, 'INVALID_REQUEST');
      next();
    } catch (error) { next(error); }
  });
  router.use((req, res, next) => express.raw({type: 'application/json', limit: req.npepVersion === '0.2' ? 65536 : 16384, inflate: false})(req, res, next));
  router.use((req, _res, next) => {
    try {
      if (req.method === 'POST') req.body = parseStrictJson(req.body);
      const bodyId = req.body?.requestId, headerId = req.get('X-Request-Id');
      req.npepRequestId = req.method === 'GET' ? headerId : bodyId;
      if (!UUID.test(req.npepRequestId || '') || (headerId && headerId !== req.npepRequestId)) fail(400, 'INVALID_REQUEST');
      next();
    } catch (error) { next(error); }
  });
  const rate = async (...args) => { if (rateLimits) await service.rate(...args); };
  const body = name => (req, _res, next) => {
    if (validate(name, req.body)) return next();
    const caps = req.body?.requestedCapabilities || req.body?.capabilities;
    next(new NpepError(caps && Array.isArray(caps) && caps.some(cap => cap !== 'device.status') ? 403 : 400,
      caps && Array.isArray(caps) && caps.some(cap => cap !== 'device.status') ? 'CAPABILITY_DENIED' : 'INVALID_REQUEST'));
  };
  router.param('id', (req, _res, next, id) => next(UUID.test(id) ? undefined : new NpepError(400, 'INVALID_REQUEST')));
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
  router.post('/pairings', body('createPairing'), send(async req => {
    // Socket address deliberately ignores arbitrary forwarded headers. Deployments
    // behind a proxy have a conservative shared quota until trusted proxies are configured.
    await rate('create-minute', req.socket.remoteAddress, 5, 60);
    await rate('create-hour', req.socket.remoteAddress, 30, 3600);
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
  router.get('/device/me', send(req => service.me(deviceAuth(req))));
  router.get('/device/notifications', send(async req => {
    const auth = deviceAuth(req);
    if (Object.keys(req.query).some(key => key !== 'cursor') ||
        (req.query.cursor !== undefined && (typeof req.query.cursor !== 'string' || !notificationCursor.test(req.query.cursor)))) fail(400, 'INVALID_REQUEST');
    await service.me(auth);
    await rate(req.query.cursor ? 'notification-pages' : 'notifications', auth.id, req.query.cursor ? 180 : 12, 60);
    return notifications.snapshot(auth, req.query.cursor);
  }));
  router.post('/device/notification-receipts', send(async req => {
    if (!validateNotification('receiptRequest', req.body)) fail(400, 'INVALID_REQUEST');
    const auth = deviceAuth(req);
    await service.me(auth);
    await rate('notification-receipts', auth.id, 30, 60);
    return notifications.receipts(auth, req.body.events);
  }));
  router.post('/device/sessions', body('openSession'), send(async req => {
    const auth = deviceAuth(req);
    await service.me(auth);
    await rate('session', auth.id, 30, 60);
    return service.session(auth, req.body);
  }));
  router.post('/device/status', body('reportStatus'), send(async req => {
    const auth = deviceAuth(req);
    await service.me(auth);
    await rate('status', auth.id, 12, 60);
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
