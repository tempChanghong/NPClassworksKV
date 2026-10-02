import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {metricsAuth} from "../middleware/metricsAuth.js";

test("metrics authenticate through the header and reject query credentials", async () => {
    const previous = process.env.METRICS_TOKEN; process.env.METRICS_TOKEN = "metrics-test-secret";
    const app = express(); app.get("/metrics", metricsAuth, (_req, res) => res.send("metrics"));
    const server = await new Promise(done => {const s = app.listen(0, "127.0.0.1", () => done(s));});
    const url = `http://127.0.0.1:${server.address().port}/metrics`;
    try {
        for (const [suffix, auth, status] of [["", undefined, 401], ["?token=metrics-test-secret", undefined, 401],
            ["", "Bearer wrong", 401], ["", "Bearer metrics-test-secret", 200], ["?token=metrics-test-secret", "Bearer metrics-test-secret", 401]]) {
            const response = await fetch(url + suffix, {headers: auth ? {Authorization: auth} : {}});
            assert.equal(response.status, status); await response.text();
        }
    } finally {server.closeAllConnections(); await new Promise(done => server.close(done)); if (previous === undefined) delete process.env.METRICS_TOKEN; else process.env.METRICS_TOKEN = previous;}
});
