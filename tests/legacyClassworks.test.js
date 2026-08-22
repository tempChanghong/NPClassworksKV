import test from "node:test";
import assert from "node:assert/strict";
import {isLegacyClassworksEnabled} from "../utils/legacyClassworks.js";

test("legacy Classworks APIs default to disabled in production", () => {
    assert.equal(isLegacyClassworksEnabled({NODE_ENV: "production"}), false);
});

test("legacy Classworks APIs remain available for development", () => {
    assert.equal(isLegacyClassworksEnabled({NODE_ENV: "development"}), true);
});

test("legacy Classworks APIs require an explicit production opt-in", () => {
    assert.equal(isLegacyClassworksEnabled({NODE_ENV: "production", ENABLE_LEGACY_CLASSWORKS_API: "true"}), true);
    assert.equal(isLegacyClassworksEnabled({NODE_ENV: "development", ENABLE_LEGACY_CLASSWORKS_API: "false"}), false);
});
