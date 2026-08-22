import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";
import {cloneAcademicTerm} from "./organizationAdminService.js";
import {getSchoolManagementOverview} from "./schoolManagementOverviewService.js";

async function requireManagedTerm(accountId, termId) {
    const term = await prisma.academicTerm.findUnique({where: {id: termId}});
    if (!term) throw authorizationError("学期不存在", "TERM_NOT_FOUND", 404);
    await assertSchoolManager(accountId, term.schoolId);
    return term;
}

export async function previewAcademicTermTransition({accountId, sourceTermId, target}) {
    const source = await requireManagedTerm(accountId, sourceTermId);
    const academicYear = Number(target?.academicYear);
    const semester = Number(target?.semester);
    const name = typeof target?.name === "string" ? target.name.trim() : "";
    if (
        !name ||
        !Number.isInteger(academicYear) || academicYear < 2000 || academicYear > 2200 ||
        !Number.isInteger(semester) || semester < 1 || semester > 3
    ) {
        throw authorizationError("需要有效的目标学期名称、学年和学期序号", "INVALID_TARGET_TERM", 400);
    }
    for (const field of ["startsAt", "endsAt"]) {
        if (target?.[field] && Number.isNaN(Date.parse(target[field]))) {
            throw authorizationError(`${field}不是有效日期`, "INVALID_TARGET_TERM_DATE", 400, {field});
        }
    }
    if (target?.startsAt && target?.endsAt && Date.parse(target.endsAt) < Date.parse(target.startsAt)) {
        throw authorizationError("学期结束日期不能早于开始日期", "INVALID_TARGET_TERM_RANGE", 400);
    }
    const [counts, existing, screens] = await Promise.all([
        prisma.academicTerm.findUnique({
            where: {id: source.id},
            select: {
                _count: {select: {grades: true, workspaces: true}},
                grades: {select: {_count: {select: {leaderships: true}}}},
                workspaces: {select: {_count: {select: {members: true, teachingAssignments: true, leaderships: true, pendingInvitations: true}}}},
            },
        }),
        prisma.academicTerm.findUnique({
            where: {schoolId_academicYear_semester: {
                schoolId: source.schoolId,
                academicYear,
                semester,
            }},
        }),
        prisma.classroomScreenBinding.count({where: {schoolId: source.schoolId, isActive: true}}),
    ]);
    if (existing) throw authorizationError("目标学期已经存在", "TARGET_TERM_EXISTS", 409, {termId: existing.id});
    return {
        source: {id: source.id, name: source.name, status: source.status},
        target: {name, academicYear, semester},
        counts: {
            grades: counts._count.grades,
            workspaces: counts._count.workspaces,
            workspaceMembers: counts.workspaces.reduce((sum, item) => sum + item._count.members, 0),
            teachingAssignments: counts.workspaces.reduce((sum, item) => sum + item._count.teachingAssignments, 0),
            gradeLeaderships: counts.grades.reduce((sum, item) => sum + item._count.leaderships, 0),
            classLeaderships: counts.workspaces.reduce((sum, item) => sum + item._count.leaderships, 0),
            pendingInvitations: counts.workspaces.reduce((sum, item) => sum + item._count.pendingInvitations, 0),
            screens,
        },
        warnings: screens ? ["大屏不会在创建草稿时立即切换；正式启用学期时按行政班代码迁移绑定。"] : [],
    };
}

export async function createAcademicTermTransition({accountId, sourceTermId, target}) {
    await previewAcademicTermTransition({accountId, sourceTermId, target});
    return cloneAcademicTerm({accountId, sourceTermId, target: {...target, transitionMode: true}});
}

export async function getAcademicTermReadiness({accountId, termId}) {
    const term = await requireManagedTerm(accountId, termId);
    const [overview, current, targetClasses, screens] = await Promise.all([
        getSchoolManagementOverview({managerAccountId: accountId, schoolId: term.schoolId, termId: term.id}),
        prisma.academicTerm.findFirst({where: {schoolId: term.schoolId, status: "ACTIVE", id: {not: term.id}}}),
        prisma.workspace.findMany({where: {termId: term.id, type: "ADMIN_CLASS", isActive: true}, select: {id: true, code: true, name: true}}),
        prisma.classroomScreenBinding.findMany({
            where: {schoolId: term.schoolId, isActive: true},
            include: {administrativeClass: {select: {code: true, name: true}}},
        }),
    ]);
    const targetByCode = new Map(targetClasses.map((item) => [item.code, item]));
    const screenMappings = screens.map((screen) => ({
        screenId: screen.id,
        screenName: screen.name,
        fromClass: screen.administrativeClass.name,
        classCode: screen.administrativeClass.code,
        targetClass: targetByCode.get(screen.administrativeClass.code) || null,
    }));
    const blockingDiagnostics = overview.diagnostics.filter((item) => item.severity === "ERROR");
    return {
        term,
        currentActiveTerm: current,
        overview,
        screenMappings,
        mappedScreens: screenMappings.filter((item) => item.targetClass).length,
        unmappedScreens: screenMappings.filter((item) => !item.targetClass),
        blockingDiagnostics,
        ready: blockingDiagnostics.length === 0,
    };
}

export async function activateAcademicTermTransition({accountId, termId, force = false, rebindScreens = true}) {
    const readiness = await getAcademicTermReadiness({accountId, termId});
    if (!readiness.ready && !force) {
        throw authorizationError("学期仍有阻断项，请修复后重试或明确强制启用", "TERM_NOT_READY", 409, {
            diagnostics: readiness.blockingDiagnostics,
        });
    }
    const mappingByScreenId = new Map(readiness.screenMappings
        .filter((item) => item.targetClass)
        .map((item) => [item.screenId, item.targetClass.id]));
    const result = await prisma.$transaction(async (tx) => {
        await tx.academicTerm.updateMany({
            where: {schoolId: readiness.term.schoolId, status: "ACTIVE", id: {not: termId}},
            data: {status: "ARCHIVED"},
        });
        const term = await tx.academicTerm.update({where: {id: termId}, data: {status: "ACTIVE"}});
        let reboundScreens = 0;
        if (rebindScreens) {
            for (const [screenId, administrativeClassId] of mappingByScreenId) {
                await tx.classroomScreenBinding.update({where: {id: screenId}, data: {administrativeClassId}});
                reboundScreens += 1;
            }
        }
        return {term, reboundScreens};
    }, {timeout: 30000});
    return {...result, unmappedScreens: readiness.unmappedScreens};
}
