'use strict'
// auth.js — JWT HS256, zero dependencies.
// RFC 7519 compliant: HMAC-SHA256 signature, exp/iat claims, timing-safe verify.

const crypto = require('crypto')

const b64u  = (s) => Buffer.from(s).toString('base64url')
const b64d  = (s) => Buffer.from(s, 'base64url').toString('utf8')

function sign(payload, secret, opts = {}) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now    = Math.floor(Date.now() / 1000)
  const claims = { iat: now, exp: now + (opts.expiresIn || 3600), ...payload }
  const msg    = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`
  const sig    = crypto.createHmac('sha256', secret).update(msg).digest('base64url')
  return `${msg}.${sig}`
}

function verify(token, secret) {
  const parts = (token || '').split('.')
  if (parts.length !== 3) throw new Error('Malformed token')

  const [headerB64, payloadB64, sigB64] = parts
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url')

  // Timing-safe compare prevents length-oracle attacks
  const a = Buffer.from(expected)
  const b = Buffer.from(sigB64)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    throw new Error('Invalid signature')

  const payload = JSON.parse(b64d(payloadB64))
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000))
    throw new Error('Token expired')

  return payload
}

// Express-style middleware — reads Bearer token, sets req.user
function middleware(secret) {
  return function jwtAuth(req, res, next) {
    const auth = req.headers['authorization'] || ''
    if (!auth.startsWith('Bearer '))
      return res.status(401).json({ error: 'Authorization header missing or invalid' })
    try {
      req.user = verify(auth.slice(7), secret)
      next()
    } catch (e) {
      res.status(401).json({ error: e.message })
    }
  }
}

module.exports = { sign, verify, middleware }
