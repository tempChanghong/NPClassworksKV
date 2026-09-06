import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {performance} from "node:perf_hooks";
import {classifyActionRequiredPublication, compareActionRequiredItems, isPublicationWithinActionScope} from "../domain/publicationActionCenter.js";

test("action center paginates real PostgreSQL without loading off-page snapshots", {skip: process.env.RUN_DATABASE_TESTS !== "true", timeout: 120000}, async t => {
    const url = new URL(process.env.DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.match(url.pathname, /^\/npclassworks_test(?:_[a-z0-9_]+)?$/);
    const {prisma} = await import("../utils/prisma.js");
    const {listActionRequiredPublications: list, publicationInclude} = await import("../services/publicationService.js");
    const suffix = randomUUID();
    const now = new Date("2099-06-06T12:00:00Z");
    const school = await prisma.school.create({data: {code: `ACTION-${suffix}`, name: "待处理分页测试", allowOAuthTeacherLogin: true}});
    const term = await prisma.academicTerm.create({data: {schoolId: school.id, name: "测试学期", academicYear: 2099, semester: 1, status: "ACTIVE"}});
    const accounts = await Promise.all(["owner", "teacher"].map(role => prisma.account.create({data: {provider: "integration-test", providerId: suffix + role}})));
    await prisma.schoolMember.createMany({data: accounts.map((account, i) => ({schoolId: school.id, accountId: account.id, role: i ? "VIEWER" : "OWNER"}))});
    const subjects = await Promise.all(["math", "english"].map(code => prisma.subject.create({data: {schoolId: school.id, code, name: code}})));
    const workspaces = await Promise.all(["C1", "C2"].map(code => prisma.workspace.create({data: {termId: term.id, code, name: code, type: "ADMIN_CLASS"}})));
    await prisma.teachingAssignment.create({data: {accountId: accounts[1].id, workspaceId: workspaces[0].id, subjectId: subjects[0].id}});
    const ids = Array.from({length: 1200}, (_, i) => `action-${suffix}-${String(i).padStart(4, "0")}`);
    t.after(async () => {
        await prisma.publication.deleteMany({where: {id: {in: ids}}});
        await prisma.teachingAssignment.deleteMany({where: {accountId: {in: accounts.map(x => x.id)}}});
        await prisma.workspace.deleteMany({where: {termId: term.id}});
        await prisma.subject.deleteMany({where: {schoolId: school.id}});
        await prisma.academicTerm.delete({where: {id: term.id}});
        await prisma.schoolMember.deleteMany({where: {schoolId: school.id}});
        await prisma.school.delete({where: {id: school.id}});
        await prisma.account.deleteMany({where: {id: {in: accounts.map(x => x.id)}}});
        await prisma.$disconnect();
    });
    await prisma.publication.createMany({data: ids.map((id, i) => ({
        id, type: "ASSIGNMENT", subjectId: subjects[i % 2].id, content: "测试正文".repeat(1000), title: String(i),
        status: i % 17 === 0 ? "DRAFT" : "PUBLISHED", isCertified: i % 19 === 0,
        publishAt: new Date(now.getTime() + (i % 23 === 0 ? 86400000 : -86400000)),
        revision: 2, latestActorType: i % 3 === 0 ? "CLASSROOM_SCREEN" : "ACCOUNT",
        priority: ["URGENT", "IMPORTANT", "NORMAL"][i % 3],
        dueAt: i % 4 === 0 ? null : new Date(now.getTime() + (i % 4 - 2) * 3600000),
        updatedAt: new Date(now.getTime() - Math.floor(i / 7) * 1000),
    }))});
    await prisma.publicationTarget.createMany({data: ids.flatMap((publicationId, i) => [
        {publicationId, workspaceId: workspaces[0].id},
        ...(i % 5 === 0 ? [{publicationId, workspaceId: workspaces[1].id}] : []),
    ])});
    await prisma.publicationRevision.createMany({data: ids.filter((_, i) => i % 3 === 1).map(publicationId => ({
        publicationId, revision: 1, action: "CREATED", actorType: "ACCOUNT", isCertified: true,
        snapshot: {content: "历史正文".repeat(1000), targetWorkspaceIds: [workspaces[0].id]},
    }))});
    const raw = await prisma.publication.findMany({where: {id: {in: ids}, status: "PUBLISHED", isCertified: false, publishAt: {lte: now}},
        include: {...publicationInclude, revisions: {where: {isCertified: true, purgedAt: null}, orderBy: {revision: "desc"}, take: 1,
            select: {id: true, revision: true, snapshot: true, certifiedAt: true, certifiedBy: {select: {id: true, name: true}}}}}});
    function expected({teacher = false, reason, subjectId, workspaceId} = {}) {
        const scope = teacher ? {teachingAssignments: [{workspaceId: workspaces[0].id, subjectId: subjects[0].id}]} : {fullWorkspaceIds: workspaces.map(x => x.id)};
        const all = raw.filter(x => isPublicationWithinActionScope(x, scope))
            .filter(x => !subjectId || x.subjectId === subjectId)
            .filter(x => !workspaceId || x.targets.some(target => target.workspaceId === workspaceId))
            .map(x => classifyActionRequiredPublication(x, {now})).sort(compareActionRequiredItems);
        return {all, filtered: reason ? all.filter(x => x.reason === reason) : all};
    }
    const original = prisma.publication.findMany;
    const materialized = [];
    prisma.publication.findMany = async function (...args) {
        const rows = await original.apply(this, args);
        materialized.push({rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows))});
        return rows;
    };
    t.after(() => { prisma.publication.findMany = original; });
    const originalTransaction = prisma.$transaction;
    prisma.$transaction = function (work, ...options) {
        if (typeof work !== "function") return originalTransaction.call(this, work, ...options);
        return originalTransaction.call(this, async tx => {
            const find = tx.publication.findMany;
            tx.publication.findMany = async function (...args) {
                const rows = await find.apply(this, args);
                materialized.push({rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows))});
                return rows;
            };
            return work(tx);
        }, ...options);
    };
    t.after(() => { prisma.$transaction = originalTransaction; });

    for (const filter of [{}, {teacher: true}, {reason: "CREATED_BY_SCREEN"}, {reason: "CHANGED_AFTER_CERTIFICATION"},
        {reason: "OTHER_UNCERTIFIED"}, {subjectId: subjects[1].id}, {workspaceId: workspaces[1].id}, {reason: "UNKNOWN"}]) {
        await t.test(JSON.stringify(filter), async () => {
            const expectedPage = expected(filter);
            const query = {...filter, accountId: accounts[filter.teacher ? 1 : 0].id, schoolId: school.id, now};
            materialized.length = 0;
            const started = performance.now();
            const first = await list({...query, limit: 20, skip: 0});
            assert.ok(materialized.every(query => query.rows <= 20), "off-page content must stay in the database");
            console.log("ACTION_MEASUREMENT", JSON.stringify({filter, ms: performance.now() - started, materialized: materialized.splice(0), total: first.total}));
            assert.deepEqual(first.items.map(x => x.id), expectedPage.filtered.slice(0, 20).map(x => x.id));
            assert.equal(first.total, expectedPage.filtered.length);
            assert.equal(first.summary.total, expectedPage.all.length);
            for (const [name, predicate] of Object.entries({
                changedAfterCertified: x => x.reason === "CHANGED_AFTER_CERTIFICATION",
                createdByScreen: x => x.reason === "CREATED_BY_SCREEN", other: x => x.reason === "OTHER_UNCERTIFIED",
                overdue: x => x.overdue, dueSoon: x => x.dueSoon,
            })) assert.equal(first.summary[name], expectedPage.all.filter(predicate).length);
            const second = await list({...query, limit: 20, skip: 20});
            assert.deepEqual(second.items.map(x => x.id), expectedPage.filtered.slice(20, 40).map(x => x.id));
            for (let i = 0; i < first.items.length; i++) assert.deepEqual(first.items[i].changedFields, expectedPage.filtered[i].changedFields);
            const pastEnd = await list({...query, skip: expectedPage.filtered.length + 10});
            assert.deepEqual(pastEnd.items, []); assert.equal(pastEnd.total, expectedPage.filtered.length);
        });
    }
});
