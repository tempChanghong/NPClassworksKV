import assert from "node:assert/strict";
import {before, after, beforeEach, test, mock} from "node:test";
import express from "express";
import {createHmac, createHash} from "node:crypto";
import {prisma} from "../utils/prisma.js";
import {generateAccessToken} from "../utils/tokenManager.js";
import adminRouter from "../routes/v2/academic-admin.js";
import screenRouter from "../routes/v2/classroom-screens.js";
import meRouter from "../routes/v2/academic-me.js";
import setupRouter from "../routes/v2/setup.js";

let server, origin, members, school, writes, screenActive;
const restore = [];
function stub(object, method, implementation) {
    const original = object[method];
    object[method] = mock.fn(implementation);
    restore.push(() => { object[method] = original; });
}
const accounts = new Map(["owner", "admin", "teacher", "outsider"].map((id) =>
    [id, {id, name: id, provider: "school-local", providerId: "TEST:" + id, localPasswordHash: "original-hash", tokenVersion: 1}]));
const token = (id) => generateAccessToken(accounts.get(id));
const key = (schoolId, accountId) => schoolId + ":" + accountId;

before(async () => {
    stub(prisma.account, "findUnique", async ({where}) => where.id ? accounts.get(where.id) || null : [...accounts.values()].find((a) => a.providerId === where.provider_providerId?.providerId) || null);
    stub(prisma.schoolMember, "findUnique", async ({where}) => {
        const {schoolId, accountId} = where.schoolId_accountId;
        return members.get(key(schoolId, accountId)) || null;
    });
    stub(prisma.schoolMember, "findMany", async ({where, include}) =>
        [...members.values()].filter((m) => (!where.schoolId || m.schoolId === where.schoolId) && (!where.accountId || m.accountId === where.accountId))
            .map((m) => include?.school ? {...m, school: {...school, terms: []}} : m));
    stub(prisma.schoolMember, "count", async ({where}) =>
        [...members.values()].filter((m) => m.schoolId === where.schoolId && m.role === where.role).length);
    stub(prisma.schoolMember, "upsert", async ({where, update, create}) => {
        writes++;
        const k = key(where.schoolId_accountId.schoolId, where.schoolId_accountId.accountId);
        const m = members.has(k) ? {...members.get(k), ...update} : create;
        members.set(k, m); return m;
    });
    stub(prisma.schoolMember, "delete", async ({where}) => {
        writes++; members.delete(key(where.schoolId_accountId.schoolId, where.schoolId_accountId.accountId));
    });
    stub(prisma.school, "findUnique", async ({where}) => where.id === "school-a" ? school : null);
    stub(prisma.school, "update", async ({data}) => { writes++; Object.assign(school, data); return school; });
    stub(prisma.auditLog, "create", async () => ({}));
    stub(prisma, "$transaction", async (fn) => fn(prisma));
    stub(prisma, "$queryRaw", async () => [{id: "school-a"}]);
    stub(prisma.classroomScreenBinding, "findUnique", async ({where}) => where.tokenHash === createHash("sha256").update("screen-token").digest("hex") ? {
        id: "screen-a", administrativeClassId: "class-a", schoolId: "school-a", isActive: screenActive, lastUsedAt: new Date(),
        administrativeClass: {id: "class-a", isActive: true, termId: "term", gradeId: "grade", subjectRules: [], term: {status: "ACTIVE"}},
    } : null);
    stub(prisma.administrativeClassStudent, "findMany", async ({where}) => [{id: "student", administrativeClassId: where.administrativeClassId}]);
    stub(prisma.workspace, "findMany", async () => [{id: "class-b", termId: "term", gradeId: "grade", type: "ADMIN_CLASS", code: "G1-C1", isActive: true}]);
    stub(prisma.academicTerm, "findFirst", async () => ({id: "term", name: "测试学期"}));
    stub(prisma.account, "upsert", async () => { writes++; return accounts.get("owner"); });
    const app = express();
    app.use(express.json());
    app.use("/api/v2/admin", adminRouter);
    app.use("/api/v2/classroom-screens", screenRouter);
    app.use("/api/v2/setup", setupRouter);
    app.use("/api/v2/me", meRouter);
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({code: error.code, message: error.message}));
    server = await new Promise((done) => { const s = app.listen(0, "127.0.0.1", () => done(s)); });
    origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => { if (server) await new Promise((done) => server.close(done)); restore.reverse().forEach((fn) => fn()); });
beforeEach(() => {
    writes = 0; screenActive = true;
    members = new Map([["owner", "OWNER"], ["admin", "ADMIN"], ["teacher", "VIEWER"]].map(([accountId, role]) =>
        [key("school-a", accountId), {schoolId: "school-a", accountId, role}]));
    school = {id: "school-a", name: "测试学校", code: "TEST", teacherAuthMode: "LOCAL_PIN", teacherSharedPasswordHash: "private-hash"};
});
async function request(path, {actor, headers = {}, method = "GET", body} = {}) {
    return fetch(origin + path, {method, headers: {...(actor ? {Authorization: "Bearer " + token(actor)} : {}),
        "Content-Type": "application/json", ...headers}, ...(body ? {body: JSON.stringify(body)} : {})});
}
const profile = "/api/v2/admin/schools/school-a/profile";
test("management HTTP rejects anonymous, invalid and screen credentials", async () => {
    for (const headers of [{}, {Authorization: "Bearer invalid"}, {"X-Classworks-Screen-Token": "screen-token"},
        {Authorization: "Screen screen-token"}, {Authorization: "Bearer screen-token"}]) {
        assert.equal((await request(profile, {headers})).status, 401);
    }
    assert.equal(writes, 0);
});
test("teacher and another school's administrator cannot read or mutate school administration", async () => {
    members.set(key("school-b", "outsider"), {schoolId: "school-b", accountId: "outsider", role: "ADMIN"});
    for (const actor of ["teacher", "outsider"]) {
        for (const path of [profile, "/api/v2/admin/schools/school-a/members", "/api/v2/admin/schools/school-a/local-accounts",
            "/api/v2/admin/schools/school-a/classroom-screens", "/api/v2/admin/schools/school-a/audit-logs"]) {
            const res = await request(path, {actor});
            assert.equal(res.status, 403, actor + " " + path);
            assert.equal((await res.json()).code, "SCHOOL_ADMIN_REQUIRED");
        }
        assert.equal((await request(profile, {actor, method: "PATCH", body: {name: "unauthorized"}})).status, 403);
    }
    assert.equal(writes, 0); assert.equal(school.name, "测试学校");
});
test("school ADMIN and OWNER can read management profile without receiving password hashes", async () => {
    for (const actor of ["admin", "owner"]) {
        const res = await request(profile, {actor});
        assert.equal(res.status, 200);
        const {data} = await res.json();
        assert.equal(data.hasSharedTeacherPassword, true);
        assert.equal(data.teacherSharedPasswordHash, undefined);
    }
    assert.equal((await request(profile, {actor: "admin", method: "PATCH", body: {name: "authorized"}})).status, 200);
    assert.equal(school.name, "authorized");
});
test("ADMIN cannot grant OWNER, demote OWNER or delete OWNER", async () => {
    const path = "/api/v2/admin/schools/school-a/members";
    for (const body of [{accountId: "teacher", role: "OWNER"}, {accountId: "owner", role: "VIEWER"}]) {
        const res = await request(path, {actor: "admin", method: "PUT", body});
        assert.equal(res.status, 403);
        assert.equal((await res.json()).code, "SCHOOL_OWNER_REQUIRED");
    }
    assert.equal((await request(path + "/owner", {actor: "admin", method: "DELETE"})).status, 403);
    assert.equal(members.get(key("school-a", "owner")).role, "OWNER"); assert.equal(writes, 0);
});
test("last OWNER cannot demote or delete themselves; adding a successor enables demotion", async () => {
    const path = "/api/v2/admin/schools/school-a/members";
    assert.equal((await request(path, {actor: "owner", method: "PUT", body: {accountId: "owner", role: "ADMIN"}})).status, 409);
    assert.equal((await request(path + "/owner", {actor: "owner", method: "DELETE"})).status, 409);
    assert.equal(writes, 0);
    assert.equal((await request(path, {actor: "owner", method: "PUT", body: {accountId: "admin", role: "OWNER"}})).status, 200);
    assert.equal((await request(path, {actor: "owner", method: "PUT", body: {accountId: "owner", role: "ADMIN"}})).status, 200);
});
test("account credentials cannot substitute for a screen binding", async () => {
    assert.equal((await request("/api/v2/classroom-screens/session", {actor: "admin"})).status, 401);
});
test("setup endpoints reject tokens signed with an empty key when setup key is unconfigured", async () => {
    const previous = process.env.BOOTSTRAP_SETUP_KEY;
    delete process.env.BOOTSTRAP_SETUP_KEY;
    try {
        const body = Buffer.from(JSON.stringify({purpose: "classworks-instance-setup", exp: Math.floor(Date.now() / 1000) + 600})).toString("base64url");
        const signature = createHmac("sha256", "").update(body).digest("base64url");
        const res = await request("/api/v2/setup/organization/template", {headers: {"X-Classworks-Setup-Token": body + "." + signature}});
        assert.equal(res.status, 503);
        assert.equal((await res.json()).code, "SETUP_KEY_NOT_CONFIGURED");
    } finally { if (previous === undefined) delete process.env.BOOTSTRAP_SETUP_KEY; else process.env.BOOTSTRAP_SETUP_KEY = previous; }
});

test("valid screen reads only its bound roster and cannot publish to another classroom", async () => {
    const headers = {"X-Classworks-Screen-Token": "screen-token"};
    const res = await request("/api/v2/classroom-screens/students?administrativeClassId=class-b", {headers});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data[0].administrativeClassId, "class-a");
    const denied = await request("/api/v2/classroom-screens/publications", {headers, method: "POST", body: {targetWorkspaceIds: ["class-b"], content: "forbidden"}});
    assert.equal(denied.status, 403);
    assert.equal(writes, 0);
    screenActive = false;
    assert.equal((await request("/api/v2/classroom-screens/students", {headers})).status, 401);
});

test("ADMIN cannot overwrite an existing OWNER through administrator creation or teacher import", async () => {
    const create = await request("/api/v2/admin/schools/school-a/local-admins", {actor: "admin", method: "POST",
        body: {username: "owner", name: "attempt", pin: "123456", role: "ADMIN"}});
    assert.equal(create.status, 403);
    assert.equal((await create.json()).code, "SCHOOL_OWNER_REQUIRED");
    const imported = await request("/api/v2/admin/local-teachers/import", {actor: "admin", method: "POST",
        body: {schoolId: "school-a", assignmentPlan: {assignments: [{username: "owner", name: "attempt", pin: "123456", workspaceCodes: ["G1-C1"]}]}}});
    assert.equal(imported.status, 403);
    assert.equal((await imported.json()).code, "SCHOOL_OWNER_REQUIRED");
    assert.equal(writes, 0);
    assert.equal(accounts.get("owner").localPasswordHash, "original-hash");
});
test("VIEWER school context never returns shared password hashes", async () => {
    const res = await request("/api/v2/me/schools", {actor: "teacher"});
    assert.equal(res.status, 200);
    const {data} = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].school.id, "school-a");
    assert.equal(Object.hasOwn(data[0].school, "teacherSharedPasswordHash"), false);
});
