import {timingSafeEqual} from "node:crypto";

export function metricsAuth(req, res, next) {
    const expected = process.env.METRICS_TOKEN;
    // Reject the historical query form even if a correct header is also sent.
    if (Object.hasOwn(req.query, "token")) return res.status(401).json({error: "Unauthorized", message: "Use Authorization Bearer"});
    if (!expected) return next();
    const actual = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
    const left = Buffer.from(actual || ""), right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
        return res.status(401).json({error: "Unauthorized", message: "Valid metrics token required"});
    }
    next();
}
