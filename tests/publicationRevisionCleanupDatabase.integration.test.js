import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {setTimeout as delay} from "node:timers/promises";

const enabled = process.env.RUN_DATABASE_TESTS === "true";

test("revision cleanup advances pages and serializes with reactivation", {skip: !enabled, timeout: 60000}, async t => {
    const database = new URL(process.env.DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
    assert.match(database.pathname, /^\/npclassworks_test(?:_[a-z0-9_]+)?$/);
    const [{prisma}, {purgeExpiredDisabledPublicationRevisions: purge}, {Client}] = await Promise.all([
        import("../utils/prisma.js"), import("../services/publicationRevisionCleanupService.js"), import("pg"),
    ]);
    const now = new Date("2099-06-01T00:00:00Z");
    const old = new Date("2099-05-01T00:00:00Z");
    const observer = new Client({connectionString: process.env.DATABASE_URL, query_timeout: 8000});
    await observer.connect();
    t.after(async () => { await observer.end(); await prisma.$disconnect(); });
    async function waitingFor(pid, table) {
        const deadline = Date.now() + 3500;
        do {
            const {rows} = await observer.query(`SELECT pid FROM pg_stat_activity
                WHERE $1::int = ANY(pg_blocking_pids(pid)) AND query LIKE $2`, [pid, `%${table}%`]);
            if (rows.length) return rows[0].pid;
            await delay(15);
        } while (Date.now() < deadline);
        assert.fail(`no ${table} query blocked by ${pid}`);
    }
    async function fixture() {
        const school = await prisma.school.create({data: {code: `CLEAN-${randomUUID()}`, name: "历史清理测试"}});
        const term = await prisma.academicTerm.create({data: {schoolId: school.id, name: "测试学期", academicYear: 2099, semester: 1}});
        const subject = await prisma.subject.create({data: {schoolId: school.id, code: "math", name: "数学"}});
        const workspace = await prisma.workspace.create({data: {termId: term.id, code: "C1", name: "测试班", type: "ADMIN_CLASS", isActive: false}});
        const active = await prisma.workspace.create({data: {termId: term.id, code: "C2", name: "启用班", type: "ADMIN_CLASS"}});
        const publication = await prisma.publication.create({data: {type: "ASSIGNMENT", subjectId: subject.id, content: "当前内容", revision: 1000}});
        async function revision(number, extra = {}) {
            return prisma.publicationRevision.create({data: {
                publicationId: publication.id, revision: number, action: "UPDATED", actorType: "ACCOUNT",
                snapshot: {type: "ASSIGNMENT", subjectId: subject.id, status: "PUBLISHED", content: "历史内容", targetWorkspaceIds: [workspace.id]},
                createdAt: old, ...extra,
            }});
        }
        return {workspace, active, publication, subject, revision, async close() {
            await prisma.publication.delete({where: {id: publication.id}});
            await prisma.workspace.deleteMany({where: {termId: term.id}});
            await prisma.subject.delete({where: {id: subject.id}});
            await prisma.academicTerm.delete({where: {id: term.id}});
            await prisma.school.delete({where: {id: school.id}});
        }};
    }
    async function gate(sql, args = []) {
        const client = new Client({connectionString: process.env.DATABASE_URL, query_timeout: 8000});
        await client.connect(); await client.query("BEGIN");
        const {rows: [{pid}]} = await client.query("SELECT pg_backend_pid() AS pid");
        await client.query(sql, args);
        let done = false;
        return {client, pid, async release(commit = false) {
            if (done) return;
            done = true;
            try { await client.query(commit ? "COMMIT" : "ROLLBACK"); } finally { await client.end(); }
        }};
    }
    await t.test("more than 200 retained candidates cannot starve later eligible revisions, even with tied timestamps", async () => {
        const f = await fixture();
        try {
            const retained = [];
            for (let i = 1; i <= 201; i++) {
                retained.push(await f.revision(i, {id: `page-a-${String(i).padStart(3, "0")}-${f.publication.id}`,
                    snapshot: {type: "ASSIGNMENT", subjectId: f.subject.id, targetWorkspaceIds: [f.active.id], content: "仍需保留"}}));
            }
            const later = await f.revision(202, {id: `page-z-${f.publication.id}`});
            assert.equal((await purge({now})).purged, 1);
            assert.equal((await prisma.publicationRevision.findUnique({where: {id: later.id}})).snapshot.purged, true);
            assert.equal(await prisma.publicationRevision.count({where: {id: {in: retained.map(row => row.id)}, purgedAt: null}}), 201);
            assert.equal((await purge({now, limit: 2})).purged, 0);
        } finally { await f.close(); }
    });
    await t.test("page advancement survives purged cursor rows and preserves current, certified, recent and notification history", async () => {
        const f = await fixture();
        try {
            const a = await f.revision(1);
            const b = await f.revision(2);
            await observer.query(`UPDATE "PublicationRevision" SET "createdAt" = "createdAt" + interval '123 microseconds' WHERE "publicationId" = $1`, [f.publication.id]);
            const current = await f.revision(1000);
            const certified = await f.revision(3, {isCertified: true});
            const recent = await f.revision(4, {createdAt: now});
            const notification = await f.revision(5, {snapshot: {type: "NOTIFICATION", subjectId: f.subject.id, targetWorkspaceIds: [f.workspace.id], content: "通知"}});
            assert.equal((await purge({now, limit: 1})).purged, 2);
            for (const row of [a, b]) assert.ok((await prisma.publicationRevision.findUnique({where: {id: row.id}})).purgedAt);
            for (const row of [current, certified, recent, notification]) {
                assert.deepEqual(await prisma.publicationRevision.findUnique({where: {id: row.id}}), row);
            }
        } finally { await f.close(); }
    });
    await t.test("unknown, malformed and partly active targets are retained", async () => {
        const f = await fixture();
        try {
            const rows = [];
            for (const ids of [[f.workspace.id, "missing"], [f.workspace.id, null], [f.workspace.id, f.active.id], []]) {
                rows.push(await f.revision(rows.length + 1, {snapshot: {type: "ASSIGNMENT", subjectId: f.subject.id, targetWorkspaceIds: ids, content: "需保留"}}));
            }
            assert.equal((await purge({now, limit: 1})).purged, 0);
            for (const row of rows) assert.deepEqual(await prisma.publicationRevision.findUnique({where: {id: row.id}}), row);
        } finally { await f.close(); }
    });
    for (const change of ["certified", "current"]) {
        await t.test(`a revision made ${change} before cleanup's locked check is retained`, async () => {
            const f = await fixture();
            let lock, cleanup;
            try {
                const row = await f.revision(1);
                const table = change === "certified" ? "PublicationRevision" : "Publication";
                const id = change === "certified" ? row.id : f.publication.id;
                lock = await gate(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, [id]);
                cleanup = purge({now});
                await waitingFor(lock.pid, table);
                if (change === "certified") {
                    await lock.client.query('UPDATE "PublicationRevision" SET "isCertified" = true WHERE id = $1', [id]);
                } else {
                    await lock.client.query('UPDATE "Publication" SET revision = 1 WHERE id = $1', [id]);
                }
                await lock.release(true);
                assert.equal((await cleanup).purged, 0);
                const result = await prisma.publicationRevision.findUnique({where: {id: row.id}});
                assert.deepEqual(result.snapshot, row.snapshot);
                assert.equal(result.purgedAt, null);
            } finally { await lock?.release(); await cleanup?.catch(() => {}); await f.close(); }
        });
    }
    await t.test("reactivation committed before cleanup writes preserves the original snapshot", async () => {
        const f = await fixture();
        let lock, cleanup;
        try {
            const row = await f.revision(1);
            lock = await gate('SELECT id FROM "PublicationRevision" WHERE id = $1 FOR UPDATE', [row.id]);
            cleanup = purge({now});
            await waitingFor(lock.pid, "PublicationRevision");
            await lock.client.query('UPDATE "Workspace" SET "isActive" = true WHERE id = $1', [f.workspace.id]);
            await lock.release(true);
            assert.equal((await cleanup).purged, 0);
            assert.deepEqual(await prisma.publicationRevision.findUnique({where: {id: row.id}}), row);
        } finally { await lock?.release(); await cleanup?.catch(() => {}); await f.close(); }
    });
    await t.test("cleanup holding target locks finishes before a waiting reactivation", async () => {
        const f = await fixture();
        let lock, cleanup, activation;
        try {
            const row = await f.revision(1);
            lock = await gate('LOCK TABLE "PublicationRevision" IN SHARE MODE');
            cleanup = purge({now});
            const writer = await waitingFor(lock.pid, "PublicationRevision");
            activation = prisma.workspace.update({where: {id: f.workspace.id}, data: {isActive: true}}).then(value => value);
            await waitingFor(writer, "Workspace");
            await lock.release();
            assert.equal((await cleanup).purged, 1);
            assert.equal((await activation).isActive, true);
            assert.ok((await prisma.publicationRevision.findUnique({where: {id: row.id}})).purgedAt);
        } finally { await lock?.release(); await cleanup?.catch(() => {}); await activation?.catch(() => {}); await f.close(); }
    });
});
