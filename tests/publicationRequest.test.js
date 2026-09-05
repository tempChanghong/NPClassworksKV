import test from "node:test";
import assert from "node:assert/strict";
import {screenPublicationRequest} from "../domain/publicationRequest.js";

test("screen creation keys are validated while legacy clients remain supported", () => {
    assert.equal(screenPublicationRequest({content: "legacy"}), null);
    for (const id of [null, 42, "", "a".repeat(101), "bad key"]) {
        assert.throws(() => screenPublicationRequest({clientRequestId: id}), {code: "INVALID_PUBLICATION_REQUEST_ID"});
    }
});

test("request hashing ignores object key order and duplicate confirmation but detects content changes", () => {
    const first = screenPublicationRequest({clientRequestId: "request-1", content: "作业", contentJson: {a: 1, b: 2}});
    const retry = screenPublicationRequest({allowDuplicate: true, contentJson: {b: 2, a: 1}, content: "作业", clientRequestId: "request-1"});
    assert.deepEqual(retry, first);
    assert.notEqual(screenPublicationRequest({clientRequestId: "request-1", content: "修改"}).hash, first.hash);
});
