import {
    SUBJECT_DELIVERY_MODES,
    WORKSPACE_TYPES,
} from "./academicCatalog.js";

export const PUBLICATION_TYPES = Object.freeze({
    ASSIGNMENT: "ASSIGNMENT",
    NOTICE: "NOTICE",
});

export const PUBLICATION_STATUSES = Object.freeze({
    DRAFT: "DRAFT",
    PUBLISHED: "PUBLISHED",
    WITHDRAWN: "WITHDRAWN",
});

export const PUBLICATION_PRIORITIES = Object.freeze({
    NORMAL: "NORMAL",
    IMPORTANT: "IMPORTANT",
    URGENT: "URGENT",
});

export function earliestPublicationTransition(...values) {
    const timestamps = values
        .filter(Boolean)
        .map((value) => new Date(value))
        .filter((value) => !Number.isNaN(value.getTime()));
    if (timestamps.length === 0) return null;
    return new Date(Math.min(...timestamps.map((value) => value.getTime())));
}

const EDITABLE_STATUSES = new Set([
    PUBLICATION_STATUSES.DRAFT,
    PUBLICATION_STATUSES.PUBLISHED,
]);

function cleanText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function parseDate(value, path, errors, {required = false} = {}) {
    if (value === null || value === undefined || value === "") {
        if (required) errors.push({path, code: "DATE_REQUIRED", message: `${path}不能为空`});
        return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        errors.push({path, code: "INVALID_DATE", message: `${path}不是有效日期`});
        return null;
    }
    return date;
}

export function parseBoardDate(value, errors = [], {required = false} = {}) {
    if (value === null || value === undefined || value === "") {
        if (required) {
            errors.push({path: "boardDate", code: "BOARD_DATE_REQUIRED", message: "作业板日期不能为空"});
        }
        return null;
    }
    if (typeof value === "string") {
        const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (match) {
            const date = new Date(`${value.trim()}T00:00:00.000Z`);
            if (date.toISOString().slice(0, 10) === value.trim()) return date;
        }
    } else if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
    }
    errors.push({path: "boardDate", code: "INVALID_BOARD_DATE", message: "作业板日期必须采用 YYYY-MM-DD 格式"});
    return null;
}

function workspaceSchoolId(workspace) {
    return workspace.schoolId || workspace.term?.schoolId || workspace.term?.school?.id;
}

/**
 * Validate one create/update snapshot after target workspaces have been loaded.
 * The function is database-free so the routing rules remain directly testable.
 */
export function validatePublicationSnapshot({input, workspaces}) {
    const errors = [];
    const type = cleanText(input?.type).toUpperCase();
    const status = cleanText(input?.status || PUBLICATION_STATUSES.DRAFT).toUpperCase();
    const priority = cleanText(input?.priority || PUBLICATION_PRIORITIES.NORMAL).toUpperCase();
    const subjectId = cleanText(input?.subjectId) || null;
    const title = cleanText(input?.title) || null;
    const content = typeof input?.content === "string" ? input.content.trim() : "";
    const targetWorkspaceIds = [...new Set(
        (Array.isArray(input?.targetWorkspaceIds) ? input.targetWorkspaceIds : [])
            .filter((id) => typeof id === "string" && id.trim())
            .map((id) => id.trim()),
    )];

    if (!Object.values(PUBLICATION_TYPES).includes(type)) {
        errors.push({path: "type", code: "INVALID_PUBLICATION_TYPE", message: "发布类型必须是 ASSIGNMENT 或 NOTICE"});
    }
    if (!EDITABLE_STATUSES.has(status)) {
        errors.push({path: "status", code: "INVALID_PUBLICATION_STATUS", message: "可编辑状态必须是 DRAFT 或 PUBLISHED"});
    }
    if (!Object.values(PUBLICATION_PRIORITIES).includes(priority)) {
        errors.push({path: "priority", code: "INVALID_PUBLICATION_PRIORITY", message: "无效的发布优先级"});
    }
    if (targetWorkspaceIds.length === 0) {
        errors.push({path: "targetWorkspaceIds", code: "PUBLICATION_TARGET_REQUIRED", message: "至少需要一个发布目标"});
    }
    if (targetWorkspaceIds.length > 100) {
        errors.push({path: "targetWorkspaceIds", code: "TOO_MANY_PUBLICATION_TARGETS", message: "一次发布最多选择100个目标"});
    }
    if (workspaces.length !== targetWorkspaceIds.length) {
        const foundIds = new Set(workspaces.map((workspace) => workspace.id));
        const missing = targetWorkspaceIds.filter((id) => !foundIds.has(id));
        errors.push({path: "targetWorkspaceIds", code: "WORKSPACE_NOT_FOUND", message: "部分发布目标不存在", details: {missing}});
    }
    if (status === PUBLICATION_STATUSES.PUBLISHED && !content && !title) {
        errors.push({path: "content", code: "PUBLICATION_CONTENT_REQUIRED", message: "正式发布时标题和正文不能同时为空"});
    }
    if (title && title.length > 191) {
        errors.push({path: "title", code: "PUBLICATION_TITLE_TOO_LONG", message: "标题不能超过191个字符"});
    }

    if (type === PUBLICATION_TYPES.ASSIGNMENT && !subjectId) {
        errors.push({path: "subjectId", code: "ASSIGNMENT_SUBJECT_REQUIRED", message: "作业必须选择科目"});
    }

    const termIds = new Set(workspaces.map((workspace) => workspace.termId));
    const schoolIds = new Set(workspaces.map(workspaceSchoolId).filter(Boolean));
    if (termIds.size > 1 || schoolIds.size > 1) {
        errors.push({path: "targetWorkspaceIds", code: "CROSS_TERM_TARGETS", message: "一次发布的目标必须属于同一学校、同一学期"});
    }
    if (workspaces.some((workspace) => workspace.term?.status === "ARCHIVED")) {
        errors.push({path: "targetWorkspaceIds", code: "ARCHIVED_TERM_TARGET", message: "不能向已归档学期发布内容"});
    }

    if (type === PUBLICATION_TYPES.ASSIGNMENT && subjectId) {
        for (const workspace of workspaces) {
            if (workspace.type === WORKSPACE_TYPES.COURSE_GROUP) {
                if (workspace.subjectId !== subjectId) {
                    errors.push({
                        path: "subjectId",
                        code: "COURSE_GROUP_SUBJECT_MISMATCH",
                        message: `${workspace.name}不属于所选科目`,
                        details: {workspaceId: workspace.id, workspaceSubjectId: workspace.subjectId},
                    });
                }
                continue;
            }

            if (workspace.type === WORKSPACE_TYPES.ADMIN_CLASS) {
                const rule = (workspace.subjectRules || []).find((candidate) => candidate.subjectId === subjectId);
                if (!rule) {
                    errors.push({
                        path: "subjectId",
                        code: "ADMIN_CLASS_SUBJECT_NOT_CONFIGURED",
                        message: `${workspace.name}未配置所选科目的授课模式`,
                        details: {workspaceId: workspace.id},
                    });
                } else if (rule.deliveryMode !== SUBJECT_DELIVERY_MODES.ADMIN_CLASS) {
                    errors.push({
                        path: "targetWorkspaceIds",
                        code: "COURSE_GROUP_TARGET_REQUIRED",
                        message: `${workspace.name}的该科目采用走班制，请选择具体教学班`,
                        details: {workspaceId: workspace.id, subjectId},
                    });
                }
                continue;
            }

            errors.push({
                path: "targetWorkspaceIds",
                code: "INVALID_ASSIGNMENT_TARGET_TYPE",
                message: "作业只能发布到行政班或走班教学班",
                details: {workspaceId: workspace.id, type: workspace.type},
            });
        }
    }

    const publishAt = parseDate(input?.publishAt || new Date(), "publishAt", errors, {required: true});
    const boardDate = type === PUBLICATION_TYPES.ASSIGNMENT
        ? parseBoardDate(input?.boardDate, errors, {required: true})
        : null;
    const dueAt = parseDate(input?.dueAt, "dueAt", errors);
    const expiresAt = parseDate(input?.expiresAt, "expiresAt", errors);
    if (publishAt && dueAt && dueAt < publishAt) {
        errors.push({path: "dueAt", code: "DUE_BEFORE_PUBLISH", message: "作业截止时间不能早于发布时间"});
    }
    if (publishAt && expiresAt && expiresAt < publishAt) {
        errors.push({path: "expiresAt", code: "EXPIRES_BEFORE_PUBLISH", message: "失效时间不能早于发布时间"});
    }

    return {
        valid: errors.length === 0,
        errors,
        normalized: {
            type,
            status,
            priority,
            subjectId,
            title,
            content,
            contentJson: input?.contentJson === null
                ? null
                : input?.contentJson && typeof input.contentJson === "object"
                    ? input.contentJson
                    : undefined,
            boardDate,
            publishAt,
            dueAt,
            expiresAt,
            targetWorkspaceIds,
        },
    };
}
