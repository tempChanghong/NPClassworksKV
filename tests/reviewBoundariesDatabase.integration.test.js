import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";

test("review security boundaries use persisted credentials and final publication scopes", {skip: process.env.RUN_DATABASE_TESTS !== "true", timeout: 60000}, async t => {
    const url = new URL(process.env.DATABASE_URL);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    assert.match(url.pathname, /^\/npclassworks_test(?:_[a-z0-9_]+)?$/);
    process.env.JWT_SECRET = "review-isolated-access-secret-at-least-32-characters";
    process.env.REFRESH_TOKEN_SECRET = "review-isolated-refresh-secret-at-least-32-characters";
    const [{prisma}, local, tokens, migration, pub, {default: bcrypt}] = await Promise.all([
        import("../utils/prisma.js"), import("../services/localAccountService.js"), import("../utils/tokenManager.js"),
        import("../services/schoolMigrationService.js"), import("../services/publicationService.js"), import("bcrypt"),
    ]);
    const code = "R" + randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    const school = await prisma.school.create({data: {code, name: "边界回归", teacherAuthMode: "LOCAL_PIN"}});
    const accountIds = [], workspaceIds = [];
    t.after(async () => {
        const rows = await prisma.publication.findMany({where: {authorAccountId: {in: accountIds}}, select: {id: true}});
        const ids = rows.map(x => x.id);
        await prisma.publicationRevision.deleteMany({where: {publicationId: {in: ids}}});
        await prisma.publicationTarget.deleteMany({where: {publicationId: {in: ids}}});
        await prisma.publication.deleteMany({where: {id: {in: ids}}});
        await prisma.teachingAssignment.deleteMany({where: {accountId: {in: accountIds}}});
        await prisma.workspaceMember.deleteMany({where: {workspaceId: {in: workspaceIds}}});
        await prisma.administrativeClassSubject.deleteMany({where: {administrativeClassId: {in: workspaceIds}}});
        await prisma.workspace.deleteMany({where: {id: {in: workspaceIds}}});
        await prisma.academicTerm.deleteMany({where: {schoolId: school.id}});
        await prisma.subject.deleteMany({where: {schoolId: school.id}});
        await prisma.schoolMember.deleteMany({where: {schoolId: school.id}});
        await prisma.school.delete({where: {id: school.id}});
        await prisma.accountSession.deleteMany({where: {accountId: {in: accountIds}}});
        await prisma.account.deleteMany({where: {id: {in: accountIds}}});
        await prisma.$disconnect();
    });
    const term = await prisma.academicTerm.create({data: {schoolId: school.id, name: "回归学期", academicYear: 2099, semester: 1, status: "ACTIVE"}});
    const subjects = await Promise.all(["PHY", "CHN"].map(code => prisma.subject.create({data: {schoolId: school.id, code, name: code}})));
    const workspaces = await Promise.all(["A", "B"].map(code => prisma.workspace.create({data: {termId: term.id, code, name: code, type: "ADMIN_CLASS"}})));
    workspaceIds.push(...workspaces.map(x => x.id));
    await prisma.administrativeClassSubject.createMany({data: workspaces.flatMap(w => subjects.map(s => ({administrativeClassId: w.id, subjectId: s.id, deliveryMode: "ADMIN_CLASS"})))});
    async function account(username, role) {
        const row = await prisma.account.create({data: {provider: "school-local", providerId: `${code}:${username}`, localUsername: username, localPasswordHash: await bcrypt.hash("123456", 10), name: username}});
        accountIds.push(row.id);
        await prisma.schoolMember.create({data: {schoolId: school.id, accountId: row.id, role}});
        return row;
    }
    const owner = await account("owner", "OWNER"), admin = await account("admin", "ADMIN"), teacher = await account("teacher", "VIEWER");
    await prisma.workspaceMember.createMany({data: workspaces.map(w => ({workspaceId: w.id, accountId: teacher.id, role: "TEACHER"}))});
    await prisma.teachingAssignment.create({data: {accountId: teacher.id, subjectId: subjects[0].id, workspaceId: workspaces[0].id, position: "PRIMARY"}});
    const manager = {managerAccountId: owner.id, schoolId: school.id};
    await t.test("ADMIN cannot export credentials with a correct PIN or OAuth school-code confirmation", async () => {
        await assert.rejects(migration.createSchoolMigrationPackage({managerAccountId: admin.id, schoolId: school.id, currentPin: "123456", passphrase: "review-migration-password"}), e => e.code === "SCHOOL_OWNER_REQUIRED");
        await prisma.account.update({where: {id: admin.id}, data: {localPasswordHash: null}});
        try {
            await assert.rejects(migration.createSchoolMigrationPackage({managerAccountId: admin.id, schoolId: school.id, confirmationSchoolCode: code, passphrase: "review-migration-password"}), e => e.code === "SCHOOL_OWNER_REQUIRED");
        } finally { await prisma.account.update({where: {id: admin.id}, data: {localPasswordHash: admin.localPasswordHash}}); }
        const exported = await migration.createSchoolMigrationPackage({...manager, currentPin: "123456", passphrase: "review-migration-password"});
        assert.ok(exported.buffer.length > 0);
    });
    for (const target of [teacher, admin]) await t.test(`PIN replacement revokes every prior session: ${target.localUsername}`, async () => {
        const login = password => local.loginLocalAccount({schoolCode: code, username: target.localUsername, password});
        const old = [await login("123456"), await login("123456")];
        const importTeacher = pin => local.importLocalTeachers({...manager, termId: term.id, document: {assignments: [{username: "teacher", name: "teacher", ...(pin ? {pin} : {}), role: "TEACHER", workspaceCodes: ["A", "B"]}]}});
        if (target === teacher) {
            await prisma.school.update({where: {id: school.id}, data: {teacherAuthMode: "SHARED_PASSWORD"}});
            assert.equal((await importTeacher()).imported, true);
            await prisma.school.update({where: {id: school.id}, data: {teacherAuthMode: "LOCAL_PIN"}});
            await tokens.validateAccountToken(tokens.verifyAccessToken(old[0].accessToken));
            await tokens.refreshAccessToken(old[0].refreshToken);
            assert.equal((await importTeacher("654321")).imported, true);
        } else await local.createLocalAdministrator({...manager, username: "admin", name: "admin", pin: "654321"});
        for (const session of old) {
            await assert.rejects(tokens.validateAccountToken(tokens.verifyAccessToken(session.accessToken)));
            await assert.rejects(tokens.refreshAccessToken(session.refreshToken));
        }
        await assert.rejects(login("123456"));
        await tokens.validateAccountToken(tokens.verifyAccessToken((await login("654321")).accessToken));
        const stored = await prisma.account.findUnique({where: {id: target.id}});
        assert.equal(stored.tokenVersion, target.tokenVersion + 1);
        assert.equal(stored.refreshToken, null);
    });
    for (const target of [teacher, admin]) await t.test(`old-PIN login cannot inherit the reset version: ${target.localUsername}`, async () => {
        const originalCompare = bcrypt.compare;
        let resume, compared;
        const pause = new Promise(resolve => { resume = resolve; });
        const reached = new Promise(resolve => { compared = resolve; });
        bcrypt.compare = async (...args) => {
            const valid = await originalCompare(...args);
            if (args[0] === "654321") { compared(); await pause; }
            return valid;
        };
        let pending;
        try {
            pending = local.loginLocalAccount({schoolCode: code, username: target.localUsername, password: "654321"});
            await reached;
            if (target === teacher) await local.importLocalTeachers({...manager, termId: term.id, document: {assignments: [{username: "teacher", name: "teacher", pin: "111111", role: "TEACHER", workspaceCodes: ["A", "B"]}]}});
            else await local.createLocalAdministrator({...manager, username: "admin", name: "admin", pin: "111111"});
            const rejected = assert.rejects(pending, e => e.statusCode === 401);
            resume();
            await rejected;
        } finally { resume(); bcrypt.compare = originalCompare; if (pending) await pending.catch(() => {}); }
    });
    const input = (subjectId, targetWorkspaceIds = [workspaces[0].id]) => ({type: "ASSIGNMENT", status: "PUBLISHED", subjectId, content: randomUUID(), boardDate: "2099-09-08", targetWorkspaceIds});
    async function certification(item, expected) {
        assert.equal(item.isCertified, expected);
        assert.equal(Boolean(item.certifiedByAccountId), expected);
        assert.equal(Boolean(item.certifiedAt), expected);
        const revision = await prisma.publicationRevision.findUnique({where: {publicationId_revision: {publicationId: item.id, revision: item.revision}}});
        assert.equal(revision.isCertified, expected);
        assert.equal(revision.certifiedByAccountId, item.certifiedByAccountId);
    }
    await t.test("create and clone check the subject and every final target", async () => {
        await certification(await pub.createPublication({accountId: teacher.id, input: input(subjects[0].id)}), true);
        await certification(await pub.createPublication({accountId: teacher.id, input: input(subjects[0].id, workspaceIds)}), false);
        const other = await pub.createPublication({accountId: teacher.id, input: input(subjects[1].id)});
        await certification(other, false);
        await assert.rejects(pub.certifyPublication({accountId: teacher.id, publicationId: other.id, expectedRevision: other.revision}), e => e.code === "PUBLICATION_CERTIFY_FORBIDDEN");
        await certification(await pub.clonePublication({accountId: teacher.id, publicationId: other.id, input: {content: randomUUID()}}), false);
    });
    await t.test("empty PATCH, actual edits, subject/target changes and restore cannot certify outside scope", async () => {
        let item = await pub.createPublication({accountId: owner.id, input: input(subjects[1].id)});
        for (const change of [{}, {content: "跨学科编辑"}]) {
            item = await pub.updatePublication({accountId: teacher.id, publicationId: item.id, expectedRevision: item.revision, input: change});
            await certification(item, false);
        }
        item = await pub.restorePublicationRevision({accountId: teacher.id, publicationId: item.id, expectedRevision: item.revision, sourceRevision: 1});
        await certification(item, false);
        item = await pub.updatePublication({accountId: teacher.id, publicationId: item.id, expectedRevision: item.revision, input: {subjectId: subjects[0].id}});
        await certification(item, true);
        item = await pub.updatePublication({accountId: teacher.id, publicationId: item.id, expectedRevision: item.revision, input: {targetWorkspaceIds: workspaceIds}});
        await certification(item, false);
        await certification(await pub.certifyPublication({accountId: admin.id, publicationId: item.id, expectedRevision: item.revision}), true);
        item = await pub.withdrawPublication({accountId: teacher.id, publicationId: item.id, expectedRevision: item.revision});
        await certification(item, false);
    });
});
