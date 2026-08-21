const ACTIVE_TEACHING_POSITIONS = new Set(["PRIMARY", "CO_TEACHER"]);

export function normalizeTeachingAssignmentInput(input = {}) {
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    const subjectId = typeof input.subjectId === "string" ? input.subjectId.trim() : "";
    const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
    const position = typeof input.position === "string" ? input.position.trim().toUpperCase() : "PRIMARY";
    const errors = [];
    if (!workspaceId) errors.push({path: "workspaceId", message: "必须选择行政班或走班教学班"});
    if (!subjectId) errors.push({path: "subjectId", message: "必须选择任教学科"});
    if (!accountId) errors.push({path: "accountId", message: "必须选择教师"});
    if (!ACTIVE_TEACHING_POSITIONS.has(position)) {
        errors.push({path: "position", message: "任课身份必须是主讲教师或协同教师"});
    }
    return {valid: errors.length === 0, errors, value: {workspaceId, subjectId, accountId, position}};
}

export function normalizeTeachingAssignmentBatchInput(input = {}) {
    const single = normalizeTeachingAssignmentInput({
        ...input,
        workspaceId: Array.isArray(input.workspaceIds) ? input.workspaceIds[0] : "",
    });
    const workspaceIds = [...new Set((Array.isArray(input.workspaceIds) ? input.workspaceIds : [])
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean))];
    const errors = single.errors.filter((item) => item.path !== "workspaceId");
    if (!workspaceIds.length) errors.unshift({path: "workspaceIds", message: "必须选择至少一个教学单元"});
    if (workspaceIds.length > 64) errors.push({path: "workspaceIds", message: "一次最多分配64个教学单元"});
    return {
        valid: errors.length === 0,
        errors,
        value: {
            workspaceIds,
            subjectId: single.value.subjectId,
            accountId: single.value.accountId,
            position: single.value.position,
        },
    };
}

function diagnostic(code, severity, message, context = {}) {
    return {code, severity, message, ...context};
}

export function buildTeachingRelationshipDiagnostics({administrativeClasses = [], courseGroups = []} = {}) {
    const diagnostics = [];
    const classesById = new Map(administrativeClasses.map((item) => [item.id, item]));

    for (const administrativeClass of administrativeClasses.filter((item) => item.isActive !== false)) {
        for (const rule of administrativeClass.subjectRules || []) {
            const context = {
                gradeId: administrativeClass.gradeId,
                administrativeClassId: administrativeClass.id,
                workspaceId: administrativeClass.id,
                subjectId: rule.subjectId,
            };
            if (rule.deliveryMode === "ADMIN_CLASS" && !(rule.assignments || []).some((item) => item.isActive !== false)) {
                diagnostics.push(diagnostic(
                    "ADMIN_CLASS_SUBJECT_WITHOUT_TEACHER",
                    "WARNING",
                    `${administrativeClass.name}的${rule.subject?.name || "该科目"}随行政班授课，但尚未明确任课教师`,
                    context,
                ));
            }
            const primaryCount = (rule.assignments || []).filter(
                (item) => item.isActive !== false && item.position === "PRIMARY",
            ).length;
            if (rule.deliveryMode === "ADMIN_CLASS" && primaryCount > 1) {
                diagnostics.push(diagnostic(
                    "MULTIPLE_PRIMARY_TEACHERS",
                    "WARNING",
                    `${administrativeClass.name}的${rule.subject?.name || "该科目"}有 ${primaryCount} 位主讲教师，请确认是否符合实际安排`,
                    context,
                ));
            }
            if (rule.deliveryMode === "COURSE_GROUP") {
                const coveringGroups = courseGroups.filter((group) => group.isActive !== false &&
                    group.subjectId === rule.subjectId &&
                    (group.sourceClasses || []).some((source) => source.administrativeClassId === administrativeClass.id));
                if (coveringGroups.length === 0) {
                    diagnostics.push(diagnostic(
                        "WALKING_SUBJECT_WITHOUT_GROUP",
                        "ERROR",
                        `${administrativeClass.name}的${rule.subject?.name || "该科目"}设置为走班，但没有走班教学班覆盖`,
                        context,
                    ));
                }
            }
        }
        for (const assignment of administrativeClass.assignments || []) {
            const matchingRule = administrativeClass.subjectRules?.find((rule) =>
                rule.subjectId === assignment.subjectId && rule.deliveryMode === "ADMIN_CLASS");
            if (!matchingRule && assignment.isActive !== false) {
                diagnostics.push(diagnostic(
                    "TEACHING_ASSIGNMENT_SUBJECT_CONFLICT",
                    "ERROR",
                    `${administrativeClass.name}存在与当前授课规则不一致的任课关系`,
                    {
                        gradeId: administrativeClass.gradeId,
                        administrativeClassId: administrativeClass.id,
                        workspaceId: administrativeClass.id,
                        subjectId: assignment.subjectId,
                        accountId: assignment.accountId,
                    },
                ));
            }
        }
    }

    for (const group of courseGroups.filter((item) => item.isActive !== false)) {
        const context = {gradeId: group.gradeId, workspaceId: group.id, subjectId: group.subjectId};
        if (!(group.sourceClasses || []).length) {
            diagnostics.push(diagnostic(
                "COURSE_GROUP_WITHOUT_SOURCE",
                "ERROR",
                `${group.name}没有来源行政班`,
                context,
            ));
        }
        if (!(group.assignments || []).some((item) => item.isActive !== false)) {
            diagnostics.push(diagnostic(
                "COURSE_GROUP_WITHOUT_TEACHER",
                "WARNING",
                `${group.name}尚未明确任课教师`,
                context,
            ));
        }
        const primaryCount = (group.assignments || []).filter(
            (item) => item.isActive !== false && item.position === "PRIMARY",
        ).length;
        if (primaryCount > 1) {
            diagnostics.push(diagnostic(
                "MULTIPLE_PRIMARY_TEACHERS",
                "WARNING",
                `${group.name}有 ${primaryCount} 位主讲教师，请确认是否符合实际安排`,
                context,
            ));
        }
        for (const source of group.sourceClasses || []) {
            const administrativeClass = classesById.get(source.administrativeClassId);
            const matchingRule = administrativeClass?.subjectRules?.find((rule) => rule.subjectId === group.subjectId);
            if (!administrativeClass || matchingRule?.deliveryMode !== "COURSE_GROUP") {
                diagnostics.push(diagnostic(
                    "COURSE_GROUP_SOURCE_CONFLICT",
                    "ERROR",
                    `${group.name}的来源班级${administrativeClass?.name || "已不存在"}没有将该科设置为走班`,
                    {...context, administrativeClassId: source.administrativeClassId},
                ));
            }
        }
    }

    const allAssignments = [
        ...administrativeClasses.flatMap((item) => item.assignments ||
            (item.subjectRules || []).flatMap((rule) => rule.assignments || [])),
        ...courseGroups.flatMap((item) => item.assignments || []),
    ];
    for (const assignment of allAssignments.filter((item) => item.isActive !== false)) {
        if (assignment.account?.localDisabled) {
            diagnostics.push(diagnostic(
                "DISABLED_TEACHER_ASSIGNED",
                "WARNING",
                `${assignment.account.name || assignment.account.localUsername || "已停用教师"}仍有任课安排`,
                {workspaceId: assignment.workspaceId, subjectId: assignment.subjectId, accountId: assignment.accountId},
            ));
        }
        if (assignment.hasWorkspaceAccess === false) {
            diagnostics.push(diagnostic(
                "TEACHER_ACCESS_MISSING",
                "ERROR",
                `${assignment.account?.name || assignment.account?.localUsername || "教师"}缺少对应教学空间权限`,
                {workspaceId: assignment.workspaceId, subjectId: assignment.subjectId, accountId: assignment.accountId},
            ));
        }
    }

    return diagnostics;
}
