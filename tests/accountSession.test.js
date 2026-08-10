import test from "node:test";
import assert from "node:assert/strict";
import {
    generateAccessToken,
    generateRefreshToken,
    hashRefreshToken,
    isLegacyAccountTokenPayload,
    verifyAccessToken,
    verifyRefreshToken,
} from "../utils/tokenManager.js";

const account = {
    id: "account-teacher-1",
    provider: "test",
    email: "teacher@example.com",
    name: "测试教师",
    avatarUrl: null,
    tokenVersion: 1,
};

test("access and refresh tokens retain their independent session id", () => {
    const accessToken = generateAccessToken(account, "session-classroom-a");
    const refreshToken = generateRefreshToken(account, "session-classroom-a");

    assert.equal(verifyAccessToken(accessToken).sessionId, "session-classroom-a");
    assert.equal(verifyRefreshToken(refreshToken).sessionId, "session-classroom-a");
});

test("different teacher devices receive distinguishable refresh credentials", () => {
    const first = generateRefreshToken(account, "session-classroom-a");
    const second = generateRefreshToken(account, "session-classroom-b");

    assert.notEqual(first, second);
    assert.notEqual(hashRefreshToken(first), hashRefreshToken(second));
    assert.match(hashRefreshToken(first), /^[a-f0-9]{64}$/);
});

test("new access tokens can never fall back to the legacy validation path", () => {
    const current = verifyAccessToken(generateAccessToken(account, "session-classroom-a"));
    assert.equal(isLegacyAccountTokenPayload(current), false);
    assert.equal(isLegacyAccountTokenPayload({accountId: account.id, provider: "test"}), true);
});
