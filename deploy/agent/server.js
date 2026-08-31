import crypto from "node:crypto";
import http from "node:http";
import {spawn} from "node:child_process";
import {appendFile, realpath, stat} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const JOB_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_JOB_HISTORY = 100;
const ALLOWED_BODY_KEYS = new Set(["action", "repository", "commit", "runId"]);

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

function safeEqualToken(left, right) {
    const leftBuffer = Buffer.from(String(left || ""));
    const rightBuffer = Buffer.from(String(right || ""));
    return leftBuffer.length > 0 &&
        leftBuffer.length === rightBuffer.length &&
        crypto.timingSafeEqual(leftBuffer, rightBuffer);
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

function parseDeployRequest(body) {
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
    return input;
}

function appendTail(current, chunk) {
    const next = Buffer.concat([current, Buffer.from(chunk)]);
    return next.length > MAX_CAPTURE_BYTES ? next.subarray(next.length - MAX_CAPTURE_BYTES) : next;
}

function createDeploymentRunner({repositoryDirectory, scriptPath, timeoutMs, logPath}) {
    return (request, jobId) => new Promise((resolve) => {
        const startedAt = new Date();
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let settled = false;
        let timedOut = false;
        const child = spawn("bash", [scriptPath], {
            cwd: repositoryDirectory,
            env: {...process.env, GIT_TERMINAL_PROMPT: "0"},
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        });
        const writeLog = (stream, chunk) => {
            const line = `[${new Date().toISOString()}] [${jobId}] [${stream}] ${chunk}`;
            process[stream === "stdout" ? "stdout" : "stderr"].write(line);
            if (logPath) void appendFile(logPath, line, {mode: 0o600}).catch(() => {});
        };
        child.stdout.on("data", (chunk) => {
            stdout = appendTail(stdout, chunk);
            writeLog("stdout", chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr = appendTail(stderr, chunk);
            writeLog("stderr", chunk);
        });
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve({
                ...result,
                jobId,
                request,
                startedAt: startedAt.toISOString(),
                finishedAt: new Date().toISOString(),
                stdout: stdout.toString("utf8"),
                stderr: stderr.toString("utf8"),
            });
        };
        const timeout = setTimeout(() => {
            timedOut = true;
            if (process.platform !== "win32") {
                try { process.kill(-child.pid, "SIGTERM"); } catch {}
            } else {
                child.kill("SIGTERM");
            }
            setTimeout(() => {
                if (settled) return;
                if (process.platform !== "win32") {
                    try { process.kill(-child.pid, "SIGKILL"); } catch {}
                } else {
                    child.kill("SIGKILL");
                }
                finish({ok: false, code: "DEPLOY_TIMEOUT", exitCode: null});
            }, 10000).unref();
        }, timeoutMs);
        child.on("error", (error) => finish({ok: false, code: "DEPLOY_START_FAILED", exitCode: null, error: error.message}));
        child.on("close", (exitCode, signal) => finish({
            ok: !timedOut && exitCode === 0,
            code: timedOut ? "DEPLOY_TIMEOUT" : (exitCode === 0 ? "DEPLOY_COMPLETED" : "DEPLOY_FAILED"),
            exitCode,
            signal,
        }));
    });
}

export function createDeployAgent({secret, runDeployment, maxQueue = 3, now = () => Date.now()}) {
    const authenticate = createRequestAuthenticator({secret, now});
    const queue = [];
    const jobs = new Map();
    let activeJob = null;

    function cleanupJobs() {
        const cutoff = now() - JOB_HISTORY_TTL_MS;
        for (const [jobId, job] of jobs) {
            if (job.finishedAt && new Date(job.finishedAt).getTime() < cutoff) jobs.delete(jobId);
        }
        if (jobs.size <= MAX_JOB_HISTORY) return;
        const completed = [...jobs.values()]
            .filter((job) => job.finishedAt)
            .sort((left, right) => new Date(left.finishedAt) - new Date(right.finishedAt));
        for (const job of completed.slice(0, jobs.size - MAX_JOB_HISTORY)) jobs.delete(job.jobId);
    }

    function jobStatus(job) {
        if (job.result) {
            return {
                ...job.result,
                state: job.result.ok ? "succeeded" : "failed",
                createdAt: job.createdAt,
            };
        }
        return {
            ok: true,
            code: job.state === "running" ? "DEPLOY_RUNNING" : "DEPLOY_QUEUED",
            jobId: job.jobId,
            state: job.state,
            createdAt: job.createdAt,
            startedAt: job.startedAt || null,
            queuePosition: job.state === "queued"
                ? Math.max(1, queue.findIndex((item) => item.jobId === job.jobId) + 1)
                : 0,
        };
    }

    async function drainQueue() {
        if (activeJob || queue.length === 0) return;
        activeJob = queue.shift();
        activeJob.state = "running";
        activeJob.startedAt = new Date(now()).toISOString();
        let result;
        try {
            result = await runDeployment(activeJob.request, activeJob.jobId);
        } catch (error) {
            result = {ok: false, code: "DEPLOY_AGENT_INTERNAL_ERROR", jobId: activeJob.jobId, error: error.message};
        }
        activeJob.result = result;
        activeJob.finishedAt = result.finishedAt || new Date(now()).toISOString();
        for (const response of activeJob.responses) {
            if (!response.destroyed) json(response, result.ok ? 200 : 500, result);
        }
        activeJob = null;
        cleanupJobs();
        void drainQueue();
    }

    const server = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/healthz") {
            return json(res, 200, {ok: true, busy: Boolean(activeJob), queued: queue.length});
        }
        const statusMatch = req.method === "GET"
            ? req.url?.match(/^\/v1\/deploy\/jobs\/([0-9a-f-]{36})$/i)
            : null;
        if (statusMatch) {
            cleanupJobs();
            const job = jobs.get(statusMatch[1]);
            if (!job || !safeEqualToken(req.headers["x-np-deploy-status-token"], job.statusToken)) {
                return json(res, 404, {ok: false, code: "DEPLOY_JOB_NOT_FOUND"});
            }
            return json(res, 200, jobStatus(job));
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
            const job = {
                jobId: crypto.randomUUID(),
                statusToken: crypto.randomBytes(32).toString("hex"),
                request,
                state: "queued",
                createdAt: new Date(now()).toISOString(),
                startedAt: null,
                finishedAt: null,
                result: null,
                responses: [],
            };
            jobs.set(job.jobId, job);
            queue.push(job);
            if (req.headers["x-np-deploy-async"] === "1") {
                json(res, 202, {
                    ok: true,
                    code: "DEPLOY_ACCEPTED",
                    jobId: job.jobId,
                    state: job.state,
                    statusPath: `/v1/deploy/jobs/${job.jobId}`,
                    statusToken: job.statusToken,
                });
            } else {
                // 兼容尚未升级的工作流：旧客户端没有轮询能力，只能等待
                // 最终 200/500。显式选择异步协议的新客户端不会走到这里。
                job.responses.push(res);
            }
            void drainQueue();
        });
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 32;
    return server;
}

async function loadConfig() {
    const secret = process.env.DEPLOY_AGENT_SECRET || "";
    if (Buffer.byteLength(secret) < 32 || secret.startsWith("replace_with_")) {
        throw new Error("DEPLOY_AGENT_SECRET 至少需要 32 个随机字节，且不能保留示例占位符");
    }
    const configuredDirectory = process.env.DEPLOY_AGENT_BACKEND_DIR;
    if (!configuredDirectory || !path.isAbsolute(configuredDirectory)) {
        throw new Error("DEPLOY_AGENT_BACKEND_DIR 必须是后端仓库的绝对路径");
    }
    const repositoryDirectory = await realpath(configuredDirectory);
    const scriptPath = path.join(repositoryDirectory, "deploy", "ci-deploy.sh");
    const scriptInfo = await stat(scriptPath);
    if (!scriptInfo.isFile()) throw new Error("找不到固定升级脚本 deploy/ci-deploy.sh");
    const port = Number(process.env.DEPLOY_AGENT_PORT || 19090);
    const timeoutMs = Number(process.env.DEPLOY_AGENT_TIMEOUT_MS || 30 * 60 * 1000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DEPLOY_AGENT_PORT 无效");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 60000 || timeoutMs > 60 * 60 * 1000) {
        throw new Error("DEPLOY_AGENT_TIMEOUT_MS 必须介于 60000 和 3600000 之间");
    }
    const logPath = process.env.DEPLOY_AGENT_LOG_PATH
        ? path.resolve(process.env.DEPLOY_AGENT_LOG_PATH)
        : null;
    return {
        secret,
        host: process.env.DEPLOY_AGENT_HOST || "127.0.0.1",
        port,
        repositoryDirectory,
        scriptPath,
        timeoutMs,
        logPath,
    };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    loadConfig().then((config) => {
        const runDeployment = createDeploymentRunner(config);
        const server = createDeployAgent({secret: config.secret, runDeployment});
        server.listen(config.port, config.host, () => {
            console.log(`NPClassworks deploy agent listening on http://${config.host}:${config.port}`);
        });
    }).catch((error) => {
        console.error(`部署代理启动失败：${error.message}`);
        process.exitCode = 1;
    });
}
