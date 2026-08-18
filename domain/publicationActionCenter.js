export const ACTION_REQUIRED_REASONS = Object.freeze({
    CHANGED_AFTER_CERTIFICATION: "CHANGED_AFTER_CERTIFICATION",
    CREATED_BY_SCREEN: "CREATED_BY_SCREEN",
    OTHER_UNCERTIFIED: "OTHER_UNCERTIFIED",
});

const DIFF_FIELDS = Object.freeze([
    ["title", "标题"],
    ["content", "作业内容"],
    ["subjectId", "科目"],
    ["boardDate", "作业板日期"],
    ["dueAt", "截止时间"],
    ["publishAt", "发布时间"],
    ["expiresAt", "通知有效期"],
    ["priority", "优先级"],
    ["targetWorkspaceIds", "发布目标"],
]);

function normalizedValue(value) {
    if (Array.isArray(value)) return [...value].sort();
    return value ?? null;
}

function valuesEqual(left, right) {
    return JSON.stringify(normalizedValue(left)) === JSON.stringify(normalizedValue(right));
}

export function currentPublicationSnapshot(publication) {
    const dateValue = (value) => value ? new Date(value).toISOString() : null;
    const boardDateValue = publication.boardDate
        ? (publication.boardDate instanceof Date
            ? publication.boardDate.toISOString().slice(0, 10)
            : String(publication.boardDate).slice(0, 10))
        : null;
    return {
        type: publication.type,
        subjectId: publication.subjectId,
        title: publication.title,
        content: publication.content,
        contentJson: publication.contentJson ?? null,
        boardDate: boardDateValue,
        publishAt: dateValue(publication.publishAt),
        dueAt: dateValue(publication.dueAt),
        expiresAt: dateValue(publication.expiresAt),
        priority: publication.priority,
        status: publication.status,
        targetWorkspaceIds: (publication.targets || []).map((target) => target.workspaceId),
    };
}

export function summarizePublicationChanges(previousSnapshot, currentSnapshot) {
    if (!previousSnapshot) return [];
    return DIFF_FIELDS
        .filter(([key]) => !valuesEqual(previousSnapshot[key], currentSnapshot[key]))
        .map(([key, label]) => ({
            field: key,
            label,
            before: previousSnapshot[key] ?? null,
            after: currentSnapshot[key] ?? null,
        }));
}

export function classifyActionRequiredPublication(publication, {now = new Date(), dueSoonHours = 24} = {}) {
    const lastCertifiedRevision = publication.revisions?.[0] || null;
    const reason = lastCertifiedRevision
        ? ACTION_REQUIRED_REASONS.CHANGED_AFTER_CERTIFICATION
        : publication.latestActorType === "CLASSROOM_SCREEN"
            ? ACTION_REQUIRED_REASONS.CREATED_BY_SCREEN
            : ACTION_REQUIRED_REASONS.OTHER_UNCERTIFIED;
    const dueTime = publication.dueAt ? new Date(publication.dueAt).getTime() : null;
    const nowTime = now.getTime();
    const overdue = Number.isFinite(dueTime) && dueTime <= nowTime;
    const dueSoon = Number.isFinite(dueTime)
        && dueTime > nowTime
        && dueTime <= nowTime + dueSoonHours * 60 * 60 * 1000;
    const currentSnapshot = currentPublicationSnapshot(publication);

    return {
        id: `${publication.id}:${publication.revision}:${reason}`,
        reason,
        severity: reason === ACTION_REQUIRED_REASONS.CHANGED_AFTER_CERTIFICATION || overdue
            ? "HIGH"
            : dueSoon || publication.priority === "URGENT" ? "MEDIUM" : "NORMAL",
        overdue,
        dueSoon,
        publication: {...publication, revisions: undefined},
        lastCertifiedRevision,
        changedFields: summarizePublicationChanges(lastCertifiedRevision?.snapshot, currentSnapshot),
    };
}

const REASON_ORDER = Object.freeze({
    [ACTION_REQUIRED_REASONS.CHANGED_AFTER_CERTIFICATION]: 0,
    [ACTION_REQUIRED_REASONS.CREATED_BY_SCREEN]: 1,
    [ACTION_REQUIRED_REASONS.OTHER_UNCERTIFIED]: 2,
});

const PRIORITY_ORDER = Object.freeze({URGENT: 0, IMPORTANT: 1, NORMAL: 2});

export function compareActionRequiredItems(left, right) {
    const reasonDifference = REASON_ORDER[left.reason] - REASON_ORDER[right.reason];
    if (reasonDifference) return reasonDifference;
    if (left.overdue !== right.overdue) return left.overdue ? -1 : 1;
    if (left.dueSoon !== right.dueSoon) return left.dueSoon ? -1 : 1;
    const priorityDifference = (PRIORITY_ORDER[left.publication.priority] ?? 3)
        - (PRIORITY_ORDER[right.publication.priority] ?? 3);
    if (priorityDifference) return priorityDifference;
    return new Date(left.publication.updatedAt).getTime() - new Date(right.publication.updatedAt).getTime();
}
