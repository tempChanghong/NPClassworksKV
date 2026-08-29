import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";

const shouldRun = process.env.RUN_DATABASE_TESTS === "true";

test("audit log and classroom screen duty commands work against PostgreSQL", {skip: !shouldRun}, async () => {
    const [{prisma}, auditService, dutyService] = await Promise.all([
        import("../utils/prisma.js"),
        import("../services/auditLogService.js"),
        import("../services/classroomScreenDutyService.js"),
    ]);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const ids = {};
    try {
        const account = await prisma.account.create({
            data: {provider: "integration-test", providerId: `ops-${suffix}`, name: "值守测试管理员"},
        });
        ids.accountId = account.id;
        const school = await prisma.school.create({data: {code: `OPS-${suffix}`.toUpperCase(), name: "值守测试学校"}});
        ids.schoolId = school.id;
        await prisma.schoolMember.create({data: {schoolId: school.id, accountId: account.id, role: "OWNER"}});
        const term = await prisma.academicTerm.create({
            data: {schoolId: school.id, name: "测试学期", academicYear: 2098, semester: 1, status: "ACTIVE"},
        });
        ids.termId = term.id;
        const grade = await prisma.grade.create({data: {termId: term.id, code: "G1", name: "测试年级"}});
        ids.gradeId = grade.id;
        const workspace = await prisma.workspace.create({
            data: {termId: term.id, gradeId: grade.id, code: "G1-C1", name: "测试1班", type: "ADMIN_CLASS"},
        });
        ids.workspaceId = workspace.id;
        const screen = await prisma.classroomScreenBinding.create({
            data: {
                schoolId: school.id,
                administrativeClassId: workspace.id,
                name: "测试大屏",
                loginCode: `screen-${suffix}`,
                tokenHash: suffix.padEnd(64, "0"),
                activatedAt: new Date(),
                createdByAccountId: account.id,
            },
        });
        ids.screenId = screen.id;

        await auditService.writeAuditLog({
            schoolId: school.id,
            actorType: "ACCOUNT",
            actorAccountId: account.id,
            action: "INTEGRATION_TEST",
            metadata: {pin: "123456", changed: true},
        });
        const audit = await auditService.listAuditLogs({managerAccountId: account.id, schoolId: school.id});
        assert.equal(audit.items[0].metadata.pin, "[REDACTED]");
        const filteredAudit = await auditService.listAuditLogs({
            managerAccountId: account.id,
            schoolId: school.id,
            action: "INTEGRATION_TEST",
            actorType: "ACCOUNT",
            success: "true",
            from: new Date(Date.now() - 60_000).toISOString(),
            to: new Date(Date.now() + 60_000).toISOString(),
        });
        assert.equal(filteredAudit.items.length, 1);
        const failedAudit = await auditService.listAuditLogs({
            managerAccountId: account.id,
            schoolId: school.id,
            success: "false",
        });
        assert.equal(failedAudit.items.length, 0);

        const command = await dutyService.issueClassroomScreenCommand({
            managerAccountId: account.id,
            schoolId: school.id,
            bindingId: screen.id,
            type: "REFRESH_DATA",
        });
        const heartbeat = await dutyService.reportClassroomScreenHeartbeat({
            screenBinding: screen,
            status: {online: true, realtimeConnected: true, syncState: "synced", appVersion: "1.0.0"},
        });
        assert.equal(heartbeat.commands[0].id, command.id);
        await dutyService.acknowledgeClassroomScreenCommand({
            screenBinding: screen,
            commandId: command.id,
            success: true,
            result: {message: "done"},
        });
        const saved = await prisma.classroomScreenBinding.findUnique({where: {id: screen.id}});
        assert.ok(saved.lastHeartbeatAt);
        assert.equal(saved.runtimeStatus.syncState, "synced");
        assert.equal((await prisma.classroomScreenCommand.findUnique({where: {id: command.id}})).status, "ACKNOWLEDGED");
    } finally {
        if (ids.schoolId) await prisma.auditLog.deleteMany({where: {schoolId: ids.schoolId}});
        if (ids.screenId) await prisma.classroomScreenCommand.deleteMany({where: {screenBindingId: ids.screenId}});
        if (ids.screenId) await prisma.classroomScreenBinding.deleteMany({where: {id: ids.screenId}});
        if (ids.workspaceId) await prisma.workspace.deleteMany({where: {id: ids.workspaceId}});
        if (ids.gradeId) await prisma.grade.deleteMany({where: {id: ids.gradeId}});
        if (ids.termId) await prisma.academicTerm.deleteMany({where: {id: ids.termId}});
        if (ids.schoolId) await prisma.schoolMember.deleteMany({where: {schoolId: ids.schoolId}});
        if (ids.schoolId) await prisma.school.deleteMany({where: {id: ids.schoolId}});
        if (ids.accountId) await prisma.account.deleteMany({where: {id: ids.accountId}});
        await prisma.$disconnect();
    }
});
