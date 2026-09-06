import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";

test("notification receipts remain monotonic in PostgreSQL", {skip: process.env.RUN_DATABASE_TESTS !== "true", timeout: 60000}, async t => {
    const url = new URL(process.env.DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.match(url.pathname, /^\/npclassworks_test(?:_[a-z0-9_]+)?$/);
    const {prisma} = await import("../utils/prisma.js");
    const {acknowledgeScreenNotifications: acknowledge} = await import("../services/notificationDeliveryService.js");
    const suffix = randomUUID();
    const account = await prisma.account.create({data: {provider: "integration-test", providerId: suffix}});
    const school = await prisma.school.create({data: {code: `RECEIPT-${suffix}`, name: "回执测试"}});
    const term = await prisma.academicTerm.create({data: {schoolId: school.id, name: "测试学期", academicYear: 2099, semester: 1, status: "ACTIVE"}});
    const workspace = await prisma.workspace.create({data: {termId: term.id, code: "C1", name: "测试班", type: "ADMIN_CLASS"}});
    const binding = await prisma.classroomScreenBinding.create({data: {
        schoolId: school.id, administrativeClassId: workspace.id, name: "测试屏", tokenHash: suffix, createdByAccountId: account.id,
    }, include: {administrativeClass: {include: {subjectRules: true}}}});
    const notice = await prisma.publication.create({data: {
        type: "NOTICE", content: "测试通知", status: "PUBLISHED", targets: {create: {workspaceId: workspace.id}},
    }});
    const key = {publicationId: notice.id, screenBindingId: binding.id};
    const get = () => prisma.notificationScreenDelivery.findUnique({where: {publicationId_screenBindingId: key}});
    const send = (revision, flags = {}) => acknowledge({screenBinding: binding, items: [{publicationId: notice.id, revision, ...flags}]});
    t.after(async () => {
        await prisma.publication.delete({where: {id: notice.id}});
        await prisma.classroomScreenBinding.delete({where: {id: binding.id}});
        await prisma.workspace.delete({where: {id: workspace.id}});
        await prisma.academicTerm.delete({where: {id: term.id}});
        await prisma.school.delete({where: {id: school.id}});
        await prisma.account.delete({where: {id: account.id}});
        await prisma.$disconnect();
    });
    async function reset(revision = 1) {
        await prisma.notificationScreenDelivery.deleteMany({where: key});
        await prisma.publication.update({where: {id: notice.id}, data: {revision, status: "PUBLISHED"}});
    }
    // Delay only entry into the first real transaction. All reads/writes still use
    // PostgreSQL. This deterministically exposes calculations made before entry.
    async function delayedTransaction(first, during) {
        const original = prisma.$transaction;
        let release, entered;
        const gate = new Promise(resolve => { release = resolve; });
        const ready = new Promise(resolve => { entered = resolve; });
        let intercepted = false;
        prisma.$transaction = async function (...args) {
            if (!intercepted) { intercepted = true; entered(); await gate; }
            return original.apply(prisma, args);
        };
        let pending;
        try {
            pending = first();
            await Promise.race([ready, pending.then(() => { throw new Error("receipt did not enter a transaction"); })]);
            await during();
            release();
            return await pending;
        } finally {
            release(); await pending?.catch(() => {}); prisma.$transaction = original;
        }
    }

    await t.test("a delayed received-only receipt cannot erase confirmation for the same new revision", async () => {
        await reset();
        await delayedTransaction(() => send(1), () => send(1, {acknowledged: true}));
        const row = await get();
        assert.ok(row.acknowledgedAt);
        assert.ok(row.displayedAt);
    });
    await t.test("old revision cannot overwrite a newer confirmed receipt", async () => {
        await reset();
        await delayedTransaction(() => send(1, {displayed: true}), async () => {
            await prisma.publication.update({where: {id: notice.id}, data: {revision: 2}});
            await send(2, {acknowledged: true});
        });
        const row = await get();
        assert.equal(row.revision, 2);
        assert.ok(row.acknowledgedAt);
    });
    await t.test("withdrawal while a receipt waits prevents a new delivery", async () => {
        await reset();
        const rows = await delayedTransaction(() => send(1), () =>
            prisma.publication.update({where: {id: notice.id}, data: {status: "WITHDRAWN"}}));
        assert.deepEqual(rows, []);
        assert.equal(await get(), null);
    });
    await t.test("many simultaneous receipts retain display and confirmation timestamps", async () => {
        await reset();
        await Promise.all(Array.from({length: 12}, (_, i) => send(1, {acknowledged: i === 0, displayed: i === 1})));
        const first = await get();
        assert.ok(first.acknowledgedAt); assert.ok(first.displayedAt);
        await send(1);
        const second = await get();
        assert.equal(second.acknowledgedAt.toISOString(), first.acknowledgedAt.toISOString());
        assert.equal(second.receivedAt.toISOString(), first.receivedAt.toISOString());
        await prisma.publication.update({where: {id: notice.id}, data: {revision: 2}});
        await send(2);
        const next = await get();
        assert.equal(next.revision, 2); assert.equal(next.acknowledgedAt, null); assert.equal(next.displayedAt, null);
    });
    await t.test("duplicate items in one batch retain the strongest acknowledgement", async () => {
        await reset();
        await acknowledge({screenBinding: binding, items: [
            {publicationId: notice.id, revision: 1, acknowledged: true},
            {publicationId: notice.id, revision: 1},
        ]});
        assert.ok((await get()).acknowledgedAt);
    });

    await t.test("revocation before transaction entry rejects a previously authenticated binding", async () => {
        await reset();
        try {
            await assert.rejects(delayedTransaction(() => send(1), () =>
                prisma.classroomScreenBinding.update({where: {id: binding.id}, data: {isActive: false}})),
            {code: "SCREEN_TOKEN_INVALID"});
            assert.equal(await get(), null);
        } finally {
            await prisma.classroomScreenBinding.update({where: {id: binding.id}, data: {isActive: true}});
        }
    });
    await t.test("wrong revision, non-notice and removed targets create no receipt", async () => {
        await reset();
        assert.deepEqual(await send(2), []);
        await prisma.publication.update({where: {id: notice.id}, data: {type: "ASSIGNMENT"}});
        assert.deepEqual(await send(1), []);
        await prisma.publication.update({where: {id: notice.id}, data: {type: "NOTICE"}});
        await prisma.publicationTarget.deleteMany({where: {publicationId: notice.id}});
        assert.deepEqual(await send(1), []);
        assert.equal(await get(), null);
    });

});
