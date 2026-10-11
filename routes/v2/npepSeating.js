import express from 'express';
import {NpepError, fail, UUID, OPAQUE_ID, parseStrictJson, bearer, envelope} from '../../domain/npep/wire.js';
import {validateSeating} from '../../domain/npep/seating.js';
import {createNpepSeatingService} from '../../services/npepSeatingService.js';
export function createNpepSeatingRouter({base, study, authenticate, rateLimits}) {
  const router = express.Router(), service = createNpepSeatingService(base, study);
  // A separate parser/transfer namespace keeps all 0.1–0.13 request limits unchanged.
  router.use((req, res, next) => {
    if (!/^\/schools\/[^/]+\/seating(?:\/|$)|^\/device\/study-settings\/seating(?:\/|$)/.test(req.path)) return next('router');
    res.set('Cache-Control', 'no-store');
    try {
      if (req.get('X-NPEP-Version') !== '0.14') fail(426, 'PROTOCOL_UNSUPPORTED');
      if (!UUID.test(req.get('X-Request-Id') || '')) fail(400, 'INVALID_REQUEST');
      req.seatId = req.get('X-Request-Id');
      if (req.path.startsWith('/schools/')) {
        const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.get('Authorization') || '')?.[1];
        if (!token) fail(401, 'AUTH_INVALID');
        try { req.seatClaims = authenticate(token); } catch { fail(401, 'AUTH_INVALID'); }
        if (!req.seatClaims?.accountId || !req.seatClaims?.sessionId) fail(401, 'AUTH_INVALID');
      } else req.seatAuth = bearer(req.get('Authorization'), 'npep1');
      if (req.method === 'POST' && !req.is('application/json')) fail(400, 'INVALID_REQUEST');
      next();
    } catch (e) { next(e); }
  });
  router.use(async (req, _res, next) => {
    try {
      if (rateLimits) {
        if (req.seatAuth) { await base.preflightDevice(req.seatAuth); await base.rate('seating-read', req.seatAuth.id, 200, 60); }
        else await base.rate('seating-admin', req.seatClaims.sessionId, 30, 60);
      }
      next();
    } catch (e) { next(e); }
  });
  router.use(express.raw({type: 'application/json', limit: 2850000, inflate: false}));
  router.use((req, _res, next) => {
    try { if (req.method === 'POST') { req.body = parseStrictJson(req.body); if (req.body?.requestId !== req.seatId) fail(400, 'INVALID_REQUEST'); } next(); }
    catch (e) { next(e); }
  });
  router.param('schoolId', (_req, _res, next, id) => next(OPAQUE_ID.test(id) ? undefined : new NpepError(400, 'INVALID_REQUEST')));
  const send = fn => async (req, res, next) => { try { res.json({...envelope(req.seatId, await fn(req)), protocolVersion: '0.14'}); } catch (e) { next(e); } };
  const query = keys => (req, _res, next) => next(Object.keys(req.query).some(k => !keys.includes(k)) ? new NpepError(400, 'INVALID_REQUEST') : undefined);
  router.get('/schools/:schoolId/seating/catalog', query(['termId']), send(r => service.catalog(r.seatClaims, r.params.schoolId, r.query.termId)));
  router.get('/schools/:schoolId/seating', query(['termId', 'classId']), send(r => service.list(r.seatClaims, r.params.schoolId, r.query.termId, r.query.classId)));
  router.post('/schools/:schoolId/seating', query([]), send(r => service.publish(r.seatClaims, r.params.schoolId, r.body)));
  router.get('/schools/:schoolId/seating/image', query(['termId', 'classId', 'revision']), send(r => service.preview(r.seatClaims, r.params.schoolId, r.query.termId, r.query.classId, Number(r.query.revision))));
  const body = name => (r, _s, next) => next(validateSeating(name, r.body) ? undefined : new NpepError(400, 'INVALID_REQUEST'));
  router.post('/device/study-settings/seating', query([]), body('manifestRequest'), send(r => service.manifest(r.seatAuth, r.body)));
  router.post('/device/study-settings/seating/chunk', query([]), body('chunkRequest'), send(r => service.chunk(r.seatAuth, r.body)));
  router.post('/device/study-settings/seating/upload-status', query([]), body('uploadStatusRequest'), send(r => service.uploadStatus(r.seatAuth, r.body)));
  router.post('/device/study-settings/seating/upload', query([]), body('uploadRequest'), send(r => service.upload(r.seatAuth, r.body)));
  router.use((_req, _res, next) => next(new NpepError(404, 'NOT_FOUND')));
  router.use((e, req, res, _next) => {
    const safe = e instanceof NpepError ? e : new NpepError(e.type === 'entity.too.large' ? 413 : e.status === 415 ? 400 : 503, e.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'TEMPORARILY_UNAVAILABLE');
    res.status(safe.status).json({protocolVersion: '0.14', requestId: req.seatId ?? null, serverTime: new Date().toISOString(), error: {code: safe.code}});
  });
  return router;
}
