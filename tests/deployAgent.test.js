import assert from "node:assert/strict";
import test from "node:test";
import {
    createDeployAgent,
    createRequestAuthenticator,
    signDeployRequest,
} from "../deploy/agent/server.js";

const secret = "test-secret-that-is-at-least-thirty-two-bytes-long";
const nowMs = 1_800_000_000_000;

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

async function signedRequest(baseUrl, input, nonce, {async = true} = {}) {
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
            ...(async ? {"X-NP-Deploy-Async": "1"} : {}),
        },
        body,
    });
}

async function deploymentStatus(baseUrl, accepted, token = accepted.statusToken) {
    return fetch(`${baseUrl}${accepted.statusPath}`, {
        headers: {"X-NP-Deploy-Status-Token": token},
    });
}

async function waitForDeployment(baseUrl, accepted) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const response = await deploymentStatus(baseUrl, accepted);
        assert.equal(response.status, 200);
        const status = await response.json();
        if (["succeeded", "failed"].includes(status.state)) return status;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("部署测试任务未完成");
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

    const accepted = await signedRequest(baseUrl, {
        action: "upgrade",
        repository: "example/NPClassworks",
        commit: "abc123",
        runId: "42",
    }, "accepted_upgrade_123456");
    assert.equal(accepted.status, 202);
    const acceptedJob = await accepted.json();
    assert.equal(acceptedJob.code, "DEPLOY_ACCEPTED");
    assert.match(acceptedJob.jobId, /^[0-9a-f-]{36}$/);
    assert.equal((await deploymentStatus(baseUrl, acceptedJob, "wrong-token")).status, 404);
    const completed = await waitForDeployment(baseUrl, acceptedJob);
    assert.equal(completed.code, "DEPLOY_COMPLETED");
    assert.equal(completed.state, "succeeded");
    assert.equal(calls.length, 1);
});

test("未声明异步协议的旧工作流仍等待最终结果", async (t) => {
    const server = createDeployAgent({
        secret,
        runDeployment: async (request, jobId) => ({ok: true, code: "DEPLOY_COMPLETED", jobId}),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const response = await signedRequest(
        baseUrl,
        {action: "upgrade"},
        "legacy_sync_upgrade_123456",
        {async: false},
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.code, "DEPLOY_COMPLETED");
});

test("部署请求立即返回并通过状态接口报告最终失败", async (t) => {
    let finishDeployment;
    const server = createDeployAgent({
        secret,
        runDeployment: (request, jobId) => new Promise((resolve) => {
            finishDeployment = () => resolve({ok: false, code: "DEPLOY_FAILED", jobId, exitCode: 1});
        }),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const response = await signedRequest(baseUrl, {action: "upgrade"}, "async_upgrade_1234567890");
    assert.equal(response.status, 202);
    const accepted = await response.json();
    const runningResponse = await deploymentStatus(baseUrl, accepted);
    const running = await runningResponse.json();
    assert.equal(running.state, "running");

    finishDeployment();
    const failed = await waitForDeployment(baseUrl, accepted);
    assert.equal(failed.state, "failed");
    assert.equal(failed.code, "DEPLOY_FAILED");
});
