import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {getLocalLoginSourceKey} from "../middleware/rateLimiter.js";

function request({deviceId = "", ip = "192.0.2.10", schoolCode = "TJ2", username = "teacher"} = {}) {
    return {
        ip,
        connection: {},
        socket: {},
        headers: deviceId ? {"x-classworks-device-id": deviceId} : {},
        body: {schoolCode, username},
    };
}

test("local login throttling isolates devices using the same account and public IP", () => {
    const first = getLocalLoginSourceKey(request({deviceId: "device-classroom-a"}));
    const second = getLocalLoginSourceKey(request({deviceId: "device-teacher-phone"}));
    assert.notEqual(first, second);
});

test("local login throttling isolates accounts on the same device", () => {
    const first = getLocalLoginSourceKey(request({deviceId: "device-classroom-a", username: "teacher-a"}));
    const second = getLocalLoginSourceKey(request({deviceId: "device-classroom-a", username: "teacher-b"}));
    assert.notEqual(first, second);
});

test("local login throttling falls back to the request IP without a device id", () => {
    const key = getLocalLoginSourceKey(request({deviceId: ""}));
    assert.match(key, /ip-192\.0\.2\.10/);
});

test("teacher login no longer rejects or locks an account globally after failures", () => {
    const source = fs.readFileSync(new URL("../services/localAccountService.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /account\?\.localLockedUntil/);
    assert.doesNotMatch(source, /registerFailure/);
});
