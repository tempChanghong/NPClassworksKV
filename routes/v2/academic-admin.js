import {Router} from "express";
import {readFileSync} from "node:fs";
import {jwtAuth} from "../../middleware/jwt-auth.js";
import errors from "../../utils/errors.js";
import {
    cloneAcademicTerm,
    importOrganization,
    setAcademicTermStatus,
} from "../../services/organizationAdminService.js";
import {
    removeWorkspaceMember,
    upsertWorkspaceMember,
} from "../../services/workspaceMembershipService.js";
import {
    listSchoolMembers,
    removeSchoolMember,
    upsertSchoolMember,
} from "../../services/schoolMembershipService.js";
import {
    importWorkspaceAssignments,
    listWorkspaceAssignments,
    removeWorkspaceInvitation,
} from "../../services/workspaceAssignmentImportService.js";
import {
    createLocalAdministrator,
    deactivateLocalAccount,
    importLocalTeachers,
    listSchoolLocalAccounts,
    updateManagedLocalAccount,
} from "../../services/localAccountService.js";
import {
    bindClassroomScreen,
    configureClassroomScreenAccount,
    createClassroomScreenAccount,
    listClassroomScreens,
    resetClassroomScreenDevice,
    updateClassroomScreenAccount,
} from "../../services/classroomScreenService.js";
import {
    createManagedCourseGroup,
    getManagedAcademicStructure,
    replaceAdministrativeClassSubjectRules,
    updateManagedCourseGroup,
} from "../../services/academicStructureManagementService.js";
import {
    getSchoolHomeworkSettings,
    updateSchoolHomeworkSettings,
} from "../../services/schoolHomeworkSettingsService.js";
import {
    getTeachingRelationshipOverview,
    removeTeachingAssignment,
    upsertTeachingAssignment,
    upsertTeachingAssignmentBatch,
} from "../../services/teachingRelationshipService.js";
import {
    getStaffResponsibilityOverview,
    removeClassLeadership,
    removeGradeLeadership,
    updateStaffResponsibilityPolicy,
    upsertClassLeadership,
    upsertGradeLeadership,
} from "../../services/staffResponsibilityService.js";

const organizationTemplate = JSON.parse(readFileSync(
    new URL("../../config/examples/newfires-high-school-organization.example.json", import.meta.url),
    "utf8",
));

const router = Router();

router.use(jwtAuth);

router.get("/organization/template", (req, res) => {
    return res.json(errors.createSuccessResponse(organizationTemplate));
});

router.post("/organization/import", errors.catchAsync(async (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
    const document = req.body?.organization || req.body;
    const result = await importOrganization({
        accountId: res.locals.account.id,
        document,
        dryRun,
    });

    if (!result.valid) {
        return res.status(422).json({
            success: false,
            code: "ORGANIZATION_VALIDATION_FAILED",
            message: "学校组织配置校验失败",
            data: result,
        });
    }

    return res.status(result.imported ? 201 : 200).json(
        errors.createSuccessResponse(result, result.imported ? "组织配置导入成功" : "组织配置校验通过"),
    );
}));

router.post("/workspace-memberships/import", errors.catchAsync(async (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
    const result = await importWorkspaceAssignments({
        managerAccountId: res.locals.account.id,
        schoolId: req.body?.schoolId,
        termId: req.body?.termId,
        document: req.body?.assignmentPlan || req.body,
        dryRun,
    });
    if (!result.valid) {
        return res.status(422).json({
            success: false,
            code: "WORKSPACE_ASSIGNMENT_VALIDATION_FAILED",
            message: "教师教学空间分配校验失败",
            data: result,
        });
    }
    return res.status(result.imported ? 201 : 200).json(
        errors.createSuccessResponse(result, result.imported ? "教师分配已导入" : "教师分配校验通过"),
    );
}));

router.post("/local-teachers/import", errors.catchAsync(async (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
    const result = await importLocalTeachers({
        managerAccountId: res.locals.account.id,
        schoolId: req.body?.schoolId,
        termId: req.body?.termId,
        document: req.body?.assignmentPlan || req.body,
        dryRun,
    });
    if (!result.valid) {
        return res.status(422).json({
            success: false,
            code: "LOCAL_TEACHER_IMPORT_VALIDATION_FAILED",
            message: "本地教师账号与教学空间分配校验失败",
            data: result,
        });
    }
    return res.status(result.imported ? 201 : 200).json(
        errors.createSuccessResponse(result, result.imported ? "教师短账号已创建并完成分配" : "教师短账号预检通过"),
    );
}));

router.get("/schools/:schoolId/workspace-memberships", errors.catchAsync(async (req, res) => {
    const roster = await listWorkspaceAssignments({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        termId: req.query.termId,
    });
    return res.json(errors.createSuccessResponse(roster));
}));

router.get("/schools/:schoolId/academic-structure", errors.catchAsync(async (req, res) => {
    const structure = await getManagedAcademicStructure({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        termId: req.query.termId,
    });
    return res.json(errors.createSuccessResponse(structure));
}));

router.get("/schools/:schoolId/teaching-relationships", errors.catchAsync(async (req, res) => {
    const overview = await getTeachingRelationshipOverview({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        termId: req.query.termId,
        gradeId: req.query.gradeId,
    });
    return res.json(errors.createSuccessResponse(overview));
}));

router.get("/schools/:schoolId/staff-responsibilities", errors.catchAsync(async (req, res) => {
    const overview = await getStaffResponsibilityOverview({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        termId: req.query.termId,
    });
    return res.json(errors.createSuccessResponse(overview));
}));

router.put("/schools/:schoolId/grade-leaderships", errors.catchAsync(async (req, res) => {
    const leadership = await upsertGradeLeadership({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        input: req.body,
    });
    return res.json(errors.createSuccessResponse(leadership, "年级职责已保存"));
}));

router.delete("/schools/:schoolId/grade-leaderships/:leadershipId", errors.catchAsync(async (req, res) => {
    const result = await removeGradeLeadership({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        leadershipId: req.params.leadershipId,
    });
    return res.json(errors.createSuccessResponse(result, "年级职责已移除"));
}));

router.put("/schools/:schoolId/class-leaderships", errors.catchAsync(async (req, res) => {
    const leadership = await upsertClassLeadership({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        input: req.body,
    });
    return res.json(errors.createSuccessResponse(leadership, "班主任职责已保存"));
}));

router.delete("/schools/:schoolId/class-leaderships/:leadershipId", errors.catchAsync(async (req, res) => {
    const result = await removeClassLeadership({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        leadershipId: req.params.leadershipId,
    });
    return res.json(errors.createSuccessResponse(result, "班主任职责已移除"));
}));

router.put("/schools/:schoolId/staff-responsibility-policy", errors.catchAsync(async (req, res) => {
    const policy = await updateStaffResponsibilityPolicy({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        input: req.body,
    });
    return res.json(errors.createSuccessResponse(policy, "岗位联动规则已更新"));
}));

router.put("/schools/:schoolId/teaching-assignments", errors.catchAsync(async (req, res) => {
    const assignment = await upsertTeachingAssignment({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        input: req.body,
    });
    return res.json(errors.createSuccessResponse(assignment, "任课关系已保存"));
}));

router.put("/schools/:schoolId/teaching-assignments/bulk", errors.catchAsync(async (req, res) => {
    const result = await upsertTeachingAssignmentBatch({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        input: req.body,
    });
    return res.json(errors.createSuccessResponse(result, `已保存 ${result.count} 项任课关系`));
}));

router.delete("/schools/:schoolId/teaching-assignments/:assignmentId", errors.catchAsync(async (req, res) => {
    const result = await removeTeachingAssignment({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        assignmentId: req.params.assignmentId,
    });
    return res.json(errors.createSuccessResponse(result, "任课关系已移除"));
}));

router.put("/schools/:schoolId/administrative-classes/:classId/subject-rules", errors.catchAsync(async (req, res) => {
    const administrativeClass = await replaceAdministrativeClassSubjectRules({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        administrativeClassId: req.params.classId,
        subjectRules: req.body?.subjectRules,
        removeConflictingSources: req.body?.removeConflictingSources === true,
    });
    return res.json(errors.createSuccessResponse(administrativeClass, "行政班授课规则已更新"));
}));

router.post("/schools/:schoolId/course-groups", errors.catchAsync(async (req, res) => {
    const courseGroup = await createManagedCourseGroup({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        termId: req.body?.termId,
        gradeId: req.body?.gradeId,
        code: req.body?.code,
        name: req.body?.name,
        subjectId: req.body?.subjectId,
        sourceClassIds: req.body?.sourceClassIds,
        isStudentSelectable: req.body?.isStudentSelectable,
    });
    return res.status(201).json(errors.createSuccessResponse(courseGroup, "走班教学班已创建"));
}));

router.patch("/schools/:schoolId/course-groups/:courseGroupId", errors.catchAsync(async (req, res) => {
    const courseGroup = await updateManagedCourseGroup({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        courseGroupId: req.params.courseGroupId,
        code: req.body?.code,
        name: req.body?.name,
        subjectId: req.body?.subjectId,
        sourceClassIds: req.body?.sourceClassIds,
        isStudentSelectable: req.body?.isStudentSelectable,
        isActive: req.body?.isActive,
    });
    return res.json(errors.createSuccessResponse(courseGroup, "走班教学班已更新"));
}));

router.get("/schools/:schoolId/local-accounts", errors.catchAsync(async (req, res) => {
    const accounts = await listSchoolLocalAccounts({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
    });
    return res.json(errors.createSuccessResponse(accounts));
}));

router.get("/schools/:schoolId/classroom-screens", errors.catchAsync(async (req, res) => {
    const bindings = await listClassroomScreens({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
    });
    return res.json(errors.createSuccessResponse(bindings));
}));

router.get("/schools/:schoolId/homework-settings", errors.catchAsync(async (req, res) => {
    const settings = await getSchoolHomeworkSettings({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
    });
    return res.json(errors.createSuccessResponse(settings));
}));

router.put("/schools/:schoolId/homework-settings", errors.catchAsync(async (req, res) => {
    const settings = await updateSchoolHomeworkSettings({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        quickDeadlines: req.body?.quickDeadlines,
        quickInputs: req.body?.quickInputs,
    });
    return res.json(errors.createSuccessResponse(settings, "作业快捷设置已更新"));
}));

router.post("/schools/:schoolId/classroom-screens/bind", errors.catchAsync(async (req, res) => {
    const result = await bindClassroomScreen({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        administrativeClassId: req.body?.administrativeClassId,
        deviceFingerprint: req.body?.deviceFingerprint,
        name: req.body?.name,
    });
    return res.status(201).json(errors.createSuccessResponse(result, "当前浏览器已绑定为班级大屏"));
}));

router.post("/schools/:schoolId/classroom-screen-accounts", errors.catchAsync(async (req, res) => {
    const binding = await createClassroomScreenAccount({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        administrativeClassId: req.body?.administrativeClassId,
        loginCode: req.body?.loginCode,
        pin: req.body?.pin,
        name: req.body?.name,
    });
    return res.status(201).json(errors.createSuccessResponse(binding, "大屏账号已创建"));
}));

router.patch("/schools/:schoolId/classroom-screens/:bindingId/account", errors.catchAsync(async (req, res) => {
    const binding = await configureClassroomScreenAccount({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        bindingId: req.params.bindingId,
        loginCode: req.body?.loginCode,
        pin: req.body?.pin,
    });
    return res.json(errors.createSuccessResponse(binding, "现有大屏已升级为设备账号"));
}));

router.patch("/schools/:schoolId/classroom-screens/:bindingId", errors.catchAsync(async (req, res) => {
    const binding = await updateClassroomScreenAccount({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        bindingId: req.params.bindingId,
        administrativeClassId: req.body?.administrativeClassId,
        loginCode: req.body?.loginCode,
        pin: req.body?.pin,
        name: req.body?.name,
        isActive: req.body?.isActive,
    });
    return res.json(errors.createSuccessResponse(binding, "大屏账号已更新"));
}));

router.post("/schools/:schoolId/classroom-screens/:bindingId/reset-device", errors.catchAsync(async (req, res) => {
    const binding = await resetClassroomScreenDevice({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        bindingId: req.params.bindingId,
    });
    return res.json(errors.createSuccessResponse(binding, "原设备登录已失效，可在新设备上重新登录"));
}));

router.post("/schools/:schoolId/local-admins", errors.catchAsync(async (req, res) => {
    const result = await createLocalAdministrator({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        username: req.body?.username,
        name: req.body?.name,
        pin: req.body?.pin,
        role: req.body?.role,
    });
    return res.status(201).json(errors.createSuccessResponse(result, "本地管理员已创建"));
}));

router.patch("/schools/:schoolId/local-accounts/:accountId", errors.catchAsync(async (req, res) => {
    const account = await updateManagedLocalAccount({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        accountId: req.params.accountId,
        name: req.body?.name,
        pin: req.body?.pin,
        disabled: req.body?.disabled,
    });
    return res.json(errors.createSuccessResponse(account, "本地账号已更新"));
}));

router.delete("/schools/:schoolId/local-accounts/:accountId", errors.catchAsync(async (req, res) => {
    const result = await deactivateLocalAccount({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        accountId: req.params.accountId,
    });
    return res.json(errors.createSuccessResponse(result, "账号已停用并移除学校权限"));
}));

router.delete(
    "/workspaces/:workspaceId/invitations/:invitationId",
    errors.catchAsync(async (req, res) => {
        await removeWorkspaceInvitation({
            managerAccountId: res.locals.account.id,
            workspaceId: req.params.workspaceId,
            invitationId: req.params.invitationId,
        });
        return res.status(204).end();
    }),
);

router.post("/terms/:termId/status", errors.catchAsync(async (req, res) => {
    const term = await setAcademicTermStatus({
        accountId: res.locals.account.id,
        termId: req.params.termId,
        status: req.body?.status,
    });
    return res.json(errors.createSuccessResponse(term, "学期状态已更新"));
}));

router.post("/terms/:termId/clone", errors.catchAsync(async (req, res) => {
    const term = await cloneAcademicTerm({
        accountId: res.locals.account.id,
        sourceTermId: req.params.termId,
        target: req.body,
    });
    return res.status(201).json(errors.createSuccessResponse(term, "学期结构复制成功"));
}));

router.get("/schools/:schoolId/members", errors.catchAsync(async (req, res) => {
    const members = await listSchoolMembers({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
    });
    return res.json(errors.createSuccessResponse(members));
}));

router.put("/schools/:schoolId/members", errors.catchAsync(async (req, res) => {
    const membership = await upsertSchoolMember({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        accountId: req.body?.accountId,
        email: req.body?.email,
        role: req.body?.role || "VIEWER",
    });
    return res.json(errors.createSuccessResponse(membership, "学校成员已更新"));
}));

router.delete(
    "/schools/:schoolId/members/:accountId",
    errors.catchAsync(async (req, res) => {
        await removeSchoolMember({
            managerAccountId: res.locals.account.id,
            schoolId: req.params.schoolId,
            accountId: req.params.accountId,
        });
        return res.status(204).end();
    }),
);

router.put("/workspaces/:workspaceId/members", errors.catchAsync(async (req, res) => {
    const membership = await upsertWorkspaceMember({
        managerAccountId: res.locals.account.id,
        workspaceId: req.params.workspaceId,
        accountId: req.body?.accountId,
        email: req.body?.email,
        role: req.body?.role || "TEACHER",
    });
    return res.json(errors.createSuccessResponse(membership, "教学空间成员已更新"));
}));

router.delete(
    "/workspaces/:workspaceId/members/:accountId",
    errors.catchAsync(async (req, res) => {
        await removeWorkspaceMember({
            managerAccountId: res.locals.account.id,
            workspaceId: req.params.workspaceId,
            accountId: req.params.accountId,
        });
        return res.status(204).end();
    }),
);

export default router;
