export function validatePreparation(metadata, type, errors) {
    const value = metadata?.preparation;
    if (value == null) return;
    const validDate = typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date) && value.date >= "2000-01-01"
        && Number.isFinite(Date.parse(`${value.date}T00:00:00Z`)) && new Date(`${value.date}T00:00:00Z`).toISOString().slice(0, 10) === value.date;
    if (type !== "ASSIGNMENT" || typeof value.text !== "string" || !value.text.trim() || value.text.length > 500 || !validDate) {
        errors.push({path: "contentJson.preparation", code: "INVALID_HOMEWORK_PREPARATION", message: "需带物品仅适用于作业，须填写1—500字物品说明及有效的携带日期"});
    }
}

export function withoutPreparation(metadata) {
    if (!metadata || typeof metadata !== "object") return metadata;
    const result = {...metadata};
    delete result.preparation;
    return Object.keys(result).length ? result : null;
}
