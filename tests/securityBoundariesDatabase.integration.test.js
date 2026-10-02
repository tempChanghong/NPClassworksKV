import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import bcrypt from "bcrypt";

test("security boundaries with real PostgreSQL", {skip: process.env.RUN_DATABASE_TESTS !== "true"}, async t => {
    const {prisma} = await import("../utils/prisma.js");
    const {upsertSchoolMember} = await import("../services/schoolMembershipService.js");
    const {upsertWorkspaceMember} = await import("../services/workspaceMembershipService.js");
    const {importWorkspaceAssignments} = await import("../services/workspaceAssignmentImportService.js");
    const migration = await import("../services/schoolMigrationService.js");
    const screens = await import("../services/classroomScreenService.js");
    const code = ("SEC-" + randomUUID()).toUpperCase();
    const school = await prisma.school.create({data: {code, name: "Security regression"}});
    const owner = await prisma.account.create({data: {provider: "school-local", providerId: code + ":owner", localUsername: "owner", name: "Owner", localPasswordHash: await bcrypt.hash("123456", 10)}});
    const foreign = await prisma.account.create({data: {provider: "school-local", providerId: "FOREIGN:teacher-" + randomUUID(), localUsername: "teacher", name: "Foreign", email: code + "@invalid.example", localPasswordHash: await bcrypt.hash("123456", 10)}});
    const federated = await prisma.account.create({data: {provider: "integration-test", providerId: randomUUID(), name: "Federated"}});
    await prisma.schoolMember.create({data: {schoolId: school.id, accountId: owner.id, role: "OWNER"}});
    const term = await prisma.academicTerm.create({data: {schoolId: school.id, name: "Term", academicYear: 2099, semester: 1, status: "ACTIVE"}});
    const workspace = await prisma.workspace.create({data: {termId: term.id, code: "A", name: "A", type: "ADMIN_CLASS"}});
    const manager = {managerAccountId: owner.id, schoolId: school.id};
    t.after(async () => {
        await prisma.classroomScreenBinding.deleteMany({where: {schoolId: school.id}});
        await prisma.workspaceMember.deleteMany({where: {workspaceId: workspace.id}});
        await prisma.workspace.delete({where: {id: workspace.id}});
        await prisma.academicTerm.delete({where: {id: term.id}});
        await prisma.schoolMember.deleteMany({where: {schoolId: school.id}});
        await prisma.school.delete({where: {id: school.id}});
        await prisma.account.deleteMany({where: {id: {in: [owner.id, foreign.id, federated.id]}}});
        await prisma.$disconnect();
    });
    await t.test("foreign ID/email memberships are rejected, same-school and federated workflows remain", async () => {
        await assert.rejects(upsertSchoolMember({...manager, accountId: foreign.id, role: "VIEWER"}), e => e.code === "LOCAL_ACCOUNT_SCHOOL_MISMATCH");
        await assert.rejects(upsertWorkspaceMember({managerAccountId: owner.id, workspaceId: workspace.id, email: foreign.email, role: "TEACHER"}), e => e.code === "LOCAL_ACCOUNT_SCHOOL_MISMATCH");
        assert.equal((await upsertSchoolMember({...manager, accountId: federated.id, role: "VIEWER"})).accountId, federated.id);
        assert.equal((await upsertWorkspaceMember({managerAccountId: owner.id, workspaceId: workspace.id, accountId: owner.id, role: "TEACHER"})).accountId, owner.id);
    });
    await t.test("bulk email import cannot attach a foreign local account or partially import", async () => {
        await prisma.account.update({where: {id: federated.id}, data: {email: "federated-" + code + "@invalid.example"}});
        const document = {assignments: [
            {email: "federated-" + code + "@invalid.example", role: "TEACHER", workspaceCodes: [workspace.code]},
            {email: foreign.email, role: "TEACHER", workspaceCodes: [workspace.code]},
        ]};
        await assert.rejects(importWorkspaceAssignments({...manager, termId: term.id, document}), e => e.code === "LOCAL_ACCOUNT_SCHOOL_MISMATCH");
        assert.equal(await prisma.workspaceMember.count({where: {workspaceId: workspace.id, accountId: {in: [foreign.id, federated.id]}}}), 0);
        assert.equal((await importWorkspaceAssignments({...manager, termId: term.id, document: {assignments: [document.assignments[0]]}})).result.memberships, 1);
    });
    await t.test("legacy foreign references cannot leak PIN hashes through export", async () => {
        await prisma.schoolMember.create({data: {schoolId: school.id, accountId: foreign.id, role: "VIEWER"}});
        const args = {...manager, currentPin: "123456", passphrase: "security-regression-package"};
        await assert.rejects(migration.createSchoolMigrationPackage(args), e => e.code === "MIGRATION_FOREIGN_LOCAL_ACCOUNT");
        await prisma.schoolMember.delete({where: {schoolId_accountId: {schoolId: school.id, accountId: foreign.id}}});
        const payload = await migration.decryptMigrationPackage((await migration.createSchoolMigrationPackage(args)).buffer, args.passphrase);
        assert.equal(payload.data.accounts.find(a => a.id === owner.id).localPasswordHash, owner.localPasswordHash);
        assert.equal(payload.data.accounts.some(a => a.id === foreign.id), false);
    });
    const screen = await screens.createClassroomScreenAccount({...manager, administrativeClassId: workspace.id, loginCode: "SCREEN", pin: "123456", name: "Screen"});
    const login = pin => screens.loginClassroomScreen({schoolCode: code, loginCode: "SCREEN", pin, deviceFingerprint: "security-test-device"});
    await t.test("PIN/login-code replacement revokes old bearer tokens and allows fresh login", async () => {
        const first = await login("123456");
        await screens.authenticateClassroomScreen(first.token);
        await screens.updateClassroomScreenAccount({...manager, bindingId: screen.id, pin: "654321"});
        await assert.rejects(screens.authenticateClassroomScreen(first.token), e => e.code === "SCREEN_TOKEN_INVALID");
        const second = await login("654321");
        await screens.configureClassroomScreenAccount({...manager, bindingId: screen.id, loginCode: "SCREEN", pin: "123456"});
        await assert.rejects(screens.authenticateClassroomScreen(second.token), e => e.code === "SCREEN_TOKEN_INVALID");
        await screens.authenticateClassroomScreen((await login("123456")).token);
    });
    await t.test("parallel wrong PINs cannot overwrite the lock counter", async () => {
        const attempts = await Promise.allSettled(Array.from({length: 7}, () => login("999999")));
        assert(attempts.every(r => r.status === "rejected"));
        const binding = await prisma.classroomScreenBinding.findUnique({where: {id: screen.id}});
        assert(binding.lockedUntil > new Date());
        await assert.rejects(login("123456"), e => e.code === "SCREEN_ACCOUNT_LOCKED");
        await screens.configureClassroomScreenAccount({...manager, bindingId: screen.id, loginCode: "SCREEN", pin: "123456"});
        await login("123456");
    });
    await t.test("an old-PIN login paused across credential replacement cannot mint a fresh token", async () => {
        const compare = bcrypt.compare;
        let resume, reached;
        const pause = new Promise(r => {resume = r;});
        const ready = new Promise(r => {reached = r;});
        bcrypt.compare = async (...args) => {const ok = await compare(...args); if (args[0] === "123456") {reached(); await pause;} return ok;};
        const pending = login("123456");
        try {
            await ready;
            await screens.configureClassroomScreenAccount({...manager, bindingId: screen.id, loginCode: "SCREEN", pin: "654321"});
            const rejected = assert.rejects(pending, e => e.code === "SCREEN_LOGIN_FAILED");
            resume(); await rejected;
        } finally {resume(); bcrypt.compare = compare; await pending.catch(() => {});}
        await login("654321");
    });
});
