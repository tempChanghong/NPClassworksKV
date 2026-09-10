import test from "node:test";
import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";

test("managed roster preserves identities/history, rejects cross-school and serializes screen/admin saves", {skip: process.env.RUN_DATABASE_TESTS !== "true"}, async () => {
    const [{prisma}, service, {default: express}, {default: adminRouter}, {default: screenRouter}, {generateAccessToken}] = await Promise.all([
        import("../utils/prisma.js"), import("../services/classroomToolsService.js"), import("express"),
        import("../routes/v2/academic-admin.js"), import("../routes/v2/classroom-screens.js"), import("../utils/tokenManager.js"),
    ]);
    const app = express(); app.use(express.json());
    app.use("/api/v2/admin", adminRouter); app.use("/api/v2/classroom-screens", screenRouter);
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({code: error.code}));
    const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const suffix = randomUUID();
    let school, account, term, classroom, screen;
    try {
        school = await prisma.school.create({data: {code: `ROSTER-${suffix}`, name: "名单测试学校"}});
        account = await prisma.account.create({data: {provider: "integration-test", providerId: suffix}});
        await prisma.schoolMember.create({data: {schoolId: school.id, accountId: account.id, role: "ADMIN"}});
        term = await prisma.academicTerm.create({data: {schoolId: school.id, name: "测试学期", academicYear: 2099, semester: 1, status: "ACTIVE"}});
        classroom = await prisma.workspace.create({data: {termId: term.id, code: "C1", name: "测试班", type: "ADMIN_CLASS"}});
        screen = await prisma.classroomScreenBinding.create({data: {schoolId: school.id, administrativeClassId: classroom.id, name: "大屏", tokenHash: createHash("sha256").update(suffix).digest("hex"), createdByAccountId: account.id}});
        const args = {managerAccountId: account.id, schoolId: school.id, administrativeClassId: classroom.id};
        const path = `/api/v2/admin/schools/${school.id}/administrative-classes/${classroom.id}/students`;
        const headers = {Authorization: `Bearer ${generateAccessToken(account)}`, "Content-Type": "application/json"};
        const request = (url, options = {}) => fetch(origin + url, {headers, signal: AbortSignal.timeout(10000), ...options});
        assert.equal((await request(path, {headers: {}})).status, 401);
        const initial = await service.getManagedClassRoster(args);
        assert.deepEqual((await (await request(path)).json()).data, initial);
        await assert.rejects(service.replaceClassRoster({...args, students: []}), {code: "CLASS_ROSTER_VERSION_REQUIRED"});
        const savedResponse = await request(path, {method: "PUT", body: JSON.stringify({students: [{name: "张三", studentNumber: "01"}, {name: "李四", studentNumber: "02"}], expectedRevision: initial.revision})});
        assert.equal(savedResponse.status, 200);
        const first = (await savedResponse.json()).data.students;
        const screenResponse = await request("/api/v2/classroom-screens/students", {headers: {"X-Classworks-Screen-Token": suffix}});
        const screenBody = await screenResponse.json();
        assert.equal(screenResponse.status, 200);
        assert.ok(Array.isArray(screenBody.data));
        assert.equal(screenBody.rosterRevision, service.rosterRevision(first));
        assert.equal((await request("/api/v2/classroom-screens/students", {headers: {"X-Classworks-Screen-Token": suffix, "Content-Type": "application/json"}, method: "PUT", body: JSON.stringify({students: []})})).status, 428);
        const attendance = await service.saveClassAttendance({screenBinding: screen, date: "2099-01-01", attendance: {absent: [first[1].id]}});
        assert.deepEqual(attendance.absent, [first[1].id]);
        const revision = service.rosterRevision(first);
        const concurrent = await Promise.allSettled([
            service.replaceClassRoster({...args, students: [{...first[0], name: "张小三"}], expectedRevision: revision}),
            service.replaceClassRoster({screenBinding: screen, students: [{...first[0], name: "张新三"}], expectedRevision: revision}),
        ]);
        assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
        assert.equal(concurrent.find(r => r.status === "rejected").reason.code, "CLASS_ROSTER_CONFLICT");
        let current = await service.getManagedClassRoster(args);
        const screenFirst = await Promise.allSettled([
            service.replaceClassRoster({screenBinding: screen, students: [{...current.students[0], name: "大屏先保存"}], expectedRevision: current.revision}),
            service.replaceClassRoster({...args, students: [{...current.students[0], name: "管理员随后保存"}], expectedRevision: current.revision}),
        ]);
        assert.equal(screenFirst.filter(r => r.status === "fulfilled").length, 1);
        assert.equal(screenFirst.find(r => r.status === "rejected").reason.code, "CLASS_ROSTER_CONFLICT");
        current = await service.getManagedClassRoster(args);
        assert.equal(current.students[0].id, first[0].id);
        assert.equal((await prisma.administrativeClassStudent.findUnique({where: {id: first[1].id}})).isActive, false);
        assert.deepEqual((await service.getClassAttendance({screenBinding: screen, date: "2099-01-01"})).absent, [first[1].id]);
        await assert.rejects(service.getManagedClassRoster({...args, schoolId: "another-school"}), {code: "SCHOOL_ADMIN_REQUIRED"});
        await assert.rejects(service.replaceClassRoster({...args, administrativeClassId: "another-class", students: [], expectedRevision: current.revision}), {code: "CLASS_ROSTER_CLASS_INVALID"});
        await assert.rejects(service.replaceClassRoster({...args, students: [{id: "foreign-student", name: "越界"}], expectedRevision: current.revision}), {code: "CLASS_ROSTER_STUDENT_INVALID"});
        await prisma.schoolMember.update({where: {schoolId_accountId: {schoolId: school.id, accountId: account.id}}, data: {role: "VIEWER"}});
        assert.equal((await request(path)).status, 403);
        await assert.rejects(service.replaceClassRoster({...args, students: [], expectedRevision: current.revision}), {code: "SCHOOL_ADMIN_REQUIRED"});
        await prisma.classroomScreenBinding.update({where: {id: screen.id}, data: {isActive: false}});
        await assert.rejects(service.replaceClassRoster({screenBinding: screen, students: [], expectedRevision: current.revision}), {code: "SCREEN_TOKEN_INVALID"});
        const logs = await prisma.auditLog.findMany({where: {schoolId: school.id, action: "CLASS_ROSTER_SAVED"}});
        assert.equal(logs.length, 3);
        assert.ok(logs.some(log => log.metadata.before.some(s => s.id === first[1].id)));
    } finally {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        if (school) await prisma.auditLog.deleteMany({where: {schoolId: school.id}});
        if (screen) await prisma.classroomScreenBinding.deleteMany({where: {id: screen.id}});
        if (classroom) await prisma.workspace.deleteMany({where: {id: classroom.id}});
        if (term) await prisma.academicTerm.deleteMany({where: {id: term.id}});
        if (school) { await prisma.schoolMember.deleteMany({where: {schoolId: school.id}}); await prisma.school.deleteMany({where: {id: school.id}}); }
        if (account) await prisma.account.deleteMany({where: {id: account.id}});
        await prisma.$disconnect();
    }
});
