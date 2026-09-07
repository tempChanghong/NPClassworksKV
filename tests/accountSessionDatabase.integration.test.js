import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";

const enabled = process.env.RUN_DATABASE_TESTS === "true";

test("single-session logout persists in PostgreSQL and invalidates access and renewal without logging out another device", {skip: !enabled, timeout: 30000}, async t => {
    // Validate before importing Prisma (which loads dotenv) or opening any connection.
    const database = new URL(process.env.DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname), "test database must be local");
    assert.match(database.pathname, /^\/npclassworks_test(?:_[a-z0-9_]+)?$/, "only an explicitly named disposable test database is allowed");
    process.env.JWT_ALG = "HS256";
    process.env.JWT_SECRET = "isolated-account-session-database-test-secret";
    process.env.REFRESH_TOKEN_SECRET = "isolated-account-session-database-refresh-secret";
    process.env.ACCESS_TOKEN_EXPIRES_IN = "15m";
    process.env.REFRESH_TOKEN_EXPIRES_IN = "1d";
    const [{prisma}, {default: express}, {default: accountRouter}, tokens, {default: jwt}, {Client}] = await Promise.all([
        import("../utils/prisma.js"), import("express"), import("../routes/accounts.js"),
        import("../utils/tokenManager.js"), import("jsonwebtoken"), import("pg"),
    ]);
    const observer = new Client({connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000});
    let server, accountId;
    t.after(async () => {
        try {
            if (server) {
                server.closeAllConnections();
                await new Promise(resolve => server.close(resolve));
            }
            // AccountSession rows cascade from this test's unique account only.
            if (accountId) await prisma.account.delete({where: {id: accountId}});
        } finally {
            await Promise.allSettled([observer.end(), prisma.$disconnect()]);
        }
    });
    await observer.connect();
    const app = express();
    app.use(express.json());
    app.use("/api/accounts", accountRouter);
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({message: error.message}));
    server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    async function request(path, {token, method = "GET", body} = {}) {
        const response = await fetch(origin + "/api/accounts" + path, {
            method, signal: AbortSignal.timeout(5000),
            headers: {"Content-Type": "application/json", ...(token ? {Authorization: `Bearer ${token}`} : {})},
            ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        });
        return {status: response.status, headers: response.headers, body: await response.json()};
    }
    const profile = token => request("/profile", {token});
    const refresh = refresh_token => request("/refresh", {method: "POST", body: {refresh_token}});
    // Independent SQL connection observes committed data, not Prisma fixtures.
    async function persistedSession(id) {
        const {rows} = await observer.query('SELECT * FROM "AccountSession" WHERE "id" = $1', [id]);
        assert.equal(rows.length, 1);
        return rows[0];
    }
    function assertDenied(response) {
        assert.equal(response.status, 401, JSON.stringify(response.body));
        assert.equal(response.headers.get("x-new-access-token"), null);
        assert.equal(response.headers.get("x-token-refreshed"), null);
        assert.equal(response.body.data?.access_token, undefined);
    }

    const account = await prisma.account.create({data: {provider: "integration-test", providerId: randomUUID()}});
    accountId = account.id;
    const first = await tokens.generateTokenPair(account);
    const second = await tokens.generateTokenPair(account);
    assert.notEqual(first.sessionId, second.sessionId);
    for (const pair of [first, second]) {
        const row = await persistedSession(pair.sessionId);
        assert.equal(row.accountId, account.id);
        assert.equal(row.revokedAt, null);
        assert.equal(row.refreshTokenHash, tokens.hashRefreshToken(pair.refreshToken));
        assert.ok(row.expiresAt > new Date());
        const response = await profile(pair.accessToken);
        assert.equal(response.status, 200);
        assert.equal(response.body.data.id, account.id);
    }
    const secondBefore = await persistedSession(second.sessionId);
    const {iat: _iat, exp: _exp, ...payload} = tokens.verifyAccessToken(first.accessToken);
    const expiring = jwt.sign(payload, process.env.JWT_SECRET, {algorithm: "HS256", expiresIn: "2m"});
    const nearExpiry = await profile(expiring);
    assert.equal(nearExpiry.status, 200);
    const renewed = nearExpiry.headers.get("x-new-access-token");
    assert.ok(renewed, "active near-expiry access should renew before logout");
    assert.equal(tokens.verifyAccessToken(renewed).sessionId, first.sessionId);
    const refreshedBefore = await refresh(first.refreshToken);
    assert.equal(refreshedBefore.status, 200);
    const refreshedAccess = refreshedBefore.body.data.access_token;
    assert.equal((await profile(refreshedAccess)).status, 200);

    const logout = await request("/logout", {token: first.accessToken, method: "POST"});
    assert.equal(logout.status, 200, JSON.stringify(logout.body));
    assert.equal(logout.body.success, true);
    const revoked = await persistedSession(first.sessionId);
    assert.ok(revoked.revokedAt instanceof Date, "logout response must follow committed revocation");
    assert.deepEqual(await persistedSession(second.sessionId), secondBefore, "logout must not mutate the other session");
    const {rows: [persistedAccount]} = await observer.query('SELECT "tokenVersion" FROM "Account" WHERE "id" = $1', [account.id]);
    assert.equal(persistedAccount.tokenVersion, account.tokenVersion, "single logout must not revoke the whole account");

    for (const token of [first.accessToken, expiring, renewed, refreshedAccess]) {
        assertDenied(await profile(token));
    }
    assertDenied(await refresh(first.refreshToken));
    assertDenied(await request("/logout", {token: first.accessToken, method: "POST"}));
    assert.deepEqual(await persistedSession(first.sessionId), revoked, "denied requests must not revive or update the revoked session");

    assert.equal((await profile(second.accessToken)).status, 200);
    const secondRefresh = await refresh(second.refreshToken);
    assert.equal(secondRefresh.status, 200, JSON.stringify(secondRefresh.body));
    const secondAccess = secondRefresh.body.data.access_token;
    assert.equal(tokens.verifyAccessToken(secondAccess).sessionId, second.sessionId);
    assert.equal((await profile(secondAccess)).body.data.id, account.id);
    const secondAfter = await persistedSession(second.sessionId);
    assert.equal(secondAfter.revokedAt, null);
    assert.equal(secondAfter.refreshTokenHash, secondBefore.refreshTokenHash);
    assert.ok(secondAfter.lastUsedAt instanceof Date);
    assert.equal(await prisma.accountSession.count({where: {accountId: account.id}}), 2);
});
