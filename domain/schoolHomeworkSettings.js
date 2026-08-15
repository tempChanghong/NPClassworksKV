export const DEFAULT_HOMEWORK_QUICK_DEADLINES = Object.freeze([
    Object.freeze({label: "明早 7:30", dayOffset: 1, time: "07:30"}),
    Object.freeze({label: "明天 12:00", dayOffset: 1, time: "12:00"}),
    Object.freeze({label: "明晚 18:00", dayOffset: 1, time: "18:00"}),
    Object.freeze({label: "后早 7:30", dayOffset: 2, time: "07:30"}),
]);

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function sanitizeHomeworkQuickDeadlines(value, {strict = false} = {}) {
    if (value == null && !strict) return DEFAULT_HOMEWORK_QUICK_DEADLINES.map((item) => ({...item}));
    if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
        if (strict) throw new Error("快捷截止时间必须包含1至8项");
        return DEFAULT_HOMEWORK_QUICK_DEADLINES.map((item) => ({...item}));
    }

    const normalized = value.map((item) => ({
        label: typeof item?.label === "string" ? item.label.trim() : "",
        dayOffset: Number(item?.dayOffset),
        time: typeof item?.time === "string" ? item.time.trim() : "",
    }));
    const invalid = normalized.some((item) => (
        !item.label || item.label.length > 16 ||
        !Number.isInteger(item.dayOffset) || item.dayOffset < 0 || item.dayOffset > 14 ||
        !TIME_PATTERN.test(item.time)
    ));
    if (invalid) {
        if (strict) throw new Error("快捷截止时间名称、日期偏移或时间格式无效");
        return DEFAULT_HOMEWORK_QUICK_DEADLINES.map((item) => ({...item}));
    }
    return normalized;
}
