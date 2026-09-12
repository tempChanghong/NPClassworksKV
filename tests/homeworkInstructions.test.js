import {test} from "node:test";
import assert from "node:assert/strict";
import {validateSubmission, withoutCorrection, withCorrection} from "../domain/homeworkInstructions.js";
import {validateHomeworkTemplate} from "../domain/homeworkTemplates.js";
import {validatePublicationSnapshot} from "../domain/publication.js";

test("submission metadata and template limits reject malformed values while reasons remain edit-scoped", () => {
    for (const submission of [12, {}, [], "长".repeat(501)]) {
        const errors = []; validateSubmission({submission}, "ASSIGNMENT", errors); assert.equal(errors.length, 1);
        assert.throws(() => validateHomeworkTemplate({name: "模板", title: "练习", content: "五题", submission}));
    }
    const errors = []; validateSubmission({submission: "交给课代表"}, "NOTICE", errors); assert.equal(errors.length, 1);
    validateSubmission({kind: "NO_HOMEWORK", submission: "交给课代表"}, "ASSIGNMENT", errors); assert.equal(errors.length, 2);
    const metadata = {submission: "交给课代表", correctionReason: "上次原因"};
    assert.deepEqual(withoutCorrection(metadata), {submission: "交给课代表"});
    assert.deepEqual(withCorrection(metadata, undefined, true), {submission: "交给课代表"});
    assert.deepEqual(withCorrection(metadata, " 新原因 ", true), {submission: "交给课代表", correctionReason: "新原因"});
    assert.throws(() => withCorrection(metadata, "原因", false), /已发布/);
    assert.throws(() => withCorrection(metadata, "长".repeat(301), true), /300/);
    assert.throws(() => withCorrection(metadata, {}, true), /300/);
    assert.equal(metadata.correctionReason, "上次原因");
    const normalized = validatePublicationSnapshot({input: {type: "ASSIGNMENT", contentJson: metadata}, workspaces: []}).normalized;
    assert.equal(normalized.contentJson.correctionReason, undefined);
    assert.equal(normalized.contentJson.submission, "交给课代表");
    const template = validateHomeworkTemplate({name: "模板", title: "练习", content: "五题", submission: "交给〔课代表〕", correctionReason: "不能套用"});
    assert.equal(template.submission, "交给〔课代表〕"); assert.equal(template.correctionReason, undefined);
});
