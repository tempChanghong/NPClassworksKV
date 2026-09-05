import assert from "node:assert/strict";
import {before, after, beforeEach, test} from "node:test";
import express from "express";
import {createHash} from "node:crypto";
import {prisma} from "../utils/prisma.js";
import {generateAccessToken} from "../utils/tokenManager.js";
import publicationsRouter from "../routes/v2/publications.js";
import screenRouter from "../routes/v2/classroom-screens.js";

let server, origin, workspaces, items, history, provider, teacherMembership, leader, writes;
const restore = [];
function stub(object, method, fn) {
    const old = object[method]; object[method] = fn;
    restore.push(() => { object[method] = old; });
}
function match(item, where) {
    if (where.status && item.status !== where.status) return false;
    if (where.authorAccountId && item.authorAccountId !== where.authorAccountId) return false;
    if (where.OR && !where.OR.some((branch) => match(item, branch))) return false;
    const target = where.targets?.some?.workspaceId;
    if (target && !item.targets.some((t) => typeof target === "string" ? t.workspaceId === target : target.in.includes(t.workspaceId))) return false;
    return true;
}
before(async () => {
    stub(prisma.account, "findUnique", async () => ({id: "teacher", provider, tokenVersion: 1}));
    stub(prisma.workspaceMember, "findMany", async () => teacherMembership ? [{workspaceId: "group", role: "TEACHER"}] : []);
    stub(prisma.schoolMember, "findMany", async () => []);
    stub(prisma.gradeLeadership, "findMany", async () => []);
    stub(prisma.administrativeClassLeadership, "findMany", async () => leader ? [{administrativeClassId: "class-a"}] : []);
    stub(prisma.workspace, "findMany", async ({where}) => where.id?.in ? workspaces.filter((w) => where.id.in.includes(w.id)) : workspaces);
    stub(prisma.publication, "findMany", async ({where}) => items.filter((p) => match(p, where)));
    stub(prisma.publication, "count", async ({where}) => items.filter((p) => match(p, where)).length);
    stub(prisma.publication, "findUnique", async ({where}) => items.find((p) => p.id === where.id) || null);
    stub(prisma.publicationRevision, "findUnique", async () => history);
    stub(prisma.publicationRevision, "findMany", async () => [history]);
    stub(prisma.publication, "updateMany", async () => { writes++; return {count: 1}; });
    stub(prisma.auditLog, "create", async () => ({}));
    stub(prisma.classroomScreenBinding, "findUnique", async ({where}) =>
        where.tokenHash === createHash("sha256").update("screen-token").digest("hex") ? {
            id: "screen-a", schoolId: "school-a", administrativeClassId: "class-a", isActive: true, lastUsedAt: new Date(),
            administrativeClass: workspaces[0],
        } : null);
    const app = express(); app.use(express.json());
    app.use("/api/v2/publications", publicationsRouter);
    app.use("/api/v2/classroom-screens", screenRouter);
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({code: error.code, message: error.message}));
    server = await new Promise((done) => { const s = app.listen(0, "127.0.0.1", () => done(s)); });
    origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => { if (server) await new Promise((done) => server.close(done)); restore.reverse().forEach((fn) => fn()); });
beforeEach(() => {
    provider = "school-local"; teacherMembership = false; leader = true; writes = 0;
    const term = {schoolId: "school-a", status: "ACTIVE", school: {id: "school-a", teacherAuthMode: "LOCAL_PIN", allowOAuthTeacherLogin: false}};
    workspaces = [
        {id: "class-a", type: "ADMIN_CLASS", termId: "term", gradeId: "grade", isActive: true, term, subjectRules: [], sourceClasses: []},
        {id: "group", type: "COURSE_GROUP", termId: "term", gradeId: "grade", isActive: true, term, sourceClasses: [{administrativeClassId: "class-a"}]},
    ];
    items = [
        {id: "draft", status: "DRAFT", authorAccountId: "other", content: "other teacher draft"},
        {id: "published", status: "PUBLISHED", authorAccountId: "other", content: "public homework"},
        {id: "own-draft", status: "DRAFT", authorAccountId: "teacher", content: "own draft"},
    ].map((p) => ({...p, type: "ASSIGNMENT", targets: [{workspaceId: "group", workspace: workspaces[1]}]}));
    history = {revision: 1, snapshot: {type: "NOTICE", status: "PUBLISHED", targetWorkspaceIds: ["class-a"]}};
});
async function get(path) {
    return fetch(origin + path, {headers: {Authorization: "Bearer " + generateAccessToken({id: "teacher", provider, tokenVersion: 1})}});
}
test("read-only homeroom access sees published work but not other teachers' drafts in unscoped lists", async () => {
    assert.equal((await get("/api/v2/publications?workspaceId=group&status=DRAFT")).status, 403);
    assert.equal((await get("/api/v2/publications/draft")).status, 403);
    const res = await get("/api/v2/publications");
    assert.equal(res.status, 200);
    const {data} = await res.json();
    assert.deepEqual(data.items.map((p) => p.id), ["published", "own-draft"]);
    assert.equal(data.total, 2);
    assert.deepEqual((await (await get("/api/v2/publications?status=DRAFT")).json()).data.items.map((p) => p.id), ["own-draft"]);
});
test("writable teacher retains draft access, while disabled OAuth policy removes target-derived access", async () => {
    teacherMembership = true; leader = false;
    assert.deepEqual((await (await get("/api/v2/publications?status=DRAFT")).json()).data.items.map((p) => p.id), ["draft", "own-draft"]);
    provider = "github";
    const res = await get("/api/v2/publications");
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data.items.map((p) => p.id), ["own-draft"]);
});
test("screen rejects NOTICE history and restore, including a NOTICE snapshot on an assignment", async () => {
    const headers = {"X-Classworks-Screen-Token": "screen-token", "Content-Type": "application/json", "If-Match": '"2"'};
    items = [{id: "notice", type: "NOTICE", status: "PUBLISHED", revision: 2, targets: [{workspaceId: "class-a", workspace: workspaces[0]}]}];
    const path = origin + "/api/v2/classroom-screens/publications/notice";
    assert.equal((await fetch(path + "/revisions", {headers})).status, 409);
    const blocked = await fetch(path + "/restore", {method: "POST", headers, body: JSON.stringify({sourceRevision: 1})});
    assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, "SCREEN_PUBLICATION_NOT_EDITABLE");
    items[0].type = "ASSIGNMENT";
    assert.equal((await fetch(path + "/restore", {method: "POST", headers, body: JSON.stringify({sourceRevision: 1})})).status, 409);
    assert.equal(writes, 0);
    history.snapshot.type = "ASSIGNMENT";
    assert.equal((await fetch(path + "/revisions", {headers})).status, 200);
});
