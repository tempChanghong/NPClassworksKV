const DELIVERY_MODES = new Set(["ADMIN_CLASS", "COURSE_GROUP"]);

function cleanText(value) {
    return typeof value === "string" ? value.trim() : "";
}

export function normalizeWorkspaceCode(value) {
    return cleanText(value).toUpperCase();
}

export function validateWorkspaceCode(value) {
    return /^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(normalizeWorkspaceCode(value));
}

export function normalizeSubjectRules(value) {
    if (!Array.isArray(value)) return {valid: false, errors: ["授课规则必须是数组"], rules: []};
    const errors = [];
    const seen = new Set();
    const rules = [];
    value.forEach((item, index) => {
        const subjectId = cleanText(item?.subjectId);
        const deliveryMode = cleanText(item?.deliveryMode).toUpperCase();
        if (!subjectId) errors.push(`第${index + 1}条规则缺少科目`);
        if (!DELIVERY_MODES.has(deliveryMode)) {
            errors.push(`第${index + 1}条规则的授课方式无效`);
        }
        if (seen.has(subjectId)) errors.push(`科目 ${subjectId} 重复配置`);
        if (subjectId) seen.add(subjectId);
        rules.push({
            subjectId,
            deliveryMode,
            isCompulsory: item?.isCompulsory === undefined
                ? deliveryMode === "ADMIN_CLASS"
                : Boolean(item.isCompulsory),
        });
    });
    return {valid: errors.length === 0, errors, rules};
}

export function normalizeSourceClassIds(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(cleanText).filter(Boolean))];
}

export function validateCourseGroupFields({code, name, subjectId, sourceClassIds}) {
    const errors = [];
    if (!validateWorkspaceCode(code)) errors.push("教学班代码需为2至64位字母、数字、点、横线或下划线");
    const cleanName = cleanText(name);
    if (!cleanName || cleanName.length > 191) errors.push("教学班名称不能为空且不能超过191个字符");
    if (!cleanText(subjectId)) errors.push("必须选择科目");
    if (normalizeSourceClassIds(sourceClassIds).length === 0) errors.push("至少选择一个来源行政班");
    return errors;
}

export function validateGradeFields({code, name, sortOrder}) {
    const errors = [];
    if (!validateWorkspaceCode(code)) errors.push("年级代码需为2至64位字母、数字、点、横线或下划线");
    const cleanName = cleanText(name);
    if (!cleanName || cleanName.length > 191) errors.push("年级名称不能为空且不能超过191个字符");
    if (!Number.isInteger(Number(sortOrder)) || Number(sortOrder) < -10000 || Number(sortOrder) > 10000) {
        errors.push("年级排序必须是 -10000 至 10000 之间的整数");
    }
    return errors;
}

export function validateAdministrativeClassFields({code, name, gradeId}) {
    const errors = [];
    if (!validateWorkspaceCode(code)) errors.push("行政班代码需为2至64位字母、数字、点、横线或下划线");
    const cleanName = cleanText(name);
    if (!cleanName || cleanName.length > 191) errors.push("行政班名称不能为空且不能超过191个字符");
    if (!cleanText(gradeId)) errors.push("必须选择所属年级");
    return errors;
}
