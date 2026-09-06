import assert from "node:assert/strict";
import test from "node:test";
import {publicationWeekWindow} from "../domain/publicationWeek.js";

test("ordinary date feeds retain their existing filter", () => {
    assert.equal(publicationWeekWindow(undefined), null);
});
test("board week uses an exclusive date boundary across years", () => {
    const result = publicationWeekWindow("2026-12-28");
    assert.equal(result.where.type, "ASSIGNMENT");
    assert.equal(result.where.boardDate.gte.toISOString(), "2026-12-28T00:00:00.000Z");
    assert.equal(result.where.boardDate.lt.toISOString(), "2027-01-04T00:00:00.000Z");
});
test("deadline week includes earlier-board-date homework due in the China calendar week", () => {
    const result = publicationWeekWindow("2026-09-07", "due");
    assert.equal(result.where.dueAt.gte.toISOString(), "2026-09-06T16:00:00.000Z");
    assert.equal(result.where.dueAt.lt.toISOString(), "2026-09-13T16:00:00.000Z");
    assert.equal(result.where.boardDate, undefined);
});
test("invalid dates and modes cannot silently fall back to today's feed", () => {
    for (const args of [["2026-02-30"], [""], [["2026-09-07"]], ["2026-09-07","bad"], [undefined,"due"]]) {
        assert.throws(() => publicationWeekWindow(...args), {code: "INVALID_PUBLICATION_WEEK", statusCode: 422});
    }
});
