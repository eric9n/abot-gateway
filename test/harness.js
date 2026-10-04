// 行为测试工具：node:sqlite 模拟 D1，自签 Access JWT，mock JWKS
import { DatabaseSync } from 'node:sqlite';

export const AUD = '20d26cf162fe474df036d3de12e12f893893bd7b031a4b03ec50ce3e4cdbaf99';
export const ISS = 'https://boliam.cloudflareaccess.com';
export const ADMIN = 'https://admin.abot.run';

// 与 D1 一致：bind 返回新语句；run() 返回 { meta: { changes } }；batch 是事务，任一失败整体回滚。
// 每次调用前让出一次事件循环，用来模拟并发请求交错。
export function sqliteD1() {
  const db = new DatabaseSync(':memory:');
  const tick = () => new Promise((r) => setTimeout(r, 0));
  function check(args) {
    for (const a of args) {
      if (a === undefined) throw new Error('D1_TYPE_ERROR: Type \'undefined\' not supported');
    }
  }
  function exec(sql, args) {
    check(args);
    const r = db.prepare(sql).run(...args);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  function stmt(sql, args) {
    return {
      sql,
      args,
      bind(...a) { return stmt(sql, a); },
      async first() { await tick(); check(args); return db.prepare(sql).get(...args) ?? null; },
      async all() { await tick(); check(args); return { success: true, results: db.prepare(sql).all(...args), meta: {} }; },
      async run() { await tick(); return exec(sql, args); },
    };
  }
  return {
    raw: db,
    prepare(sql) { return stmt(sql, []); },
    async batch(list) {
      await tick();
      db.exec('BEGIN');
      try {
        const out = list.map((s) => exec(s.sql, s.args));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function newKey(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const ex = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: 'RSA', alg: 'RS256', use: 'sig', e: ex.e, n: ex.n } };
}

export async function accessKeys() {
  const keys = { k1: await newKey('k1'), k2: await newKey('k2') };
  const state = { published: ['k1'], certFetches: 0 };
  async function sign(payload, opts = {}) {
    const key = keys[opts.kid || 'k1'];
    const header = b64url(JSON.stringify({ alg: opts.alg || 'RS256', kid: key.kid, typ: 'JWT' }));
    const body = b64url(JSON.stringify(payload));
    const data = new TextEncoder().encode(header + '.' + body);
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, data));
    return header + '.' + body + '.' + b64url(sig);
  }
  function claims(extra = {}) {
    return { aud: [AUD], iss: ISS, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), email: 'owner@example.com', ...extra };
  }
  function fetchMock(url) {
    if (String(url).includes('/cdn-cgi/access/certs')) {
      state.certFetches += 1;
      return Promise.resolve(Response.json({ keys: state.published.map((k) => keys[k].jwk) }));
    }
    return Promise.reject(new Error('unexpected fetch ' + url));
  }
  return { keys, state, sign, claims, fetchMock };
}
