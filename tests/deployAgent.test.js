import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, writeFile, rm} from "node:fs/promises";
import {existsSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {
    createDeployAgent,
    createRequestAuthenticator,
    signDeployRequest,
    createDeploymentRunner,
    parseDeployRequest,
} from "../deploy/agent/server.js";

const secret = "test-secret-that-is-at-least-thirty-two-bytes-long";
const nowMs = 1_800_000_000_000;
const backendCommit = "a".repeat(40);
const frontendCommit = "b".repeat(40);
const deployment = {action: "upgrade", repository: "tempChanghong/NPClassworksKV", commit: backendCommit, backendCommit, frontendCommit, runId: "42"};

test("部署请求必须绑定合法仓库和完整的测试提交对", () => {
    assert.deepEqual(parseDeployRequest(Buffer.from(JSON.stringify(deployment))), deployment);
    const frontend = {...deployment, repository: "tempChanghong/NPClassworks", commit: frontendCommit};
    assert.deepEqual(parseDeployRequest(Buffer.from(JSON.stringify(frontend))), frontend);
    for (const input of [
        {action: "upgrade"}, {...deployment, backendCommit: null}, {...deployment, frontendCommit: "main"},
        {...deployment, frontendCommit: "B".repeat(40)}, {...deployment, backendCommit: "abc123"},
        {...deployment, repository: "other/NPClassworksKV"}, {...deployment, commit: frontendCommit},
        {...deployment, frontendCommit: "$(touch injected)"}, {...frontend, commit: backendCommit},
    ]) assert.throws(() => parseDeployRequest(Buffer.from(JSON.stringify(input))));
});

test("测试提交对被签名覆盖，修改其中一个提交无法通过认证", () => {
    const body = Buffer.from(JSON.stringify(deployment));
    const timestamp = String(Math.floor(nowMs / 1000));
    const nonce = "tampered_pair_nonce_1234";
    const signature = signDeployRequest({secret, timestamp, nonce, body});
    const modified = Buffer.from(JSON.stringify({...deployment, frontendCommit: "c".repeat(40)}));
    assert.equal(createRequestAuthenticator({secret, now: () => nowMs})({timestamp, nonce, signature, body: modified}).code, "DEPLOY_SIGNATURE_INVALID");
});

test("实际代理和 CI 入口只把测试提交对传给 upgrade；拒绝默认分支", async (t) => {
    const executable = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
    assert.ok(existsSync(executable), "bash is required for this deployment regression");
    const dir = await mkdtemp(path.join(os.tmpdir(), "np-deploy-pair-"));
    t.after(() => rm(dir, {recursive: true, force: true}));
    const scriptPath = path.join(dir, "ci-deploy.sh").replaceAll("\\", "/");
    await writeFile(scriptPath, await readFile(new URL("../deploy/ci-deploy.sh", import.meta.url)));
    // This fixture never performs upgrades or touches production.
    await writeFile(path.join(dir, "upgrade.sh"), 'printf "%s\\n" "$@"\n');
    assert.throws(() => createDeploymentRunner({repositoryDirectory: dir, scriptPath, timeoutMs: 5000, executable}), /已停用/);
    for (const request of [deployment, {...deployment, repository: "tempChanghong/NPClassworks", commit: frontendCommit}]) {
        const result = spawnSync(executable, [scriptPath, request.backendCommit, request.frontendCommit], {cwd: dir, encoding: "utf8"});
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.stdout.trim().split("\n"), ["--backend-ref", backendCommit, "--frontend-ref", frontendCommit, "--rollback-on-failure"]);
    }
    for (const args of [[], [backendCommit], ["main", frontendCommit], [backendCommit, frontendCommit, "extra"]]) {
        const result = spawnSync(executable, [scriptPath, ...args], {cwd: dir, encoding: "utf8"});
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.stdout, "");
    }
});

test("旧 Node 生产启动入口和旧 timer 安装器在执行工作区代码前拒绝启动", () => {
    const agent = spawnSync(process.execPath, [new URL("../deploy/agent/server.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], {encoding: "utf8", env: {PATH: process.env.PATH}});
    assert.equal(agent.status, 1, agent.stderr);
    assert.match(agent.stderr, /已停用/);
    const executable = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
    const timer = spawnSync(executable, [new URL("../deploy/install-backup-timer.sh", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], {encoding: "utf8"});
    assert.equal(timer.status, 1, timer.stderr);
    assert.match(timer.stderr, /已停用/);
});

test("部署请求签名可验证且同一 nonce 不可重放", () => {
    const body = Buffer.from('{"action":"upgrade"}');
    const timestamp = String(Math.floor(nowMs / 1000));
    const nonce = "0123456789abcdef0123456789abcdef";
    const signature = signDeployRequest({secret, timestamp, nonce, body});
    const authenticate = createRequestAuthenticator({secret, now: () => nowMs});
    assert.deepEqual(authenticate({timestamp, nonce, signature: `sha256=${signature}`, body}), {ok: true});
    assert.equal(authenticate({timestamp, nonce, signature, body}).code, "DEPLOY_NONCE_INVALID");
});

test("部署请求拒绝过期时间戳和错误签名", () => {
    const body = Buffer.from('{"action":"upgrade"}');
    const authenticate = createRequestAuthenticator({secret, now: () => nowMs});
    assert.equal(authenticate({
        timestamp: String(Math.floor(nowMs / 1000) - 301),
        nonce: "stale_nonce_1234567890",
        signature: "0".repeat(64),
        body,
    }).code, "DEPLOY_TIMESTAMP_INVALID");
    assert.equal(authenticate({
        timestamp: String(Math.floor(nowMs / 1000)),
        nonce: "invalid_signature_nonce",
        signature: "0".repeat(64),
        body,
    }).code, "DEPLOY_SIGNATURE_INVALID");
});

async function signedRequest(baseUrl, input, nonce) {
    const body = JSON.stringify(input);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signDeployRequest({secret, timestamp, nonce, body});
    return fetch(`${baseUrl}/v1/deploy`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-NP-Deploy-Timestamp": timestamp,
            "X-NP-Deploy-Nonce": nonce,
            "X-NP-Deploy-Signature": `sha256=${signature}`,
        },
        body,
    });
}

test("HTTP 代理只执行固定 upgrade 动作，不接受命令和目录", async (t) => {
    const calls = [];
    const server = createDeployAgent({
        secret,
        runDeployment: async (request, jobId) => {
            calls.push(request);
            return {ok: true, code: "DEPLOY_COMPLETED", jobId};
        },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const {port} = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const rejected = await signedRequest(baseUrl, {
        action: "upgrade",
        command: "rm -rf /",
    }, "reject_unknown_field_1234");
    assert.equal(rejected.status, 400);
    assert.equal(calls.length, 0);

    const accepted = await signedRequest(baseUrl, deployment, "accepted_upgrade_123456");
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).code, "DEPLOY_COMPLETED");
    assert.equal(calls.length, 1);
});
