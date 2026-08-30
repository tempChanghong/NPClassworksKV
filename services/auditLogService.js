import {prisma} from "../utils/prisma.js";
import {assertSchoolManager} from "./academicAuthorizationService.js";
import {sanitizeAuditValue} from "../domain/auditLog.js";

function actionFor(method, routePath) {
    const route = `${method} ${routePath || ""}`;
    const rules = [
        [/schools.*\/profile$/, "SCHOOL_PROFILE_UPDATED"],
        [/schools.*\/subjects(?:\/[^/]+)?$/, method === "POST" ? "SUBJECT_CREATED" : "SUBJECT_UPDATED"],
        [/schools.*\/grades(?:\/[^/]+)?$/, method === "POST" ? "GRADE_CREATED" : "GRADE_UPDATED"],
        [/administrative-classes\/batch$/, "ADMIN_CLASSES_BATCH_CREATED"],
        [/administrative-classes.*\/subject-rules$/, "SUBJECT_RULES_CHANGED"],
        [/administrative-classes(?:\/[^/]+)?$/, method === "POST" ? "ADMIN_CLASS_CREATED" : "ADMIN_CLASS_UPDATED"],
        [/course-groups(?:\/[^/]+)?$/, method === "POST" ? "COURSE_GROUP_CREATED" : "COURSE_GROUP_UPDATED"],
        [/organization\/import/, "ORGANIZATION_IMPORT"],
        [/migration\/export/, "SCHOOL_MIGRATION_EXPORT_CREATED"],
        [/transition\/preview/, "TERM_TRANSITION_PREVIEW"],
        [/transition-readiness/, "TERM_ACTIVATION_PREVIEW"],
        [/\/activate$/, "TERM_ACTIVATED"],
        [/\/transition$/, "TERM_DRAFT_CREATED"],
        [/\/status$/, "TERM_STATUS_CHANGED"],
        [/classroom-screens.*commands/, "SCREEN_COMMAND_ISSUED"],
        [/reset-device/, "SCREEN_DEVICE_RESET"],
        [/classroom-screen-accounts/, "SCREEN_ACCOUNT_CREATED"],
        [/classroom-screens/, method === "POST" ? "SCREEN_BOUND" : "SCREEN_ACCOUNT_UPDATED"],
        [/teaching-assignments/, "TEACHING_ASSIGNMENT_CHANGED"],
        [/grade-leaderships/, "GRADE_LEADERSHIP_CHANGED"],
        [/class-leaderships/, "CLASS_LEADERSHIP_CHANGED"],
        [/local-(?:teachers|admins)/, "LOCAL_ACCOUNT_PROVISIONED"],
        [/local-accounts/, "LOCAL_ACCOUNT_CHANGED"],
        [/workspace-memberships/, "WORKSPACE_MEMBERSHIP_CHANGED"],
        [/homework-settings/, "HOMEWORK_SETTINGS_CHANGED"],
        [/subject-rules/, "SUBJECT_RULES_CHANGED"],
        [/course-groups/, "COURSE_GROUP_UPDATED"],
        [/students/, "SCREEN_ROSTER_CHANGED"],
        [/attendance/, "SCREEN_ATTENDANCE_CHANGED"],
        [/publications.*restore/, "SCREEN_PUBLICATION_RESTORED"],
        [/publications/, method === "POST" ? "SCREEN_PUBLICATION_CREATED" : "SCREEN_PUBLICATION_UPDATED"],
        [/board\/copy/, "SCREEN_BOARD_COPIED"],
    ];
    return rules.find(([pattern]) => pattern.test(route))?.[1] || `${method}_ADMIN_OPERATION`;
}

const ACTION_SUMMARIES = {
    SCHOOL_PROFILE_UPDATED: "修改学校基础设置",
    SUBJECT_CREATED: "创建学科",
    SUBJECT_UPDATED: "修改学科",
    GRADE_CREATED: "创建年级",
    GRADE_UPDATED: "修改年级",
    ADMIN_CLASS_CREATED: "创建行政班",
    ADMIN_CLASSES_BATCH_CREATED: "批量创建行政班",
    ADMIN_CLASS_UPDATED: "修改行政班",
    SUBJECT_RULES_CHANGED: "修改行政班授课规则",
    COURSE_GROUP_CREATED: "创建走班教学班",
    COURSE_GROUP_UPDATED: "修改走班教学班",
    ORGANIZATION_IMPORT: "导入学校组织配置",
    SCHOOL_MIGRATION_EXPORT_CREATED: "生成整校迁移包",
    TERM_TRANSITION_PREVIEW: "预览学期切换影响",
    TERM_ACTIVATION_PREVIEW: "检查学期启用条件",
    TERM_ACTIVATED: "启用新学期",
    TERM_DRAFT_CREATED: "创建学期草稿",
    TERM_STATUS_CHANGED: "修改学期状态",
    SCREEN_COMMAND_ISSUED: "向班级大屏下发指令",
    SCREEN_DEVICE_RESET: "重置班级大屏设备",
    SCREEN_ACCOUNT_CREATED: "创建班级大屏账号",
    SCREEN_ACCOUNT_UPDATED: "修改班级大屏账号",
    SCREEN_BOUND: "绑定班级大屏",
    TEACHING_ASSIGNMENT_CHANGED: "修改教师任课关系",
    GRADE_LEADERSHIP_CHANGED: "修改年级组长职责",
    CLASS_LEADERSHIP_CHANGED: "修改班主任职责",
    LOCAL_ACCOUNT_PROVISIONED: "批量创建校内账号",
    LOCAL_ACCOUNT_CHANGED: "修改校内账号",
    WORKSPACE_MEMBERSHIP_CHANGED: "修改教学空间成员",
    HOMEWORK_SETTINGS_CHANGED: "修改学校作业设置",
    SCREEN_ROSTER_CHANGED: "修改班级学生名单",
    SCREEN_ATTENDANCE_CHANGED: "修改班级考勤",
    SCREEN_PUBLICATION_CREATED: "通过大屏发布内容",
    SCREEN_PUBLICATION_UPDATED: "通过大屏修改内容",
    SCREEN_PUBLICATION_RESTORED: "恢复大屏内容历史版本",
    SCREEN_BOARD_COPIED: "复制班级作业板内容",
};

function requestTarget(body) {
    const label = body?.name || body?.code || body?.title;
    if (typeof label !== "string" || !label.trim()) return "";
    return `“${label.trim().slice(0, 80)}”`;
}

function summaryFor(action, req, statusCode) {
    let summary = ACTION_SUMMARIES[action] || "执行学校管理操作";
    const target = requestTarget(req.body);
    if (target) summary += target;
    if (action === "ADMIN_CLASSES_BATCH_CREATED" && Array.isArray(req.body?.classes)) {
        summary += `（${req.body.classes.length} 个班级）`;
    }
    if (statusCode >= 400) summary = `操作未成功：${summary}`;
    return summary;
}

async function resolveSchoolId(req, explicitSchoolId) {
    if (explicitSchoolId) return explicitSchoolId;
    const direct = req.originalUrl.match(/\/schools\/([^/?]+)/)?.[1];
    if (direct) return direct;
    const termId = req.originalUrl.match(/\/terms\/([^/?]+)/)?.[1];
    if (termId) return (await prisma.academicTerm.findUnique({where: {id: termId}, select: {schoolId: true}}))?.schoolId;
    const workspaceId = req.originalUrl.match(/\/workspaces\/([^/?]+)/)?.[1];
    if (workspaceId) {
        return (await prisma.workspace.findUnique({
            where: {id: workspaceId},
            select: {term: {select: {schoolId: true}}},
        }))?.term?.schoolId;
    }
    return null;
}

function entityFromRequest(req) {
    const path = req.originalUrl.split("?")[0];
    const parsedCandidates = [
        ["SUBJECT", path.match(/\/subjects\/([^/]+)$/)?.[1]],
        ["GRADE", path.match(/\/grades\/([^/]+)$/)?.[1]],
        ["WORKSPACE", path.match(/\/(?:administrative-classes|course-groups)\/([^/]+)(?:\/subject-rules)?$/)?.[1]],
        ["SCHOOL", path.match(/\/schools\/([^/]+)\/profile$/)?.[1]],
    ];
    const candidates = [
        ...parsedCandidates,
        ["SCREEN", req.params?.bindingId],
        ["TERM", req.params?.termId],
        ["WORKSPACE", req.params?.workspaceId],
        ["PUBLICATION", req.params?.id],
        ["ACCOUNT", req.params?.accountId],
    ];
    const found = candidates.find(([, id]) => id);
    return found ? {entityType: found[0], entityId: found[1]} : {};
}

export async function writeAuditLog(input) {
    return prisma.auditLog.create({
        data: {
            schoolId: input.schoolId || null,
            actorAccountId: input.actorAccountId || null,
            actorScreenBindingId: input.actorScreenBindingId || null,
            actorType: input.actorType,
            action: input.action,
            entityType: input.entityType || null,
            entityId: input.entityId || null,
            requestMethod: input.requestMethod || null,
            requestPath: input.requestPath?.slice(0, 512) || null,
            statusCode: input.statusCode || null,
            success: input.success !== false,
            summary: input.summary?.slice(0, 512) || null,
            metadata: input.metadata ? sanitizeAuditValue(input.metadata) : undefined,
            clientIp: input.clientIp?.slice(0, 64) || null,
            userAgent: input.userAgent?.slice(0, 512) || null,
        },
    });
}

export function createAuditMiddleware({actorType, actorResolver}) {
    return (req, res, next) => {
        if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(req.method)) return next();
        if (/\/heartbeat$|\/commands\/[^/]+\/ack$/.test(req.path)) return next();
        res.on("finish", () => {
            const actor = actorResolver(req, res) || {};
            const routePath = req.route?.path || req.path;
            const entity = entityFromRequest(req);
            const action = actionFor(req.method, routePath);
            void resolveSchoolId(req, actor.schoolId)
                .then((schoolId) => writeAuditLog({
                    schoolId,
                    actorType,
                    actorAccountId: actor.accountId,
                    actorScreenBindingId: actor.screenBindingId,
                    action,
                    ...entity,
                    requestMethod: req.method,
                    requestPath: req.originalUrl,
                    statusCode: res.statusCode,
                    success: res.statusCode < 400,
                    summary: summaryFor(action, req, res.statusCode),
                    metadata: {body: req.body, query: req.query},
                    clientIp: req.ip,
                    userAgent: req.get("user-agent"),
                }))
                .catch((error) => console.error("Failed to write audit log", error));
        });
        next();
    };
}

export async function listAuditLogs({managerAccountId, schoolId, action, actorType, success, from, to, cursor, limit = 50}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const take = Math.min(100, Math.max(1, Number(limit) || 50));
    const successFilter = success === true || success === "true"
        ? true
        : success === false || success === "false"
            ? false
            : undefined;
    const fromDate = from && !Number.isNaN(Date.parse(from)) ? new Date(from) : null;
    const toDate = to && !Number.isNaN(Date.parse(to)) ? new Date(to) : null;
    const items = await prisma.auditLog.findMany({
        where: {
            schoolId,
            ...(action ? {action} : {}),
            ...(actorType ? {actorType} : {}),
            ...(successFilter === undefined ? {} : {success: successFilter}),
            ...(fromDate || toDate ? {createdAt: {
                ...(fromDate ? {gte: fromDate} : {}),
                ...(toDate ? {lte: toDate} : {}),
            }} : {}),
        },
        include: {
            actorAccount: {select: {id: true, name: true, localUsername: true, email: true}},
            actorScreen: {select: {id: true, name: true, loginCode: true}},
        },
        orderBy: [{createdAt: "desc"}, {id: "desc"}],
        ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}),
        take: take + 1,
    });
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return {items: page, nextCursor: hasMore ? page.at(-1)?.id : null};
}
