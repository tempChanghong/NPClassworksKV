import {Router} from "express";
import errors from "../../utils/errors.js";
import {
    authenticateClassroomScreen,
    listClassroomScreenTargets,
    resolveClassroomScreenWorkspaces,
} from "../../services/classroomScreenService.js";
import {
    createScreenPublication,
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

const router = Router();

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

router.use(errors.catchAsync(async (req, res, next) => {
    res.locals.classroomScreen = await authenticateClassroomScreen(readToken(req));
    next();
}));

router.get("/session", errors.catchAsync(async (req, res) => {
    const result = await listClassroomScreenTargets(res.locals.classroomScreen);
    return res.json(errors.createSuccessResponse(result));
}));

router.get("/feed", errors.catchAsync(async (req, res) => {
    const workspaces = await resolveClassroomScreenWorkspaces(res.locals.classroomScreen);
    const result = await listPublishedFeed({
        workspaceIds: workspaces.map((workspace) => workspace.id),
        limit: req.query.limit,
        skip: req.query.skip,
    });
    return res.json(errors.createSuccessResponse(result));
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
    return res.status(201).json(errors.createSuccessResponse(publication, "作业已保存为未认证版本"));
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
