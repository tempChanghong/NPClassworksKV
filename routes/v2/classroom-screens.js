import {Router} from "express";
import rateLimit from "express-rate-limit";
import errors from "../../utils/errors.js";
import {
    authenticateClassroomScreen,
    loginClassroomScreen,
    listClassroomScreenTargets,
    resolveClassroomScreenWorkspaces,
    verifyClassroomScreenPin,
} from "../../services/classroomScreenService.js";
import {
    copyScreenBoardDate,
    createScreenPublication,
    getScreenPublication,
    listPublishedFeed,
    listScreenPublicationRevisions,
    restoreScreenPublicationRevision,
    updateScreenPublication,
} from "../../services/publicationService.js";
import {
    getClassAttendance,
    listClassRoster,
    replaceClassRoster,
    saveClassAttendance,
} from "../../services/classroomToolsService.js";
import {acknowledgeScreenNotifications} from "../../services/notificationDeliveryService.js";
import {
    acknowledgeClassroomScreenCommand,
    reportClassroomScreenHeartbeat,
} from "../../services/classroomScreenDutyService.js";
import {createAuditMiddleware} from "../../services/auditLogService.js";

const router = Router();
const screenLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
});

function readToken(req) {
    const explicit = req.get("X-Classworks-Screen-Token");
    if (explicit) return explicit;
    const authorization = req.get("Authorization") || "";
    const match = authorization.match(/^Screen\s+(.+)$/i);
    return match?.[1] || "";
}

function parseExpectedRevision(req) {
    const raw = req.get("If-Match") ?? req.body?.revision;
    if (Number.isInteger(raw)) return raw;
    if (typeof raw !== "string") return null;
    const match = raw.trim().match(/^(?:W\/)?"?(\d+)"?$/);
    return match ? Number(match[1]) : null;
}

router.post("/login", screenLoginLimiter, errors.catchAsync(async (req, res) => {
    const result = await loginClassroomScreen({
        schoolCode: req.body?.schoolCode,
        loginCode: req.body?.loginCode,
        pin: req.body?.pin,
        deviceFingerprint: req.body?.deviceFingerprint,
    });
    return res.json(errors.createSuccessResponse(result, "班级大屏登录成功"));
}));

router.use(errors.catchAsync(async (req, res, next) => {
    res.locals.classroomScreen = await authenticateClassroomScreen(readToken(req));
    next();
}));
router.use(createAuditMiddleware({
    actorType: "CLASSROOM_SCREEN",
    actorResolver: (_req, res) => ({
        schoolId: res.locals.classroomScreen?.schoolId,
        screenBindingId: res.locals.classroomScreen?.id,
    }),
}));

router.post("/heartbeat", errors.catchAsync(async (req, res) => {
    const result = await reportClassroomScreenHeartbeat({
        screenBinding: res.locals.classroomScreen,
        status: req.body,
    });
    return res.json(errors.createSuccessResponse(result));
}));

router.post("/commands/:commandId/ack", errors.catchAsync(async (req, res) => {
    const command = await acknowledgeClassroomScreenCommand({
        screenBinding: res.locals.classroomScreen,
        commandId: req.params.commandId,
        success: req.body?.success !== false,
        result: req.body?.result,
    });
    return res.json(errors.createSuccessResponse(command));
}));

router.post("/unlock", screenLoginLimiter, errors.catchAsync(async (req, res) => {
    const result = await verifyClassroomScreenPin(res.locals.classroomScreen, req.body?.pin);
    return res.json(errors.createSuccessResponse(result, "大屏 PIN 验证成功"));
}));

router.get("/session", errors.catchAsync(async (req, res) => {
    const result = await listClassroomScreenTargets(res.locals.classroomScreen);
    return res.json(errors.createSuccessResponse(result));
}));

router.get("/feed", errors.catchAsync(async (req, res) => {
    const workspaces = await resolveClassroomScreenWorkspaces(res.locals.classroomScreen);
    const result = await listPublishedFeed({
        workspaceIds: workspaces.map((workspace) => workspace.id),
        boardDate: req.query.boardDate,
        limit: req.query.limit,
        skip: req.query.skip,
    });
    return res.json(errors.createSuccessResponse(result));
}));

router.post("/notification-deliveries", errors.catchAsync(async (req, res) => {
    const deliveries = await acknowledgeScreenNotifications({
        screenBinding: res.locals.classroomScreen,
        items: req.body?.items,
    });
    return res.json(errors.createSuccessResponse({count: deliveries.length}));
}));

router.get("/students", errors.catchAsync(async (req, res) => {
    const students = await listClassRoster({screenBinding: res.locals.classroomScreen});
    return res.json(errors.createSuccessResponse(students));
}));

router.put("/students", errors.catchAsync(async (req, res) => {
    const students = await replaceClassRoster({
        screenBinding: res.locals.classroomScreen,
        students: req.body?.students,
    });
    return res.json(errors.createSuccessResponse(students, "行政班学生名单已保存"));
}));

router.get("/attendance/:date", errors.catchAsync(async (req, res) => {
    const attendance = await getClassAttendance({
        screenBinding: res.locals.classroomScreen,
        date: req.params.date,
    });
    return res.json(errors.createSuccessResponse(attendance));
}));

router.put("/attendance/:date", errors.catchAsync(async (req, res) => {
    const attendance = await saveClassAttendance({
        screenBinding: res.locals.classroomScreen,
        date: req.params.date,
        attendance: req.body,
    });
    return res.json(errors.createSuccessResponse(attendance, "今日考勤已保存"));
}));

router.post("/publications", errors.catchAsync(async (req, res) => {
    const publication = await createScreenPublication({
        screenBinding: res.locals.classroomScreen,
        input: req.body,
    });
    res.set("ETag", `"${publication.revision}"`);
    return res.status(201).json(errors.createSuccessResponse(publication, "作业已保存，等待教师确认"));
}));

router.post("/board/copy", errors.catchAsync(async (req, res) => {
    const result = await copyScreenBoardDate({
        screenBinding: res.locals.classroomScreen,
        sourceBoardDate: req.body?.sourceBoardDate,
        targetBoardDate: req.body?.targetBoardDate,
    });
    return res.status(201).json(errors.createSuccessResponse(result, "作业已复制到目标日期"));
}));

router.patch("/publications/:id", errors.catchAsync(async (req, res) => {
    const publication = await updateScreenPublication({
        screenBinding: res.locals.classroomScreen,
        publicationId: req.params.id,
        expectedRevision: parseExpectedRevision(req),
        input: req.body,
    });
    res.set("ETag", `"${publication.revision}"`);
    return res.json(errors.createSuccessResponse(publication, "新版本已保存，原版本仍可恢复"));
}));

router.get("/publications/:id", errors.catchAsync(async (req, res) => {
    const publication = await getScreenPublication({
        screenBinding: res.locals.classroomScreen,
        publicationId: req.params.id,
    });
    res.set("ETag", `"${publication.revision}"`);
    return res.json(errors.createSuccessResponse(publication));
}));

router.get("/publications/:id/revisions", errors.catchAsync(async (req, res) => {
    const revisions = await listScreenPublicationRevisions({
        screenBinding: res.locals.classroomScreen,
        publicationId: req.params.id,
    });
    return res.json(errors.createSuccessResponse(revisions));
}));

router.post("/publications/:id/restore", errors.catchAsync(async (req, res) => {
    const publication = await restoreScreenPublicationRevision({
        screenBinding: res.locals.classroomScreen,
        publicationId: req.params.id,
        sourceRevision: Number(req.body?.sourceRevision),
        expectedRevision: parseExpectedRevision(req),
    });
    res.set("ETag", `"${publication.revision}"`);
    return res.json(errors.createSuccessResponse(publication, "历史版本已恢复"));
}));

export default router;
