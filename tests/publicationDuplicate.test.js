import test from "node:test";
import assert from "node:assert/strict";
import {
    assignmentDuplicateReason,
    findDuplicateAssignmentCandidates,
} from "../domain/publicationDuplicate.js";

test("duplicate assignments ignore punctuation, whitespace and full-width differences", () => {
    assert.equal(assignmentDuplicateReason(
        {content: "完成练习册，第 10～12 页"},
        {content: "完成练习册 第10~12页"},
    ), "CONTENT_MATCH");
});

test("same title with different homework content is not treated as a duplicate", () => {
    assert.equal(assignmentDuplicateReason(
        {title: "今日作业", content: "练习册第10页"},
        {title: "今日作业", content: "练习册第11页"},
    ), null);
});

test("title-only assignments can still be detected", () => {
    assert.equal(assignmentDuplicateReason(
        {title: "背诵第一段", content: ""},
        {title: "背诵第一段", content: ""},
    ), "TITLE_MATCH");
});

test("candidate matching returns only suspected duplicates", () => {
    const duplicates = findDuplicateAssignmentCandidates(
        {content: "完成卷子"},
        [{id: "same", content: "完成卷子"}, {id: "different", content: "预习课文"}],
    );
    assert.deepEqual(duplicates.map((item) => item.candidate.id), ["same"]);
});
