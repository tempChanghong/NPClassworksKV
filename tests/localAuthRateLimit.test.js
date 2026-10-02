import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import express from "express";
import {getLocalLoginSourceKey, localLoginSourceLimiter} from "../middleware/rateLimiter.js";

function request({deviceId = "", ip = "192.0.2.10", schoolCode = "TJ2", username = "teacher"} = {}) {
    return {
        ip,
        connection: {},
        socket: {},
        headers: deviceId ? {"x-classworks-device-id": deviceId} : {},
        body: {schoolCode, username},
    };
}

test("untrusted device IDs cannot split the account/source limit", () => {
    const first = getLocalLoginSourceKey(request({deviceId: "device-classroom-a"}));
    const second = getLocalLoginSourceKey(request({deviceId: "device-teacher-phone"}));
    assert.equal(first, second);
});

test("rotating device headers is rejected after eight failed HTTP attempts", async () => {
    const app = express(); app.use(express.json());
    app.post("/login", localLoginSourceLimiter, (_req, res) => res.status(401).end());
    const server = await new Promise(done => {const s = app.listen(0, "127.0.0.1", () => done(s));});
    try {
        const url = `http://127.0.0.1:${server.address().port}/login`;
        for (let n = 0; n < 10; n++) {
            const response = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json", "X-Classworks-Device-ID": `rotated-${n}`},
                body: JSON.stringify({schoolCode: "HTTP", username: "target"})});
            assert.equal(response.status, n < 8 ? 401 : 429);
            await response.text();
        }
        const other = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({schoolCode: "HTTP", username: "other"})});
        assert.equal(other.status, 401);
    } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});

test("local login throttling isolates accounts on the same device", () => {
    const first = getLocalLoginSourceKey(request({deviceId: "device-classroom-a", username: "teacher-a"}));
    const second = getLocalLoginSourceKey(request({deviceId: "device-classroom-a", username: "teacher-b"}));
    assert.notEqual(first, second);
});

test("local login throttling falls back to the request IP without a device id", () => {
    const key = getLocalLoginSourceKey(request({deviceId: ""}));
    assert.match(key, /ip-192\.0\.2\.10/);
});

test("teacher login no longer rejects or locks an account globally after failures", () => {
    const source = fs.readFileSync(new URL("../services/localAccountService.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /account\?\.localLockedUntil/);
    assert.doesNotMatch(source, /registerFailure/);
});
