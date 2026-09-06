import {parseBoardDate} from "./publication.js";

export function publicationWeekWindow(weekStart, weekView = "board") {
    if (weekStart === undefined) {
        if (weekView !== "board") throw invalidWeek();
        return null;
    }
    const errors = [];
    const start = parseBoardDate(weekStart, errors, {required: true});
    if (!start || errors.length || !["board", "due"].includes(weekView)) throw invalidWeek();
    const end = new Date(start.getTime() + 7 * 86400000);
    // Board dates are UTC date-only columns; deadlines are instants in the school's China time zone.
    const offset = weekView === "due" ? 8 * 3600000 : 0;
    return {
        weekStart: start.toISOString().slice(0, 10), weekView,
        where: {type: "ASSIGNMENT", [weekView === "due" ? "dueAt" : "boardDate"]: {
            gte: new Date(start.getTime() - offset), lt: new Date(end.getTime() - offset),
        }},
    };
}
function invalidWeek() {
    return Object.assign(new Error("一周查询需要有效的开始日期，以及 board 或 due 查看方式"), {
        code: "INVALID_PUBLICATION_WEEK", statusCode: 422,
    });
}
