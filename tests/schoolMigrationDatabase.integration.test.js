import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import {randomUUID} from "node:crypto";
import test from "node:test";

const shouldRun = process.env.RUN_DATABASE_TESTS === "true";

async function clearV2Data(prisma) {
    await prisma.notificationScreenDelivery.deleteMany();
    await prisma.classroomScreenCommand.deleteMany();
    await prisma.publicationRevision.deleteMany();
    await prisma.publicationTarget.deleteMany();
    await prisma.publication.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.classAttendanceDay.deleteMany();
    await prisma.administrativeClassStudent.deleteMany();
    await prisma.classroomScreenBinding.deleteMany();
    await prisma.workspaceMemberInvite.deleteMany();
    await prisma.administrativeClassLeadership.deleteMany();
    await prisma.gradeLeadership.deleteMany();
    await prisma.teachingAssignment.deleteMany();
    await prisma.workspaceMember.deleteMany();
    await prisma.administrativeClassSubject.deleteMany();
    await prisma.workspaceSourceClass.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.subject.deleteMany();
    await prisma.grade.deleteMany();
    await prisma.academicTerm.deleteMany();
    await prisma.schoolMember.deleteMany();
    await prisma.school.deleteMany();
    await prisma.accountSession.deleteMany();
    await prisma.accountPreference.deleteMany();
    await prisma.instanceSetup.deleteMany();
    await prisma.account.deleteMany();
}

test("an encrypted school package restores a school into an empty instance", {skip: !shouldRun}, async () => {
    const [{prisma}, migrationService] = await Promise.all([
        import("../utils/prisma.js"),
        import("../services/schoolMigrationService.js"),
    ]);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const pin = "482615";
    const passphrase = "integration-migration-package-password";
    try {
        await clearV2Data(prisma);
        const account = await prisma.account.create({
            data: {
                provider: "school-local",
                providerId: `MIG-${suffix}:owner`,
                name: "迁移管理员",
                localUsername: "owner",
                localPasswordHash: await bcrypt.hash(pin, 10),
                accessToken: "must-not-transfer",
                refreshToken: "must-not-transfer",
            },
        });
        const school = await prisma.school.create({
            data: {code: `MIG-${suffix}`, name: "迁移测试学校", homeworkQuickInputs: [{text: "完成练习"}]},
        });
        await prisma.schoolMember.create({data: {schoolId: school.id, accountId: account.id, role: "OWNER"}});
        const term = await prisma.academicTerm.create({
            data: {schoolId: school.id, name: "迁移学期", academicYear: 2097, semester: 1, status: "ACTIVE"},
        });
        const grade = await prisma.grade.create({data: {termId: term.id, code: "G2", name: "高二"}});
        const subject = await prisma.subject.create({data: {schoolId: school.id, code: "PHY", name: "物理", category: "ELECTIVE"}});
        const workspace = await prisma.workspace.create({
            data: {termId: term.id, gradeId: grade.id, code: "G2-C1", name: "高二1班", type: "ADMIN_CLASS"},
        });
        const originalScreenTokenHash = "a".repeat(64);
        const screen = await prisma.classroomScreenBinding.create({
            data: {
                schoolId: school.id,
                administrativeClassId: workspace.id,
                deviceFingerprint: `fingerprint-${suffix}`,
                name: "高二1班一体机",
                loginCode: `screen-${suffix}`.toLowerCase(),
                pinHash: await bcrypt.hash("135790", 10),
                tokenHash: originalScreenTokenHash,
                activatedAt: new Date(),
                createdByAccountId: account.id,
            },
        });
        const publication = await prisma.publication.create({
            data: {
                authorAccountId: account.id,
                type: "ASSIGNMENT",
                subjectId: subject.id,
                title: "迁移作业",
                content: "完成第一题",
                status: "PUBLISHED",
            },
        });
        await prisma.publicationTarget.create({data: {publicationId: publication.id, workspaceId: workspace.id}});
        await prisma.publicationRevision.create({
            data: {
                publicationId: publication.id,
                revision: 1,
                snapshot: {title: publication.title, content: publication.content},
                action: "CREATED",
                actorType: "ACCOUNT",
                editorAccountId: account.id,
                isCertified: true,
            },
        });
        await prisma.auditLog.create({
            data: {schoolId: school.id, actorAccountId: account.id, actorType: "ACCOUNT", action: "TEST_SOURCE", summary: "来源审计"},
        });

        const exported = await migrationService.createSchoolMigrationPackage({
            managerAccountId: account.id,
            schoolId: school.id,
            currentPin: pin,
            passphrase,
        });
        assert.match(exported.filename, /\.npcw-transfer$/);

        await clearV2Data(prisma);
        const preview = await migrationService.previewSchoolMigrationImport({packageBuffer: exported.buffer, passphrase});
        assert.equal(preview.valid, true);
        assert.equal(preview.counts.publications, 1);

        const imported = await migrationService.importSchoolMigrationPackage({packageBuffer: exported.buffer, passphrase});
        assert.equal(imported.school.id, school.id);
        assert.equal(imported.screensRequireRebind, 1);

        const restoredAccount = await prisma.account.findUnique({where: {id: account.id}});
        const restoredScreen = await prisma.classroomScreenBinding.findUnique({where: {id: screen.id}});
        assert.equal(await bcrypt.compare(pin, restoredAccount.localPasswordHash), true);
        assert.equal(restoredAccount.accessToken, null);
        assert.equal(restoredAccount.refreshToken, null);
        assert.equal(restoredScreen.deviceFingerprint, null);
        assert.equal(restoredScreen.activatedAt, null);
        assert.notEqual(restoredScreen.tokenHash, originalScreenTokenHash);
        assert.equal(await prisma.publication.count({where: {id: publication.id}}), 1);
        assert.equal((await prisma.instanceSetup.findUnique({where: {id: "default"}})).completedAt, null);
        assert.equal(await prisma.auditLog.count({where: {action: "SCHOOL_MIGRATION_IMPORT_COMPLETED"}}), 1);
    } finally {
        await clearV2Data(prisma);
    }
});
