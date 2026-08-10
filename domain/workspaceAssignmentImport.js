const WORKSPACE_ROLES = new Set(["OWNER", "TEACHER", "ASSISTANT", "VIEWER"]);

export function normalizeAssignmentEmail(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeCode(value) {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function validateWorkspaceAssignmentImport(input) {
    const errors = [];
    const warnings = [];
    const rawAssignments = Array.isArray(input?.assignments) ? input.assignments : [];
    if (rawAssignments.length === 0) {
        errors.push({path: "assignments", code: "ASSIGNMENTS_REQUIRED", message: "至少需要一条教师分配"});
    }
    if (rawAssignments.length > 500) {
        errors.push({path: "assignments", code: "TOO_MANY_ASSIGNMENTS", message: "单次最多导入500名教师"});
    }

    const pairRoles = new Map();
    const normalized = [];
    rawAssignments.forEach((item, index) => {
        const email = normalizeAssignmentEmail(item?.email);
        const role = normalizeCode(item?.role || "TEACHER");
        const rawCodes = Array.isArray(item?.workspaceCodes)
            ? item.workspaceCodes
            : Array.isArray(item?.workspaces) ? item.workspaces : [];
        const workspaceCodes = [...new Set(rawCodes.map(normalizeCode).filter(Boolean))];

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            errors.push({path: `assignments[${index}].email`, code: "INVALID_EMAIL", message: "教师邮箱格式无效"});
        }
        if (!WORKSPACE_ROLES.has(role)) {
            errors.push({path: `assignments[${index}].role`, code: "INVALID_WORKSPACE_ROLE", message: "无效的教学空间角色"});
        }
        if (workspaceCodes.length === 0) {
            errors.push({path: `assignments[${index}].workspaceCodes`, code: "WORKSPACES_REQUIRED", message: "至少选择一个教学空间"});
        }

        for (const code of workspaceCodes) {
            const pairKey = `${email}\u0000${code}`;
            const previousRole = pairRoles.get(pairKey);
            if (previousRole && previousRole !== role) {
                errors.push({
                    path: `assignments[${index}].workspaceCodes`,
                    code: "CONFLICTING_ASSIGNMENT_ROLE",
                    message: `${email} 在 ${code} 上出现冲突角色`,
                });
            }
            pairRoles.set(pairKey, role);
        }
        normalized.push({email, role, workspaceCodes});
    });

    const deduplicated = new Map();
    for (const assignment of normalized) {
        const key = `${assignment.email}\u0000${assignment.role}`;
        if (!deduplicated.has(key)) {
            deduplicated.set(key, {...assignment, workspaceCodes: []});
        }
        const target = deduplicated.get(key);
        target.workspaceCodes = [...new Set([...target.workspaceCodes, ...assignment.workspaceCodes])];
    }
    const normalizedAssignments = [...deduplicated.values()];
    const emails = new Set(normalizedAssignments.map((item) => item.email).filter(Boolean));
    const membershipCount = new Set(pairRoles.keys()).size;
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        normalized: {assignments: normalizedAssignments},
        summary: {teachers: emails.size, memberships: membershipCount},
    };
}

export {WORKSPACE_ROLES};
