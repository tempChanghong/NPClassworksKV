import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import express from "express";
import {createHash, randomBytes} from "node:crypto";
import {OAuthStateStore} from "../domain/oauthState.js";
import {oauthProviders, generateState} from "../config/oauth.js";
import {prisma} from "../utils/prisma.js";
import router from "../routes/accounts.js";

test("state storage is bounded, browser-bound, expiring and single-use", () => {
    let now = 0;
    const store = new OAuthStateStore({maxEntries: 1, ttlMs: 100, now: () => now});
    assert.equal(store.set("a", {provider: "stcn", browserBinding: "browser-a"}), true);
    assert.equal(store.set("b", {provider: "stcn", browserBinding: "browser-b"}), false);
    assert.equal(store.consume("a", "stcn", "browser-b"), null);
    assert.equal(store.consume("a", "dlass", "browser-a"), null);
    assert(store.consume("a", "stcn", "browser-a"));
    assert.equal(store.consume("a", "stcn", "browser-a"), null);
    store.set("b", {provider: "stcn", browserBinding: "browser-b"}); now = 100;
    assert.equal(store.consume("b", "stcn", "browser-b"), null);
    assert.equal(store.set("c", {provider: "stcn", browserBinding: "browser-c"}), true);
    assert.match(generateState(), /^[A-Za-z0-9_-]{43}$/);
});

let server, origin, account, userData, invitationQueries, providerCalls;
const restore = [];
const networkFetch = globalThis.fetch;
function stub(object, key, fn) {const old = object[key]; object[key] = fn; restore.push(() => {object[key] = old;});}
before(async () => {
    for (const key of ["stcn", "dlass"]) {
        const old = {...oauthProviders[key]}; Object.assign(oauthProviders[key], {clientId: "test-client", clientSecret: "test-secret"});
        restore.push(() => Object.assign(oauthProviders[key], old));
    }
    stub(prisma.account, "findUnique", async () => account);
    stub(prisma.account, "update", async ({data}) => {account = {...account, ...data}; return account;});
    stub(prisma.accountSession, "create", async ({data}) => data);
    stub(prisma.workspaceMemberInvite, "findMany", async () => {invitationQueries++; return [];});
    stub(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith(origin)) return networkFetch(url, options);
        providerCalls++;
        return {json: async () => String(url).includes("access_token") ? {access_token: "provider-token"} : userData};
    });
    const app = express(); app.use(express.json()); app.use("/accounts", router);
    server = await new Promise(done => {const s = app.listen(0, "127.0.0.1", () => done(s));});
    origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {server?.closeAllConnections(); if (server) await new Promise(done => server.close(done)); restore.reverse().forEach(fn => fn());});

async function initiate(provider) {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const response = await networkFetch(`${origin}/accounts/oauth/${provider}?handoff_challenge=${challenge}`, {redirect: "manual"});
    assert.equal(response.status, 302);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
    return {state: new URL(response.headers.get("location")).searchParams.get("state"), cookie: cookie.split(";")[0], verifier};
}

async function exchange(code, verifier) {
    return networkFetch(`${origin}/accounts/oauth/exchange`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({code, verifier})});
}

test("handoff is browser-bound, single-use, creates no URL bearer and respects intervening revocation", async () => {
    account = {id: "oauth-account", provider: "stcn", tokenVersion: 1};
    userData = {sub: "user", name: "User", email_verified: false}; invitationQueries = 0;
    for (const revoked of [false, true]) {
        const {state, cookie, verifier} = await initiate("stcn");
        const response = await networkFetch(`${origin}/accounts/oauth/stcn/callback?state=${state}&code=code`, {redirect: "manual", headers: {Cookie: cookie}});
        const location = new URL(response.headers.get("location"));
        assert.equal(location.searchParams.has("access_token"), false);
        assert.equal(location.searchParams.has("refresh_token"), false);
        const code = location.searchParams.get("oauth_code"); assert.match(code, /^[A-Za-z0-9_-]{43}$/);
        assert.equal((await exchange(code, randomBytes(32).toString("base64url"))).status, 401);
        if (revoked) account.tokenVersion++;
        const result = await exchange(code, verifier);
        assert.equal(result.status, revoked ? 401 : 200);
        if (!revoked) {assert.match(result.headers.get("cache-control"), /no-store/); assert((await result.json()).refresh_token);}
        assert.equal((await exchange(code, verifier)).status, 401);
    }
});

test("a callback from another browser cannot exchange the initiating browser's code", async () => {
    providerCalls = 0;
    const {state, cookie} = await initiate("stcn");
    const path = `${origin}/accounts/oauth/stcn/callback?state=${state}&code=authorization-code`;
    const response = await networkFetch(path, {redirect: "manual"});
    assert.equal(new URL(response.headers.get("location")).searchParams.get("error"), "invalid_state");
    assert.equal(providerCalls, 0);
    account = {id: "oauth-account", provider: "stcn", tokenVersion: 1};
    userData = {sub: "user", name: "User", email: "verified@example.invalid", email_verified: true};
    invitationQueries = 0;
    const allowed = await networkFetch(path, {redirect: "manual", headers: {Cookie: cookie}});
    assert.equal(new URL(allowed.headers.get("location")).searchParams.get("success"), "true");
    assert.equal(invitationQueries, 1);
    const replay = await networkFetch(path, {redirect: "manual", headers: {Cookie: cookie}});
    assert.equal(new URL(replay.headers.get("location")).searchParams.get("error"), "invalid_state");
});

for (const provider of ["stcn", "dlass"]) for (const verified of [false, undefined, "true", true]) {
    test(`${provider} accepts invitation email only for boolean verified=${String(verified)}`, async () => {
        account = {id: "oauth-account", provider, tokenVersion: 1, email: "previously-unverified@example.invalid"};
        userData = {sub: "user", name: "User", email: "invited@example.invalid", email_verified: verified};
        invitationQueries = 0;
        const {state, cookie} = await initiate(provider);
        const response = await networkFetch(`${origin}/accounts/oauth/${provider}/callback?state=${state}&code=code`, {redirect: "manual", headers: {Cookie: cookie}});
        assert.equal(new URL(response.headers.get("location")).searchParams.get("success"), "true");
        assert.equal(account.email, verified === true ? userData.email : null);
        assert.equal(invitationQueries, verified === true ? 1 : 0);
    });
}
