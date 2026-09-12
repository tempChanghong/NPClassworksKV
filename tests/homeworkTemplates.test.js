import {test} from "node:test";
import assert from "node:assert/strict";
import {validateHomeworkTemplate} from "../domain/homeworkTemplates.js";

test("templates allow only trimmed name/title/content and bounded named placeholders", () => {
    assert.deepEqual(validateHomeworkTemplate({name: " 模板 ", title: "", content: "练习〔页码〕", accountId: "other", revision: 999, dueAt: "old"}),
        {name: "模板", title: "", content: "练习〔页码〕"});
    for (const input of [null, {}, {name: "", title: "", content: "x"}, {name: "x", title: "", content: ""},
        {name: "x", title: "x".repeat(192), content: "x"}, {name: "x", title: "", content: "x".repeat(6001)},
        {name: "x", title: "", content: "〔未闭合"}, {name: "x", title: "", content: "〔 〕"}]) {
        assert.throws(() => validateHomeworkTemplate(input), {statusCode: 422});
    }
});
