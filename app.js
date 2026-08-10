import "./utils/instrumentation.js";
// import createError from "http-errors";
import express from "express";
import {dirname, join} from "path";
import {fileURLToPath} from "url";
// import cookieParser from "cookie-parser";
import logger from "morgan";
import bodyParser from "body-parser";
import errorHandler from "./middleware/errorHandler.js";
import errors from "./utils/errors.js";

import kvRouter from "./routes/kv-token.js";
import appsRouter from "./routes/apps.js";
import deviceRouter from "./routes/device.js";
import deviceAuthRouter from "./routes/device-auth.js";
import accountsRouter from "./routes/accounts.js";
import autoAuthRouter from "./routes/auto-auth.js";
import academicCatalogRouter from "./routes/v2/academic-catalog.js";
import academicAdminRouter from "./routes/v2/academic-admin.js";
import academicMeRouter from "./routes/v2/academic-me.js";
import publicationsRouter from "./routes/v2/publications.js";
import classroomScreensRouter from "./routes/v2/classroom-screens.js";
import {register} from "./utils/metrics.js";
import {prisma} from "./utils/prisma.js";
import cors from "cors";

var app = express();

if (process.env.TRUST_PROXY) {
    const parsedTrustProxy = Number.parseInt(process.env.TRUST_PROXY, 10);
    app.set("trust proxy", Number.isNaN(parsedTrustProxy) ? process.env.TRUST_PROXY : parsedTrustProxy);
}

app.options("/{*path}", cors());
app.use(
    cors({
        exposedHeaders: ["ratelimit-policy", "retry-after", "ratelimit", "X-New-Access-Token", "X-Token-Refreshed", "ETag"], // 告诉浏览器这些响应头可以暴露
        maxAge: 86400, // 设置OPTIONS请求的结果缓存24小时(86400秒)，减少预检请求
        credentials: true, // 允许跨域请求携带凭证
        allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "X-App-Token", "X-Site-Key", "If-Match"], // 允许的请求头
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], // 允许的HTTP方法
        withCredentials: true, // 允许携带cookie等凭证信息
    })
);
app.disable("x-powered-by");

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// view engine setup
app.set("views", join(__dirname, "views"));
app.set("view engine", "ejs");
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());
app.use(logger("dev"));
app.use(express.json());
app.use(express.urlencoded({extended: false}));
// app.use(cookieParser());
app.use(express.static(join(__dirname, "public")));

// 添加请求超时处理中间件
app.use((req, res, next) => {
    // 设置默认请求超时时间为30秒
    const timeout = 30000;

    // 设置超时回调
    const timeoutCallback = () => {
        const timeoutError = errors.createError(408, "请求处理超时");
        next(timeoutError);
    };

    // 设置超时
    req.setTimeout(timeout, timeoutCallback);

    // 监听响应完成事件
    res.on("finish", () => {
        // 如果响应已经完成，清除超时处理
        req.setTimeout(0, timeoutCallback);
    });

    next();
});
app.get("/", (req, res) => {
    res.render("index.ejs");
});
app.get("/check", (req, res) => {
    res.json({
        status: "success",
        message: "Classworks KV is running",
        time: new Date().getTime(),
    });
});

// Readiness additionally verifies that PostgreSQL is reachable. The reverse
// proxy and container orchestrator should use this endpoint before routing.
app.get("/ready", async (req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({
            status: "success",
            message: "Classworks KV is ready",
            time: new Date().getTime(),
        });
    } catch (error) {
        res.status(503).json({
            status: "error",
            message: "Database is unavailable",
            time: new Date().getTime(),
        });
    }
});

// Prometheus metrics endpoint with token auth
app.get("/metrics", async (req, res) => {
    try {
        // 检查 token 验证
        const metricsToken = process.env.METRICS_TOKEN;
        if (metricsToken) {
            const providedToken = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
            if (!providedToken || providedToken !== metricsToken) {
                return res.status(401).json({
                    error: "Unauthorized",
                    message: "Valid metrics token required"
                });
            }
        }

        res.set("Content-Type", register.contentType);
        res.end(await register.metrics());
    } catch (err) {
        res.status(500).end(err.message);
    }
});

// Mount the Apps router with API rate limiting
app.use("/apps", appsRouter);

// Mount the Auto Auth router with API rate limiting
app.use("/auto-auth", autoAuthRouter);

// Mount the Device router with API rate limiting
app.use("/devices", deviceRouter);

// Mount the KV store router
app.use("/kv", kvRouter);

// Mount the Device Authorization router with API rate limiting
app.use("/auth", deviceAuthRouter);

// Mount the Accounts router with API rate limiting
app.use("/accounts", accountsRouter);

// Classworks 2.0 public academic catalog. Phase 1 is read-only and does not
// change any of the existing UUID/KV flows.
app.use("/api/v2/catalog", academicCatalogRouter);
app.use("/api/v2/admin", academicAdminRouter);
app.use("/api/v2/me", academicMeRouter);
app.use("/api/v2/publications", publicationsRouter);
app.use("/api/v2/classroom-screens", classroomScreensRouter);

// 兜底404路由 - 处理所有未匹配的路由
app.use((req, res, next) => {
    const notFoundError = errors.createError(404, `找不到路径: ${req.path}`);
    next(notFoundError);
});

// 全局错误处理中间件
app.use(errorHandler);

export default app;
