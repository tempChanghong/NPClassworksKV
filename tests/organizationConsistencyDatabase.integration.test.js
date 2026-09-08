import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";

test("catalog validity and organization identity constraints agree across entry points", {skip: process.env.RUN_DATABASE_TESTS !== "true", timeout: 60000}, async t => {
    const url = new URL(process.env.DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.match(url.pathname, /^\/npclassworks_test(?:_[a-z0-9_]+)?$/);
    const [{prisma}, org, catalog, structures] = await Promise.all([
        import("../utils/prisma.js"), import("../services/organizationAdminService.js"),
        import("../services/academicCatalogService.js"), import("../services/academicStructureManagementService.js"),
    ]);
    const code = "ORG" + randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const owner = await prisma.account.create({data: {provider: "integration", providerId: code, name: "Owner"}});
    const school = await prisma.school.create({data: {code, name: "组织回归"}});
    await prisma.schoolMember.create({data: {accountId: owner.id, schoolId: school.id, role: "OWNER"}});
    t.after(async () => {
        const workspaces = await prisma.workspace.findMany({where: {term: {schoolId: school.id}}, select: {id: true}});
        const ids = workspaces.map(x => x.id);
        const pubs = await prisma.publicationTarget.findMany({where: {workspaceId: {in: ids}}, select: {publicationId: true}});
        const pids = pubs.map(x => x.publicationId);
        await prisma.publicationRevision.deleteMany({where: {publicationId: {in: pids}}});
        await prisma.publicationTarget.deleteMany({where: {workspaceId: {in: ids}}});
        await prisma.publication.deleteMany({where: {id: {in: pids}}});
        await prisma.teachingAssignment.deleteMany({where: {workspaceId: {in: ids}}});
        await prisma.workspaceSourceClass.deleteMany({where: {workspaceId: {in: ids}}});
        await prisma.administrativeClassSubject.deleteMany({where: {administrativeClassId: {in: ids}}});
        await prisma.workspace.deleteMany({where: {id: {in: ids}}});
        await prisma.grade.deleteMany({where: {term: {schoolId: school.id}}});
        await prisma.academicTerm.deleteMany({where: {schoolId: school.id}});
        await prisma.subject.deleteMany({where: {schoolId: school.id}});
        await prisma.schoolMember.deleteMany({where: {schoolId: school.id}});
        await prisma.school.delete({where: {id: school.id}});
        await prisma.account.delete({where: {id: owner.id}});
        await prisma.$disconnect();
    });
    const document = {
        school: {code, name: "组织回归"},
        term: {academicYear: 2099, semester: 1, name: "回归学期", status: "ACTIVE"},
        grade: {code: "G1", name: "一年级"},
        subjects: [{code: "PHY", name: "物理"}, {code: "CHN", name: "语文"}],
        administrativeClasses: [{code: "C1", name: "一班", subjectRules: {PHY: "COURSE_GROUP", CHN: "COURSE_GROUP"}}],
        courseGroups: [{code: "CG", name: "物理走班", subject: "PHY", sourceClasses: ["C1"]}],
    };
    const imported = await org.importOrganization({accountId: owner.id, document});
    assert.equal(imported.imported, true, JSON.stringify(imported));
    const termId = imported.result.term.id;
    const classOne = await prisma.workspace.findUnique({where: {termId_code: {termId, code: "C1"}}});
    const group = await prisma.workspace.findUnique({where: {termId_code: {termId, code: "CG"}}});
    const chinese = await prisma.subject.findUnique({where: {schoolId_code: {schoolId: school.id, code: "CHN"}}});
    const manager = {managerAccountId: owner.id, schoolId: school.id, courseGroupId: group.id};
    await t.test("inactive course groups disappear from catalog and stale selections are rejected", async () => {
        const options = () => catalog.getAdministrativeClassCourseOptions(classOne.id);
        assert.equal((await options()).subjects[0].courseGroups.length, 1);
        await prisma.workspace.update({where: {id: group.id}, data: {isActive: false}});
        try {
            assert.ok((await options()).subjects.every(s => !s.courseGroups.some(g => g.id === group.id)));
            const validation = await catalog.validateAdministrativeClassStudentSelection(classOne.id, {courseGroupIds: {[group.subjectId]: group.id}, declinedSubjectIds: [chinese.id]});
            assert.equal(validation.valid, false);
            assert.equal(validation.normalized.courseGroupIds[group.subjectId], undefined);
            assert.ok(validation.issues.some(x => x.code === "COURSE_GROUP_NOT_AVAILABLE"));
        } finally { await prisma.workspace.update({where: {id: group.id}, data: {isActive: true}}); }
        assert.ok((await options()).subjects.some(s => s.courseGroups.some(g => g.id === group.id)));
    });
    const pub = await prisma.publication.create({data: {type: "ASSIGNMENT", content: "原科目历史", subjectId: group.subjectId, targets: {create: {workspaceId: group.id}}}});
    for (const scenario of ["subject", "type", "grade"]) await t.test(`preview and commit reject ${scenario} identity changes without partial writes`, async () => {
        const changed = structuredClone(document);
        changed.school.name = "不得写入的名称";
        if (scenario === "subject") changed.courseGroups[0].subject = "CHN";
        if (scenario === "type") {
            changed.courseGroups = [];
            changed.administrativeClasses.push({code: "CG", name: "换成行政班", subjectRules: {PHY: "ADMIN_CLASS", CHN: "ADMIN_CLASS"}});
        }
        if (scenario === "grade") changed.grade = {code: "G2", name: "二年级"};
        for (const dryRun of [true, false]) {
            const result = await org.importOrganization({accountId: owner.id, document: changed, dryRun});
            assert.equal(result.valid, false);
            assert.equal(result.imported, false);
            assert.ok(result.errors.some(e => e.workspaceId === group.id || e.workspaceId === classOne.id));
            assert.equal((await prisma.school.findUnique({where: {id: school.id}})).name, document.school.name);
            assert.equal((await prisma.workspace.findUnique({where: {id: group.id}})).subjectId, group.subjectId);
        }
    });
    await t.test("single edit and import share historical subject protection", async () => {
        await assert.rejects(structures.updateManagedCourseGroup({...manager, subjectId: chinese.id}), e => e.code === "COURSE_GROUP_SUBJECT_LOCKED");
        const changed = structuredClone(document); changed.courseGroups[0].subject = "CHN";
        const result = await org.importOrganization({accountId: owner.id, document: changed, dryRun: true});
        assert.ok(result.errors.some(e => e.code === "COURSE_GROUP_SUBJECT_LOCKED"));
    });
    await t.test("a clean preview does not authorize a later import after history appears", async () => {
        await prisma.publicationTarget.deleteMany({where: {publicationId: pub.id}});
        const changed = structuredClone(document); changed.courseGroups[0].subject = "CHN";
        assert.equal((await org.importOrganization({accountId: owner.id, document: changed, dryRun: true})).valid, true);
        await prisma.publicationTarget.create({data: {publicationId: pub.id, workspaceId: group.id}});
        assert.equal((await org.importOrganization({accountId: owner.id, document: changed})).valid, false);
    });
    await t.test("the transaction rechecks references added after service preflight", async () => {
        await prisma.publicationTarget.deleteMany({where: {publicationId: pub.id}});
        const changed = structuredClone(document); changed.courseGroups[0].subject = "CHN";
        changed.school.name = "事务内拒绝时不得写入";
        const transaction = prisma.$transaction;
        let entered = false;
        prisma.$transaction = async (...args) => {
            entered = true;
            prisma.$transaction = transaction;
            await prisma.publicationTarget.create({data: {publicationId: pub.id, workspaceId: group.id}});
            return transaction.apply(prisma, args);
        };
        try {
            const result = await org.importOrganization({accountId: owner.id, document: changed});
            assert.equal(entered, true);
            assert.equal(result.valid, false);
            assert.equal(result.imported, false);
            assert.ok(result.errors.some(e => e.code === "COURSE_GROUP_SUBJECT_LOCKED"));
            assert.equal((await prisma.school.findUnique({where: {id: school.id}})).name, document.school.name);
        } finally { prisma.$transaction = transaction; }
    });
    await t.test("teaching assignments also prevent repurposing; renames remain allowed", async () => {
        await prisma.publicationTarget.deleteMany({where: {publicationId: pub.id}});
        await prisma.publication.delete({where: {id: pub.id}});
        await prisma.teachingAssignment.create({data: {workspaceId: group.id, accountId: owner.id, subjectId: group.subjectId, position: "PRIMARY", isActive: false}});
        await assert.rejects(structures.updateManagedCourseGroup({...manager, subjectId: chinese.id}), e => e.code === "COURSE_GROUP_SUBJECT_LOCKED");
        const changed = structuredClone(document); changed.courseGroups[0].subject = "CHN";
        assert.equal((await org.importOrganization({accountId: owner.id, document: changed})).valid, false);
        const renamed = structuredClone(document); renamed.courseGroups[0].name = "新名称";
        const result = await org.importOrganization({accountId: owner.id, document: renamed});
        assert.equal(result.imported, true);
        assert.equal((await prisma.workspace.findUnique({where: {id: group.id}})).name, "新名称");
        await prisma.teachingAssignment.deleteMany({where: {workspaceId: group.id}});
        assert.equal((await org.importOrganization({accountId: owner.id, document: changed})).imported, true);
    });
});
