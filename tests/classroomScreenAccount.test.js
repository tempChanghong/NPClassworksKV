import assert from "node:assert/strict";
import test from "node:test";
import {
    normalizeScreenLoginCode,
    validateDeviceFingerprint,
    validateScreenLoginCode,
    validateScreenPin,
} from "../domain/classroomScreenAccount.js";

test("screen login codes are normalized and constrained", () => {
    assert.equal(normalizeScreenLoginCode(" g2-c1-screen "), "G2-C1-SCREEN");
    assert.equal(validateScreenLoginCode("G2-C1-SCREEN"), true);
    assert.equal(validateScreenLoginCode("x"), false);
    assert.equal(validateScreenLoginCode("screen account"), false);
});

test("screen PIN and device fingerprints reject malformed values", () => {
    assert.equal(validateScreenPin("260101"), true);
    assert.equal(validateScreenPin("123"), false);
    assert.equal(validateScreenPin("12ab56"), false);
    assert.equal(validateDeviceFingerprint("browser-device-id"), true);
    assert.equal(validateDeviceFingerprint("unknown"), false);
});
