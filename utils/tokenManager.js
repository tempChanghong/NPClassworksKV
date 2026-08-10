import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from './prisma.js';

// Token 配置
const ACCESS_TOKEN_SECRET = process.env.JWT_SECRET || 'your-access-token-secret-change-this-in-production';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'your-refresh-token-secret-change-this-in-production';

// Token 过期时间配置
const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || '15m'; // 15分钟
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '30d'; // 30天

// JWT 算法配置
const JWT_ALG = (process.env.JWT_ALG || 'HS256').toUpperCase();

// RS256 密钥对（如果使用RSA算法）
const ACCESS_TOKEN_PRIVATE_KEY = process.env.ACCESS_TOKEN_PRIVATE_KEY?.replace(/\\n/g, '\n');
const ACCESS_TOKEN_PUBLIC_KEY = process.env.ACCESS_TOKEN_PUBLIC_KEY?.replace(/\\n/g, '\n');
const REFRESH_TOKEN_PRIVATE_KEY = process.env.REFRESH_TOKEN_PRIVATE_KEY?.replace(/\\n/g, '\n');
const REFRESH_TOKEN_PUBLIC_KEY = process.env.REFRESH_TOKEN_PUBLIC_KEY?.replace(/\\n/g, '\n');

/**
 * 获取签名和验证密钥
 */
function getKeys(tokenType = 'access') {
    if (JWT_ALG === 'RS256') {
        const privateKey = tokenType === 'access' ? ACCESS_TOKEN_PRIVATE_KEY : REFRESH_TOKEN_PRIVATE_KEY;
        const publicKey = tokenType === 'access' ? ACCESS_TOKEN_PUBLIC_KEY : REFRESH_TOKEN_PUBLIC_KEY;

        if (!privateKey || !publicKey) {
            throw new Error(`RS256 需要同时提供 ${tokenType.toUpperCase()}_TOKEN_PRIVATE_KEY 与 ${tokenType.toUpperCase()}_TOKEN_PUBLIC_KEY`);
        }
        return {signKey: privateKey, verifyKey: publicKey};
    }

    // 默认 HS256
    const secret = tokenType === 'access' ? ACCESS_TOKEN_SECRET : REFRESH_TOKEN_SECRET;
    return {signKey: secret, verifyKey: secret};
}

/**
 * 生成访问令牌
 */
export function generateAccessToken(account, sessionId = null) {
    const {signKey} = getKeys('access');

    const payload = {
        type: 'access',
        accountId: account.id,
        provider: account.provider,
        email: account.email,
        name: account.name,
        avatarUrl: account.avatarUrl,
        tokenVersion: account.tokenVersion || 1,
        ...(sessionId ? {sessionId} : {}),
    };

    return jwt.sign(payload, signKey, {
        expiresIn: ACCESS_TOKEN_EXPIRES_IN,
        algorithm: JWT_ALG,
        issuer: 'ClassworksKV',
        audience: 'classworks-client',
    });
}

/**
 * 生成刷新令牌
 */
export function generateRefreshToken(account, sessionId = null) {
    const {signKey} = getKeys('refresh');

    const payload = {
        type: 'refresh',
        accountId: account.id,
        tokenVersion: account.tokenVersion || 1,
        ...(sessionId ? {sessionId} : {}),
        // 添加随机字符串增加安全性
        jti: crypto.randomBytes(16).toString('hex'),
    };

    return jwt.sign(payload, signKey, {
        expiresIn: REFRESH_TOKEN_EXPIRES_IN,
        algorithm: JWT_ALG,
        issuer: 'ClassworksKV',
        audience: 'classworks-client',
    });
}

/**
 * 验证访问令牌
 */
export function verifyAccessToken(token) {
    const {verifyKey} = getKeys('access');

    try {
        const decoded = jwt.verify(token, verifyKey, {
            algorithms: [JWT_ALG],
            issuer: 'ClassworksKV',
            audience: 'classworks-client',
        });

        if (decoded.type !== 'access') {
            throw new Error('Invalid token type');
        }

        return decoded;
    } catch (error) {
        throw error;
    }
}

/**
 * 验证刷新令牌
 */
export function verifyRefreshToken(token) {
    const {verifyKey} = getKeys('refresh');

    try {
        const decoded = jwt.verify(token, verifyKey, {
            algorithms: [JWT_ALG],
            issuer: 'ClassworksKV',
            audience: 'classworks-client',
        });

        if (decoded.type !== 'refresh') {
            throw new Error('Invalid token type');
        }

        return decoded;
    } catch (error) {
        throw error;
    }
}

/**
 * 生成令牌对（访问令牌 + 刷新令牌）
 */
export async function generateTokenPair(account) {
    const sessionId = crypto.randomUUID();
    const accessToken = generateAccessToken(account, sessionId);
    const refreshToken = generateRefreshToken(account, sessionId);

    // 计算刷新令牌过期时间
    const refreshTokenExpiry = new Date();
    const expiresInMs = parseExpirationToMs(REFRESH_TOKEN_EXPIRES_IN);
    refreshTokenExpiry.setTime(refreshTokenExpiry.getTime() + expiresInMs);

    // 每次登录创建独立会话，避免另一台一体机登录后覆盖当前设备。
    await prisma.accountSession.create({
        data: {
            id: sessionId,
            accountId: account.id,
            refreshTokenHash: hashRefreshToken(refreshToken),
            expiresAt: refreshTokenExpiry,
        },
    });

    return {
        accessToken,
        refreshToken,
        accessTokenExpiresIn: ACCESS_TOKEN_EXPIRES_IN,
        refreshTokenExpiresIn: REFRESH_TOKEN_EXPIRES_IN,
        sessionId,
    };
}

/**
 * 刷新访问令牌
 */
export async function refreshAccessToken(refreshToken) {
    try {
        // 验证刷新令牌
        const decoded = verifyRefreshToken(refreshToken);

        const sessionId = typeof decoded.sessionId === 'string' ? decoded.sessionId : null;
        const [account, session] = await Promise.all([
            prisma.account.findUnique({where: {id: decoded.accountId}}),
            sessionId
                ? prisma.accountSession.findUnique({where: {id: sessionId}})
                : Promise.resolve(null),
        ]);

        if (!account) {
            throw new Error('Account not found');
        }

        if (sessionId) {
            if (
                !session ||
                session.accountId !== account.id ||
                session.revokedAt ||
                session.refreshTokenHash !== hashRefreshToken(refreshToken)
            ) {
                throw new Error('Invalid refresh token');
            }
            if (session.expiresAt < new Date()) {
                throw new Error('Refresh token expired');
            }
        } else {
            // 兼容迁移前已经签发的单会话刷新令牌。
            if (account.refreshToken !== refreshToken) {
                throw new Error('Invalid refresh token');
            }
            if (account.refreshTokenExpiry && account.refreshTokenExpiry < new Date()) {
                throw new Error('Refresh token expired');
            }
        }

        // 验证令牌版本
        if (account.tokenVersion !== decoded.tokenVersion) {
            throw new Error('Token version mismatch');
        }

        // 生成新的访问令牌
        const newAccessToken = generateAccessToken(account, sessionId);

        if (sessionId) {
            await prisma.accountSession.update({
                where: {id: sessionId},
                data: {lastUsedAt: new Date()},
            });
        }

        return {
            accessToken: newAccessToken,
            accessTokenExpiresIn: ACCESS_TOKEN_EXPIRES_IN,
            account: {
                id: account.id,
                provider: account.provider,
                email: account.email,
                name: account.name,
                avatarUrl: account.avatarUrl,
            },
        };
    } catch (error) {
        throw error;
    }
}

/**
 * 撤销所有令牌（登出所有设备）
 */
export async function revokeAllTokens(accountId) {
    const now = new Date();
    await prisma.$transaction([
        prisma.account.update({
            where: {id: accountId},
            data: {
                tokenVersion: {increment: 1},
                refreshToken: null,
                refreshTokenExpiry: null,
                updatedAt: now,
            },
        }),
        prisma.accountSession.updateMany({
            where: {accountId, revokedAt: null},
            data: {revokedAt: now},
        }),
    ]);
}

/**
 * 撤销当前刷新令牌（登出当前设备）
 */
export async function revokeRefreshToken(accountId, sessionId = null) {
    if (sessionId) {
        await prisma.accountSession.updateMany({
            where: {id: sessionId, accountId, revokedAt: null},
            data: {revokedAt: new Date()},
        });
        return;
    }
    await prisma.account.update({
        where: {id: accountId},
        data: {refreshToken: null, refreshTokenExpiry: null, updatedAt: new Date()},
    });
}

export function hashRefreshToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

export function isLegacyAccountTokenPayload(decoded) {
    return Boolean(
        decoded &&
        decoded.accountId &&
        decoded.type === undefined &&
        decoded.tokenVersion === undefined,
    );
}

/**
 * 解析过期时间字符串为毫秒
 */
function parseExpirationToMs(expiresIn) {
    if (typeof expiresIn === 'number') {
        return expiresIn * 1000;
    }

    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (!match) {
        throw new Error('Invalid expiration format');
    }

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
        case 's':
            return value * 1000;
        case 'm':
            return value * 60 * 1000;
        case 'h':
            return value * 60 * 60 * 1000;
        case 'd':
            return value * 24 * 60 * 60 * 1000;
        default:
            throw new Error('Invalid time unit');
    }
}

/**
 * 验证账户并检查令牌版本
 */
export async function validateAccountToken(decoded) {
    const account = await prisma.account.findUnique({
        where: {id: decoded.accountId},
    });

    if (!account) {
        throw new Error('Account not found');
    }

    // 验证令牌版本
    if (account.tokenVersion !== decoded.tokenVersion) {
        throw new Error('Token version mismatch');
    }

    return account;
}

// 向后兼容的导出
export const signToken = generateAccessToken;
export const verifyToken = verifyAccessToken;
export const generateAccountToken = generateAccessToken;
