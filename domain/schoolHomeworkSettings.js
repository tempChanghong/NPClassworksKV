export const DEFAULT_HOMEWORK_QUICK_DEADLINES = Object.freeze([
    Object.freeze({label: "明早 7:30", dayOffset: 1, time: "07:30"}),
    Object.freeze({label: "明天 12:00", dayOffset: 1, time: "12:00"}),
    Object.freeze({label: "明晚 18:00", dayOffset: 1, time: "18:00"}),
    Object.freeze({label: "后早 7:30", dayOffset: 2, time: "07:30"}),
    Object.freeze({label: "下周一 7:30", dateRule: "next-weekday", weekday: 1, time: "07:30"}),
]);

export const DEFAULT_HOMEWORK_QUICK_INPUTS = Object.freeze([
    Object.freeze({label: "完成", text: "完成", group: "动作", subjectIds: [], insertMode: "INLINE"}),
    Object.freeze({label: "预习", text: "预习", group: "动作", subjectIds: [], insertMode: "INLINE"}),
    Object.freeze({label: "复习", text: "复习", group: "动作", subjectIds: [], insertMode: "INLINE"}),
    Object.freeze({label: "背诵", text: "背诵", group: "动作", subjectIds: [], insertMode: "INLINE"}),
    Object.freeze({label: "订正", text: "订正", group: "动作", subjectIds: [], insertMode: "INLINE"}),
    Object.freeze({label: "课本", text: "课本", group: "材料", subjectIds: [], insertMode: "INLINE"}),
    Object.freeze({label: "练习册", text: "练习册", group: "材料", subjectIds: [], insertMode: "INLINE"}),
    Object.freeze({label: "第", text: "第", group: "范围", subjectIds: [], insertMode: "INLINE"}),
    Object.freeze({label: "至", text: "至", group: "范围", subjectIds: [], insertMode: "INLINE"}),
    Object.freeze({label: "页", text: "页", group: "范围", subjectIds: [], insertMode: "INLINE"}),
    Object.freeze({label: "题", text: "题", group: "范围", subjectIds: [], insertMode: "INLINE"}),
    Object.freeze({label: "换行", text: "", group: "排版", subjectIds: [], insertMode: "NEW_LINE"}),
]);

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function sanitizeHomeworkQuickDeadlines(value, {strict = false} = {}) {
    if (value == null && !strict) return DEFAULT_HOMEWORK_QUICK_DEADLINES.map((item) => ({...item}));
    if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
        if (strict) throw new Error("快捷截止时间必须包含1至8项");
        return DEFAULT_HOMEWORK_QUICK_DEADLINES.map((item) => ({...item}));
    }

    const normalized = value.map((item) => {
        const common = {
            label: typeof item?.label === "string" ? item.label.trim() : "",
            time: typeof item?.time === "string" ? item.time.trim() : "",
        };
        if (item?.dateRule === "next-weekday") {
            return {...common, dateRule: "next-weekday", weekday: Number(item.weekday)};
        }
        return {...common, dayOffset: Number(item?.dayOffset)};
    });
    const invalid = normalized.some((item) => (
        !item.label || item.label.length > 16 ||
        (item.dateRule === "next-weekday"
            ? !Number.isInteger(item.weekday) || item.weekday < 0 || item.weekday > 6
            : !Number.isInteger(item.dayOffset) || item.dayOffset < 0 || item.dayOffset > 14) ||
        !TIME_PATTERN.test(item.time)
    ));
    if (invalid) {
        if (strict) throw new Error("快捷截止时间名称、日期偏移或时间格式无效");
        return DEFAULT_HOMEWORK_QUICK_DEADLINES.map((item) => ({...item}));
    }
    return normalized;
}

export function sanitizeHomeworkQuickInputs(value, {strict = false} = {}) {
    if (value == null && !strict) return DEFAULT_HOMEWORK_QUICK_INPUTS.map((item) => ({...item, subjectIds: []}));
    if (!Array.isArray(value) || value.length > 64) {
        if (strict) throw new Error("作业快捷词必须包含0至64项");
        return DEFAULT_HOMEWORK_QUICK_INPUTS.map((item) => ({...item, subjectIds: []}));
    }
    const normalized = value.map((item) => ({
        label: typeof item?.label === "string" ? item.label.trim() : "",
        text: typeof item?.text === "string" ? item.text.trim() : "",
        group: typeof item?.group === "string" ? item.group.trim() : "",
        subjectIds: [...new Set(Array.isArray(item?.subjectIds)
            ? item.subjectIds.filter((id) => typeof id === "string").map((id) => id.trim()).filter(Boolean)
            : [])],
        insertMode: item?.insertMode === "NEW_LINE" ? "NEW_LINE" : "INLINE",
    }));
    const invalid = normalized.some((item) => (
        !item.label || item.label.length > 16 || item.text.length > 120 || item.group.length > 16 ||
        item.subjectIds.length > 32 || item.subjectIds.some((id) => id.length > 191) ||
        (item.insertMode === "INLINE" && !item.text)
    ));
    if (invalid) {
        if (strict) throw new Error("快捷词名称、插入内容、分组或适用学科无效");
        return DEFAULT_HOMEWORK_QUICK_INPUTS.map((item) => ({...item, subjectIds: []}));
    }
    return normalized;
}
