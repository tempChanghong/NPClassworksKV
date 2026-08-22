import {prisma} from "../utils/prisma.js";
import {assertSchoolManager} from "./academicAuthorizationService.js";
import {sanitizeAuditValue} from "../domain/auditLog.js";

function actionFor(method, routePath) {
    const route = `${method} ${routePath || ""}`;
    const rules = [
        [/organization\/import/, "ORGANIZATION_IMPORT"],
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
        [/course-groups/, "COURSE_GROUP_CHANGED"],
        [/students/, "SCREEN_ROSTER_CHANGED"],
        [/attendance/, "SCREEN_ATTENDANCE_CHANGED"],
        [/publications.*restore/, "SCREEN_PUBLICATION_RESTORED"],
        [/publications/, method === "POST" ? "SCREEN_PUBLICATION_CREATED" : "SCREEN_PUBLICATION_UPDATED"],
        [/board\/copy/, "SCREEN_BOARD_COPIED"],
    ];
    return rules.find(([pattern]) => pattern.test(route))?.[1] || `${method}_ADMIN_OPERATION`;
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
    const candidates = [
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
            void resolveSchoolId(req, actor.schoolId)
                .then((schoolId) => writeAuditLog({
                    schoolId,
                    actorType,
                    actorAccountId: actor.accountId,
                    actorScreenBindingId: actor.screenBindingId,
                    action: actionFor(req.method, routePath),
                    ...entity,
                    requestMethod: req.method,
                    requestPath: req.originalUrl,
                    statusCode: res.statusCode,
                    success: res.statusCode < 400,
                    metadata: {body: req.body, query: req.query},
                    clientIp: req.ip,
                    userAgent: req.get("user-agent"),
                }))
                .catch((error) => console.error("Failed to write audit log", error));
        });
        next();
    };
}

export async function listAuditLogs({managerAccountId, schoolId, action, actorType, cursor, limit = 50}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const take = Math.min(100, Math.max(1, Number(limit) || 50));
    const items = await prisma.auditLog.findMany({
        where: {
            schoolId,
            ...(action ? {action} : {}),
            ...(actorType ? {actorType} : {}),
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
