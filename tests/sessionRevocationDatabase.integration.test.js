import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import test from "node:test";
import {setTimeout as delay} from "node:timers/promises";

const enabled = process.env.RUN_DATABASE_TESTS === "true";
const hash = value => createHash("sha256").update(value).digest("hex");

async function eventually(check, message) {
    const deadline = Date.now() + 3500;
    do {
        const result = await check();
        if (result) return result;
        await delay(15);
    } while (Date.now() < deadline);
    assert.fail(message);
}

test("persisted revocation and concurrent queued uploads use real HTTP and PostgreSQL", {skip: !enabled, timeout: 60000}, async t => {
    const database = new URL(process.env.DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname), "test database must be local");
    assert.match(database.pathname, /^\/npclassworks_test(?:_[a-z0-9_]+)?$/, "only an explicitly named disposable test database is allowed");
    const [{prisma}, {default: express}, {default: adminRouter}, {default: screenRouter}, {generateAccessToken}, {Client}] = await Promise.all([
        import("../utils/prisma.js"), import("express"), import("../routes/v2/academic-admin.js"),
        import("../routes/v2/classroom-screens.js"), import("../utils/tokenManager.js"), import("pg"),
    ]);
    const app = express();
    app.use(express.json());
    app.use("/api/v2/admin", adminRouter);
    app.use("/api/v2/classroom-screens", screenRouter);
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({code: error.code, message: error.message}));
    const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const observer = new Client({connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 8000});
    await observer.connect();
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await observer.end();
        await prisma.$disconnect();
    });

    async function request(path, headers, method = "GET", body) {
        const response = await fetch(origin + path, {method, signal: AbortSignal.timeout(10000),
            headers: {"Content-Type": "application/json", ...headers},
            ...(body === undefined ? {} : {body: JSON.stringify(body)})});
        return {status: response.status, body: response.status === 204 ? null : await response.json()};
    }

    async function fixture() {
        const suffix = randomUUID();
        const school = await prisma.school.create({data: {code: `REVOKE-${suffix}`, name: "撤销权限测试学校"}});
        const accounts = [];
        for (const role of ["OWNER", "ADMIN"]) {
            const account = await prisma.account.create({data: {provider: "integration-test", providerId: `${suffix}-${role}`}});
            accounts.push(account);
            await prisma.schoolMember.create({data: {schoolId: school.id, accountId: account.id, role}});
        }
        const term = await prisma.academicTerm.create({data: {schoolId: school.id, name: "测试学期", academicYear: 2099, semester: 1, status: "ACTIVE"}});
        const subject = await prisma.subject.create({data: {schoolId: school.id, code: "math", name: "数学"}});
        const workspace = await prisma.workspace.create({data: {termId: term.id, code: "C1", name: "测试班", type: "ADMIN_CLASS",
            subjectRules: {create: {subjectId: subject.id, deliveryMode: "ADMIN_CLASS"}}}});
        const token = randomUUID();
        const binding = await prisma.classroomScreenBinding.create({data: {
            schoolId: school.id, administrativeClassId: workspace.id, name: "测试大屏", tokenHash: hash(token),
            deviceFingerprint: `device-${suffix}`, activatedAt: new Date(), lastUsedAt: new Date(), createdByAccountId: accounts[0].id,
        }});
        const management = `/api/v2/admin/schools/${school.id}/classroom-screens/${binding.id}`;
        const profile = `/api/v2/admin/schools/${school.id}/profile`;
        const ownerHeaders = {Authorization: `Bearer ${generateAccessToken(accounts[0])}`};
        const adminHeaders = {Authorization: `Bearer ${generateAccessToken(accounts[1])}`};
        const screenHeaders = {"X-Classworks-Screen-Token": token};
        const input = {clientRequestId: randomUUID(), subjectId: subject.id, content: "离线待上传作业",
            targetWorkspaceIds: [workspace.id], boardDate: "2099-01-01", publishAt: "2099-01-01T08:00:00.000Z", allowDuplicate: true};
        return {
            school, accounts, binding, token, input, ownerHeaders, adminHeaders, screenHeaders, management, profile,
            upload: (data = input) => request("/api/v2/classroom-screens/publications", screenHeaders, "POST", data),
            revoke: operation => operation === "disable"
                ? request(management, ownerHeaders, "PATCH", {isActive: false})
                : request(management + "/reset-device", ownerHeaders, "POST", {}),
            async cleanup() {
                const publications = await prisma.publication.findMany({where: {subjectId: subject.id}, select: {id: true}});
                const ids = publications.map(item => item.id);
                await prisma.publicationRevision.deleteMany({where: {publicationId: {in: ids}}});
                await prisma.publicationTarget.deleteMany({where: {publicationId: {in: ids}}});
                await prisma.publication.deleteMany({where: {id: {in: ids}}});
                await prisma.auditLog.deleteMany({where: {schoolId: school.id}});
                await prisma.classroomScreenBinding.deleteMany({where: {schoolId: school.id}});
                await prisma.administrativeClassSubject.deleteMany({where: {subjectId: subject.id}});
                await prisma.workspace.delete({where: {id: workspace.id}});
                await prisma.subject.delete({where: {id: subject.id}});
                await prisma.academicTerm.delete({where: {id: term.id}});
                await prisma.schoolMember.deleteMany({where: {schoolId: school.id}});
                await prisma.school.delete({where: {id: school.id}});
                await prisma.account.deleteMany({where: {id: {in: accounts.map(account => account.id)}}});
            },
        };
    }

    async function gate(query, parameters) {
        const client = new Client({connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 8000});
        await client.connect();
        await client.query("BEGIN");
        const {rows: [{pid}]} = await client.query("SELECT pg_backend_pid() AS pid");
        await client.query(query, parameters);
        let released = false;
        return {pid, async release() {
            if (released) return;
            released = true;
            try { await client.query("ROLLBACK"); } finally { await client.end(); }
        }};
    }

    async function waitBlockedBy(pid, pattern) {
        return eventually(async () => {
            const result = await observer.query("SELECT pid, query FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [pid]);
            return result.rows.find(row => pattern.test(row.query));
        }, `expected a database query blocked by ${pid}: ${pattern}`);
    }

    for (const operation of ["disable", "reset"]) {
        await t.test(`${operation} persists and rejects previously accepted tokens without new publication rows`, async () => {
            const f = await fixture();
            try {
                const baseline = await f.upload();
                assert.equal(baseline.status, 201, JSON.stringify(baseline.body));
                assert.equal((await f.revoke(operation)).status, 200);
                const persisted = await prisma.classroomScreenBinding.findUnique({where: {id: f.binding.id}});
                if (operation === "disable") assert.equal(persisted.isActive, false);
                else {
                    assert.notEqual(persisted.tokenHash, hash(f.token));
                    assert.equal(persisted.deviceFingerprint, null);
                    assert.equal(persisted.credentialVersion, f.binding.credentialVersion + 1);
                }
                for (const endpoint of ["session", "feed", "students"]) {
                    const result = await request(`/api/v2/classroom-screens/${endpoint}`, f.screenHeaders);
                    assert.equal(result.status, 401);
                    assert.equal(result.body.code, "SCREEN_TOKEN_INVALID");
                }
                for (const input of [f.input, {...f.input, clientRequestId: randomUUID()}]) {
                    assert.equal((await f.upload(input)).status, 401);
                }
                assert.equal(await prisma.publication.count({where: {creationScreenBindingId: f.binding.id}}), 1);
                assert.equal(await prisma.publicationRevision.count({where: {screenBindingId: f.binding.id}}), 1);
            } finally { await f.cleanup(); }
        });

        for (const replay of [false, true]) await t.test(`${operation} rejects an authenticated ${replay ? "idempotent replay" : "new upload"} waiting on its request lock`, async () => {
            const f = await fixture();
            if (replay) assert.equal((await f.upload()).status, 201);
            const lockKey = JSON.stringify([f.binding.id, f.input.clientRequestId]);
            const blocker = await gate("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
            let upload;
            try {
                upload = f.upload();
                await waitBlockedBy(blocker.pid, /pg_advisory_xact_lock/);
                assert.equal((await f.revoke(operation)).status, 200);
                await blocker.release();
                const result = await upload;
                assert.equal(result.status, 401, `revocation already committed: ${JSON.stringify(result)}`);
                assert.equal(result.body.code, "SCREEN_TOKEN_INVALID");
                assert.equal(await prisma.publication.count({where: {creationScreenBindingId: f.binding.id}}), replay ? 1 : 0);
                assert.equal(await prisma.publicationRevision.count({where: {screenBindingId: f.binding.id}}), replay ? 1 : 0);
            } finally {
                await blocker.release();
                if (upload) await upload.catch(() => {});
                await f.cleanup();
            }
        });

        await t.test(`${operation} also rejects a stale upload without a client request ID`, async () => {
            const f = await fixture();
            const blocker = await gate('LOCK TABLE "Subject" IN ACCESS EXCLUSIVE MODE');
            let upload;
            try {
                const {clientRequestId: _requestId, ...input} = f.input;
                upload = f.upload(input);
                await waitBlockedBy(blocker.pid, /FROM.*"Subject"/s);
                assert.equal((await f.revoke(operation)).status, 200);
                await blocker.release();
                const result = await upload;
                assert.equal(result.status, 401, JSON.stringify(result));
                assert.equal(result.body.code, "SCREEN_TOKEN_INVALID");
                assert.equal(await prisma.publication.count({where: {latestScreenBindingId: f.binding.id}}), 0);
                assert.equal(await prisma.publicationRevision.count({where: {screenBindingId: f.binding.id}}), 0);
            } finally {
                await blocker.release();
                if (upload) await upload.catch(() => {});
                await f.cleanup();
            }
        });

        await t.test(`an upload already holding its authorization lock commits once before ${operation}`, async () => {
            const f = await fixture();
            const blocker = await gate('LOCK TABLE "Publication" IN SHARE MODE');
            let upload, revocation;
            try {
                upload = f.upload();
                const writer = await waitBlockedBy(blocker.pid, /INSERT INTO.*"Publication"/s);
                revocation = f.revoke(operation);
                await waitBlockedBy(writer.pid, /UPDATE.*"ClassroomScreenBinding"/s);
                await blocker.release();
                assert.equal((await upload).status, 201);
                assert.equal((await revocation).status, 200);
                assert.equal((await f.upload()).status, 401);
                assert.equal(await prisma.publication.count({where: {creationScreenBindingId: f.binding.id}}), 1);
                assert.equal(await prisma.publicationRevision.count({where: {screenBindingId: f.binding.id}}), 1);
            } finally {
                await blocker.release();
                await Promise.allSettled([upload, revocation].filter(Boolean));
                await f.cleanup();
            }
        });
    }

    for (const operation of ["demote", "remove"]) {
        await t.test(`${operation} persists and an existing administrator JWT loses management access`, async () => {
            const f = await fixture();
            try {
                assert.equal((await request(f.profile, f.adminHeaders)).status, 200);
                const members = `/api/v2/admin/schools/${f.school.id}/members`;
                const response = operation === "demote"
                    ? await request(members, f.ownerHeaders, "PUT", {accountId: f.accounts[1].id, role: "VIEWER"})
                    : await request(`${members}/${f.accounts[1].id}`, f.ownerHeaders, "DELETE");
                assert.equal(response.status, operation === "demote" ? 200 : 204);
                const membership = await prisma.schoolMember.findUnique({where: {schoolId_accountId: {schoolId: f.school.id, accountId: f.accounts[1].id}}});
                assert.equal(membership?.role ?? null, operation === "demote" ? "VIEWER" : null);
                for (const [path, method, body] of [[f.profile, "GET"], [f.profile, "PATCH", {name: "unauthorized"}],
                    [f.management + "/reset-device", "POST", {}]]) {
                    const result = await request(path, f.adminHeaders, method, body);
                    assert.equal(result.status, 403);
                    assert.equal(result.body.code, "SCHOOL_ADMIN_REQUIRED");
                }
                assert.equal((await prisma.school.findUnique({where: {id: f.school.id}})).name, f.school.name);
                assert.equal((await prisma.classroomScreenBinding.findUnique({where: {id: f.binding.id}})).tokenHash, hash(f.token));
                assert.equal((await request(f.profile, f.ownerHeaders)).status, 200);
            } finally { await f.cleanup(); }
        });
    }
});
