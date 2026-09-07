import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {once} from 'node:events';
import {createServer} from 'node:http';
import express from 'express';
import {httpMetrics, register, socketConnectionsGauge} from '../utils/metrics.js';
import {initSocket} from '../utils/socket.js';

let server, io, origin;
before(async () => {
    const app = express();
    app.use(httpMetrics);
    const router = express.Router();
    router.get('/:id', (req, res) => res.json({id: req.params.id}));
    router.patch('/:id', (_req, _res, next) => next(Object.assign(new Error('conflict'), {status: 409})));
    router.post('/', (_req, _res, next) => next(new Error('failure')));
    app.use('/api/v2/publications', router);
    app.get('/slow', (_req, res) => { res.write('waiting'); });
    app.get('/metrics', async (_req, res) => res.send(await register.metrics()));
    app.use((_req, res) => res.sendStatus(404));
    app.use((error, _req, res, _next) => res.sendStatus(error.status || 500));
    server = createServer(app);
    io = initSocket(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => io.close(resolve));
});
async function values(name) {
    return (await register.getSingleMetric(name).get()).values;
}
const request = (path, method = 'GET') => fetch(origin + path, {method, signal: AbortSignal.timeout(5000)});

test('HTTP success, conflicts and errors use bounded templates with accurate counters and durations', async () => {
    register.resetMetrics();
    for (const id of ['private-school-1', 'private-school-2']) {
        assert.equal((await request(`/api/v2/publications/${id}?token=never-a-label`)).status, 200);
    }
    assert.equal((await request('/api/v2/publications/another-private-id', 'PATCH')).status, 409);
    assert.equal((await request('/api/v2/publications', 'POST')).status, 500);
    assert.equal((await request('/unknown-one')).status, 404);
    assert.equal((await request('/unknown-two')).status, 404);
    const counters = await values('classworks_http_requests_total');
    assert.equal(counters.find(row => row.labels.method === 'GET' && row.labels.route === '/api/v2/publications/:id').value, 2);
    assert.equal(counters.find(row => row.labels.route === 'unmatched').value, 2);
    assert.equal(counters.reduce((sum, row) => sum + row.value, 0), 6);
    const failures = await values('classworks_http_failures_total');
    assert.equal(failures.reduce((sum, row) => sum + row.value, 0), 4);
    assert.deepEqual(new Set(failures.map(row => row.labels.status)), new Set(['409', '500', '404']));
    const durations = await values('classworks_http_request_duration_seconds');
    assert.equal(durations.filter(row => row.metricName.endsWith('_count')).reduce((sum, row) => sum + row.value, 0), 6);
    assert.ok(durations.filter(row => row.metricName.endsWith('_sum')).every(row => row.value >= 0));
    const scrape = await (await request('/metrics')).text();
    assert.doesNotMatch(scrape, /private-school|another-private|never-a-label|unknown-one|unknown-two/);
    assert.doesNotMatch(scrape, /classworks_keys_total|classworks_registered_devices_total/);
    assert.deepEqual(await values('classworks_http_requests_total'), counters, 'scrapes must not count themselves');
});

test('aborted HTTP requests count once on connection close', async () => {
    register.resetMetrics();
    const controller = new AbortController();
    const response = await fetch(origin + '/slow', {signal: controller.signal});
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    for (let i = 0; i < 50; i++) {
        if ((await values('classworks_http_failures_total')).some(row => row.labels.status === 'aborted')) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const failed = (await values('classworks_http_failures_total')).filter(row => row.labels.status === 'aborted');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].value, 1);
});

async function connect() {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { socket.close(); reject(new Error('Socket handshake timed out')); }, 5000);
        socket.addEventListener('error', error => { clearTimeout(timeout); reject(error); }, {once: true});
        socket.addEventListener('message', event => {
            const data = String(event.data);
            if (data.startsWith('0')) socket.send('40');
            if (data === '2') socket.send('3');
            if (data.startsWith('40')) { clearTimeout(timeout); resolve(); }
        });
    });
    return socket;
}
async function count() { return (await socketConnectionsGauge.get()).values[0].value; }
async function waitCount(expected) {
    for (let i = 0; i < 50; i++) {
        if (await count() === expected) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(await count(), expected);
}
test('actual Socket.IO connect, disconnect, reconnect and shutdown update the live gauge', async () => {
    const sockets = [];
    try {
        sockets.push(await connect(), await connect());
        await waitCount(2);
        sockets[0].close();
        await waitCount(1);
        sockets.push(await connect());
        await waitCount(2);
        io.disconnectSockets(true);
        await waitCount(0);
    } finally { sockets.forEach(socket => socket.close()); }
});
