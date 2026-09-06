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

test("history pagination keeps route authorization and validates cursor parameters", async () => {
    assert.equal((await get("/api/v2/publications/draft/revisions?limit=20")).status, 403);
    const response = await get("/api/v2/publications/published/revisions?limit=20");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.items.length, 1);
    for (const query of ["limit=101", "limit=1&limit=2", "beforeRevision=0", "beforeRevision=abc"]) {
        assert.equal((await get("/api/v2/publications/published/revisions?" + query)).status, 400);
    }
    const headers = {"X-Classworks-Screen-Token": "screen-token"};
    items.find(item => item.id === "published").targets = [{workspaceId: "class-a", workspace: workspaces[0]}];
    const url = origin + "/api/v2/classroom-screens/publications/published/revisions?limit=20";
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, {headers})).status, 200);
    const blocked = items.find(item => item.id === "published");
    blocked.targets = [{workspaceId: "other-school", workspace: {id: "other-school", type: "ADMIN_CLASS"}}];
    assert.equal((await fetch(url, {headers})).status, 403);
});


test("weekly HTTP feeds keep classroom token scope and pass bounded date filters to storage", async t => {
    let query;
    const mock = {method(object, name, value) {
        const original = object[name]; object[name] = value; t.after(() => { object[name] = original; });
    }};
    mock.method(prisma.publication, "findMany", async args => { query = args; return []; });
    mock.method(prisma.publication, "count", async () => 0);
    mock.method(prisma.publication, "findFirst", async () => null);
    const suffix = "?weekStart=2026-09-07&weekView=due&limit=2&skip=3";
    const screenUrl = origin + "/api/v2/classroom-screens/feed" + suffix + "&workspaceIds=group";
    assert.equal((await fetch(screenUrl)).status, 401);
    const screen = await fetch(screenUrl, {headers: {"X-Classworks-Screen-Token": "screen-token"}});
    assert.equal(screen.status, 200);
    const body = (await screen.json()).data;
    assert.equal(body.weekStart, "2026-09-07"); assert.equal(body.weekView, "due");
    assert.deepEqual(query.where.targets.some.workspaceId.in, ["class-a"]);
    assert.equal(query.where.status, "PUBLISHED");
    assert.ok(query.where.publishAt.lte instanceof Date);
    assert.deepEqual(query.where.OR, [{type: "ASSIGNMENT", dueAt: {
        gte: new Date("2026-09-06T16:00:00Z"), lt: new Date("2026-09-13T16:00:00Z"),
    }}]);
    assert.equal(query.take, 2); assert.equal(query.skip, 3);
    assert.deepEqual(query.orderBy.at(-1), {id: "asc"});
    const publicUrl = origin + "/api/v2/publications/feed?workspaceIds=group&weekStart=2026-09-07&weekView=board";
    assert.equal((await fetch(publicUrl)).status, 200);
    assert.deepEqual(query.where.targets.some.workspaceId.in, ["group"]);
    assert.deepEqual(query.where.OR, [{type: "ASSIGNMENT", boardDate: {
        gte: new Date("2026-09-07T00:00:00Z"), lt: new Date("2026-09-14T00:00:00Z"),
    }}]);
    assert.equal((await fetch(publicUrl.replace("2026-09-07", "2026-02-30"))).status, 422);
    assert.equal((await fetch(publicUrl.replace("weekView=board", "weekView=bad"))).status, 422);
});
