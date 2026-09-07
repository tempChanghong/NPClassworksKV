import assert from "node:assert/strict";
import {before, after, beforeEach, test} from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import {prisma} from "../utils/prisma.js";
import {jwtAuth} from "../middleware/jwt-auth.js";
import {generateTokenPair, refreshAccessToken, verifyAccessToken} from "../utils/tokenManager.js";

import accountRouter from "../routes/accounts.js";

const account = {id: "session-owner", provider: "test", tokenVersion: 1};
let server, origin, sessions;
const restores = [];
function stub(object, key, fn) { const previous = object[key]; object[key] = fn; restores.push(() => { object[key] = previous; }); }
before(async () => {
    stub(prisma.account, "findUnique", async ({where}) => where.id === account.id ? account : null);
    stub(prisma.accountSession, "create", async ({data}) => { sessions.set(data.id, {...data, revokedAt: null}); return data; });
    stub(prisma.accountSession, "findUnique", async ({where}) => sessions.get(where.id) || null);
    stub(prisma.accountSession, "update", async ({where, data}) => Object.assign(sessions.get(where.id), data));
    stub(prisma.accountSession, "updateMany", async ({where, data}) => {
        let count = 0;
        for (const row of sessions.values()) if (row.id === where.id && row.accountId === where.accountId && !row.revokedAt) {
            Object.assign(row, data); count++;
        }
        return {count};
    });
    const app = express();
    app.get("/protected", jwtAuth, (_req, res) => res.json({id: res.locals.account.id}));
    app.use("/accounts", accountRouter);
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({message: error.message}));
    server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    origin = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => { sessions = new Map(); });
after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); restores.reverse().forEach(fn => fn()); });
const request = (token, path = "/protected", method = "GET") => fetch(origin + path, {method, headers: {Authorization: `Bearer ${token}`}});
function nearExpiry(token, patch = {}) {
    const {iat: _iat, exp: _exp, ...payload} = verifyAccessToken(token);
    return jwt.sign({...payload, ...patch}, process.env.JWT_SECRET || "your-access-token-secret-change-this-in-production", {expiresIn: "2m", algorithm: "HS256"});
}

test("logging out one session rejects its access, refresh and near-expiry renewal while another session stays signed in", async () => {
    const first = await generateTokenPair(account), second = await generateTokenPair(account);
    const expiring = nearExpiry(first.accessToken);
    const healthy = await request(expiring);
    assert.equal(healthy.status, 200);
    const renewedBeforeLogout = healthy.headers.get("x-new-access-token");
    assert(renewedBeforeLogout);
    assert.equal((await request(first.accessToken, "/accounts/logout", "POST")).status, 200);
    for (const token of [first.accessToken, expiring, renewedBeforeLogout]) {
        const denied = await request(token);
        assert.equal(denied.status, 401);
        assert.equal(denied.headers.get("x-new-access-token"), null);
    }
    await assert.rejects(refreshAccessToken(first.refreshToken), /Invalid refresh token/);
    assert.equal((await request(second.accessToken)).status, 200);
    const refreshed = await refreshAccessToken(second.refreshToken);
    assert.equal((await request(refreshed.accessToken)).status, 200);
});

for (const state of ["missing", "expired", "wrong-owner", "null", "empty", "number"]) {
    test(`access and auto-renewal reject ${state} session identity without legacy fallback`, async () => {
        const pair = await generateTokenPair(account);
        let token = nearExpiry(pair.accessToken);
        if (state === "missing") sessions.delete(pair.sessionId);
        if (state === "expired") sessions.get(pair.sessionId).expiresAt = new Date(Date.now() - 1);
        if (state === "wrong-owner") sessions.get(pair.sessionId).accountId = "someone-else";
        if (state === "null") token = nearExpiry(pair.accessToken, {sessionId: null});
        if (state === "empty") token = nearExpiry(pair.accessToken, {sessionId: ""});
        if (state === "number") token = nearExpiry(pair.accessToken, {sessionId: 123});
        const response = await request(token);
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("x-new-access-token"), null);
    });
}

test("pre-session access tokens remain compatible until their existing account/version checks fail", async () => {
    const pair = await generateTokenPair(account);
    const {sessionId: _session, ...payload} = verifyAccessToken(nearExpiry(pair.accessToken));
    const token = jwt.sign(payload, process.env.JWT_SECRET || "your-access-token-secret-change-this-in-production", {algorithm: "HS256"});
    assert.equal((await request(token)).status, 200);
    account.tokenVersion++;
    try { assert.equal((await request(token)).status, 401); } finally { account.tokenVersion--; }
});
