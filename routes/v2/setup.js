import {Router} from "express";
import {readFileSync} from "node:fs";
import errors from "../../utils/errors.js";
import {localAuthLimiter} from "../../middleware/rateLimiter.js";
import {createSetupToken, setupKeyMatches, setupTokenAuth} from "../../utils/setupToken.js";
import {
    completeInstanceSetup,
    createInstanceSetupScreen,
    getInstanceSetupContext,
    getInstanceSetupStatus,
    importInstanceSetupOrganization,
    importInstanceSetupStaffConfiguration,
    importInstanceSetupTeachers,
    initializeInstanceCore,
    verifyInstanceSetupLogin,
} from "../../services/instanceSetupService.js";

const organizationTemplate = JSON.parse(readFileSync(
    new URL("../../config/examples/newfires-high-school-organization.example.json", import.meta.url),
    "utf8",
));
const staffConfigurationTemplate = JSON.parse(readFileSync(
    new URL("../../config/examples/teacher-configuration.example.json", import.meta.url),
    "utf8",
));

const router = Router();
const BULK_IMPORT_TIMEOUT_MS = 150000;

function bulkImportTimeout(req, res, next) {
    req.setTimeout(BULK_IMPORT_TIMEOUT_MS);
    res.setTimeout(BULK_IMPORT_TIMEOUT_MS);
    next();
}

router.get("/status", errors.catchAsync(async (req, res) => {
    return res.json(errors.createSuccessResponse(await getInstanceSetupStatus()));
}));

router.post("/session", localAuthLimiter, errors.catchAsync(async (req, res) => {
    const status = await getInstanceSetupStatus();
    if (status.state === "COMPLETED") {
        throw errors.createError(409, "实例已经完成初始化", null, "SETUP_ALREADY_COMPLETED");
    }
    if (!setupKeyMatches(req.body?.setupKey)) {
        throw errors.createError(401, "初始化密钥不正确", null, "INVALID_BOOTSTRAP_KEY");
    }
    return res.json(errors.createSuccessResponse(createSetupToken(), "初始化会话已创建"));
}));

router.post("/initialize", setupTokenAuth, errors.catchAsync(async (req, res) => {
    const result = await initializeInstanceCore(req.body || {});
    return res.status(201).json(errors.createSuccessResponse(result, "管理员、学校与学期已创建"));
}));

router.get("/context", setupTokenAuth, errors.catchAsync(async (req, res) => {
    return res.json(errors.createSuccessResponse(await getInstanceSetupContext()));
}));

router.get("/organization/template", setupTokenAuth, (req, res) => {
    return res.json(errors.createSuccessResponse(organizationTemplate));
});

router.get("/staff-configuration/template", setupTokenAuth, (req, res) => {
    return res.json(errors.createSuccessResponse(staffConfigurationTemplate));
});

router.post("/organization/import", setupTokenAuth, errors.catchAsync(async (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
    const result = await importInstanceSetupOrganization(req.body?.organization || req.body, dryRun);
    if (!result.valid) {
        return res.status(422).json({
            success: false,
            code: "ORGANIZATION_VALIDATION_FAILED",
            message: "学校组织配置校验失败",
            data: result,
        });
    }
    return res.status(result.imported ? 201 : 200).json(errors.createSuccessResponse(result));
}));

router.post("/teachers/import", setupTokenAuth, bulkImportTimeout, errors.catchAsync(async (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
    const result = await importInstanceSetupTeachers(req.body?.assignmentPlan || req.body, dryRun);
    if (!result.valid) {
        return res.status(422).json({
            success: false,
            code: "LOCAL_TEACHER_IMPORT_VALIDATION_FAILED",
            message: "教师账号与任课空间校验失败",
            data: result,
        });
    }
    return res.status(result.imported ? 201 : 200).json(errors.createSuccessResponse(result));
}));

router.post("/staff-configuration/import", setupTokenAuth, bulkImportTimeout, errors.catchAsync(async (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
    const result = await importInstanceSetupStaffConfiguration(req.body?.staffConfiguration || req.body, dryRun);
    if (!result.valid) {
        return res.status(422).json({
            success: false,
            code: "STAFF_CONFIGURATION_VALIDATION_FAILED",
            message: "教师账号、任课与职责配置校验失败",
            data: result,
        });
    }
    return res.status(result.imported ? 201 : 200).json(errors.createSuccessResponse(result));
}));

router.post("/screens", setupTokenAuth, errors.catchAsync(async (req, res) => {
    return res.status(201).json(errors.createSuccessResponse(
        await createInstanceSetupScreen(req.body || {}),
        "首个大屏账号已创建",
    ));
}));

router.post("/verify-login", localAuthLimiter, setupTokenAuth, errors.catchAsync(async (req, res) => {
    return res.json(errors.createSuccessResponse(
        await verifyInstanceSetupLogin(req.body || {}),
        "登录凭据验证通过，未签发令牌或绑定设备",
    ));
}));

router.post("/complete", setupTokenAuth, errors.catchAsync(async (req, res) => {
    return res.json(errors.createSuccessResponse(await completeInstanceSetup(), "实例初始化已完成"));
}));

export default router;
