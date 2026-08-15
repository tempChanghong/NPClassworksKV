import test from "node:test";
import assert from "node:assert/strict";
import {normalizeNotificationDeliveryItems} from "../domain/notificationDelivery.js";

test("notification delivery acknowledgement also implies display", () => {
    assert.deepEqual(normalizeNotificationDeliveryItems([{
        publicationId: "notice-a",
        revision: "2",
        acknowledged: true,
    }]), [{
        publicationId: "notice-a",
        revision: 2,
        displayed: true,
        acknowledged: true,
    }]);
});

test("notification delivery normalization rejects invalid records and enforces its limit", () => {
    const valid = Array.from({length: 105}, (_, index) => ({
        publicationId: `notice-${index}`,
        revision: 1,
    }));
    const result = normalizeNotificationDeliveryItems([
        {publicationId: "", revision: 1},
        {publicationId: "invalid", revision: 0},
        ...valid,
    ]);
    assert.equal(result.length, 100);
    assert.equal(result[0].publicationId, "notice-0");
});
