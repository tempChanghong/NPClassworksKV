import assert from "node:assert/strict";
import test from "node:test";
import {assertCanBootstrapSchool} from "../services/academicAuthorizationService.js";

function clientFor(account) {
    return {
        school: {count: async () => 0},
        account: {findUnique: async () => account},
    };
}

test("an empty instance requires the one-time local bootstrap administrator", async () => {
    const previous = process.env.ALLOW_OAUTH_BOOTSTRAP;
    delete process.env.ALLOW_OAUTH_BOOTSTRAP;
    try {
        await assert.rejects(
            assertCanBootstrapSchool("oauth-account", clientFor({provider: "github", providerData: {}})),
            (error) => error.code === "LOCAL_BOOTSTRAP_REQUIRED",
        );
        await assert.doesNotReject(assertCanBootstrapSchool("local-admin", clientFor({
            provider: "school-local",
            providerData: {bootstrapAdministrator: true},
        })));
    } finally {
        if (previous === undefined) delete process.env.ALLOW_OAUTH_BOOTSTRAP;
        else process.env.ALLOW_OAUTH_BOOTSTRAP = previous;
    }
});

test("legacy deployments may explicitly allow OAuth bootstrap", async () => {
    const previous = process.env.ALLOW_OAUTH_BOOTSTRAP;
    process.env.ALLOW_OAUTH_BOOTSTRAP = "true";
    try {
        await assert.doesNotReject(assertCanBootstrapSchool(
            "oauth-account",
            clientFor({provider: "github", providerData: {}}),
        ));
    } finally {
        if (previous === undefined) delete process.env.ALLOW_OAUTH_BOOTSTRAP;
        else process.env.ALLOW_OAUTH_BOOTSTRAP = previous;
    }
});
