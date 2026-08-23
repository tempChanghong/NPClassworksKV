import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const shouldRun = process.env.RUN_DATABASE_TESTS === "true";

test("local school login and pending OAuth assignments work together", {skip: !shouldRun}, async () => {
    process.env.BOOTSTRAP_SETUP_KEY = "phase5d-bootstrap-key-that-is-long-enough";
    const [
        {prisma},
        {cloneAcademicTerm, importOrganization, setAcademicTermStatus},
        assignmentService,
        localAccountService,
        workspaceService,
        schoolMembershipService,
        publicationService,
        classroomScreenService,
        classroomToolsService,
        revisionCleanupService,
    ] = await Promise.all([
        import("../utils/prisma.js"),
        import("../services/organizationAdminService.js"),
        import("../services/workspaceAssignmentImportService.js"),
        import("../services/localAccountService.js"),
        import("../services/workspaceMembershipService.js"),
        import("../services/schoolMembershipService.js"),
        import("../services/publicationService.js"),
        import("../services/classroomScreenService.js"),
        import("../services/classroomToolsService.js"),
        import("../services/publicationRevisionCleanupService.js"),
    ]);
    const organization = JSON.parse(readFileSync(
        new URL("../config/examples/newfires-high-school-organization.example.json", import.meta.url),
        "utf8",
    ));
    organization.school.code = "PHASE5C-TEST";
    organization.school.name = "Phase 5C Test School";

    try {
        const ownerLogin = await localAccountService.bootstrapLocalAdministrator({
            setupKey: process.env.BOOTSTRAP_SETUP_KEY,
            schoolCode: organization.school.code,
            username: "admin",
            name: "系统管理员",
            pin: "260100",
        });
        const imported = await importOrganization({
            accountId: ownerLogin.account.id,
            document: organization,
            dryRun: false,
        });
        assert.equal(imported.imported, true);

        const localTeacherImport = await localAccountService.importLocalTeachers({
            managerAccountId: ownerLogin.account.id,
            schoolId: imported.result.school.id,
            termId: imported.result.term.id,
            document: {
                assignments: [{
                    username: "wangls",
                    name: "王老师",
                    pin: "260101",
                    role: "TEACHER",
                    workspaceCodes: ["G2-C1", "G2-PHY-A1"],
                }],
            },
            dryRun: false,
        });
        assert.deepEqual(localTeacherImport.result, {createdAccounts: 1, memberships: 2});

        const secondAdmin = await localAccountService.createLocalAdministrator({
            managerAccountId: ownerLogin.account.id,
            schoolId: imported.result.school.id,
            username: "backup-admin",
            name: "备用管理员",
            pin: "260102",
            role: "ADMIN",
        });
        assert.equal(secondAdmin.role, "ADMIN");
        assert.equal((await localAccountService.listSchoolLocalAccounts({
            managerAccountId: ownerLogin.account.id,
            schoolId: imported.result.school.id,
        })).length, 3);

        const secondAdminLogin = await localAccountService.loginLocalAccount({
            schoolCode: organization.school.code,
            username: "backup-admin",
            password: "260102",
        });
        await localAccountService.changeOwnLocalPin({
            accountId: secondAdminLogin.account.id,
            currentPin: "260102",
            newPin: "260103",
        });
        await assert.rejects(
            localAccountService.loginLocalAccount({
                schoolCode: organization.school.code,
                username: "backup-admin",
                password: "260102",
            }),
            (error) => error.code === "LOCAL_LOGIN_FAILED",
        );
        await localAccountService.loginLocalAccount({
            schoolCode: organization.school.code,
            username: "backup-admin",
            password: "260103",
        });

        const teacherLogin = await localAccountService.loginLocalAccount({
            schoolCode: organization.school.code,
            username: "WangLS",
            password: "260101",
        });
        assert.equal(teacherLogin.account.name, "王老师");
        await localAccountService.updateManagedLocalAccount({
            managerAccountId: ownerLogin.account.id,
            schoolId: imported.result.school.id,
            accountId: teacherLogin.account.id,
            pin: "260199",
        });
        await assert.rejects(
            localAccountService.loginLocalAccount({
                schoolCode: organization.school.code,
                username: "wangls",
                password: "260101",
            }),
            (error) => error.code === "LOCAL_LOGIN_FAILED",
        );
        await localAccountService.loginLocalAccount({
            schoolCode: organization.school.code,
            username: "wangls",
            password: "260199",
        });
        await assert.rejects(
            localAccountService.loginLocalAccount({
                schoolCode: organization.school.code,
                username: "unknown",
                password: "000000",
            }),
            (error) => error.code === "LOCAL_LOGIN_FAILED",
        );
        const teacherWorkspaces = await workspaceService.listMyWorkspaces({accountId: teacherLogin.account.id});
        assert.equal(teacherWorkspaces.length, 2);
        const classOneWorkspace = teacherWorkspaces.find(({workspace}) => workspace.code === "G2-C1").workspace;
        const physics = await prisma.subject.findUnique({
            where: {
                schoolId_code: {
                    schoolId: imported.result.school.id,
                    code: "PHY",
                },
            },
        });
        const emptyFeed = await publicationService.listPublishedFeed({
            workspaceIds: [classOneWorkspace.id],
        });
        assert.deepEqual(emptyFeed.items, []);
        assert.equal(emptyFeed.nextTransitionAt, null);
        const teacherPublication = await publicationService.createPublication({
            accountId: teacherLogin.account.id,
            input: {
                type: "ASSIGNMENT",
                status: "PUBLISHED",
                priority: "NORMAL",
                subjectId: physics.id,
                title: "数据库集成测试作业",
                content: "验证教师列表与学生 feed",
                boardDate: new Date().toISOString().slice(0, 10),
                publishAt: new Date(Date.now() - 1000).toISOString(),
                targetWorkspaceIds: [classOneWorkspace.id],
            },
        });
        const teacherPublications = await publicationService.listPublications({
            accountId: teacherLogin.account.id,
        });
        assert.equal(teacherPublications.items.length, 1);
        const populatedFeed = await publicationService.listPublishedFeed({
            workspaceIds: [classOneWorkspace.id],
        });
        assert.equal(populatedFeed.items.length, 1);
        assert.equal(populatedFeed.items[0].title, "数据库集成测试作业");
        assert.equal(teacherPublication.isCertified, true);
        const historicalFeed = await publicationService.listPublishedFeed({
            workspaceIds: [classOneWorkspace.id],
            boardDate: "1999-01-01",
        });
        assert.equal(historicalFeed.items.length, 0);
        assert.equal((await publicationService.listPublicationRevisions({
            accountId: teacherLogin.account.id,
            publicationId: teacherPublication.id,
        })).length, 1);

        const classThreeWorkspace = await prisma.workspace.findUnique({
            where: {termId_code: {termId: imported.result.term.id, code: "G2-C3"}},
        });
        const physicsA1Workspace = await prisma.workspace.findUnique({
            where: {termId_code: {termId: imported.result.term.id, code: "G2-PHY-A1"}},
        });
        const classFourWorkspace = await prisma.workspace.findUnique({
            where: {termId_code: {termId: imported.result.term.id, code: "G2-C4"}},
        });
        const unrelatedPhysicsWorkspace = await prisma.workspace.create({
            data: {
                termId: imported.result.term.id,
                gradeId: classThreeWorkspace.gradeId,
                subjectId: physics.id,
                code: "G2-PHY-UNRELATED",
                name: "物理无关测试班",
                type: "COURSE_GROUP",
                sourceClasses: {
                    create: {administrativeClassId: classFourWorkspace.id},
                },
            },
        });
        const {binding, token} = await classroomScreenService.bindClassroomScreen({
            managerAccountId: ownerLogin.account.id,
            schoolId: imported.result.school.id,
            administrativeClassId: classThreeWorkspace.id,
            deviceFingerprint: "phase6-integration-screen",
            name: "高二3班一体机",
        });
        assert.ok(token.length >= 32);
        const authenticatedScreen = await classroomScreenService.authenticateClassroomScreen(token);
        const screenTargets = await classroomScreenService.listClassroomScreenTargets(authenticatedScreen);
        assert.ok(screenTargets.workspaces.some((workspace) => workspace.id === classThreeWorkspace.id));
        assert.ok(screenTargets.workspaces.some((workspace) => workspace.id === physicsA1Workspace.id));
        assert.ok(!screenTargets.workspaces.some((workspace) => workspace.id === classOneWorkspace.id));
        assert.ok(!screenTargets.workspaces.some((workspace) => workspace.id === unrelatedPhysicsWorkspace.id));
        const screenFeed = await publicationService.listPublishedFeed({
            workspaceIds: screenTargets.workspaces.map((workspace) => workspace.id),
        });
        assert.ok(screenFeed.workspaceIds.includes(classThreeWorkspace.id));
        assert.ok(screenFeed.workspaceIds.includes(physicsA1Workspace.id));
        assert.ok(!screenFeed.workspaceIds.includes(unrelatedPhysicsWorkspace.id));
        await assert.rejects(
            publicationService.createScreenPublication({
                screenBinding: authenticatedScreen,
                input: {
                    subjectId: physics.id,
                    content: "不应允许写入无关走班",
                    boardDate: new Date().toISOString().slice(0, 10),
                    publishAt: new Date(Date.now() - 1000).toISOString(),
                    targetWorkspaceIds: [unrelatedPhysicsWorkspace.id],
                },
            }),
            (error) => error.code === "SCREEN_TARGET_FORBIDDEN",
        );
        await prisma.workspace.delete({where: {id: unrelatedPhysicsWorkspace.id}});

        const classRoster = await classroomToolsService.replaceClassRoster({
            screenBinding: authenticatedScreen,
            students: [
                {studentNumber: "01", name: "张同学"},
                {studentNumber: "02", name: "李同学"},
                {studentNumber: "03", name: "王同学"},
            ],
        });
        assert.deepEqual(classRoster.map((student) => student.name), ["张同学", "李同学", "王同学"]);
        const attendance = await classroomToolsService.saveClassAttendance({
            screenBinding: authenticatedScreen,
            date: "2026-08-09",
            attendance: {
                absent: [classRoster[0].id],
                late: [classRoster[1].id],
                excluded: [],
            },
        });
        assert.deepEqual(attendance.absent, [classRoster[0].id]);
        assert.deepEqual(attendance.late, [classRoster[1].id]);
        assert.deepEqual(
            await classroomToolsService.getClassAttendance({
                screenBinding: authenticatedScreen,
                date: "2026-08-09",
            }),
            attendance,
        );
        await assert.rejects(
            classroomToolsService.saveClassAttendance({
                screenBinding: authenticatedScreen,
                date: "2026-08-09",
                attendance: {absent: [classRoster[0].id], late: [classRoster[0].id], excluded: []},
            }),
            (error) => error.code === "ATTENDANCE_STATE_CONFLICT",
        );

        let screenPublication = await publicationService.createScreenPublication({
            screenBinding: authenticatedScreen,
            input: {
                subjectId: physics.id,
                title: "大屏未认证作业",
                content: "版本一",
                boardDate: new Date().toISOString().slice(0, 10),
                publishAt: new Date(Date.now() - 1000).toISOString(),
                targetWorkspaceIds: [physicsA1Workspace.id],
            },
        });
        assert.equal(screenPublication.isCertified, false);
        assert.equal(screenPublication.latestActorType, "CLASSROOM_SCREEN");
        const copiedBoard = await publicationService.copyScreenBoardDate({
            screenBinding: authenticatedScreen,
            sourceBoardDate: new Date().toISOString().slice(0, 10),
            targetBoardDate: "2099-01-01",
        });
        assert.equal(copiedBoard.createdCount, 1);
        const copiedAgain = await publicationService.copyScreenBoardDate({
            screenBinding: authenticatedScreen,
            sourceBoardDate: new Date().toISOString().slice(0, 10),
            targetBoardDate: "2099-01-01",
        });
        assert.equal(copiedAgain.createdCount, 0);
        assert.equal(copiedAgain.skippedCount, 1);
        const copiedPublication = copiedBoard.created[0];
        await publicationService.certifyPublication({
            accountId: teacherLogin.account.id,
            publicationId: copiedPublication.id,
            expectedRevision: copiedPublication.revision,
        });
        screenPublication = await publicationService.updateScreenPublication({
            screenBinding: authenticatedScreen,
            publicationId: screenPublication.id,
            expectedRevision: 1,
            input: {content: "版本二"},
        });
        assert.equal(screenPublication.revision, 2);
        assert.equal((await publicationService.getScreenPublication({
            screenBinding: authenticatedScreen,
            publicationId: screenPublication.id,
        })).revision, 2);
        await assert.rejects(
            publicationService.updateScreenPublication({
                screenBinding: authenticatedScreen,
                publicationId: screenPublication.id,
                expectedRevision: 1,
                input: {content: "不应覆盖版本二"},
            }),
            (error) => error.code === "PUBLICATION_REVISION_CONFLICT"
                && error.details.revision === 2,
        );
        let actionCenter = await publicationService.listActionRequiredPublications({
            accountId: teacherLogin.account.id,
        });
        assert.equal(actionCenter.summary.total, 1);
        assert.equal(actionCenter.items[0].reason, "CREATED_BY_SCREEN");
        assert.equal((await publicationService.listScreenPublicationRevisions({
            screenBinding: authenticatedScreen,
            publicationId: screenPublication.id,
        })).length, 2);
        screenPublication = await publicationService.certifyPublication({
            accountId: teacherLogin.account.id,
            publicationId: screenPublication.id,
            expectedRevision: 2,
        });
        assert.equal(screenPublication.isCertified, true);
        assert.equal(screenPublication.revision, 2);
        actionCenter = await publicationService.listActionRequiredPublications({
            accountId: teacherLogin.account.id,
        });
        assert.equal(actionCenter.summary.total, 0);
        screenPublication = await publicationService.updateScreenPublication({
            screenBinding: authenticatedScreen,
            publicationId: screenPublication.id,
            expectedRevision: 2,
            input: {content: "版本三，认证后又被大屏修改"},
        });
        assert.equal(screenPublication.isCertified, false);
        actionCenter = await publicationService.listActionRequiredPublications({
            accountId: teacherLogin.account.id,
        });
        assert.equal(actionCenter.items[0].reason, "CHANGED_AFTER_CERTIFICATION");
        assert.deepEqual(actionCenter.items[0].changedFields.map((change) => change.field), ["content"]);
        screenPublication = await publicationService.restoreScreenPublicationRevision({
            screenBinding: authenticatedScreen,
            publicationId: screenPublication.id,
            sourceRevision: 2,
            expectedRevision: 3,
        });
        assert.equal(screenPublication.revision, 4);
        assert.equal(screenPublication.content, "版本二");
        assert.equal(screenPublication.isCertified, true);
        actionCenter = await publicationService.listActionRequiredPublications({
            accountId: teacherLogin.account.id,
        });
        assert.equal(actionCenter.summary.total, 0);
        assert.equal((await publicationService.listScreenPublicationRevisions({
            screenBinding: authenticatedScreen,
            publicationId: screenPublication.id,
        })).length, 4);
        await prisma.publicationRevision.updateMany({
            where: {
                publicationId: screenPublication.id,
                revision: {in: [1, 3]},
            },
            data: {createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)},
        });
        await prisma.workspace.update({where: {id: physicsA1Workspace.id}, data: {isActive: false}});
        const cleanup = await revisionCleanupService.purgeExpiredDisabledPublicationRevisions();
        assert.equal(cleanup.purged, 2);
        const cleanedRevisions = await prisma.publicationRevision.findMany({
            where: {publicationId: screenPublication.id},
            orderBy: {revision: "asc"},
        });
        assert.ok(cleanedRevisions[0].purgedAt);
        assert.equal(cleanedRevisions[0].snapshot.purged, true);
        assert.equal(cleanedRevisions[1].purgedAt, null);
        assert.ok(cleanedRevisions[2].purgedAt);
        assert.equal(cleanedRevisions[3].purgedAt, null);
        await prisma.workspace.update({where: {id: physicsA1Workspace.id}, data: {isActive: true}});
        assert.ok(binding.id);
        await prisma.school.update({
            where: {id: imported.result.school.id},
            data: {teacherAuthMode: "OAUTH_EMAIL"},
        });
        assert.equal((await workspaceService.listMyWorkspaces({accountId: teacherLogin.account.id})).length, 0);
        await assert.rejects(
            localAccountService.loginLocalAccount({
                schoolCode: organization.school.code,
                username: "wangls",
                password: "260101",
            }),
            (error) => error.code === "LOCAL_LOGIN_DISABLED",
        );
        await prisma.school.update({
            where: {id: imported.result.school.id},
            data: {teacherAuthMode: "LOCAL_PIN"},
        });

        const pending = await assignmentService.importWorkspaceAssignments({
            managerAccountId: ownerLogin.account.id,
            schoolId: imported.result.school.id,
            termId: imported.result.term.id,
            document: {
                assignments: [{
                    email: "Teacher@Example.com",
                    role: "TEACHER",
                    workspaceCodes: ["G2-C1", "G2-PHY-A1"],
                }],
            },
            dryRun: false,
        });
        assert.deepEqual(pending.result, {memberships: 0, invitations: 2});

        const teacher = await prisma.account.create({
            data: {provider: "test", providerId: "phase5c-teacher", email: "teacher@example.com"},
        });
        const claimed = await assignmentService.claimWorkspaceInvitations({
            accountId: teacher.id,
            email: teacher.email,
        });
        assert.equal(claimed.claimed, 2);
        assert.equal(await prisma.workspaceMember.count({where: {accountId: teacher.id}}), 2);
        assert.equal(await prisma.workspaceMemberInvite.count({where: {claimedAt: null}}), 0);

        const direct = await assignmentService.importWorkspaceAssignments({
            managerAccountId: ownerLogin.account.id,
            schoolId: imported.result.school.id,
            termId: imported.result.term.id,
            document: {
                assignments: [{
                    email: "TEACHER@EXAMPLE.COM",
                    role: "TEACHER",
                    workspaceCodes: ["G2-C2"],
                }],
            },
            dryRun: false,
        });
        assert.deepEqual(direct.result, {memberships: 1, invitations: 0});

        const roster = await assignmentService.listWorkspaceAssignments({
            managerAccountId: ownerLogin.account.id,
            schoolId: imported.result.school.id,
            termId: imported.result.term.id,
        });
        assert.equal(roster.workspaces.find((item) => item.code === "G2-C2").members.length, 1);
        assert.equal(roster.workspaces.find((item) => item.code === "G2-C1").members.length, 2);
        assert.equal((await workspaceService.listMyWorkspaces({accountId: teacher.id})).length, 0);
        await prisma.school.update({
            where: {id: imported.result.school.id},
            data: {allowOAuthTeacherLogin: true},
        });
        assert.equal((await workspaceService.listMyWorkspaces({accountId: teacher.id})).length, 3);

        const futureInvite = await assignmentService.importWorkspaceAssignments({
            managerAccountId: ownerLogin.account.id,
            schoolId: imported.result.school.id,
            termId: imported.result.term.id,
            document: {
                assignments: [{
                    email: "future@example.com",
                    role: "TEACHER",
                    workspaceCodes: ["G2-C1"],
                }],
            },
            dryRun: false,
        });
        assert.deepEqual(futureInvite.result, {memberships: 0, invitations: 1});

        const clonedTerm = await cloneAcademicTerm({
            accountId: ownerLogin.account.id,
            sourceTermId: imported.result.term.id,
            target: {
                name: "2027-2028学年上学期",
                academicYear: 2027,
                semester: 1,
                startsAt: "2027-09-01",
                endsAt: "2028-01-31",
            },
        });
        assert.equal(clonedTerm.workspaces, 20);
        assert.equal(clonedTerm.pendingInvitations, 1);
        assert.equal((await workspaceService.listMyWorkspaces({
            accountId: teacherLogin.account.id,
            termId: clonedTerm.id,
        })).length, 2);

        await setAcademicTermStatus({
            accountId: ownerLogin.account.id,
            termId: clonedTerm.id,
            status: "ACTIVE",
        });
        const schoolTerms = (await schoolMembershipService.listMySchools(ownerLogin.account.id))[0].school.terms;
        assert.equal(schoolTerms.length, 2);
        assert.equal(schoolTerms.find((term) => term.id === imported.result.term.id).status, "ARCHIVED");
        assert.equal((await workspaceService.listMyWorkspaces({accountId: teacher.id})).length, 3);

        await localAccountService.updateManagedLocalAccount({
            managerAccountId: ownerLogin.account.id,
            schoolId: imported.result.school.id,
            accountId: teacherLogin.account.id,
            disabled: true,
        });
        await assert.rejects(
            localAccountService.loginLocalAccount({
                schoolCode: organization.school.code,
                username: "wangls",
                password: "260199",
            }),
            (error) => error.code === "LOCAL_ACCOUNT_DISABLED",
        );
        await localAccountService.updateManagedLocalAccount({
            managerAccountId: ownerLogin.account.id,
            schoolId: imported.result.school.id,
            accountId: teacherLogin.account.id,
            disabled: false,
        });

        await localAccountService.recoverLocalOwner({
            setupKey: process.env.BOOTSTRAP_SETUP_KEY,
            schoolCode: organization.school.code,
            username: "admin",
            newPin: "260188",
        });
        await localAccountService.loginLocalAccount({
            schoolCode: organization.school.code,
            username: "admin",
            password: "260188",
        });

        const deactivated = await localAccountService.deactivateLocalAccount({
            managerAccountId: ownerLogin.account.id,
            schoolId: imported.result.school.id,
            accountId: teacherLogin.account.id,
        });
        assert.equal(deactivated.removedWorkspaceMemberships, 4);
        assert.equal((await workspaceService.listMyWorkspaces({accountId: teacherLogin.account.id})).length, 0);
    } finally {
        await prisma.$disconnect();
    }
});
