import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schema from './wire.schema.json' with {type: 'json'};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,191}$/;
export const capabilities = ['device.status'];
export class NpepError extends Error {
  constructor(status, code, retryAfterSeconds = null) {
    super(code);
    Object.assign(this, {status, code, retryAfterSeconds});
  }
}
export function fail(status, code) { throw new NpepError(status, code); }
const ajv = new Ajv({strict: true, allErrors: false});
addFormats(ajv);
const validators = new Map();
export function validate(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.compile({definitions: schema.definitions, $ref: `#/definitions/${name}`}));
  return validators.get(name)(value);
}

// JSON.parse alone silently accepts duplicate properties. Tokenize recursively
// before parsing so escaped aliases ("a" and "\u0061") are duplicates too.
export function parseStrictJson(bytes) {
  try {
    const source = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    let offset = 0;
    const whitespace = () => { while (/[\x20\t\n\r]/.test(source[offset] || '!')) offset++; };
    function string() {
      const start = offset++;
      while (offset < source.length) {
        const char = source[offset++];
        if (char === '\\') offset++;
        else if (char === '"') {
          const value = JSON.parse(source.slice(start, offset));
          if (!value.isWellFormed()) throw new Error();
          return value;
        }
      }
      throw new Error();
    }
    function value(depth = 0) {
      if (depth > 32) throw new Error();
      whitespace();
      const char = source[offset];
      if (char === '"') { string(); return; }
      if (char === '{' || char === '[') {
        offset++;
        const object = char === '{', end = object ? '}' : ']';
        const keys = new Set();
        whitespace();
        if (source[offset] === end) { offset++; return; }
        while (true) {
          whitespace();
          if (object) {
            if (source[offset] !== '"') throw new Error();
            const key = string();
            if (keys.has(key)) throw new Error();
            keys.add(key);
            whitespace();
            if (source[offset++] !== ':') throw new Error();
          }
          value(depth + 1);
          whitespace();
          const next = source[offset++];
          if (next === end) return;
          if (next !== ',') throw new Error();
        }
      }
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(offset));
      if (!match) throw new Error();
      offset += match[0].length;
    }
    value(); whitespace();
    if (offset !== source.length) throw new Error();
    return JSON.parse(source);
  } catch { fail(400, 'INVALID_REQUEST'); }
}

export function hash(value) { return createHash('sha256').update(value).digest('hex'); }
export function secretHash(secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) fail(401, 'AUTH_INVALID');
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== secret) fail(401, 'AUTH_INVALID');
  return hash(bytes);
}
export function hashMatches(actual, expected) {
  const a = Buffer.from(actual || '0'.repeat(64), 'hex');
  const b = Buffer.from(expected || '0'.repeat(64), 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b) && Boolean(expected);
}
export function bearer(header, prefix) {
  const match = /^Bearer ([^. ]+)\.([^. ]+)\.([^. ]+)$/.exec(header || '');
  if (!match || match[1] !== prefix || !UUID.test(match[2])) fail(401, 'AUTH_INVALID');
  return {id: match[2], hash: secretHash(match[3])};
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key =>
    [key, ['pairingSecret', 'deviceSecret'].includes(key) ? secretHash(value[key]) : canonical(value[key])]));
  return value;
}
export function digest(value) { return hash(JSON.stringify(canonical(value))); }
export function displayText(value, max = 191) {
  const clean = String(value || '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return [...clean].slice(0, max).join('') || '未命名';
}
export function envelope(requestId, data) {
  return {protocolVersion: '0.1', requestId: UUID.test(requestId || '') ? requestId : randomUUID(), serverTime: new Date().toISOString(), data};
}
