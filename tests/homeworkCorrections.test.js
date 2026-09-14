import {test} from "node:test";
import assert from "node:assert/strict";
import {publicHomeworkCorrection} from "../domain/homeworkCorrections.js";
import {validateSubmission} from "../domain/homeworkInstructions.js";
import {validateHomeworkTemplate} from "../domain/homeworkTemplates.js";
import {summarizePublicationChanges} from "../domain/publicationActionCenter.js";
const row = (revision, content) => ({revision, createdAt: "2026-09-14T01:00:00Z", snapshot: {
    type: "ASSIGNMENT", status: "PUBLISHED", content, publishAt: "2026-09-13T00:00:00Z", targetWorkspaceIds: ["class"],
    contentJson: {correctionReason: "进度调整", privateField: "secret"}, editorAccountId: "private"}});

test("public corrections compare consecutive visible snapshots and expose only safe display fields", () => {
    const before = row(1, "前五题"), after = row(2, "前三题");
    const result = publicHomeworkCorrection(before, after, ["class"]);
    assert.equal(result.before.content, "前五题"); assert.equal(result.after.content, "前三题");
    assert.equal(result.after.correctionReason, "进度调整");
    assert.doesNotMatch(JSON.stringify(result), /private|secret|editorAccountId|targetWorkspaceIds/);
    assert.equal(publicHomeworkCorrection(before, row(3, "三"), ["class"]), null);
    assert.equal(publicHomeworkCorrection(before, after, ["other"]), null);
    assert.equal(publicHomeworkCorrection({...before, purgedAt: new Date()}, after, ["class"]), null);
    for (const status of ["DRAFT", "WITHDRAWN"]) assert.equal(publicHomeworkCorrection({...before, snapshot: {...before.snapshot, status}}, after, ["class"]), null);
    assert.equal(publicHomeworkCorrection(before, {...after, snapshot: {...after.snapshot, targetWorkspaceIds: ["other"]}}, ["class"]), null);
    assert.equal(publicHomeworkCorrection(before, {...after, snapshot: {...after.snapshot, publishAt: "2026-09-15T00:00:00Z"}}, ["class"]), null);
    // A scheduled original version may have been created earlier, but is visible by the correction time.
    assert.ok(publicHomeworkCorrection({...before, createdAt: "2026-09-12T00:00:00Z"}, after, ["class"]));
    assert.equal(publicHomeworkCorrection(before, row(2, "前五题"), ["class"]), null);
});

test("optional homework metadata and templates reject invalid values and no-homework contradictions", () => {
    assert.deepEqual(summarizePublicationChanges({content: "相同"}, {content: "相同", contentJson: {optionalContent: "拓展题"}}),
        [{field: "optionalContent", label: "选做内容", before: "", after: "拓展题"}]);
    for (const optionalContent of [null, 42, {}, "长".repeat(6001)]) {
        const errors = []; validateSubmission({optionalContent}, "ASSIGNMENT", errors); assert.equal(errors.length, 1);
        assert.throws(() => validateHomeworkTemplate({name: "模板", title: "", content: "基础题", optionalContent}));
    }
    for (const [type, metadata] of [["NOTICE", {optionalContent: "拓展题"}], ["ASSIGNMENT", {kind: "NO_HOMEWORK", optionalContent: "拓展题"}]]) {
        const errors = []; validateSubmission(metadata, type, errors); assert.equal(errors.length, 1);
    }
    assert.equal(validateHomeworkTemplate({name: "模板", title: "", content: "基础题", optionalContent: "拓展〔题号〕"}).optionalContent, "拓展〔题号〕");
});
