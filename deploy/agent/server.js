import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const NONCE_TTL_MS = 10 * 60 * 1000;
const ALLOWED_BODY_KEYS = new Set(["action", "repository", "commit", "runId", "backendCommit", "frontendCommit"]);

function json(res, statusCode, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
}

function safeEqualHex(left, right) {
    if (!/^[a-f0-9]{64}$/i.test(left || "") || !/^[a-f0-9]{64}$/i.test(right || "")) return false;
    return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function signDeployRequest({secret, timestamp, nonce, body}) {
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    return crypto.createHmac("sha256", secret)
        .update(`${timestamp}\n${nonce}\n${bodyHash}`)
        .digest("hex");
}

export function createRequestAuthenticator({secret, now = () => Date.now()}) {
    const usedNonces = new Map();
    return ({timestamp, nonce, signature, body}) => {
        const currentTime = now();
        for (const [value, expiresAt] of usedNonces) {
            if (expiresAt <= currentTime) usedNonces.delete(value);
        }
        const timestampSeconds = Number(timestamp);
        if (!Number.isInteger(timestampSeconds) || Math.abs(Math.floor(currentTime / 1000) - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
            return {ok: false, code: "DEPLOY_TIMESTAMP_INVALID"};
        }
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce || "") || usedNonces.has(nonce)) {
            return {ok: false, code: "DEPLOY_NONCE_INVALID"};
        }
        const provided = String(signature || "").replace(/^sha256=/i, "");
        const expected = signDeployRequest({secret, timestamp, nonce, body});
        if (!safeEqualHex(provided, expected)) return {ok: false, code: "DEPLOY_SIGNATURE_INVALID"};
        usedNonces.set(nonce, currentTime + NONCE_TTL_MS);
        return {ok: true};
    };
}

export function parseDeployRequest(body) {
    let input;
    try {
        input = JSON.parse(body.toString("utf8"));
    } catch {
        throw new Error("请求正文不是有效 JSON");
    }
    if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("请求正文必须是对象");
    if (Object.keys(input).some((key) => !ALLOWED_BODY_KEYS.has(key))) {
        throw new Error("请求包含不受支持的字段；部署代理不接受目录、命令或 Git 引用");
    }
    if (input.action !== "upgrade") throw new Error("仅支持 upgrade 操作");
    for (const field of ["repository", "commit", "runId"]) {
        if (input[field] != null && (typeof input[field] !== "string" || input[field].length > 200)) {
            throw new Error(`${field} 字段无效`);
        }
    }
    for (const field of ["backendCommit", "frontendCommit", "commit"]) {
        if (typeof input[field] !== "string" || !/^[a-f0-9]{40}$/.test(input[field])) {
            throw new Error(`${field} 必须是完整的小写提交 SHA`);
        }
    }
    const triggerField = {"tempChanghong/NPClassworksKV": "backendCommit", "tempChanghong/NPClassworks": "frontendCommit"}[input.repository];
    if (!triggerField || input.commit !== input[triggerField]) throw new Error("触发仓库与测试提交不匹配");
    return input;
}

// The checkout-hosted runner is retired. Do not recreate privileged execution here.
export function createDeploymentRunner() {
    throw new Error("工作区 Node 部署执行器已停用；请使用 NPEssentials 独立受保护执行器");
}

export function createDeployAgent({secret, runDeployment, maxQueue = 3, now = () => Date.now()}) {
    const authenticate = createRequestAuthenticator({secret, now});
    const queue = [];
    let activeJob = null;

    async function drainQueue() {
        if (activeJob || queue.length === 0) return;
        activeJob = queue.shift();
        let result;
        try {
            result = await runDeployment(activeJob.request, activeJob.jobId);
        } catch (error) {
            result = {ok: false, code: "DEPLOY_AGENT_INTERNAL_ERROR", jobId: activeJob.jobId, error: error.message};
        }
        for (const res of activeJob.responses) {
            if (!res.destroyed) json(res, result.ok ? 200 : 500, result);
        }
        activeJob = null;
        void drainQueue();
    }

    const server = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/healthz") {
            return json(res, 200, {ok: true, busy: Boolean(activeJob), queued: queue.length});
        }
        if (req.method !== "POST" || req.url !== "/v1/deploy") {
            req.resume();
            return json(res, 404, {ok: false, code: "NOT_FOUND"});
        }
        const chunks = [];
        let size = 0;
        let oversized = false;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) oversized = true;
            else chunks.push(chunk);
        });
        req.on("end", () => {
            if (oversized) return json(res, 413, {ok: false, code: "DEPLOY_REQUEST_TOO_LARGE"});
            const body = Buffer.concat(chunks);
            const auth = authenticate({
                timestamp: req.headers["x-np-deploy-timestamp"],
                nonce: req.headers["x-np-deploy-nonce"],
                signature: req.headers["x-np-deploy-signature"],
                body,
            });
            if (!auth.ok) return json(res, 401, {ok: false, code: auth.code});
            let request;
            try {
                request = parseDeployRequest(body);
            } catch (error) {
                return json(res, 400, {ok: false, code: "DEPLOY_REQUEST_INVALID", message: error.message});
            }
            if (queue.length >= maxQueue) {
                return json(res, 429, {ok: false, code: "DEPLOY_QUEUE_FULL"});
            }
            const job = {jobId: crypto.randomUUID(), request, responses: [res]};
            queue.push(job);
            void drainQueue();
        });
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 32;
    return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    console.error("工作区 Node 部署代理已停用；请迁移到 NPEssentials 独立受保护执行器");
    process.exitCode = 1;
}
