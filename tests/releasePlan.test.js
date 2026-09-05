import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {resolveRelease} from "../deploy/release-plan.js";

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "classworks-release-"));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const git = (path, ...args) => execFileSync("git", ["-C", path, ...args], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
    const roots = {};
    for (const component of ["backend", "frontend"]) {
        const path = join(root, component); mkdirSync(join(path, "deploy"), {recursive: true});
        git(path, "init"); git(path, "config", "user.email", "release-test@localhost"); git(path, "config", "user.name", "Release Test");
        roots[component + "Root"] = path;
    }
    const commit = (component, contract = {}) => {
        const path = roots[component + "Root"];
        writeFileSync(join(path, "deploy", "compatibility.json"), JSON.stringify({schemaVersion: 1, component, compatibilityEpoch: 1, ...contract}));
        git(path, "add", "."); git(path, "commit", "--allow-empty", "-m", "fixture");
        return git(path, "rev-parse", "HEAD");
    };
    commit("backend"); commit("frontend");
    return {roots, commit, git};
}
test("release resolves immutable commits; later branch movement does not change the plan", (t) => {
    const {roots, commit} = fixture(t);
    const plan = resolveRelease(roots);
    commit("frontend", {compatibilityEpoch: 2});
    assert.match(plan.backend.commit, /^[a-f0-9]{40}$/);
    assert.deepEqual(resolveRelease({...roots, backendRef: plan.backend.commit, frontendRef: plan.frontend.commit}).frontend, plan.frontend);
    assert.throws(() => resolveRelease(roots), /compatibilityEpoch/);
});
test("release rejects mismatched, missing or malformed compatibility contracts", (t) => {
    const {roots, commit, git} = fixture(t);
    commit("frontend", {compatibilityEpoch: 2});
    assert.throws(() => resolveRelease(roots), /compatibilityEpoch/);
    commit("frontend", {component: "backend"});
    assert.throws(() => resolveRelease(roots), /声明无效/);
    git(roots.frontendRoot, "rm", "deploy/compatibility.json"); git(roots.frontendRoot, "commit", "-m", "remove contract");
    assert.throws(() => resolveRelease(roots), /缺少有效/);
});
test("release validates a required peer commit against the selected peer version", (t) => {
    const {roots, commit, git} = fixture(t);
    const old = git(roots.backendRoot, "rev-parse", "HEAD");
    const required = commit("backend");
    commit("frontend", {requiresPeerCommit: required});
    assert.throws(() => resolveRelease({...roots, backendRef: old}), /配套提交/);
    assert.equal(resolveRelease(roots).backend.commit, required);
    commit("frontend", {requiresPeerCommit: "--not-a-sha"});
    assert.throws(() => resolveRelease(roots), /完整提交 SHA/);
});
