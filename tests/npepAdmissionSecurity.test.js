import assert from "node:assert/strict";
import test from "node:test";
import {randomBytes, randomUUID} from "node:crypto";
import express from "express";
import {createNpepRouter} from "../routes/v2/npep.js";
import {secretHash, hash} from "../domain/npep/wire.js";

test("NPEP device limits reject before locking transactions without letting invalid secrets poison buckets", async t => {
    const identity = {serverInstanceId: randomUUID(), deploymentEpoch: randomUUID()};
    const id = randomUUID(), secret = randomBytes(32).toString("base64url");
    let admissions = 0, transactions = 0;
    const client = {
        npepDeployment: {findUnique: async () => identity},
        npepDevice: {findUnique: async () => ({state: "ACTIVE", ...identity, secretHash: secretHash(secret), credentialExpiresAt: new Date(Date.now() + 60000)})},
        $queryRaw: async () => {admissions++; return [{count: 1000}];},
        $transaction: async () => {transactions++; throw new Error("lock must not be acquired");},
    };
    const app = express(); app.use(createNpepRouter({client, deployment: () => identity}));
    const server = await new Promise(done => {const s = app.listen(0, "127.0.0.1", () => done(s));});
    t.after(async () => {server.closeAllConnections(); await new Promise(done => server.close(done));});
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (path, token, version) => fetch(origin + path, {headers: {Authorization: `Bearer npep1.${id}.${token}`, "X-NPEP-Version": version, "X-Request-Id": randomUUID()}});
    assert.equal((await request("/device/me", randomBytes(32).toString("base64url"), "0.1")).status, 401);
    assert.equal(admissions, 0);
    for (const [path, version] of [["/device/me", "0.1"], ["/device/notifications", "0.2"], ["/device/runtime-operations", "0.4"], ["/device/exam-plans", "0.5"]]) {
        const response = await request(path, secret, version);
        assert.equal(response.status, 429); assert.equal((await response.json()).error.code, "RATE_LIMITED");
    }
    assert.equal(transactions, 0); assert.equal(admissions, 4);
});

for (const trust of [false, 1]) test(`pairing source quotas honor only configured proxy trust (${trust})`, async t => {
    const identity = {serverInstanceId: randomUUID(), deploymentEpoch: randomUUID()};
    const keys = [];
    const client = {$queryRaw: async (_sql, key) => {keys.push(key); return [{count: 1000}];}, $transaction: () => {throw new Error("admission should reject first");}};
    const app = express(); app.set("trust proxy", trust); app.use(createNpepRouter({client, deployment: () => identity}));
    const server = await new Promise(done => {const s = app.listen(0, "127.0.0.1", () => done(s));});
    t.after(async () => {server.closeAllConnections(); await new Promise(done => server.close(done));});
    for (const ip of ["192.0.2.1", "192.0.2.2"]) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/pairings`, {method: "POST",
            headers: {"X-Forwarded-For": ip, "X-NPEP-Version": "0.1", "Content-Type": "application/json"},
            body: JSON.stringify({requestId: randomUUID(), installationId: randomUUID(), ...identity,
                deviceName: "Test device", appVersion: "1.0", pairingSecret: randomBytes(32).toString("base64url"), requestedCapabilities: ["device.status"]})});
        assert.equal(response.status, 429);
    }
    assert.equal(keys.length, 2);
    if (trust) {assert.notEqual(keys[0], keys[1]); assert(keys[0].includes(hash("192.0.2.1")));}
    else assert.equal(keys[0], keys[1]);
});
