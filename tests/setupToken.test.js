import test from "node:test";
import assert from "node:assert/strict";
import {createSetupToken, setupKeyMatches, verifySetupToken} from "../utils/setupToken.js";

test("初始化密钥只换取有限时长且有用途限制的会话", () => {
    const previous = process.env.BOOTSTRAP_SETUP_KEY;
    process.env.BOOTSTRAP_SETUP_KEY = "test-setup-key-with-at-least-thirty-two-characters";
    try {
        assert.equal(setupKeyMatches(process.env.BOOTSTRAP_SETUP_KEY), true);
        assert.equal(setupKeyMatches("wrong"), false);
        const issued = createSetupToken(1_000_000);
        const payload = verifySetupToken(issued.token, 1_001_000);
        assert.equal(payload.purpose, "classworks-instance-setup");
        assert.equal(issued.expiresIn, 900);
        assert.throws(() => verifySetupToken(`${issued.token}x`, 1_001_000));
        assert.throws(() => verifySetupToken(issued.token, 1_901_000));
    } finally {
        if (previous === undefined) delete process.env.BOOTSTRAP_SETUP_KEY;
        else process.env.BOOTSTRAP_SETUP_KEY = previous;
    }
});
