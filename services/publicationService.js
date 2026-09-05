import {prisma} from "../utils/prisma.js";
import {Prisma} from "../generated/prisma/client.ts";
import {
    PUBLICATION_TYPES,
    PUBLICATION_STATUSES,
    earliestPublicationTransition,
    parseBoardDate,
    validatePublicationSnapshot,
} from "../domain/publication.js";
import {
    assertCanManagePublication,
    assertCanCertifyPublication,
    assertCanReadPublication,
    assertCanReadWorkspace,
    assertCanWriteWorkspaces,
    getPublicationCertificationScope,
    getWritableWorkspaceIds,
    getReadableWorkspaceIds,
    loadPublicationWorkspaces,
    publicationWorkspaceInclude,
} from "./publicationAuthorizationService.js";
import {getResponsibilityWorkspaceIds} from "./staffAuthorizationService.js";
import {authorizationError} from "./academicAuthorizationService.js";
import {broadcastWorkspaceEvent} from "../utils/socket.js";
import {
    isClassroomScreenWorkspaceAllowed,
    resolveClassroomScreenWorkspaces,
} from "./classroomScreenService.js";
import {
    ACTION_REQUIRED_REASONS,
    classifyActionRequiredPublication,
    compareActionRequiredItems,
    isPublicationWithinActionScope,
} from "../domain/publicationActionCenter.js";
import {findDuplicateAssignmentCandidates} from "../domain/publicationDuplicate.js";
import {screenPublicationRequest} from "../domain/publicationRequest.js";

const publicationInclude = {
    author: {select: {id: true, name: true, email: true, avatarUrl: true}},
    certifiedBy: {select: {id: true, name: true}},
    latestScreenBinding: {
        select: {
            id: true,
            name: true,
            administrativeClass: {select: {id: true, code: true, name: true}},
        },
    },
    subject: {select: {id: true, code: true, name: true, category: true}},
    targets: {
        include: {workspace: {include: publicationWorkspaceInclude}},
    },
};

const publicFeedInclude = {
    author: {select: {id: true, name: true, avatarUrl: true}},
    certifiedBy: {select: {id: true, name: true}},
    latestScreenBinding: {
        select: {
            id: true,
            name: true,
            administrativeClass: {select: {id: true, code: true, name: true}},
        },
    },
    subject: {select: {id: true, code: true, name: true, category: true}},
    targets: {
        include: {
            workspace: {
                select: {
                    id: true,
                    code: true,
                    name: true,
                    type: true,
                    termId: true,
                    gradeId: true,
                    subjectId: true,
                },
            },
        },
    },
};

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function publicationError(message, code, statusCode = 400, details = null) {
    return authorizationError(message, code, statusCode, details);
}

function validationError(validation) {
    return publicationError(
        "发布内容校验失败",
        "PUBLICATION_VALIDATION_FAILED",
        422,
        {errors: validation.errors},
    );
}

function toPublicationData(normalized) {
    return {
        type: normalized.type,
        subjectId: normalized.subjectId,
        title: normalized.title,
        content: normalized.content,
        boardDate: normalized.boardDate,
        publishAt: normalized.publishAt,
        dueAt: normalized.dueAt,
        expiresAt: normalized.expiresAt,
        priority: normalized.priority,
        status: normalized.status,
        ...(normalized.contentJson !== undefined
            ? {contentJson: normalized.contentJson === null ? Prisma.JsonNull : normalized.contentJson}
            : {}),
    };
}

function toSnapshot(normalized) {
    const dateValue = (value) => value instanceof Date ? value.toISOString() : value || null;
    return {
        type: normalized.type,
        subjectId: normalized.subjectId,
        title: normalized.title,
        content: normalized.content,
        contentJson: normalized.contentJson ?? null,
        boardDate: normalized.boardDate instanceof Date
            ? normalized.boardDate.toISOString().slice(0, 10)
            : normalized.boardDate || null,
        publishAt: dateValue(normalized.publishAt),
        dueAt: dateValue(normalized.dueAt),
        expiresAt: dateValue(normalized.expiresAt),
        priority: normalized.priority,
        status: normalized.status,
        targetWorkspaceIds: [...normalized.targetWorkspaceIds],
    };
}

function revisionData({
    publicationId,
    revision,
    normalized,
    action,
    actorType,
    editorAccountId = null,
    screenBindingId = null,
    restoredFromRevision = null,
    isCertified = false,
    certifiedByAccountId = null,
    certifiedAt = null,
}) {
    return {
        publicationId,
        revision,
        snapshot: toSnapshot(normalized),
        action,
        actorType,
        editorAccountId,
        screenBindingId,
        restoredFromRevision,
        isCertified,
        certifiedByAccountId,
        certifiedAt,
    };
}

async function assertSubjectMatchesTargets(subjectId, workspaces) {
    if (!subjectId) return;
    const subject = await prisma.subject.findUnique({where: {id: subjectId}});
    if (!subject) throw publicationError("科目不存在", "SUBJECT_NOT_FOUND", 404);
    const schoolIds = new Set(workspaces.map((workspace) => workspace.term.schoolId));
    if (schoolIds.size !== 1 || !schoolIds.has(subject.schoolId)) {
        throw publicationError("科目与发布目标不属于同一学校", "SUBJECT_SCHOOL_MISMATCH", 422);
    }
}

function emitPublicationEvent(type, publication, workspaceIds) {
    broadcastWorkspaceEvent(workspaceIds, type, {
        publicationId: publication.id,
        publicationType: publication.type,
        status: publication.status,
        revision: publication.revision,
        updatedAt: publication.updatedAt,
    });
}

async function getPublicationOrThrow(id, client = prisma) {
    const publication = await client.publication.findUnique({
        where: {id},
        include: publicationInclude,
    });
    if (!publication) throw publicationError("发布内容不存在", "PUBLICATION_NOT_FOUND", 404);
    return publication;
}

async function assertNoDuplicateAssignment({normalized, input, excludePublicationId = null, client = prisma}) {
    if (
        input?.allowDuplicate === true
        || normalized.type !== PUBLICATION_TYPES.ASSIGNMENT
        || normalized.status !== PUBLICATION_STATUSES.PUBLISHED
    ) return;

    const candidates = await client.publication.findMany({
        where: {
            type: PUBLICATION_TYPES.ASSIGNMENT,
            status: PUBLICATION_STATUSES.PUBLISHED,
            subjectId: normalized.subjectId,
            boardDate: normalized.boardDate,
            ...(excludePublicationId ? {id: {not: excludePublicationId}} : {}),
            targets: {some: {workspaceId: {in: normalized.targetWorkspaceIds}}},
        },
        include: publicationInclude,
        orderBy: {updatedAt: "desc"},
        take: 30,
    });
    const matches = findDuplicateAssignmentCandidates(normalized, candidates);
    if (!matches.length) return;

    const targetIds = new Set(normalized.targetWorkspaceIds);
    const duplicates = matches.slice(0, 5).map(({candidate, reason}) => ({
        id: candidate.id,
        revision: candidate.revision,
        title: candidate.title,
        content: candidate.content,
        boardDate: candidate.boardDate?.toISOString().slice(0, 10) || null,
        dueAt: candidate.dueAt,
        updatedAt: candidate.updatedAt,
        isCertified: candidate.isCertified,
        reason,
        sourceName: candidate.latestActorType === "CLASSROOM_SCREEN"
            ? candidate.latestScreenBinding?.name || "班级大屏"
            : candidate.author?.name || "教师",
        targets: candidate.targets
            .filter((target) => targetIds.has(target.workspaceId))
            .map((target) => ({id: target.workspaceId, name: target.workspace.name})),
    }));
    throw publicationError(
        "检测到同一天、同一科目和班级中已有内容相同的作业",
        "DUPLICATE_ASSIGNMENT_SUSPECTED",
        409,
        {duplicates},
    );
}

export async function createPublication({accountId, input}) {
    const targetIds = Array.isArray(input?.targetWorkspaceIds) ? input.targetWorkspaceIds : [];
    const workspaces = await loadPublicationWorkspaces(targetIds);
    await assertCanWriteWorkspaces(accountId, workspaces);
    const validation = validatePublicationSnapshot({input, workspaces});
    if (!validation.valid) throw validationError(validation);

    const normalized = validation.normalized;
    await assertSubjectMatchesTargets(normalized.subjectId, workspaces);
    await assertNoDuplicateAssignment({normalized, input});
    const certifiedAt = new Date();
    const publication = await prisma.$transaction(async (tx) => {
        const created = await tx.publication.create({
            data: {
                authorAccountId: accountId,
                ...toPublicationData(normalized),
                isCertified: true,
                certifiedByAccountId: accountId,
                certifiedAt,
                latestActorType: "ACCOUNT",
                targets: {
                    create: normalized.targetWorkspaceIds.map((workspaceId) => ({workspaceId})),
                },
            },
        });
        await tx.publicationRevision.create({
            data: revisionData({
                publicationId: created.id,
                revision: created.revision,
                normalized,
                action: "CREATED",
                actorType: "ACCOUNT",
                editorAccountId: accountId,
                isCertified: true,
                certifiedByAccountId: accountId,
                certifiedAt,
            }),
        });
        return tx.publication.findUnique({where: {id: created.id}, include: publicationInclude});
    });
    emitPublicationEvent("publication.created", publication, normalized.targetWorkspaceIds);
    return publication;
}

export async function getPublication({accountId, publicationId}) {
    const publication = await getPublicationOrThrow(publicationId);
    await assertCanReadPublication(accountId, publication);
    return publication;
}

export async function listPublications({accountId, workspaceId, status, type, limit = 50, skip = 0}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const safeSkip = Math.max(Number(skip) || 0, 0);
    const where = {};

    if (workspaceId) {
        const [workspace] = await loadPublicationWorkspaces([workspaceId]);
        if (!workspace) throw publicationError("教学空间不存在", "WORKSPACE_NOT_FOUND", 404);
        await assertCanReadWorkspace(accountId, workspace);
        where.targets = {some: {workspaceId}};
        const writableIds = await getWritableWorkspaceIds(accountId, [workspace]);
        if (writableIds.length === 0) {
            if (status && status !== PUBLICATION_STATUSES.PUBLISHED) {
                throw publicationError("没有未发布内容的读取权限", "PUBLICATION_DRAFT_READ_FORBIDDEN", 403);
            }
            where.status = PUBLICATION_STATUSES.PUBLISHED;
        }
    } else {
        const [workspaceMemberships, schoolMemberships, responsibilityAccess] = await Promise.all([
            prisma.workspaceMember.findMany({
                where: {accountId, role: {in: ["OWNER", "TEACHER", "ASSISTANT"]}},
                select: {workspaceId: true},
            }),
            prisma.schoolMember.findMany({
                where: {accountId, role: {in: ["OWNER", "ADMIN"]}},
                select: {schoolId: true},
            }),
            getResponsibilityWorkspaceIds(accountId),
        ]);
        const managedSchoolIds = schoolMemberships.map((membership) => membership.schoolId);
        const managedWorkspaces = managedSchoolIds.length
            ? await prisma.workspace.findMany({
                where: {term: {schoolId: {in: managedSchoolIds}}},
                select: {id: true},
            })
            : [];
        const readableWorkspaceIds = [...new Set([
            ...workspaceMemberships.map((membership) => membership.workspaceId),
            ...managedWorkspaces.map((workspace) => workspace.id),
            ...responsibilityAccess.readableIds,
        ])];
        const candidateWorkspaces = readableWorkspaceIds.length
            ? await loadPublicationWorkspaces(readableWorkspaceIds) : [];
        const [permittedReadableIds, permittedWritableIds] = await Promise.all([
            getReadableWorkspaceIds(accountId, readableWorkspaceIds),
            getWritableWorkspaceIds(accountId, candidateWorkspaces),
        ]);
        where.OR = [
            {authorAccountId: accountId},
            ...(permittedWritableIds.length
                ? [{targets: {some: {workspaceId: {in: permittedWritableIds}}}}] : []),
            ...(permittedReadableIds.length
                ? [{status: PUBLICATION_STATUSES.PUBLISHED, targets: {some: {workspaceId: {in: permittedReadableIds}}}}] : []),
        ];
    }
    if (status) where.status = status;
    if (type) where.type = type;

    const [items, total] = await Promise.all([
        prisma.publication.findMany({
            where,
            orderBy: [{publishAt: "desc"}, {updatedAt: "desc"}],
            take: safeLimit,
            skip: safeSkip,
            include: publicationInclude,
        }),
        prisma.publication.count({where}),
    ]);
    return {items, total, limit: safeLimit, skip: safeSkip};
}

async function getActionCenterScope(accountId) {
    const [teachingAssignments, schoolMemberships, responsibilityAccess] = await Promise.all([
        prisma.teachingAssignment.findMany({
            where: {accountId, isActive: true, workspace: {isActive: true}},
            select: {workspaceId: true, subjectId: true},
        }),
        prisma.schoolMember.findMany({
            where: {accountId, role: {in: ["OWNER", "ADMIN"]}},
            select: {schoolId: true},
        }),
        getResponsibilityWorkspaceIds(accountId),
    ]);
    const managedSchoolIds = schoolMemberships.map((membership) => membership.schoolId);
    const schoolWorkspaces = managedSchoolIds.length
        ? await prisma.workspace.findMany({
            where: {isActive: true, term: {schoolId: {in: managedSchoolIds}}},
            select: {id: true},
        })
        : [];
    const candidateIds = [...new Set([
        ...teachingAssignments.map((assignment) => assignment.workspaceId),
        ...schoolWorkspaces.map((workspace) => workspace.id),
        ...responsibilityAccess.writableIds,
    ])];
    if (!candidateIds.length) return {candidateWorkspaceIds: [], fullWorkspaceIds: [], teachingAssignments: []};
    const workspaces = await loadPublicationWorkspaces(candidateIds);
    const certificationScope = await getPublicationCertificationScope(accountId, workspaces);
    return {candidateWorkspaceIds: candidateIds, ...certificationScope};
}

export async function listActionRequiredPublications({
    accountId,
    schoolId,
    workspaceId,
    subjectId,
    reason,
    limit = 20,
    skip = 0,
    now = new Date(),
}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const safeSkip = Math.max(Number(skip) || 0, 0);
    const actionScope = await getActionCenterScope(accountId);
    if (!actionScope.candidateWorkspaceIds.length) {
        return {
            items: [],
            total: 0,
            limit: safeLimit,
            skip: safeSkip,
            summary: {total: 0, changedAfterCertified: 0, createdByScreen: 0, other: 0, dueSoon: 0, overdue: 0},
            generatedAt: now,
        };
    }

    const targetSome = {};
    if (workspaceId) targetSome.workspaceId = workspaceId;
    if (schoolId) targetSome.workspace = {term: {schoolId}};
    const targetFilter = {
        every: {workspaceId: {in: actionScope.candidateWorkspaceIds}},
        some: targetSome,
    };
    const publications = await prisma.publication.findMany({
        where: {
            status: PUBLICATION_STATUSES.PUBLISHED,
            isCertified: false,
            publishAt: {lte: now},
            ...(subjectId ? {subjectId} : {}),
            targets: targetFilter,
        },
        include: {
            ...publicationInclude,
            revisions: {
                where: {isCertified: true, purgedAt: null},
                orderBy: {revision: "desc"},
                take: 1,
                select: {
                    id: true,
                    revision: true,
                    snapshot: true,
                    certifiedAt: true,
                    certifiedBy: {select: {id: true, name: true}},
                },
            },
        },
    });
    const allItems = publications
        .filter((publication) => isPublicationWithinActionScope(publication, actionScope))
        .map((publication) => classifyActionRequiredPublication(publication, {now}))
        .sort(compareActionRequiredItems);
    const summary = {
        total: allItems.length,
        changedAfterCertified: allItems.filter(
            (item) => item.reason === ACTION_REQUIRED_REASONS.CHANGED_AFTER_CERTIFICATION,
        ).length,
        createdByScreen: allItems.filter(
            (item) => item.reason === ACTION_REQUIRED_REASONS.CREATED_BY_SCREEN,
        ).length,
        other: allItems.filter(
            (item) => item.reason === ACTION_REQUIRED_REASONS.OTHER_UNCERTIFIED,
        ).length,
        dueSoon: allItems.filter((item) => item.dueSoon).length,
        overdue: allItems.filter((item) => item.overdue).length,
    };
    const filteredItems = reason ? allItems.filter((item) => item.reason === reason) : allItems;
    return {
        items: filteredItems.slice(safeSkip, safeSkip + safeLimit),
        total: filteredItems.length,
        limit: safeLimit,
        skip: safeSkip,
        summary,
        generatedAt: now,
    };
}

function shanghaiBoardDate(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function normalizeBoardDate(value, {defaultToday = false} = {}) {
    const errors = [];
    const parsed = parseBoardDate(value || (defaultToday ? shanghaiBoardDate() : null), errors, {required: true});
    if (!parsed) {
        throw publicationError("无效的作业板日期", "INVALID_BOARD_DATE", 422, {errors});
    }
    return parsed;
}

export async function listPublishedFeed({workspaceIds, boardDate, limit = 50, skip = 0, now = new Date()}) {
    const targetIds = [...new Set((workspaceIds || []).filter(Boolean))];
    if (targetIds.length === 0) {
        throw publicationError("至少需要选择一个教学空间", "PUBLICATION_TARGET_REQUIRED", 400);
    }
    if (targetIds.length > 20) {
        throw publicationError("一次最多订阅20个教学空间", "TOO_MANY_WORKSPACES", 400);
    }
    const workspaces = await loadPublicationWorkspaces(targetIds);
    if (workspaces.length !== targetIds.length) {
        const found = new Set(workspaces.map((workspace) => workspace.id));
        throw publicationError("部分教学空间不存在或已停用", "WORKSPACE_NOT_FOUND", 404, {
            workspaceIds: targetIds.filter((id) => !found.has(id)),
        });
    }
    if (workspaces.some((workspace) => workspace.term.status !== "ACTIVE")) {
        throw publicationError("学生端只能读取当前启用学期", "TERM_NOT_ACTIVE", 422);
    }
    const termIds = new Set(workspaces.map((workspace) => workspace.termId));
    if (termIds.size !== 1) {
        throw publicationError("一次只能读取同一学期的教学空间", "CROSS_TERM_TARGETS", 422);
    }

    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const safeSkip = Math.max(Number(skip) || 0, 0);
    const selectedBoardDate = normalizeBoardDate(boardDate, {defaultToday: true});
    const visibleForBoardDate = [
        {type: PUBLICATION_TYPES.ASSIGNMENT, boardDate: selectedBoardDate},
        {
            type: PUBLICATION_TYPES.NOTICE,
            OR: [{expiresAt: null}, {expiresAt: {gt: now}}],
        },
    ];
    const where = {
        status: PUBLICATION_STATUSES.PUBLISHED,
        publishAt: {lte: now},
        OR: visibleForBoardDate,
        targets: {some: {workspaceId: {in: targetIds}}},
    };
    const [items, total, nextScheduled, nextExpiry] = await Promise.all([
        prisma.publication.findMany({
            where,
            orderBy: [{publishAt: "desc"}, {updatedAt: "desc"}],
            take: safeLimit,
            skip: safeSkip,
            include: publicFeedInclude,
        }),
        prisma.publication.count({where}),
        prisma.publication.findFirst({
            where: {
                status: PUBLICATION_STATUSES.PUBLISHED,
                publishAt: {gt: now},
                OR: visibleForBoardDate,
                targets: {some: {workspaceId: {in: targetIds}}},
            },
            orderBy: {publishAt: "asc"},
            select: {publishAt: true},
        }),
        prisma.publication.findFirst({
            where: {
                status: PUBLICATION_STATUSES.PUBLISHED,
                type: PUBLICATION_TYPES.NOTICE,
                publishAt: {lte: now},
                expiresAt: {gt: now},
                targets: {some: {workspaceId: {in: targetIds}}},
            },
            orderBy: {expiresAt: "asc"},
            select: {expiresAt: true},
        }),
    ]);
    return {
        items,
        total,
        limit: safeLimit,
        skip: safeSkip,
        workspaceIds: targetIds,
        boardDate: selectedBoardDate.toISOString().slice(0, 10),
        generatedAt: now,
        nextTransitionAt: earliestPublicationTransition(
            nextScheduled?.publishAt,
            nextExpiry?.expiresAt,
        ),
    };
}

export async function listPublicationRevisions({accountId, publicationId}) {
    const publication = await getPublicationOrThrow(publicationId);
    await assertCanReadPublication(accountId, publication);
    return prisma.publicationRevision.findMany({
        where: {publicationId},
        orderBy: {revision: "desc"},
        include: {
            editor: {select: {id: true, name: true}},
            certifiedBy: {select: {id: true, name: true}},
            screenBinding: {
                select: {
                    id: true,
                    name: true,
                    administrativeClass: {select: {id: true, code: true, name: true}},
                },
            },
        },
    });
}

export async function certifyPublication({accountId, publicationId, expectedRevision}) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw publicationError("需要提供有效的 revision 或 If-Match", "PUBLICATION_REVISION_REQUIRED", 428);
    }
    const existing = await getPublicationOrThrow(publicationId);
    await assertCanCertifyPublication(accountId, existing);
    if (existing.status !== PUBLICATION_STATUSES.PUBLISHED) {
        throw publicationError("只能确认已发布内容", "PUBLICATION_NOT_PUBLISHED", 409);
    }
    if (existing.isCertified) return existing;

    const certifiedAt = new Date();
    const publication = await prisma.$transaction(async (tx) => {
        const result = await tx.publication.updateMany({
            where: {id: publicationId, revision: expectedRevision, isCertified: false},
            data: {isCertified: true, certifiedByAccountId: accountId, certifiedAt},
        });
        if (result.count !== 1) {
            const latest = await tx.publication.findUnique({
                where: {id: publicationId},
                select: {revision: true, isCertified: true, updatedAt: true},
            });
            throw publicationError(
                "内容已被修改或由教师确认，请刷新后重试",
                "PUBLICATION_REVISION_CONFLICT",
                409,
                latest,
            );
        }
        await tx.publicationRevision.update({
            where: {publicationId_revision: {publicationId, revision: expectedRevision}},
            data: {isCertified: true, certifiedByAccountId: accountId, certifiedAt},
        });
        return tx.publication.findUnique({where: {id: publicationId}, include: publicationInclude});
    });
    emitPublicationEvent(
        "publication.certified",
        publication,
        publication.targets.map((target) => target.workspaceId),
    );
    return publication;
}

export async function restorePublicationRevision({
    accountId,
    publicationId,
    sourceRevision,
    expectedRevision,
}) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw publicationError("需要提供有效的 revision 或 If-Match", "PUBLICATION_REVISION_REQUIRED", 428);
    }
    if (!Number.isInteger(sourceRevision) || sourceRevision < 1) {
        throw publicationError("需要选择有效的历史版本", "PUBLICATION_SOURCE_REVISION_REQUIRED", 400);
    }
    const existing = await getPublicationOrThrow(publicationId);
    await assertCanManagePublication(accountId, existing);
    const source = await prisma.publicationRevision.findUnique({
        where: {publicationId_revision: {publicationId, revision: sourceRevision}},
    });
    if (!source) throw publicationError("历史版本不存在", "PUBLICATION_REVISION_NOT_FOUND", 404);
    if (source.snapshot?.status === PUBLICATION_STATUSES.WITHDRAWN) {
        throw publicationError("撤回记录不能恢复为当前内容", "WITHDRAWN_REVISION_NOT_RESTORABLE", 409);
    }

    const targetWorkspaceIds = Array.isArray(source.snapshot?.targetWorkspaceIds)
        ? source.snapshot.targetWorkspaceIds
        : [];
    const workspaces = await loadPublicationWorkspaces(targetWorkspaceIds);
    await assertCanWriteWorkspaces(accountId, workspaces);
    const validation = validatePublicationSnapshot({input: source.snapshot, workspaces});
    if (!validation.valid) throw validationError(validation);
    const normalized = validation.normalized;
    await assertSubjectMatchesTargets(normalized.subjectId, workspaces);
    const certifiedAt = new Date();

    const publication = await prisma.$transaction(async (tx) => {
        const result = await tx.publication.updateMany({
            where: {id: publicationId, revision: expectedRevision},
            data: {
                ...toPublicationData(normalized),
                withdrawnAt: null,
                isCertified: true,
                certifiedByAccountId: accountId,
                certifiedAt,
                latestActorType: "ACCOUNT",
                latestScreenBindingId: null,
                revision: {increment: 1},
            },
        });
        if (result.count !== 1) {
            const latest = await tx.publication.findUnique({
                where: {id: publicationId},
                select: {revision: true, updatedAt: true},
            });
            throw publicationError("内容已被其他人修改，请刷新后重试", "PUBLICATION_REVISION_CONFLICT", 409, latest);
        }
        await tx.publicationTarget.deleteMany({where: {publicationId}});
        await tx.publicationTarget.createMany({
            data: normalized.targetWorkspaceIds.map((workspaceId) => ({publicationId, workspaceId})),
        });
        await tx.publicationRevision.create({
            data: revisionData({
                publicationId,
                revision: expectedRevision + 1,
                normalized,
                action: "RESTORED",
                actorType: "ACCOUNT",
                editorAccountId: accountId,
                restoredFromRevision: sourceRevision,
                isCertified: true,
                certifiedByAccountId: accountId,
                certifiedAt,
            }),
        });
        return tx.publication.findUnique({where: {id: publicationId}, include: publicationInclude});
    });
    emitPublicationEvent(
        "publication.restored",
        publication,
        publication.targets.map((target) => target.workspaceId),
    );
    return publication;
}

function assertScreenCanWriteWorkspaces(screenBinding, workspaces) {
    if (workspaces.length !== 1) {
        throw publicationError("大屏每次只能保存一个班级的作业", "SCREEN_SINGLE_TARGET_REQUIRED", 422);
    }
    const workspace = workspaces[0];
    if (isClassroomScreenWorkspaceAllowed(screenBinding, workspace)) return;
    throw publicationError("该教学班不在本大屏的录入范围内", "SCREEN_TARGET_FORBIDDEN", 403);
}

function assertScreenCanAccessPublication(screenBinding, publication) {
    if (publication.targets.some((target) => (
        isClassroomScreenWorkspaceAllowed(screenBinding, target.workspace)
    ))) return;
    throw publicationError("该作业不属于本大屏可管理的班级", "SCREEN_TARGET_FORBIDDEN", 403);
}

function currentPublicationInput(publication, targetWorkspaceIds) {
    return {
        type: publication.type,
        status: publication.status,
        priority: publication.priority,
        subjectId: publication.subjectId,
        title: publication.title,
        content: publication.content,
        contentJson: publication.contentJson,
        boardDate: publication.boardDate,
        publishAt: publication.publishAt,
        dueAt: publication.dueAt,
        expiresAt: publication.expiresAt,
        targetWorkspaceIds,
    };
}

async function lockScreenPublicationSession(tx, binding) {
    // Hold this row until the publication and revision commit. Disabling or rotating
    // the binding must either commit before this check, or wait for this upload.
    const [current] = await tx.$queryRaw`SELECT "id", "isActive", "tokenHash", "credentialVersion", "administrativeClassId"
        FROM "ClassroomScreenBinding" WHERE "id" = ${binding.id} FOR SHARE`;
    if (!current?.isActive || !binding.tokenHash || current.tokenHash !== binding.tokenHash
        || current.credentialVersion !== binding.credentialVersion
        || current.administrativeClassId !== binding.administrativeClassId) {
        throw authorizationError("大屏绑定已失效，请联系管理员重新绑定", "SCREEN_TOKEN_INVALID", 401);
    }
}

export async function createScreenPublication({screenBinding, input}) {
    const request = screenPublicationRequest(input);
    const targetIds = Array.isArray(input?.targetWorkspaceIds) ? input.targetWorkspaceIds : [];
    const workspaces = await loadPublicationWorkspaces(targetIds);
    assertScreenCanWriteWorkspaces(screenBinding, workspaces);
    const screenInput = {...input, type: PUBLICATION_TYPES.ASSIGNMENT, status: PUBLICATION_STATUSES.PUBLISHED};
    const validation = validatePublicationSnapshot({input: screenInput, workspaces});
    if (!validation.valid) throw validationError(validation);
    const normalized = validation.normalized;
    await assertSubjectMatchesTargets(normalized.subjectId, workspaces);
    const {publication, replayed} = await prisma.$transaction(async (tx) => {
        if (request) {
            // Cross-process serialization; the lock and publication/revision commit are atomic.
            const lockKey = JSON.stringify([screenBinding.id, request.id]);
            await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        }
        await lockScreenPublicationSession(tx, screenBinding);
        if (request) {
            const existing = await tx.publication.findFirst({
                where: {creationScreenBindingId: screenBinding.id, creationRequestId: request.id},
                include: publicationInclude,
            });
            if (existing) {
                if (existing.creationRequestHash !== request.hash) {
                    throw publicationError("同一提交标识不能用于不同作业内容", "PUBLICATION_REQUEST_CONFLICT", 409);
                }
                assertScreenCanAccessPublication(screenBinding, existing);
                return {publication: existing, replayed: true};
            }
        }
        await assertNoDuplicateAssignment({normalized, input, client: tx});
        const created = await tx.publication.create({
            data: {
                authorAccountId: null,
                ...(request ? {
                    creationScreenBindingId: screenBinding.id,
                    creationRequestId: request.id,
                    creationRequestHash: request.hash,
                } : {}),
                ...toPublicationData(normalized),
                isCertified: false,
                certifiedByAccountId: null,
                certifiedAt: null,
                latestActorType: "CLASSROOM_SCREEN",
                latestScreenBindingId: screenBinding.id,
                targets: {
                    create: normalized.targetWorkspaceIds.map((workspaceId) => ({workspaceId})),
                },
            },
        });
        await tx.publicationRevision.create({
            data: revisionData({
                publicationId: created.id,
                revision: created.revision,
                normalized,
                action: "CREATED",
                actorType: "CLASSROOM_SCREEN",
                screenBindingId: screenBinding.id,
            }),
        });
        return {publication: await tx.publication.findUnique({where: {id: created.id}, include: publicationInclude}), replayed: false};
    });
    if (!replayed) emitPublicationEvent("publication.created", publication, normalized.targetWorkspaceIds);
    return publication;
}

export async function copyScreenBoardDate({screenBinding, sourceBoardDate, targetBoardDate}) {
    const source = normalizeBoardDate(sourceBoardDate);
    const target = normalizeBoardDate(targetBoardDate);
    const sourceValue = source.toISOString().slice(0, 10);
    const targetValue = target.toISOString().slice(0, 10);
    if (sourceValue === targetValue) {
        throw publicationError("来源日期和目标日期不能相同", "BOARD_DATE_COPY_SAME_DATE", 422);
    }

    const workspaces = await resolveClassroomScreenWorkspaces(screenBinding);
    const allowedIds = workspaces.map((workspace) => workspace.id);
    const sourceItems = await prisma.publication.findMany({
        where: {
            type: PUBLICATION_TYPES.ASSIGNMENT,
            status: PUBLICATION_STATUSES.PUBLISHED,
            boardDate: source,
            targets: {some: {workspaceId: {in: allowedIds}}},
        },
        orderBy: [{publishAt: "asc"}, {createdAt: "asc"}],
        take: 100,
        include: {targets: true},
    });
    const existingItems = await prisma.publication.findMany({
        where: {
            type: PUBLICATION_TYPES.ASSIGNMENT,
            status: PUBLICATION_STATUSES.PUBLISHED,
            boardDate: target,
            targets: {some: {workspaceId: {in: allowedIds}}},
        },
        select: {
            subjectId: true,
            title: true,
            content: true,
            targets: {select: {workspaceId: true}},
        },
    });
    const signature = (item, workspaceId) => [
        workspaceId,
        item.subjectId || "",
        item.title || "",
        item.content || "",
    ].join("\u0000");
    const existingSignatures = new Set(existingItems.flatMap((item) => (
        item.targets.map((targetItem) => signature(item, targetItem.workspaceId))
    )));

    const created = [];
    let skipped = 0;
    for (const item of sourceItems) {
        for (const targetItem of item.targets.filter((candidate) => allowedIds.includes(candidate.workspaceId))) {
            const itemSignature = signature(item, targetItem.workspaceId);
            if (existingSignatures.has(itemSignature)) {
                skipped += 1;
                continue;
            }
            created.push(await createScreenPublication({
                screenBinding,
                input: {
                    subjectId: item.subjectId,
                    title: item.title,
                    content: item.content,
                    contentJson: item.contentJson,
                    priority: item.priority,
                    boardDate: targetValue,
                    publishAt: new Date(),
                    dueAt: null,
                    expiresAt: null,
                    targetWorkspaceIds: [targetItem.workspaceId],
                },
            }));
            existingSignatures.add(itemSignature);
        }
    }
    return {created, createdCount: created.length, skippedCount: skipped, sourceBoardDate: sourceValue, targetBoardDate: targetValue};
}

export async function updateScreenPublication({screenBinding, publicationId, expectedRevision, input}) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw publicationError("需要提供有效的 revision 或 If-Match", "PUBLICATION_REVISION_REQUIRED", 428);
    }
    const existing = await getPublicationOrThrow(publicationId);
    if (existing.type !== PUBLICATION_TYPES.ASSIGNMENT || existing.status === PUBLICATION_STATUSES.WITHDRAWN) {
        throw publicationError("大屏只能修改当前生效的作业", "SCREEN_PUBLICATION_NOT_EDITABLE", 409);
    }
    assertScreenCanAccessPublication(screenBinding, existing);
    const targetWorkspaceIds = hasOwn(input, "targetWorkspaceIds")
        ? input.targetWorkspaceIds
        : existing.targets.map((target) => target.workspaceId);
    const mergedInput = {
        type: PUBLICATION_TYPES.ASSIGNMENT,
        status: PUBLICATION_STATUSES.PUBLISHED,
        priority: hasOwn(input, "priority") ? input.priority : existing.priority,
        subjectId: hasOwn(input, "subjectId") ? input.subjectId : existing.subjectId,
        title: hasOwn(input, "title") ? input.title : existing.title,
        content: hasOwn(input, "content") ? input.content : existing.content,
        contentJson: hasOwn(input, "contentJson") ? input.contentJson : existing.contentJson,
        boardDate: hasOwn(input, "boardDate") ? input.boardDate : existing.boardDate,
        publishAt: hasOwn(input, "publishAt") ? input.publishAt : existing.publishAt,
        dueAt: hasOwn(input, "dueAt") ? input.dueAt : existing.dueAt,
        expiresAt: hasOwn(input, "expiresAt") ? input.expiresAt : existing.expiresAt,
        targetWorkspaceIds,
    };
    const workspaces = await loadPublicationWorkspaces(
        Array.isArray(targetWorkspaceIds) ? targetWorkspaceIds : [],
    );
    assertScreenCanWriteWorkspaces(screenBinding, workspaces);
    const validation = validatePublicationSnapshot({input: mergedInput, workspaces});
    if (!validation.valid) throw validationError(validation);
    const normalized = validation.normalized;
    await assertSubjectMatchesTargets(normalized.subjectId, workspaces);
    await assertNoDuplicateAssignment({normalized, input, excludePublicationId: publicationId});

    const existingTargetIds = existing.targets.map((target) => target.workspaceId);
    const splitsMultiTargetPublication = existingTargetIds.length > 1;
    let localBaseline = null;
    let remainingNormalized = null;
    if (splitsMultiTargetPublication) {
        const localWorkspaceId = normalized.targetWorkspaceIds[0];
        if (!existingTargetIds.includes(localWorkspaceId)) {
            throw publicationError(
                "多班作业只能修改当前已收到的本班副本",
                "SCREEN_TARGET_CHANGE_FORBIDDEN",
                403,
            );
        }
        const baselineValidation = validatePublicationSnapshot({
            input: currentPublicationInput(existing, [localWorkspaceId]),
            workspaces,
        });
        if (!baselineValidation.valid) throw validationError(baselineValidation);
        localBaseline = baselineValidation.normalized;

        const remainingTargetIds = existingTargetIds.filter((id) => id !== localWorkspaceId);
        const remainingWorkspaces = await loadPublicationWorkspaces(remainingTargetIds);
        const remainingValidation = validatePublicationSnapshot({
            input: currentPublicationInput(existing, remainingTargetIds),
            workspaces: remainingWorkspaces,
        });
        if (!remainingValidation.valid) throw validationError(remainingValidation);
        remainingNormalized = remainingValidation.normalized;
    }

    const transactionResult = await prisma.$transaction(async (tx) => {
        if (splitsMultiTargetPublication) {
            const originalUpdate = await tx.publication.updateMany({
                where: {id: publicationId, revision: expectedRevision},
                data: {revision: {increment: 1}},
            });
            if (originalUpdate.count !== 1) {
                const latest = await tx.publication.findUnique({
                    where: {id: publicationId},
                    select: {revision: true, updatedAt: true},
                });
                throw publicationError("作业已被其他人修改，请刷新后比较版本", "PUBLICATION_REVISION_CONFLICT", 409, latest);
            }

            const localWorkspaceId = normalized.targetWorkspaceIds[0];
            await tx.publicationTarget.delete({
                where: {publicationId_workspaceId: {publicationId, workspaceId: localWorkspaceId}},
            });
            await tx.publicationRevision.create({
                data: revisionData({
                    publicationId,
                    revision: expectedRevision + 1,
                    normalized: remainingNormalized,
                    action: "UPDATED",
                    actorType: "CLASSROOM_SCREEN",
                    screenBindingId: screenBinding.id,
                    isCertified: existing.isCertified,
                    certifiedByAccountId: existing.certifiedByAccountId,
                    certifiedAt: existing.certifiedAt,
                }),
            });

            const fork = await tx.publication.create({
                data: {
                    authorAccountId: existing.authorAccountId,
                    ...toPublicationData(normalized),
                    revision: 2,
                    isCertified: false,
                    certifiedByAccountId: null,
                    certifiedAt: null,
                    latestActorType: "CLASSROOM_SCREEN",
                    latestScreenBindingId: screenBinding.id,
                    targets: {create: {workspaceId: localWorkspaceId}},
                },
            });
            await tx.publicationRevision.create({
                data: revisionData({
                    publicationId: fork.id,
                    revision: 1,
                    normalized: localBaseline,
                    action: "CREATED",
                    actorType: existing.authorAccountId ? "ACCOUNT" : existing.latestActorType,
                    editorAccountId: existing.authorAccountId,
                    screenBindingId: existing.authorAccountId ? null : existing.latestScreenBindingId,
                    isCertified: existing.isCertified,
                    certifiedByAccountId: existing.certifiedByAccountId,
                    certifiedAt: existing.certifiedAt,
                }),
            });
            await tx.publicationRevision.create({
                data: revisionData({
                    publicationId: fork.id,
                    revision: 2,
                    normalized,
                    action: "UPDATED",
                    actorType: "CLASSROOM_SCREEN",
                    screenBindingId: screenBinding.id,
                }),
            });
            return {
                publication: await tx.publication.findUnique({where: {id: fork.id}, include: publicationInclude}),
                original: await tx.publication.findUnique({where: {id: publicationId}, include: publicationInclude}),
            };
        }

        const result = await tx.publication.updateMany({
            where: {id: publicationId, revision: expectedRevision},
            data: {
                ...toPublicationData(normalized),
                isCertified: false,
                certifiedByAccountId: null,
                certifiedAt: null,
                latestActorType: "CLASSROOM_SCREEN",
                latestScreenBindingId: screenBinding.id,
                revision: {increment: 1},
            },
        });
        if (result.count !== 1) {
            const latest = await tx.publication.findUnique({
                where: {id: publicationId},
                select: {revision: true, updatedAt: true},
            });
            throw publicationError("作业已被其他人修改，请刷新后比较版本", "PUBLICATION_REVISION_CONFLICT", 409, latest);
        }
        if (hasOwn(input, "targetWorkspaceIds")) {
            await tx.publicationTarget.deleteMany({where: {publicationId}});
            await tx.publicationTarget.createMany({
                data: normalized.targetWorkspaceIds.map((workspaceId) => ({publicationId, workspaceId})),
            });
        }
        await tx.publicationRevision.create({
            data: revisionData({
                publicationId,
                revision: expectedRevision + 1,
                normalized,
                action: "UPDATED",
                actorType: "CLASSROOM_SCREEN",
                screenBindingId: screenBinding.id,
            }),
        });
        return {
            publication: await tx.publication.findUnique({where: {id: publicationId}, include: publicationInclude}),
            original: null,
        };
    });
    const publication = transactionResult.publication;
    const oldTargetIds = existing.targets.map((target) => target.workspaceId);
    if (transactionResult.original) {
        emitPublicationEvent("publication.updated", transactionResult.original, oldTargetIds);
        emitPublicationEvent("publication.created", publication, normalized.targetWorkspaceIds);
        return publication;
    }
    emitPublicationEvent(
        "publication.updated",
        publication,
        [...new Set([...oldTargetIds, ...normalized.targetWorkspaceIds])],
    );
    return publication;
}

export async function listScreenPublicationRevisions({screenBinding, publicationId}) {
    const publication = await getPublicationOrThrow(publicationId);
    if (publication.type !== PUBLICATION_TYPES.ASSIGNMENT) {
        throw publicationError("大屏只能查看作业历史", "SCREEN_PUBLICATION_NOT_EDITABLE", 409);
    }
    assertScreenCanAccessPublication(screenBinding, publication);
    return prisma.publicationRevision.findMany({
        where: {publicationId},
        orderBy: {revision: "desc"},
        include: {
            editor: {select: {id: true, name: true}},
            certifiedBy: {select: {id: true, name: true}},
            screenBinding: {select: {id: true, name: true}},
        },
    });
}

export async function getScreenPublication({screenBinding, publicationId}) {
    const publication = await getPublicationOrThrow(publicationId);
    if (publication.type !== PUBLICATION_TYPES.ASSIGNMENT || publication.status === PUBLICATION_STATUSES.WITHDRAWN) {
        throw publicationError("大屏只能读取当前可编辑的作业", "SCREEN_PUBLICATION_NOT_EDITABLE", 409);
    }
    assertScreenCanAccessPublication(screenBinding, publication);
    return publication;
}

export async function restoreScreenPublicationRevision({
    screenBinding,
    publicationId,
    sourceRevision,
    expectedRevision,
}) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw publicationError("需要提供有效的 revision 或 If-Match", "PUBLICATION_REVISION_REQUIRED", 428);
    }
    const existing = await getPublicationOrThrow(publicationId);
    if (existing.type !== PUBLICATION_TYPES.ASSIGNMENT) {
        throw publicationError("大屏只能恢复作业", "SCREEN_PUBLICATION_NOT_EDITABLE", 409);
    }
    assertScreenCanWriteWorkspaces(
        screenBinding,
        existing.targets.map((target) => target.workspace),
    );
    const source = await prisma.publicationRevision.findUnique({
        where: {publicationId_revision: {publicationId, revision: Number(sourceRevision)}},
    });
    if (!source) throw publicationError("历史版本不存在", "PUBLICATION_REVISION_NOT_FOUND", 404);
    if (source.snapshot?.type !== PUBLICATION_TYPES.ASSIGNMENT) {
        throw publicationError("大屏只能恢复作业历史", "SCREEN_PUBLICATION_NOT_EDITABLE", 409);
    }
    if (source.snapshot?.status === PUBLICATION_STATUSES.WITHDRAWN) {
        throw publicationError("撤回记录不能恢复", "WITHDRAWN_REVISION_NOT_RESTORABLE", 409);
    }
    const targetWorkspaceIds = Array.isArray(source.snapshot?.targetWorkspaceIds)
        ? source.snapshot.targetWorkspaceIds
        : [];
    const workspaces = await loadPublicationWorkspaces(targetWorkspaceIds);
    assertScreenCanWriteWorkspaces(screenBinding, workspaces);
    const validation = validatePublicationSnapshot({input: source.snapshot, workspaces});
    if (!validation.valid) throw validationError(validation);
    const normalized = validation.normalized;
    const certification = source.isCertified ? {
        isCertified: true,
        certifiedByAccountId: source.certifiedByAccountId,
        certifiedAt: source.certifiedAt,
    } : {
        isCertified: false,
        certifiedByAccountId: null,
        certifiedAt: null,
    };

    const publication = await prisma.$transaction(async (tx) => {
        const result = await tx.publication.updateMany({
            where: {id: publicationId, revision: expectedRevision},
            data: {
                ...toPublicationData(normalized),
                ...certification,
                withdrawnAt: null,
                latestActorType: "CLASSROOM_SCREEN",
                latestScreenBindingId: screenBinding.id,
                revision: {increment: 1},
            },
        });
        if (result.count !== 1) {
            const latest = await tx.publication.findUnique({
                where: {id: publicationId},
                select: {revision: true, updatedAt: true},
            });
            throw publicationError("作业已被其他人修改，请刷新后比较版本", "PUBLICATION_REVISION_CONFLICT", 409, latest);
        }
        await tx.publicationTarget.deleteMany({where: {publicationId}});
        await tx.publicationTarget.createMany({
            data: normalized.targetWorkspaceIds.map((workspaceId) => ({publicationId, workspaceId})),
        });
        await tx.publicationRevision.create({
            data: revisionData({
                publicationId,
                revision: expectedRevision + 1,
                normalized,
                action: "RESTORED",
                actorType: "CLASSROOM_SCREEN",
                screenBindingId: screenBinding.id,
                restoredFromRevision: Number(sourceRevision),
                ...certification,
            }),
        });
        return tx.publication.findUnique({where: {id: publicationId}, include: publicationInclude});
    });
    emitPublicationEvent(
        "publication.restored",
        publication,
        publication.targets.map((target) => target.workspaceId),
    );
    return publication;
}

export async function updatePublication({accountId, publicationId, expectedRevision, input}) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw publicationError("需要提供有效的 revision 或 If-Match", "PUBLICATION_REVISION_REQUIRED", 428);
    }
    const existing = await getPublicationOrThrow(publicationId);
    await assertCanManagePublication(accountId, existing);
    if (existing.status === PUBLICATION_STATUSES.WITHDRAWN) {
        throw publicationError("已撤回内容不能继续修改", "PUBLICATION_WITHDRAWN", 409);
    }
    if (input?.type && (
        typeof input.type !== "string" || input.type.trim().toUpperCase() !== existing.type
    )) {
        throw publicationError("发布类型不能修改", "PUBLICATION_TYPE_IMMUTABLE", 400);
    }

    const targetWorkspaceIds = hasOwn(input, "targetWorkspaceIds")
        ? input.targetWorkspaceIds
        : existing.targets.map((target) => target.workspaceId);
    const mergedInput = {
        type: existing.type,
        status: hasOwn(input, "status") ? input.status : existing.status,
        priority: hasOwn(input, "priority") ? input.priority : existing.priority,
        subjectId: hasOwn(input, "subjectId") ? input.subjectId : existing.subjectId,
        title: hasOwn(input, "title") ? input.title : existing.title,
        content: hasOwn(input, "content") ? input.content : existing.content,
        contentJson: hasOwn(input, "contentJson") ? input.contentJson : existing.contentJson,
        boardDate: hasOwn(input, "boardDate") ? input.boardDate : existing.boardDate,
        publishAt: hasOwn(input, "publishAt") ? input.publishAt : existing.publishAt,
        dueAt: hasOwn(input, "dueAt") ? input.dueAt : existing.dueAt,
        expiresAt: hasOwn(input, "expiresAt") ? input.expiresAt : existing.expiresAt,
        targetWorkspaceIds,
    };
    const workspaces = await loadPublicationWorkspaces(
        Array.isArray(targetWorkspaceIds) ? targetWorkspaceIds : [],
    );
    await assertCanWriteWorkspaces(accountId, workspaces);
    const validation = validatePublicationSnapshot({input: mergedInput, workspaces});
    if (!validation.valid) throw validationError(validation);
    const normalized = validation.normalized;
    await assertSubjectMatchesTargets(normalized.subjectId, workspaces);
    await assertNoDuplicateAssignment({normalized, input, excludePublicationId: publicationId});

    const certifiedAt = new Date();
    const publication = await prisma.$transaction(async (tx) => {
        const updateResult = await tx.publication.updateMany({
            where: {id: publicationId, revision: expectedRevision},
            data: {
                ...toPublicationData(normalized),
                isCertified: true,
                certifiedByAccountId: accountId,
                certifiedAt,
                latestActorType: "ACCOUNT",
                latestScreenBindingId: null,
                revision: {increment: 1},
            },
        });
        if (updateResult.count !== 1) {
            const latest = await tx.publication.findUnique({
                where: {id: publicationId},
                select: {revision: true, updatedAt: true},
            });
            throw publicationError(
                "内容已被其他人修改，请刷新后重试",
                "PUBLICATION_REVISION_CONFLICT",
                409,
                latest,
            );
        }

        if (hasOwn(input, "targetWorkspaceIds")) {
            await tx.publicationTarget.deleteMany({where: {publicationId}});
            await tx.publicationTarget.createMany({
                data: normalized.targetWorkspaceIds.map((workspaceId) => ({publicationId, workspaceId})),
            });
        }
        const nextRevision = expectedRevision + 1;
        await tx.publicationRevision.create({
            data: revisionData({
                publicationId,
                revision: nextRevision,
                normalized,
                action: "UPDATED",
                actorType: "ACCOUNT",
                editorAccountId: accountId,
                isCertified: true,
                certifiedByAccountId: accountId,
                certifiedAt,
            }),
        });
        return tx.publication.findUnique({where: {id: publicationId}, include: publicationInclude});
    });

    const oldTargetIds = existing.targets.map((target) => target.workspaceId);
    emitPublicationEvent(
        "publication.updated",
        publication,
        [...new Set([...oldTargetIds, ...normalized.targetWorkspaceIds])],
    );
    return publication;
}

export async function withdrawPublication({accountId, publicationId, expectedRevision}) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw publicationError("需要提供有效的 revision 或 If-Match", "PUBLICATION_REVISION_REQUIRED", 428);
    }
    const existing = await getPublicationOrThrow(publicationId);
    await assertCanManagePublication(accountId, existing);
    if (existing.status === PUBLICATION_STATUSES.WITHDRAWN) return existing;

    const certifiedAt = new Date();
    const normalized = {
        type: existing.type,
        subjectId: existing.subjectId,
        title: existing.title,
        content: existing.content,
        contentJson: existing.contentJson,
        boardDate: existing.boardDate,
        publishAt: existing.publishAt,
        dueAt: existing.dueAt,
        expiresAt: existing.expiresAt,
        priority: existing.priority,
        status: PUBLICATION_STATUSES.WITHDRAWN,
        targetWorkspaceIds: existing.targets.map((target) => target.workspaceId),
    };
    const publication = await prisma.$transaction(async (tx) => {
        const updateResult = await tx.publication.updateMany({
            where: {id: publicationId, revision: expectedRevision},
            data: {
                status: PUBLICATION_STATUSES.WITHDRAWN,
                withdrawnAt: certifiedAt,
                isCertified: true,
                certifiedByAccountId: accountId,
                certifiedAt,
                latestActorType: "ACCOUNT",
                latestScreenBindingId: null,
                revision: {increment: 1},
            },
        });
        if (updateResult.count !== 1) {
            const latest = await tx.publication.findUnique({
                where: {id: publicationId},
                select: {revision: true, updatedAt: true},
            });
            throw publicationError("内容已被其他人修改，请刷新后重试", "PUBLICATION_REVISION_CONFLICT", 409, latest);
        }
        await tx.publicationRevision.create({
            data: revisionData({
                publicationId,
                revision: expectedRevision + 1,
                normalized,
                action: "WITHDRAWN",
                actorType: "ACCOUNT",
                editorAccountId: accountId,
                isCertified: true,
                certifiedByAccountId: accountId,
                certifiedAt,
            }),
        });
        return tx.publication.findUnique({where: {id: publicationId}, include: publicationInclude});
    });
    emitPublicationEvent(
        "publication.withdrawn",
        publication,
        publication.targets.map((target) => target.workspaceId),
    );
    return publication;
}

export async function clonePublication({accountId, publicationId, input = {}}) {
    const existing = await getPublicationOrThrow(publicationId);
    await assertCanReadPublication(accountId, existing);
    return createPublication({
        accountId,
        input: {
            type: existing.type,
            subjectId: hasOwn(input, "subjectId") ? input.subjectId : existing.subjectId,
            title: hasOwn(input, "title") ? input.title : existing.title,
            content: hasOwn(input, "content") ? input.content : existing.content,
            contentJson: hasOwn(input, "contentJson") ? input.contentJson : existing.contentJson,
            boardDate: hasOwn(input, "boardDate") ? input.boardDate : existing.boardDate,
            priority: hasOwn(input, "priority") ? input.priority : existing.priority,
            status: PUBLICATION_STATUSES.DRAFT,
            publishAt: input.publishAt || new Date(),
            dueAt: hasOwn(input, "dueAt") ? input.dueAt : existing.dueAt,
            expiresAt: hasOwn(input, "expiresAt") ? input.expiresAt : existing.expiresAt,
            targetWorkspaceIds: input.targetWorkspaceIds || existing.targets.map((target) => target.workspaceId),
        },
    });
}

export {publicationInclude};
