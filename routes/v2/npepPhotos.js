import express from 'express';
import {NpepError, fail, UUID, OPAQUE_ID, parseStrictJson, bearer, envelope} from '../../domain/npep/wire.js';
import {createNpepPhotoService} from '../../services/npepPhotoService.js';
import {createNpepStudyExitService} from '../../services/npepStudyExitService.js';
export function createNpepPhotoRouter({base, study, authenticate, rateLimits = true, options = {}}) {
  const router = express.Router(), service = createNpepPhotoService(base, study, options);
  const exits=createNpepStudyExitService(base,study,options);
  router.use((req, res, next) => {
    if (!/^\/schools\/[^/]+\/study-(?:photos|exit-events)(?:\/|$)|^\/device\/study-settings\/photos(?:\/|$)/.test(req.path)) return next('router');
    res.set({'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'});
    try {
      req.photoRequestId = req.get('X-Request-Id');
      if (req.get('X-NPEP-Version') !== '0.15') fail(426, 'PROTOCOL_UNSUPPORTED');
      if (!UUID.test(req.photoRequestId || '')) fail(400, 'INVALID_REQUEST');
      if (req.path.startsWith('/schools/')) {
        const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.get('Authorization') || '')?.[1];
        if (!token) fail(401, 'AUTH_INVALID');
        try { req.photoClaims = authenticate(token); } catch { fail(401, 'AUTH_INVALID'); }
        if (!req.photoClaims?.accountId || !req.photoClaims?.sessionId) fail(401, 'AUTH_INVALID');
      } else req.photoAuth = bearer(req.get('Authorization'), 'npep1');
      const upload = req.path === '/device/study-settings/photos/upload';
      if (req.method === 'POST' && !req.is(upload ? 'image/jpeg' : 'application/json')) fail(400, 'INVALID_REQUEST');
      const queries = /^\/schools\/[^/]+\/study-(?:photos|exit-events)$/.test(req.path) ? ['termId','classId','cursor']
        : req.path.endsWith('/image') ? ['download'] : [];
      if (Object.keys(req.query).some(k => !queries.includes(k))) fail(400, 'INVALID_REQUEST');
      next();
    } catch (e) { next(e); }
  });
  router.use(async (req, _res, next) => {
    try {
      if (req.photoAuth) await base.preflightDevice(req.photoAuth);
      if (rateLimits) await base.rate('study-photos', req.photoAuth?.id ?? req.photoClaims.sessionId, req.method === 'GET' ? 180 : 60, 60);
      next();
    } catch (e) { next(e); }
  });
  router.use(express.raw({type: ['application/json', 'image/jpeg'], limit: 262144, inflate: false}));
  router.use((req, _res, next) => {
    try {
      if (req.method === 'POST') {
        if (req.path.endsWith('/upload')) {
          const header = req.get('X-NPEP-Photo');
          if (!header || header.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(header)) fail(400, 'INVALID_REQUEST');
          req.photoMetadata = parseStrictJson(Buffer.from(header, 'base64url'));
        } else {
          req.body = parseStrictJson(req.body);
          if (req.body.requestId !== req.photoRequestId) fail(400, 'INVALID_REQUEST');
        }
      }
      next();
    } catch (e) { next(e); }
  });
  router.param('schoolId', (_r, _s, next, id) => next(OPAQUE_ID.test(id) ? undefined : new NpepError(400, 'INVALID_REQUEST')));
  router.param('photoId', (_r, _s, next, id) => next(UUID.test(id) ? undefined : new NpepError(400, 'INVALID_REQUEST')));
  const send = fn => async (req, res, next) => {
    try { res.json({...envelope(req.photoRequestId, await fn(req)), protocolVersion: '0.15'}); } catch (e) { next(e); }
  };
  router.post('/device/study-settings/photos/lease', send(r => service.lease(r.photoAuth, r.body)));
  router.post('/device/study-settings/photos/upload', send(r => service.upload(r.photoAuth, r.photoMetadata, r.body)));
  router.post('/device/study-settings/photos/exit-events',send(r=>exits.store(r.photoAuth,r.body)));
  router.get('/schools/:schoolId/study-exit-events',send(r=>exits.list(r.photoClaims,r.params.schoolId,r.query.termId,r.query.classId,r.query.cursor)));
  router.get('/schools/:schoolId/study-photos', send(r => service.list(r.photoClaims, r.params.schoolId, r.query.termId, r.query.classId, r.query.cursor)));
  router.get('/schools/:schoolId/study-photos/:photoId/image', async (req, res, next) => {
    try {
      if (req.query.download !== undefined && req.query.download !== '1') fail(400, 'INVALID_REQUEST');
      const bytes = await service.image(req.photoClaims, req.params.schoolId, req.params.photoId, req.query.download === '1');
      res.set('Content-Type', 'image/jpeg');
      if (req.query.download === '1') res.set('Content-Disposition', `attachment; filename="study-${req.params.photoId}.jpg"`);
      res.send(bytes);
    } catch (e) { next(e); }
  });
  router.post('/schools/:schoolId/study-photos/:photoId/delete', send(r => {
    if (Object.keys(r.body).length !== 1) fail(400, 'INVALID_REQUEST');
    return service.remove(r.photoClaims, r.params.schoolId, r.params.photoId);
  }));
  router.use((_r, _s, next) => next(new NpepError(404, 'NOT_FOUND')));
  router.use((e, req, res, _next) => {
    const safe = e instanceof NpepError ? e : new NpepError(e.type === 'entity.too.large' ? 413 : 503,
      e.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'PHOTO_TEMPORARILY_UNAVAILABLE');
    req.npepDiagnosticError = safe.code;
    res.status(safe.status).json({protocolVersion: '0.15', requestId: req.photoRequestId ?? null,
      serverTime: new Date().toISOString(), error: {code: safe.code}});
  });
  return router;
}
