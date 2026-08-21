import crypto from "node:crypto";
import {authorizationError} from "../services/academicAuthorizationService.js";

const TOKEN_LIFETIME_SECONDS = 15 * 60;

function encode(value) {
    return Buffer.from(value).toString("base64url");
}

function signature(payload) {
    const secret = process.env.BOOTSTRAP_SETUP_KEY || "";
    return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left, right) {
    const a = Buffer.from(left || "");
    const b = Buffer.from(right || "");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function setupKeyMatches(value) {
    const expected = process.env.BOOTSTRAP_SETUP_KEY || "";
    return Boolean(expected) && safeEqual(String(value || ""), expected);
}

export function createSetupToken(now = Date.now()) {
    if (!process.env.BOOTSTRAP_SETUP_KEY) {
        throw authorizationError("服务器未配置初始化密钥", "SETUP_KEY_NOT_CONFIGURED", 503);
    }
    const issuedAt = Math.floor(now / 1000);
    const body = encode(JSON.stringify({
        purpose: "classworks-instance-setup",
        iat: issuedAt,
        exp: issuedAt + TOKEN_LIFETIME_SECONDS,
        nonce: crypto.randomBytes(16).toString("base64url"),
    }));
    return {token: `${body}.${signature(body)}`, expiresIn: TOKEN_LIFETIME_SECONDS};
}

export function verifySetupToken(token, now = Date.now()) {
    const [body, providedSignature, extra] = String(token || "").split(".");
    if (!body || !providedSignature || extra || !safeEqual(providedSignature, signature(body))) {
        throw authorizationError("初始化会话无效", "SETUP_TOKEN_INVALID", 401);
    }
    let payload;
    try {
        payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
        throw authorizationError("初始化会话无效", "SETUP_TOKEN_INVALID", 401);
    }
    if (payload.purpose !== "classworks-instance-setup" || payload.exp <= Math.floor(now / 1000)) {
        throw authorizationError("初始化会话已过期", "SETUP_TOKEN_EXPIRED", 401);
    }
    return payload;
}

export function setupTokenAuth(req, res, next) {
    try {
        const token = req.headers["x-classworks-setup-token"];
        res.locals.setupSession = verifySetupToken(token);
        next();
    } catch (error) {
        next(error);
    }
}
