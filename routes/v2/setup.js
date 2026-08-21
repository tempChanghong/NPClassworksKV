import {Router} from "express";
import errors from "../../utils/errors.js";
import {localAuthLimiter} from "../../middleware/rateLimiter.js";
import {createSetupToken, setupKeyMatches, setupTokenAuth} from "../../utils/setupToken.js";
import {
    completeInstanceSetup,
    getInstanceSetupStatus,
    initializeInstanceCore,
} from "../../services/instanceSetupService.js";

const router = Router();

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

router.post("/complete", setupTokenAuth, errors.catchAsync(async (req, res) => {
    return res.json(errors.createSuccessResponse(await completeInstanceSetup(), "实例初始化已完成"));
}));

export default router;
