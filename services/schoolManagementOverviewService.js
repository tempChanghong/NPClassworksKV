import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";
import {getTeachingRelationshipOverview} from "./teachingRelationshipService.js";
import {getStaffResponsibilityOverview} from "./staffResponsibilityService.js";

function diagnostic(source, severity, code, message, details = {}) {
    return {source, severity, code, message, ...details};
}

function normalizeDiagnostic(source, item) {
    const targetTab = source === "TEACHING" ? "structure" : source === "RESPONSIBILITY" ? "teachers" : undefined;
    return {...item, source: item.source || source, targetTab: item.targetTab || targetTab};
}

export async function getSchoolManagementOverview({managerAccountId, schoolId, termId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const term = termId
        ? await prisma.academicTerm.findFirst({where: {id: termId, schoolId}})
        : await prisma.academicTerm.findFirst({where: {schoolId, status: "ACTIVE"}});
    if (!term) throw authorizationError("学校尚无可用学期", "TERM_NOT_FOUND", 404);

    const [teaching, staff, screens] = await Promise.all([
        getTeachingRelationshipOverview({managerAccountId, schoolId, termId: term.id}),
        getStaffResponsibilityOverview({managerAccountId, schoolId, termId: term.id}),
        prisma.classroomScreenBinding.findMany({
            where: {schoolId, isActive: true},
            include: {administrativeClass: {select: {id: true, code: true, name: true, termId: true}}},
            orderBy: {name: "asc"},
        }),
    ]);

    const diagnostics = [
        ...teaching.diagnostics.map((item) => normalizeDiagnostic("TEACHING", item)),
        ...staff.diagnostics.map((item) => normalizeDiagnostic("RESPONSIBILITY", item)),
    ];
    const activeClasses = teaching.administrativeClasses.filter((item) => item.isActive);
    const screenByClassCode = new Map(screens.map((screen) => [screen.administrativeClass.code, screen]));
    for (const administrativeClass of activeClasses) {
        const screen = screenByClassCode.get(administrativeClass.code);
        if (!screen) {
            diagnostics.push(diagnostic(
                "SCREEN",
                "WARNING",
                "ADMIN_CLASS_WITHOUT_SCREEN",
                `${administrativeClass.name}尚未配置班级大屏`,
                {workspaceId: administrativeClass.id, workspaceName: administrativeClass.name, targetTab: "screens"},
            ));
        } else if (!screen.activatedAt) {
            diagnostics.push(diagnostic(
                "SCREEN",
                "WARNING",
                "SCREEN_NOT_ACTIVATED",
                `${screen.name}已创建账号，但尚未在一体机上完成首次登录`,
                {screenId: screen.id, workspaceId: administrativeClass.id, targetTab: "screens"},
            ));
        } else if (screen.lastUsedAt && Date.now() - screen.lastUsedAt.getTime() > 7 * 24 * 60 * 60 * 1000) {
            diagnostics.push(diagnostic(
                "SCREEN",
                "WARNING",
                "SCREEN_STALE",
                `${screen.name}已超过 7 天没有连接`,
                {screenId: screen.id, lastUsedAt: screen.lastUsedAt, targetTab: "screens"},
            ));
        }
    }

    const assignedAccountIds = new Set(teaching.administrativeClasses
        .concat(teaching.courseGroups)
        .flatMap((workspace) => workspace.assignments.map((assignment) => assignment.accountId)));
    for (const account of teaching.teacherAccounts.filter((item) => assignedAccountIds.has(item.id))) {
        if (account.localDisabled) {
            diagnostics.push(diagnostic(
                "ACCOUNT",
                "ERROR",
                "DISABLED_ACCOUNT_HAS_ASSIGNMENT",
                `${account.name || account.localUsername || "教师账号"}已停用，但仍有任课关系`,
                {accountId: account.id, targetTab: "accounts"},
            ));
        } else if (account.localUsername && !account.lastLoginAt) {
            diagnostics.push(diagnostic(
                "ACCOUNT",
                "WARNING",
                "LOCAL_ACCOUNT_NEVER_LOGGED_IN",
                `${account.name || account.localUsername}已有任课安排，但从未登录`,
                {accountId: account.id, targetTab: "accounts"},
            ));
        }
    }

    if (!teaching.grades.length) {
        diagnostics.push(diagnostic("TERM", "ERROR", "TERM_WITHOUT_GRADE", "本学期尚未配置年级", {targetTab: "organization"}));
    }
    if (!activeClasses.length) {
        diagnostics.push(diagnostic("TERM", "ERROR", "TERM_WITHOUT_ADMIN_CLASS", "本学期尚未配置行政班", {targetTab: "structure"}));
    }

    const severityOrder = {ERROR: 0, WARNING: 1, INFO: 2};
    diagnostics.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));
    const errors = diagnostics.filter((item) => item.severity === "ERROR").length;
    const warnings = diagnostics.filter((item) => item.severity === "WARNING").length;
    return {
        school: staff.school,
        term,
        summary: {
            grades: teaching.grades.length,
            administrativeClasses: activeClasses.length,
            courseGroups: teaching.courseGroups.filter((item) => item.isActive).length,
            teachers: assignedAccountIds.size,
            teachingAssignments: teaching.summary.teachingAssignments,
            screens: screens.length,
            activatedScreens: screens.filter((item) => item.activatedAt).length,
            errors,
            warnings,
            healthy: errors === 0 && warnings === 0,
        },
        diagnostics,
        generatedAt: new Date(),
    };
}
