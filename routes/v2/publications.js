import {Router} from "express";
import {jwtAuth} from "../../middleware/jwt-auth.js";
import errors from "../../utils/errors.js";
import {
    PUBLICATION_STATUSES,
    PUBLICATION_TYPES,
} from "../../domain/publication.js";
import {
    clonePublication,
    certifyPublication,
    createPublication,
    getPublication,
    listPublicationRevisions,
    listPublications,
    listPublishedFeed,
    restorePublicationRevision,
    updatePublication,
    withdrawPublication,
} from "../../services/publicationService.js";
import {listNotificationScreenDeliveries} from "../../services/notificationDeliveryService.js";

const router = Router();

function parseWorkspaceIds(query) {
    const values = [];
    for (const value of [query.workspaceIds, query.workspaceId].flat()) {
        if (typeof value === "string") values.push(...value.split(","));
    }
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseExpectedRevision(req) {
    const raw = req.get("If-Match") ?? req.body?.revision;
    if (Number.isInteger(raw)) return raw;
    if (typeof raw !== "string") return null;
    const match = raw.trim().match(/^(?:W\/)?"?(\d+)"?$/);
    return match ? Number(match[1]) : null;
}

function setRevisionHeader(res, publication) {
    res.set("ETag", `"${publication.revision}"`);
}

// Students select their administrative class and course groups locally. This
// endpoint intentionally requires no account and only exposes currently visible
// published items.
router.get("/feed", errors.catchAsync(async (req, res) => {
    const result = await listPublishedFeed({
        workspaceIds: parseWorkspaceIds(req.query),
        boardDate: req.query.boardDate,
        limit: req.query.limit,
        skip: req.query.skip,
    });
    return res.json(errors.createSuccessResponse(result));
}));

router.use(jwtAuth);

router.get("/", errors.catchAsync(async (req, res, next) => {
    const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
    const type = typeof req.query.type === "string" ? req.query.type.toUpperCase() : undefined;
    if (req.query.status !== undefined && !status) {
        return next(errors.createError(400, "无效的发布状态", null, "INVALID_PUBLICATION_STATUS"));
    }
    if (req.query.type !== undefined && !type) {
        return next(errors.createError(400, "无效的发布类型", null, "INVALID_PUBLICATION_TYPE"));
    }
    if (req.query.workspaceId !== undefined && typeof req.query.workspaceId !== "string") {
        return next(errors.createError(400, "无效的教学空间", null, "INVALID_WORKSPACE_ID"));
    }
    if (status && !Object.values(PUBLICATION_STATUSES).includes(status)) {
        return next(errors.createError(400, "无效的发布状态", {status}, "INVALID_PUBLICATION_STATUS"));
    }
    if (type && !Object.values(PUBLICATION_TYPES).includes(type)) {
        return next(errors.createError(400, "无效的发布类型", {type}, "INVALID_PUBLICATION_TYPE"));
    }
    const result = await listPublications({
        accountId: res.locals.account.id,
        workspaceId: typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined,
        status,
        type,
        limit: req.query.limit,
        skip: req.query.skip,
    });
    return res.json(errors.createSuccessResponse(result));
}));

router.post("/", errors.catchAsync(async (req, res) => {
    const publication = await createPublication({
        accountId: res.locals.account.id,
        input: req.body,
    });
    setRevisionHeader(res, publication);
    return res.status(201).json(errors.createSuccessResponse(publication, "发布内容已创建"));
}));

router.get("/:id", errors.catchAsync(async (req, res) => {
    const publication = await getPublication({
        accountId: res.locals.account.id,
        publicationId: req.params.id,
    });
    setRevisionHeader(res, publication);
    return res.json(errors.createSuccessResponse(publication));
}));

router.get("/:id/revisions", errors.catchAsync(async (req, res) => {
    const revisions = await listPublicationRevisions({
        accountId: res.locals.account.id,
        publicationId: req.params.id,
    });
    return res.json(errors.createSuccessResponse(revisions));
}));

router.get("/:id/screen-deliveries", errors.catchAsync(async (req, res) => {
    const deliveries = await listNotificationScreenDeliveries({
        accountId: res.locals.account.id,
        publicationId: req.params.id,
    });
    return res.json(errors.createSuccessResponse(deliveries));
}));

router.post("/:id/certify", errors.catchAsync(async (req, res) => {
    const publication = await certifyPublication({
        accountId: res.locals.account.id,
        publicationId: req.params.id,
        expectedRevision: parseExpectedRevision(req),
    });
    setRevisionHeader(res, publication);
    return res.json(errors.createSuccessResponse(publication, "当前版本已认证"));
}));

router.post("/:id/restore", errors.catchAsync(async (req, res) => {
    const publication = await restorePublicationRevision({
        accountId: res.locals.account.id,
        publicationId: req.params.id,
        sourceRevision: Number(req.body?.sourceRevision),
        expectedRevision: parseExpectedRevision(req),
    });
    setRevisionHeader(res, publication);
    return res.json(errors.createSuccessResponse(publication, "历史版本已恢复"));
}));

router.patch("/:id", errors.catchAsync(async (req, res) => {
    const publication = await updatePublication({
        accountId: res.locals.account.id,
        publicationId: req.params.id,
        expectedRevision: parseExpectedRevision(req),
        input: req.body,
    });
    setRevisionHeader(res, publication);
    return res.json(errors.createSuccessResponse(publication, "发布内容已更新"));
}));

router.post("/:id/withdraw", errors.catchAsync(async (req, res) => {
    const publication = await withdrawPublication({
        accountId: res.locals.account.id,
        publicationId: req.params.id,
        expectedRevision: parseExpectedRevision(req),
    });
    setRevisionHeader(res, publication);
    return res.json(errors.createSuccessResponse(publication, "发布内容已撤回"));
}));

router.post("/:id/clone", errors.catchAsync(async (req, res) => {
    const publication = await clonePublication({
        accountId: res.locals.account.id,
        publicationId: req.params.id,
        input: req.body,
    });
    setRevisionHeader(res, publication);
    return res.status(201).json(errors.createSuccessResponse(publication, "发布内容已复制为草稿"));
}));

export default router;
