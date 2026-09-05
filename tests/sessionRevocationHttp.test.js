import assert from "node:assert/strict";
import {before, after, beforeEach, test} from "node:test";
import express from "express";
import {createHash} from "node:crypto";
import {prisma} from "../utils/prisma.js";
import {generateAccessToken} from "../utils/tokenManager.js";
import adminRouter from "../routes/v2/academic-admin.js";
import screenRouter from "../routes/v2/classroom-screens.js";

let server, origin, members, school, binding, writes;
const restore = [];
const hash = value => createHash("sha256").update(value).digest("hex");
const accounts = new Map(["owner", "admin"].map(id => [id, {id, provider: "school-local", tokenVersion: 1}]));
function stub(object, key, implementation) {
    const previous = object[key]; object[key] = implementation;
    restore.push(() => { object[key] = previous; });
}
before(async () => {
    stub(prisma.account, "findUnique", async ({where}) => accounts.get(where.id) || null);
    stub(prisma.schoolMember, "findUnique", async ({where}) => {
        const key = where.schoolId_accountId;
        return key.schoolId === "school" ? members.get(key.accountId) || null : null;
    });
    stub(prisma.schoolMember, "count", async ({where}) => [...members.values()].filter(m => m.role === where.role).length);
    stub(prisma.schoolMember, "upsert", async ({where, update, create}) => {
        writes++;
        const id = where.schoolId_accountId.accountId;
        const member = members.has(id) ? {...members.get(id), ...update} : create;
        members.set(id, member); return member;
    });
    stub(prisma.schoolMember, "delete", async ({where}) => { writes++; members.delete(where.schoolId_accountId.accountId); });
    stub(prisma.school, "findUnique", async () => school);
    stub(prisma.school, "update", async ({data}) => { writes++; Object.assign(school, data); return school; });
    stub(prisma.classroomScreenBinding, "findUnique", async ({where}) => where.tokenHash === binding.tokenHash ? binding : null);
    stub(prisma.classroomScreenBinding, "findFirst", async ({where}) => where.id === binding.id && where.schoolId === binding.schoolId ? binding : null);
    stub(prisma.classroomScreenBinding, "update", async ({data}) => {
        writes++;
        const {credentialVersion, ...fields} = data;
        Object.assign(binding, fields);
        if (credentialVersion?.increment) binding.credentialVersion += credentialVersion.increment;
        return binding;
    });
    stub(prisma.administrativeClassStudent, "findMany", async () => [{id: "student", administrativeClassId: "class-a"}]);
    stub(prisma.publication, "create", async () => { writes++; throw new Error("revoked upload reached publication write"); });
    stub(prisma.auditLog, "create", async () => ({}));
    stub(prisma, "$queryRaw", async () => [{id: "school"}]);
    stub(prisma, "$transaction", async fn => fn(prisma));
    const app = express(); app.use(express.json());
    app.use("/api/v2/admin", adminRouter);
    app.use("/api/v2/classroom-screens", screenRouter);
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({code: error.code, message: error.message}));
    server = await new Promise(done => { const listener = app.listen(0, "127.0.0.1", () => done(listener)); });
    origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    restore.reverse().forEach(fn => fn());
});
beforeEach(() => {
    writes = 0;
    members = new Map([["owner", "OWNER"], ["admin", "ADMIN"]].map(([accountId, role]) => [accountId, {accountId, schoolId: "school", role}]));
    school = {id: "school", code: "TEST", name: "Test school", teacherAuthMode: "LOCAL_PIN"};
    binding = {id: "screen-a", schoolId: "school", administrativeClassId: "class-a", name: "Screen", tokenHash: hash("original-screen-token"),
        isActive: true, deviceFingerprint: "test-device", credentialVersion: 1, lastUsedAt: new Date(),
        administrativeClass: {id: "class-a", isActive: true, termId: "term", gradeId: "grade", subjectRules: [], term: {status: "ACTIVE"}}};
});
const accountHeaders = id => ({Authorization: `Bearer ${generateAccessToken(accounts.get(id))}`});
const screenHeaders = {"X-Classworks-Screen-Token": "original-screen-token"};
const profile = "/api/v2/admin/schools/school/profile";
const management = "/api/v2/admin/schools/school/classroom-screens/screen-a";
async function request(path, headers, method = "GET", body) {
    return fetch(origin + path, {method, headers: {"Content-Type": "application/json", ...headers},
        ...(body ? {body: JSON.stringify(body)} : {})});
}
async function assertScreenRejected() {
    const previousWrites = writes;
    for (const [path, method, body] of [
        ["students", "GET"], ["feed", "GET"], ["session", "GET"], ["heartbeat", "POST", {}],
        ["publications", "POST", {content: "previously queued work", targetWorkspaceIds: ["class-a"], clientRequestId: "stable-offline-request"}],
    ]) {
        const response = await request(`/api/v2/classroom-screens/${path}`, screenHeaders, method, body);
        assert.equal(response.status, 401, path);
        assert.equal((await response.json()).code, "SCREEN_TOKEN_INVALID", path);
    }
    assert.equal(writes, previousWrites);
}
test("disabling a screen rejects its previously accepted token, including pending uploads", async () => {
    assert.equal((await request("/api/v2/classroom-screens/students", screenHeaders)).status, 200);
    assert.equal((await request(management, accountHeaders("owner"), "PATCH", {isActive: false})).status, 200);
    assert.equal(binding.isActive, false);
    await assertScreenRejected();
});
test("resetting a screen device rotates the token and rejects old queued uploads", async () => {
    assert.equal((await request("/api/v2/classroom-screens/students", screenHeaders)).status, 200);
    assert.equal((await request(management + "/reset-device", accountHeaders("owner"), "POST", {})).status, 200);
    assert.notEqual(binding.tokenHash, hash("original-screen-token"));
    assert.equal(binding.deviceFingerprint, null);
    await assertScreenRejected();
});
for (const operation of ["demote", "remove"]) {
    test(`an already-issued administrator JWT loses management access immediately after ${operation}`, async () => {
        const oldSession = accountHeaders("admin");
        assert.equal((await request(profile, oldSession)).status, 200);
        const membersPath = "/api/v2/admin/schools/school/members";
        const response = operation === "demote"
            ? await request(membersPath, accountHeaders("owner"), "PUT", {accountId: "admin", role: "VIEWER"})
            : await request(membersPath + "/admin", accountHeaders("owner"), "DELETE");
        assert.equal(response.status, operation === "remove" ? 204 : 200);
        const previousWrites = writes;
        assert.equal((await request(profile, oldSession)).status, 403);
        assert.equal((await request(profile, oldSession, "PATCH", {name: "unauthorized change"})).status, 403);
        assert.equal((await request(management + "/reset-device", oldSession, "POST", {})).status, 403);
        assert.equal(writes, previousWrites);
        assert.equal(school.name, "Test school");
        assert.equal((await request(profile, accountHeaders("owner"))).status, 200);
    });
}
