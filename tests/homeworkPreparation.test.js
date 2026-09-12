import {test} from "node:test";
import assert from "node:assert/strict";
import {validatePreparation, withoutPreparation} from "../domain/homeworkPreparation.js";
test("only valid assignment preparation metadata is accepted and date copies clear it", () => {
    for (const preparation of [{text: "圆规", date: "2026-02-30"}, {text: "", date: "2026-09-13"}, {text: "圆".repeat(501), date: "2026-09-13"}, {text: "圆规", date: 20260913}]) {
        const errors = []; validatePreparation({preparation}, "ASSIGNMENT", errors); assert.equal(errors.length, 1);
    }
    const value = {text: "圆规", date: "2026-09-13"}, errors = [];
    validatePreparation({preparation: value}, "ASSIGNMENT", errors); assert.equal(errors.length, 0);
    validatePreparation({preparation: value}, "NOTICE", errors); assert.equal(errors.length, 1);
    assert.deepEqual(withoutPreparation({kind: "NO_HOMEWORK", preparation: value}), {kind: "NO_HOMEWORK"});
});
