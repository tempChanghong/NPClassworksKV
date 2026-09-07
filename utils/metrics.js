import client from 'prom-client';
import {performance} from 'node:perf_hooks';

const register = new client.Registry();
const labelNames = ['method', 'route', 'status'];
export const httpRequestsTotal = new client.Counter({
    name: 'classworks_http_requests_total', help: 'Completed HTTP requests, including aborted connections', labelNames, registers: [register],
});
export const httpFailuresTotal = new client.Counter({
    name: 'classworks_http_failures_total', help: 'HTTP 4xx, 5xx and aborted requests; business conflicts are included', labelNames, registers: [register],
});
export const httpRequestDuration = new client.Histogram({
    name: 'classworks_http_request_duration_seconds', help: 'HTTP request duration until finish or disconnect', labelNames,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30], registers: [register],
});
export const socketConnectionsGauge = new client.Gauge({
    name: 'classworks_socket_connections', help: 'Current Socket.IO connections (not unique devices or authenticated screens)', registers: [register],
});

export function httpMetrics(req, res, next) {
    if (req.path === '/metrics') return next();
    const start = performance.now();
    // Only fixed mount prefixes and Express route templates become labels, never raw URLs/IDs.
    const prefix = req.path.match(/^(\/accounts|\/api\/v2\/(?:catalog|admin|me|publications|classroom-screens|setup))(?=\/|$)/)?.[1] || '';
    const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
    let recorded = false;
    function observe(aborted) {
        if (recorded) return;
        recorded = true;
        const route = typeof req.route?.path === 'string' ? prefix + req.route.path : 'unmatched';
        const status = aborted ? 'aborted' : String(res.statusCode);
        const labels = {method, route, status};
        httpRequestsTotal.inc(labels);
        httpRequestDuration.observe(labels, (performance.now() - start) / 1000);
        if (aborted || res.statusCode >= 400) httpFailuresTotal.inc(labels);
    }
    res.once('finish', () => observe(false));
    res.once('close', () => observe(!res.writableFinished));
    next();
}

export {register};
