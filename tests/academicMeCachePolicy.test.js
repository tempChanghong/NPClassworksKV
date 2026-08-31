import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const routes = readFileSync(new URL("../routes/v2/academic-me.js", import.meta.url), "utf8");

test("account academic context is never stored by shared caches", () => {
    assert.match(routes, /Cache-Control["'],\s*["']private, no-store/);
    assert.match(routes, /res\.vary\(["']Authorization["']\)/);
    assert.ok(
        routes.indexOf('router.use((req, res, next)') < routes.indexOf('router.get("/schools"'),
        "no-store middleware must run before academic context routes",
    );
});
