import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";

test("weekly feeds preserve scope and visibility, paginate ties, and include earlier board dates due this week", {skip: process.env.RUN_DATABASE_TESTS !== "true", timeout: 60000}, async t => {
    const url = new URL(process.env.DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.match(url.pathname, /^\/npclassworks_test(?:_[a-z0-9_]+)?$/);
    const {prisma} = await import("../utils/prisma.js");
    const {listPublishedFeed} = await import("../services/publicationService.js");
    const suffix = randomUUID();
    const now = new Date("2099-09-10T00:00:00Z");
    const school = await prisma.school.create({data: {code: "WEEK-" + suffix, name: "一周查询测试"}});
    const term = await prisma.academicTerm.create({data: {schoolId: school.id, name: "测试学期", academicYear: 2099, semester: 1, status: "ACTIVE"}});
    const subject = await prisma.subject.create({data: {schoolId: school.id, code: "math", name: "数学"}});
    const workspaces = await Promise.all(["A", "B"].map(code => prisma.workspace.create({data: {termId: term.id, code, name: code, type: "ADMIN_CLASS"}})));
    const ids = [];
    t.after(async () => {
        await prisma.publication.deleteMany({where: {id: {in: ids}}});
        await prisma.workspace.deleteMany({where: {termId: term.id}});
        await prisma.subject.delete({where: {id: subject.id}});
        await prisma.academicTerm.delete({where: {id: term.id}});
        await prisma.school.delete({where: {id: school.id}});
        await prisma.$disconnect();
    });
    async function seed(name, data = {}, workspace = workspaces[0]) {
        const item = await prisma.publication.create({data: {
            id: suffix + name, subjectId: subject.id, type: "ASSIGNMENT", status: "PUBLISHED", title: name, content: `测试作业 ${name}`,
            boardDate: new Date("2099-09-07T00:00:00Z"), publishAt: new Date("2099-09-01T00:00:00Z"), updatedAt: now,
            ...data, targets: {create: {workspaceId: workspace.id}},
        }});
        ids.push(item.id); return item;
    }
    const first = await seed("a"), second = await seed("b");
    const marker = await seed("marker", {title: "今日无作业", content: "本日该科目无作业。", contentJson: {kind: "NO_HOMEWORK", version: 1}});
    const early = await seed("early-board", {boardDate: new Date("2099-09-01T00:00:00Z"), dueAt: new Date("2099-09-06T16:00:00Z")});
    const last = await seed("last-due", {boardDate: new Date("2099-09-01T00:00:00Z"), dueAt: new Date("2099-09-13T15:59:59Z")});
    await seed("next-week", {boardDate: new Date("2099-09-14T00:00:00Z"), dueAt: new Date("2099-09-13T16:00:00Z")});
    await seed("previous-due", {boardDate: new Date("2099-09-01T00:00:00Z"), dueAt: new Date("2099-09-06T15:59:59Z")});
    await seed("draft", {status: "DRAFT"}); await seed("withdrawn", {status: "WITHDRAWN"});
    await seed("future", {publishAt: new Date("2099-09-11T00:00:00Z")});
    await seed("other", {}, workspaces[1]); await seed("notice", {type: "NOTICE"});
    const query = {workspaceIds: [workspaces[0].id], weekStart: "2099-09-07", now};
    const board = await listPublishedFeed({...query, weekView: "board", limit: 1});
    assert.equal(board.total, 3); assert.equal(board.weekStart, query.weekStart); assert.equal(board.weekView, "board");
    assert.deepEqual(board.items.map(x => x.id), [first.id]);
    assert.deepEqual((await listPublishedFeed({...query, limit: 1, skip: 1})).items.map(x => x.id), [second.id]);
    assert.equal((await listPublishedFeed({...query, limit: 1, skip: 2})).items[0].contentJson.kind, "NO_HOMEWORK");
    const due = await listPublishedFeed({...query, weekView: "due"});
    assert.deepEqual(new Set(due.items.map(x => x.id)), new Set([early.id, last.id]));
    assert.equal(due.total, 2);
    const daily = await listPublishedFeed({workspaceIds: query.workspaceIds, boardDate: "2099-09-07", now});
    assert.equal(daily.weekStart, undefined); assert.equal(daily.items.length, 4);
    assert.ok(daily.items.some(x => x.id === marker.id));
    await t.test("daily cursor feeds include every active notice despite edits and withdrawal before the cursor", async () => {
        const expected = [];
        for (let i = 0; i < 105; i++) {
            const row = await seed(`page-${String(i).padStart(3, "0")}`, {type: "NOTICE", subjectId: null,
                priority: i === 104 ? "URGENT" : "NORMAL", expiresAt: new Date(now.getTime() + 3600000)}, workspaces[1]);
            expected.push(row.id);
        }
        await seed("page-expired", {type: "NOTICE", expiresAt: now}, workspaces[1]);
        await seed("page-future", {type: "NOTICE", publishAt: new Date(now.getTime() + 1000)}, workspaces[1]);
        const params = {workspaceIds: [workspaces[1].id], boardDate: "2099-09-09", now, limit: 50};
        const first = await listPublishedFeed({...params, afterId: ""});
        assert.equal(first.items.length, 50);
        assert.equal(first.total, 105);
        await prisma.publication.update({where: {id: expected[0]}, data: {status: "WITHDRAWN"}});
        await prisma.publication.update({where: {id: expected[80]}, data: {publishAt: new Date(now.getTime() - 1000), content: "分页期间修改"}});
        const second = await listPublishedFeed({...params, afterId: first.nextAfterId});
        const third = await listPublishedFeed({...params, afterId: second.nextAfterId});
        assert.equal(third.nextAfterId, null);
        const all = [...first.items, ...second.items, ...third.items];
        assert.deepEqual(all.map(row => row.id), expected);
        assert.equal(all.at(-1).priority, "URGENT");
        assert.equal(all.find(row => row.id === expected[80]).content, "分页期间修改");
        await assert.rejects(listPublishedFeed({...params, afterId: []}), {code: "INVALID_FEED_CURSOR"});
    });
    await prisma.workspace.update({where: {id: workspaces[0].id}, data: {isActive: false}});
    await assert.rejects(listPublishedFeed(query), error => error.code === "WORKSPACE_NOT_FOUND");
    await prisma.workspace.update({where: {id: workspaces[0].id}, data: {isActive: true}});
    await prisma.academicTerm.update({where: {id: term.id}, data: {status: "ARCHIVED"}});
    await assert.rejects(listPublishedFeed(query), error => error.code === "TERM_NOT_ACTIVE");
});
