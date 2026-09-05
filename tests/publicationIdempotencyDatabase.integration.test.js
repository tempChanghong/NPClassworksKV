import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";

test("screen creation is idempotent across concurrent requests and later retries", {
    skip: process.env.RUN_DATABASE_TESTS !== "true",
}, async () => {
    const {prisma} = await import("../utils/prisma.js");
    const {createScreenPublication} = await import("../services/publicationService.js");
    const suffix = randomUUID();
    let school;
    let account;
    try {
        account = await prisma.account.create({data: {provider: "integration-test", providerId: suffix}});
        school = await prisma.school.create({data: {code: `IDEM-${suffix}`, name: "幂等测试学校"}});
        const term = await prisma.academicTerm.create({data: {
            schoolId: school.id, name: "测试学期", academicYear: 2099, semester: 1, status: "ACTIVE",
        }});
        const subject = await prisma.subject.create({data: {schoolId: school.id, code: "math", name: "数学"}});
        const workspace = await prisma.workspace.create({data: {
            termId: term.id, code: "C1", name: "测试班", type: "ADMIN_CLASS",
            subjectRules: {create: {subjectId: subject.id, deliveryMode: "ADMIN_CLASS"}},
        }});
        const screen = await prisma.classroomScreenBinding.create({data: {
            schoolId: school.id, administrativeClassId: workspace.id,
            name: "测试大屏", tokenHash: suffix.replaceAll("-", "").padEnd(64, "0"), createdByAccountId: account.id,
        }});
        const screenBinding = {...screen, administrativeClass: workspace};
        const input = {clientRequestId: randomUUID(), targetWorkspaceIds: [workspace.id],
            subjectId: subject.id, content: "数学作业", boardDate: "2099-01-01",
            publishAt: "2099-01-01T08:00:00.000Z", allowDuplicate: true};
        const results = await Promise.all(Array.from({length: 6}, () => createScreenPublication({screenBinding, input})));
        const id = results[0].id;
        assert.ok(results.every((item) => item.id === id));
        assert.equal(await prisma.publication.count({where: {creationScreenBindingId: screen.id}}), 1);
        assert.equal(await prisma.publicationRevision.count({where: {publicationId: id}}), 1);

        // A later retry must succeed even without bypassing duplicate detection.
        assert.equal((await createScreenPublication({screenBinding, input: {...input, allowDuplicate: false}})).id, id);
        await assert.rejects(createScreenPublication({screenBinding, input: {...input, content: "不同内容"}}),
            {code: "PUBLICATION_REQUEST_CONFLICT"});

        // Editing/certifying the publication must not destroy its original creation identity.
        await prisma.publication.update({where: {id}, data: {content: "教师修订", revision: 2, latestScreenBindingId: null}});
        const replay = await createScreenPublication({screenBinding, input});
        assert.equal(replay.id, id);
        assert.equal(replay.content, "教师修订");
        assert.equal(replay.revision, 2);

        const secondScreen = await prisma.classroomScreenBinding.create({data: {
            schoolId: school.id, administrativeClassId: workspace.id, name: "另一大屏", tokenHash: "b".repeat(64), createdByAccountId: account.id,
        }});
        const other = await createScreenPublication({screenBinding: {...secondScreen, administrativeClass: workspace}, input});
        assert.notEqual(other.id, id);

        // A failed transaction does not reserve the key: explicit duplicate confirmation can retry it.
        const retryInput = {...input, clientRequestId: randomUUID(), allowDuplicate: false};
        await assert.rejects(createScreenPublication({screenBinding, input: retryInput}), {code: "DUPLICATE_ASSIGNMENT_SUSPECTED"});
        const confirmed = await createScreenPublication({screenBinding, input: {...retryInput, allowDuplicate: true}});
        assert.ok(confirmed.id);
    } finally {
        if (school) {
            const subjects = await prisma.subject.findMany({where: {schoolId: school.id}, select: {id: true}});
            const publications = await prisma.publication.findMany({where: {subjectId: {in: subjects.map((item) => item.id)}}, select: {id: true}});
            const ids = publications.map((item) => item.id);
            await prisma.publicationRevision.deleteMany({where: {publicationId: {in: ids}}});
            await prisma.publicationTarget.deleteMany({where: {publicationId: {in: ids}}});
            await prisma.publication.deleteMany({where: {id: {in: ids}}});
            await prisma.classroomScreenBinding.deleteMany({where: {schoolId: school.id}});
            await prisma.administrativeClassSubject.deleteMany({where: {subjectId: {in: subjects.map((item) => item.id)}}});
            await prisma.workspace.deleteMany({where: {term: {schoolId: school.id}}});
            await prisma.subject.deleteMany({where: {schoolId: school.id}});
            await prisma.academicTerm.deleteMany({where: {schoolId: school.id}});
            await prisma.school.delete({where: {id: school.id}});
        }
        if (account) await prisma.account.delete({where: {id: account.id}});
        await prisma.$disconnect();
    }
});
