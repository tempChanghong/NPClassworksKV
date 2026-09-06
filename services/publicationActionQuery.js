import {Prisma} from "../generated/prisma/client.ts";

// Only IDs and aggregate counts cross the DB boundary. Body/snapshot hydration
// happens for the requested page in the same repeatable-read transaction.
export async function queryActionRequiredPage(tx, {scope, schoolId, workspaceId, subjectId, reason, limit, skip, now}) {
    const inIds = (column, ids) => ids.length ? Prisma.sql`${column} IN (${Prisma.join(ids)})` : Prisma.sql`FALSE`;
    const assignments = JSON.stringify(scope.teachingAssignments || []);
    const full = inIds(Prisma.sql`t."workspaceId"`, scope.fullWorkspaceIds || []);
    const candidate = inIds(Prisma.sql`t."workspaceId"`, scope.candidateWorkspaceIds);
    const dueSoon = new Date(now.getTime() + 86400000);
    const [page] = await tx.$queryRaw`
        WITH eligible AS (
            SELECT p."id", p."updatedAt",
                CASE WHEN EXISTS (
                    SELECT 1 FROM "PublicationRevision" r
                    WHERE r."publicationId" = p."id" AND r."isCertified" = TRUE AND r."purgedAt" IS NULL
                ) THEN 'CHANGED_AFTER_CERTIFICATION'
                WHEN p."latestActorType" = 'CLASSROOM_SCREEN' THEN 'CREATED_BY_SCREEN'
                ELSE 'OTHER_UNCERTIFIED' END AS reason,
                COALESCE(p."dueAt" <= ${now}, FALSE) AS overdue,
                COALESCE(p."dueAt" > ${now} AND p."dueAt" <= ${dueSoon}, FALSE) AS "dueSoon",
                CASE p."priority" WHEN 'URGENT' THEN 0 WHEN 'IMPORTANT' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END AS priority
            FROM "Publication" p
            WHERE p."status" = 'PUBLISHED' AND p."isCertified" = FALSE AND p."publishAt" <= ${now}
                ${subjectId ? Prisma.sql`AND p."subjectId" = ${subjectId}` : Prisma.empty}
                AND EXISTS (
                    SELECT 1 FROM "PublicationTarget" t
                    JOIN "Workspace" w ON w."id" = t."workspaceId"
                    JOIN "AcademicTerm" term ON term."id" = w."termId"
                    WHERE t."publicationId" = p."id"
                        ${workspaceId ? Prisma.sql`AND t."workspaceId" = ${workspaceId}` : Prisma.empty}
                        ${schoolId ? Prisma.sql`AND term."schoolId" = ${schoolId}` : Prisma.empty}
                )
                AND NOT EXISTS (
                    SELECT 1 FROM "PublicationTarget" t
                    WHERE t."publicationId" = p."id" AND NOT (
                        ${candidate} AND (
                            ${full} OR EXISTS (
                                SELECT 1 FROM jsonb_to_recordset(${assignments}::jsonb)
                                    AS a("workspaceId" text, "subjectId" text)
                                WHERE a."workspaceId" = t."workspaceId" AND a."subjectId" = p."subjectId"
                            )
                        )
                    )
                )
        )
        SELECT
            ARRAY(SELECT "id" FROM eligible
                ${reason ? Prisma.sql`WHERE reason = ${reason}` : Prisma.empty}
                ORDER BY CASE reason WHEN 'CHANGED_AFTER_CERTIFICATION' THEN 0 WHEN 'CREATED_BY_SCREEN' THEN 1 ELSE 2 END,
                    overdue DESC, "dueSoon" DESC, priority, "updatedAt", "id" COLLATE "C"
                LIMIT ${limit} OFFSET ${skip}) AS ids,
            (SELECT COUNT(*)::int FROM eligible ${reason ? Prisma.sql`WHERE reason = ${reason}` : Prisma.empty}) AS "filteredTotal",
            COUNT(*)::int AS total,
            (COUNT(*) FILTER (WHERE reason = 'CHANGED_AFTER_CERTIFICATION'))::int AS "changedAfterCertified",
            (COUNT(*) FILTER (WHERE reason = 'CREATED_BY_SCREEN'))::int AS "createdByScreen",
            (COUNT(*) FILTER (WHERE reason = 'OTHER_UNCERTIFIED'))::int AS other,
            (COUNT(*) FILTER (WHERE overdue))::int AS overdue,
            (COUNT(*) FILTER (WHERE "dueSoon"))::int AS "dueSoon"
        FROM eligible
    `;
    return page;
}
