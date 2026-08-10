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
    listClassroomScreens,
    setClassroomScreenActive,
} from "../../services/classroomScreenService.js";

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

router.patch("/schools/:schoolId/classroom-screens/:bindingId", errors.catchAsync(async (req, res) => {
    const binding = await setClassroomScreenActive({
        managerAccountId: res.locals.account.id,
        schoolId: req.params.schoolId,
        bindingId: req.params.bindingId,
        isActive: req.body?.isActive,
    });
    return res.json(errors.createSuccessResponse(binding, binding.isActive ? "大屏绑定已启用" : "大屏绑定已停用"));
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
