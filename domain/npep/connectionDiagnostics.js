import schema from './wire.schema.json' with {type: 'json'};
import {UUID} from './wire.js';

const codes = new Set([...schema.definitions.error.properties.error.properties.code.enum,
  'PHOTO_TEMPORARILY_UNAVAILABLE', 'PHOTO_LEASE_EXPIRED', 'PHOTO_POLICY_CHANGED']);
function category(path) {
  if (path === '/info') return 'Info';
  if (path.startsWith('/pairings')) return 'Pairing';
  if (path === '/device/me') return 'Registration';
  if (path === '/device/sessions') return 'Session';
  if (path === '/device/status') return 'Status';
  if (path.includes('study-settings/photos')) return 'StudyPhotos';
  if (path.includes('study-settings/seating')) return 'StudySeating';
  if (path.includes('study-settings')) return 'StudySettings';
  if (path.includes('school-management') || path === '/admission/catalog') return 'SchoolManagement';
  if (path.includes('notification')) return 'Notifications';
  if (path.includes('runtime-')) return 'RuntimeControl';
  if (path.includes('exam-plan')) return 'ExamPlans';
  return path.includes('noise') ? 'Noise' : 'Other';
}

// Keep NPEP outside the generic access logger. No URLs, query strings, headers,
// bodies, DB messages, identities, passwords or media enter these support records.
export function connectionDiagnostics({write = entry => console.warn(JSON.stringify(entry)), clock = () => performance.now()} = {}) {
  let windowAt = clock(), emitted = 0, suppressed = 0;
  return (req, res, next) => {
    const started = clock(), endpoint = category(req.path.length <= 1024 ? req.path : '');
    let done = false;
    function record(aborted) {
      if (done) return;
      done = true;
      const now = clock(), elapsedMs = Math.max(0, Math.round(now - started));
      if (!aborted && res.statusCode < 400 && elapsedMs < 2000) return;
      if (now - windowAt >= 60000 || now < windowAt) { windowAt = now; emitted = 0; }
      if (emitted >= 120) { suppressed++; return; }
      emitted++;
      const id = req.npepRequestId ?? req.photoRequestId ?? req.seatId ?? req.get('X-Request-Id');
      const entry = {kind: 'npep-connection', timestamp: new Date().toISOString(), endpoint,
        requestId: UUID.test(id ?? '') ? id : null, httpStatus: aborted ? null : res.statusCode,
        elapsedMs: Math.min(600000, elapsedMs), outcome: aborted ? 'Aborted' : res.statusCode >= 400 ? 'Rejected' : 'Slow',
        error: aborted ? 'CONNECTION_ABORTED' : res.statusCode < 400 ? null : codes.has(req.npepDiagnosticError) ? req.npepDiagnosticError : 'UNKNOWN',
        suppressedSinceLast: suppressed};
      suppressed = 0;
      try { write(entry); } catch { /* Diagnostics cannot change or abort a response. */ }
    }
    res.once('finish', () => record(false));
    res.once('close', () => { if (!res.writableFinished) record(true); });
    next();
  };
}
