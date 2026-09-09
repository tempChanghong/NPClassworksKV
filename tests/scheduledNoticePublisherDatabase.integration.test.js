import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {readFile} from "node:fs/promises";

test("scheduled notice publisher follows successful pre-release saves in PostgreSQL", {skip: process.env.RUN_DATABASE_TESTS !== "true", timeout: 60000}, async t => {
    const url = new URL(process.env.DATABASE_URL);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    assert.match(url.pathname, /^\/npclassworks_test(?:_[a-z0-9_]+)?$/);
    const [{prisma}, pub] = await Promise.all([import("../utils/prisma.js"), import("../services/publicationService.js")]);
    const suffix = randomUUID();
    const school = await prisma.school.create({data: {code: `PUBLISHER-${suffix}`, name: "定时通知发布人测试"}});
    const accounts = [], publicationIds = [];
    const term = await prisma.academicTerm.create({data: {schoolId: school.id, name: "测试学期", academicYear: 2099, semester: 1, status: "ACTIVE"}});
    const workspace = await prisma.workspace.create({data: {termId: term.id, code: "C1", name: "测试班", type: "ADMIN_CLASS"}});
    t.after(async () => {
        await prisma.publicationRevision.deleteMany({where: {publicationId: {in: publicationIds}}});
        await prisma.publicationTarget.deleteMany({where: {publicationId: {in: publicationIds}}});
        await prisma.publication.deleteMany({where: {id: {in: publicationIds}}});
        await prisma.workspace.delete({where: {id: workspace.id}});
        await prisma.academicTerm.delete({where: {id: term.id}});
        await prisma.schoolMember.deleteMany({where: {schoolId: school.id}});
        await prisma.school.delete({where: {id: school.id}});
        await prisma.account.deleteMany({where: {id: {in: accounts.map(a => a.id)}}});
        await prisma.$disconnect();
    });
    for (const name of ["管理员甲", "管理员乙", "管理员丙", "只读账号"]) {
        const account = await prisma.account.create({data: {provider: "integration-test", providerId: `${suffix}-${name}`, name}});
        accounts.push(account);
        await prisma.schoolMember.create({data: {schoolId: school.id, accountId: account.id, role: name === "只读账号" ? "VIEWER" : "ADMIN"}});
    }
    const [a, b, c, viewer] = accounts;
    const future = () => new Date(Date.now() + 3600000);
    async function create(overrides = {}) {
        const item = await pub.createPublication({accountId: a.id, input: {type: "NOTICE", status: "PUBLISHED", content: "原通知", publishAt: future(), targetWorkspaceIds: [workspace.id], ...overrides}});
        publicationIds.push(item.id);
        return item;
    }
    const edit = (item, actor, input = {content: "修改后的通知"}) => pub.updatePublication({accountId: actor.id, publicationId: item.id, expectedRevision: item.revision, input});
    async function storedAuthor(item, actor) {
        assert.equal(item.authorAccountId, actor.id);
        assert.equal(item.author.name, actor.name);
        assert.equal((await prisma.publication.findUnique({where: {id: item.id}})).authorAccountId, actor.id);
    }
    await t.test("notice certification repair updates only the verified current account revision and is repeatable", async () => {
        const original = await create();
        const current = await edit(original, b);
        const screenOrigin = await create();
        const missingEditor = await create();
        for (const item of [current, screenOrigin, missingEditor]) {
            await prisma.publication.update({where: {id: item.id}, data: {isCertified: false, certifiedByAccountId: null, certifiedAt: null}});
            await prisma.publicationRevision.updateMany({where: {publicationId: item.id}, data: {isCertified: false, certifiedByAccountId: null, certifiedAt: null}});
        }
        await prisma.publication.update({where: {id: screenOrigin.id}, data: {latestActorType: "CLASSROOM_SCREEN"}});
        await prisma.publicationRevision.updateMany({where: {publicationId: missingEditor.id}, data: {editorAccountId: null}});
        const sql = await readFile(new URL("../prisma/migrations/20260909000000_account_notice_certification/migration.sql", import.meta.url), "utf8");
        assert.equal(await prisma.$executeRawUnsafe(sql), 1);
        assert.equal(await prisma.$executeRawUnsafe(sql), 0);
        const repaired = await prisma.publication.findUnique({where: {id: current.id}, include: {revisions: {orderBy: {revision: "asc"}}}});
        assert.equal(repaired.isCertified, true);
        assert.equal(repaired.certifiedByAccountId, b.id);
        assert.equal(repaired.revision, current.revision);
        assert.equal(repaired.content, current.content);
        assert.equal(repaired.revisions[0].isCertified, false);
        assert.equal(repaired.revisions[1].isCertified, true);
        assert.equal(repaired.certifiedAt.getTime(), repaired.revisions[1].createdAt.getTime());
        for (const item of [screenOrigin, missingEditor]) {
            assert.equal((await prisma.publication.findUnique({where: {id: item.id}})).isCertified, false);
        }
    });
    await t.test("minor priority and popup choice persist in feeds, edits, clones and restored history", async () => {
        let item = await create({priority: "MINOR", contentJson: {popupEnabled: false}});
        assert.equal(item.priority, "MINOR");
        assert.equal(item.contentJson.popupEnabled, false);
        item = await edit(item, b, {contentJson: {popupEnabled: true}});
        assert.equal(item.contentJson.popupEnabled, true);
        const feed = await pub.listPublishedFeed({workspaceIds: [workspace.id], now: new Date(item.publishAt)});
        assert.equal(feed.items.find(row => row.id === item.id).contentJson.popupEnabled, true);
        item = await edit(item, b, {priority: "NORMAL", contentJson: {popupEnabled: false}});
        assert.equal(item.contentJson.popupEnabled, true);
        item = await pub.restorePublicationRevision({accountId: b.id, publicationId: item.id, expectedRevision: item.revision, sourceRevision: 1});
        assert.equal(item.priority, "MINOR");
        assert.equal(item.contentJson.popupEnabled, false);
        const clone = await pub.clonePublication({accountId: b.id, publicationId: item.id});
        publicationIds.push(clone.id);
        assert.equal(clone.priority, "MINOR");
        assert.equal(clone.contentJson.popupEnabled, false);
    });
    await t.test("last successful editor becomes the public feed publisher, while history retains the creator", async () => {
        let item = await create();
        item = await edit(item, b);
        await storedAuthor(item, b);
        item = await edit(item, c, {content: "最终内容"});
        await storedAuthor(item, c);
        const before = await pub.listPublishedFeed({workspaceIds: [workspace.id]});
        assert.equal(before.items.some(row => row.id === item.id), false);
        const after = await pub.listPublishedFeed({workspaceIds: [workspace.id], now: new Date(item.publishAt)});
        const shown = after.items.find(row => row.id === item.id);
        assert.equal(shown.author.name, c.name);
        assert.equal(shown.content, "最终内容");
        const history = await prisma.publicationRevision.findMany({where: {publicationId: item.id}, orderBy: {revision: "asc"}});
        assert.deepEqual(history.map(row => row.editorAccountId), [a.id, b.id, c.id]);
    });
    await t.test("publishing immediately during a scheduled edit uses the saving administrator", async () => {
        const item = await edit(await create(), b, {content: "立即发布", publishAt: new Date()});
        await storedAuthor(item, b);
        const feed = await pub.listPublishedFeed({workspaceIds: [workspace.id]});
        assert.equal(feed.items.find(row => row.id === item.id).author.id, b.id);
    });
    await t.test("revision conflict and forbidden save cannot change attribution", async () => {
        const original = await create();
        const item = await edit(original, b);
        await assert.rejects(edit(original, c), {code: "PUBLICATION_REVISION_CONFLICT"});
        await assert.rejects(edit(item, viewer), {code: "PUBLICATION_MANAGE_FORBIDDEN"});
        await storedAuthor(await pub.getPublication({accountId: a.id, publicationId: item.id}), b);
        assert.equal(await prisma.publicationRevision.count({where: {publicationId: item.id}}), 2);
    });
    await t.test("restoring content before scheduled release attributes it to the restoring administrator", async () => {
        let item = await edit(await create(), b);
        item = await pub.restorePublicationRevision({accountId: c.id, publicationId: item.id, expectedRevision: item.revision, sourceRevision: 1});
        await storedAuthor(item, c);
        assert.equal(item.content, "原通知");
    });
    await t.test("already published notices retain the publisher even when rescheduled", async () => {
        const item = await create({publishAt: new Date(Date.now() - 60000)});
        await storedAuthor(await edit(item, b, {content: "发布后的更正", publishAt: future()}), a);
    });
    await t.test("an edit reaching the scheduled instant no longer transfers the publisher", async t => {
        const item = await create();
        t.mock.method(Date, "now", () => item.publishAt.getTime());
        await storedAuthor(await edit(item, b), a);
    });
    await t.test("draft notices and scheduled assignments retain their author", async () => {
        await storedAuthor(await edit(await create({status: "DRAFT"}), b), a);
        const subject = await prisma.subject.create({data: {schoolId: school.id, code: "PHY", name: "物理"}});
        try {
            await prisma.administrativeClassSubject.create({data: {administrativeClassId: workspace.id, subjectId: subject.id, deliveryMode: "ADMIN_CLASS"}});
            const item = await create({type: "ASSIGNMENT", subjectId: subject.id, boardDate: "2099-09-08"});
            await storedAuthor(await edit(item, b), a);
        } finally { await prisma.subject.delete({where: {id: subject.id}}); }
    });
});
