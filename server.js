'use strict'
// nanohttp — HTTP/1.1 + WebSocket server, zero dependencies.
// HTTP:      routing, middleware chain, keep-alive, gzip compression, SSE
// WebSocket: RFC 6455 handshake + binary framing

const net    = require('net')
const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const zlib   = require('zlib')

// ── HTTP request parser ───────────────────────────────────────────────────────

function parseRequest(raw) {
  const headerEnd = raw.indexOf('\r\n\r\n')
  if (headerEnd === -1) return null

  const headerPart = raw.slice(0, headerEnd)
  const bodyRaw    = raw.slice(headerEnd + 4)
  const lines      = headerPart.split('\r\n')
  const [method, rawPath, proto] = lines[0].split(' ')

  const headers = {}
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':')
    if (colon === -1) continue
    headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim()
  }

  const contentLen = parseInt(headers['content-length'] || '0', 10)
  if (bodyRaw.length < contentLen) return null

  const [pathname, search] = rawPath.split('?')
  const query = {}
  if (search) {
    for (const pair of search.split('&')) {
      const [k, v] = pair.split('=').map(s => decodeURIComponent(s || ''))
      query[k] = v ?? ''
    }
  }

  let body = null
  if (contentLen > 0) {
    const raw = bodyRaw.slice(0, contentLen)
    const ct  = headers['content-type'] || ''
    try { body = ct.includes('application/json') ? JSON.parse(raw) : raw }
    catch(_) { body = raw }
  }

  return { method, path: pathname, query, headers, body, proto }
}

// ── Response builder ──────────────────────────────────────────────────────────

const STATUS = {
  200:'OK', 201:'Created', 204:'No Content', 301:'Moved Permanently',
  304:'Not Modified', 400:'Bad Request', 401:'Unauthorized', 403:'Forbidden',
  404:'Not Found', 405:'Method Not Allowed', 409:'Conflict',
  429:'Too Many Requests', 500:'Internal Server Error',
}

class Response {
  constructor(socket, keepAlive) {
    this._socket    = socket
    this._keepAlive = keepAlive
    this._sent      = false
    this._hdrs      = {}
  }

  setHeader(k, v) { this._hdrs[k] = v; return this }

  _send(status, headers, body) {
    if (this._sent) return
    this._sent = true

    const all  = { ...this._hdrs, ...headers }
    const conn = this._keepAlive ? 'keep-alive' : 'close'
    const ae   = (this._req && (this._req.headers['accept-encoding'] || '')) || ''

    let bodyBuf
    if (ae.includes('gzip') && typeof body === 'string' && body.length > 512) {
      bodyBuf                    = zlib.gzipSync(Buffer.from(body))
      all['Content-Encoding']    = 'gzip'
    } else {
      bodyBuf = typeof body === 'string' ? Buffer.from(body) : (body || Buffer.alloc(0))
    }

    const head = [
      `HTTP/1.1 ${status} ${STATUS[status] || 'Unknown'}`,
      `Content-Length: ${bodyBuf.length}`,
      `Connection: ${conn}`,
      ...Object.entries(all).map(([k, v]) => `${k}: ${v}`),
      '', '',
    ].join('\r\n')

    this._socket.write(head)
    if (bodyBuf.length) this._socket.write(bodyBuf)
    if (!this._keepAlive) this._socket.end()
  }

  json(data, status = 200)  { this._send(status, { 'Content-Type': 'application/json' }, JSON.stringify(data)) }
  text(str,  status = 200)  { this._send(status, { 'Content-Type': 'text/plain' }, str) }
  html(str,  status = 200)  { this._send(status, { 'Content-Type': 'text/html' }, str) }
  redirect(url, code = 302) { this._send(code, { Location: url }, '') }
  status(code)              { return { json: (d) => this.json(d, code), text: (s) => this.text(s, code) } }

  // Server-Sent Events — returns a stream object
  sse() {
    if (this._sent) return null
    this._sent = true
    const socket = this._socket
    socket.write([
      'HTTP/1.1 200 OK',
      'Content-Type: text/event-stream',
      'Cache-Control: no-cache',
      'Connection: keep-alive',
      'Access-Control-Allow-Origin: *',
      '', '',
    ].join('\r\n'))

    let closed = false
    socket.on('close', () => { closed = true })
    socket.on('error', () => { closed = true })

    return {
      get closed() { return closed },
      send(event, data) {
        if (closed) return
        try { socket.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
        catch(_) { closed = true }
      },
      comment(str) {
        if (closed) return
        try { socket.write(`: ${str}\n\n`) } catch(_) { closed = true }
      },
      close() { closed = true; try { socket.end() } catch(_) {} },
    }
  }

  file(filePath) {
    const abs = path.resolve(filePath)
    if (!fs.existsSync(abs)) return this._send(404, {}, 'Not Found')
    const ext  = path.extname(abs)
    const mime = {
      '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
      '.json':'application/json', '.png':'image/png', '.ico':'image/x-icon',
      '.svg':'image/svg+xml', '.woff2':'font/woff2',
    }
    this._send(200, { 'Content-Type': mime[ext] || 'application/octet-stream' }, fs.readFileSync(abs))
  }
}

// ── WebSocket — RFC 6455 ──────────────────────────────────────────────────────

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function wsHandshake(socket, req) {
  const key    = req.headers['sec-websocket-key']
  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'))
}

function wsFrame(data) {
  const payload = typeof data === 'string' ? Buffer.from(data) : data
  const len     = payload.length
  let   frame

  if (len < 126) {
    frame    = Buffer.alloc(2 + len)
    frame[1] = len
    payload.copy(frame, 2)
  } else if (len < 65536) {
    frame    = Buffer.alloc(4 + len)
    frame[1] = 126
    frame.writeUInt16BE(len, 2)
    payload.copy(frame, 4)
  } else {
    frame    = Buffer.alloc(10 + len)
    frame[1] = 127
    frame.writeBigUInt64BE(BigInt(len), 2)
    payload.copy(frame, 10)
  }
  frame[0] = 0x81  // FIN + opcode 1 (text)
  return frame
}

function wsUnframe(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = !!(buf[1] & 0x80)
  let   payLen = buf[1] & 0x7f
  let   offset = 2

  if (payLen === 126)      { if (buf.length < 4) return null; payLen = buf.readUInt16BE(2);            offset = 4 }
  else if (payLen === 127) { if (buf.length < 10) return null; payLen = Number(buf.readBigUInt64BE(2)); offset = 10 }

  const need = offset + (masked ? 4 : 0) + payLen
  if (buf.length < need) return null

  let payload
  if (masked) {
    const mask = buf.slice(offset, offset + 4)
    offset    += 4
    payload    = Buffer.alloc(payLen)
    for (let i = 0; i < payLen; i++) payload[i] = buf[offset + i] ^ mask[i % 4]
  } else {
    payload = buf.slice(offset, offset + payLen)
  }

  return { opcode, payload: payload.toString(), consumed: offset + payLen }
}

class WSSocket {
  constructor(socket) {
    this._socket   = socket
    this._handlers = {}
    this._buf      = Buffer.alloc(0)

    socket.on('data', (chunk) => {
      this._buf = Buffer.concat([this._buf, chunk])
      while (true) {
        const frame = wsUnframe(this._buf)
        if (!frame) break
        this._buf = this._buf.slice(frame.consumed)
        if      (frame.opcode === 0x8) { this._emit('close'); return }
        else if (frame.opcode === 0x9) { this.send('\x0a') }  // pong
        else                           { this._emit('message', frame.payload) }
      }
    })
    socket.on('close', () => this._emit('close'))
    socket.on('error', () => this._emit('close'))
  }

  on(event, fn) { this._handlers[event] = fn; return this }
  _emit(ev, ...args) { if (this._handlers[ev]) this._handlers[ev](...args) }

  send(data) {
    const str = typeof data === 'object' ? JSON.stringify(data) : String(data)
    try { this._socket.write(wsFrame(str)) } catch(_) {}
  }

  close() { try { this._socket.end() } catch(_) {} }
}

// ── Router ────────────────────────────────────────────────────────────────────

class Router {
  constructor() { this._routes = [] }

  _add(method, pattern, ...handlers) {
    const keys  = []
    const regex = new RegExp(
      '^' + pattern
        .replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)' })
        .replace(/\*/g, '.*') + '$'
    )
    this._routes.push({ method, regex, keys, handlers })
    return this
  }

  get(p, ...h)    { return this._add('GET',    p, ...h) }
  post(p, ...h)   { return this._add('POST',   p, ...h) }
  put(p, ...h)    { return this._add('PUT',    p, ...h) }
  delete(p, ...h) { return this._add('DELETE', p, ...h) }
  patch(p, ...h)  { return this._add('PATCH',  p, ...h) }
  all(p, ...h)    { return this._add('*',      p, ...h) }
  ws(p, fn)       { return this._add('WS',     p, fn) }

  handle(req, res, socket) {
    const method = req._isWS ? 'WS' : req.method
    for (const route of this._routes) {
      if (route.method !== '*' && route.method !== method) continue
      const m = req.path.match(route.regex)
      if (!m) continue
      req.params = {}
      route.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]) })

      if (method === 'WS') {
        wsHandshake(socket, req)
        route.handlers[0](new WSSocket(socket), req)
        return true
      }

      let i = 0
      const next = () => { const h = route.handlers[i++]; if (h) h(req, res, next) }
      next()
      return true
    }
    return false
  }
}

// ── App ───────────────────────────────────────────────────────────────────────

class App {
  constructor() {
    this._middlewares = []
    this.router       = new Router()
  }

  use(fn)              { this._middlewares.push(fn); return this }
  get(p, ...h)         { this.router.get(p, ...h);    return this }
  post(p, ...h)        { this.router.post(p, ...h);   return this }
  put(p, ...h)         { this.router.put(p, ...h);    return this }
  delete(p, ...h)      { this.router.delete(p, ...h); return this }
  patch(p, ...h)       { this.router.patch(p, ...h);  return this }
  ws(p, fn)            { this.router.ws(p, fn);        return this }

  _dispatch(req, socket, keepAlive) {
    if (req._isWS) {
      this.router.handle(req, null, socket)
      return
    }
    const res  = new Response(socket, keepAlive)
    res._req   = req
    let mi     = 0
    const run  = () => {
      if (mi < this._middlewares.length) {
        this._middlewares[mi++](req, res, run)
      } else {
        if (!this.router.handle(req, res, socket))
          res.status(404).json({ error: `${req.method} ${req.path} not found` })
      }
    }
    run()
  }

  listen(port, cb) {
    const server = net.createServer((socket) => {
      let buf = ''
      socket.on('data', (chunk) => {
        buf += chunk.toString()
        while (true) {
          const req = parseRequest(buf)
          if (!req) break
          const isWS = (req.headers['upgrade'] || '').toLowerCase() === 'websocket'
          if (isWS) {
            req._isWS = true
            try { this._dispatch(req, socket, false) } catch(e) { console.error('ws:', e.message) }
            buf = ''
            return
          }
          const keepAlive = (req.headers['connection'] || '').toLowerCase() !== 'close'
          const consumed  = buf.indexOf('\r\n\r\n') + 4 + parseInt(req.headers['content-length'] || '0', 10)
          buf = buf.slice(consumed)
          try { this._dispatch(req, socket, keepAlive) }
          catch(e) { try { new Response(socket, false).status(500).json({ error: e.message }) } catch(_) {} }
        }
      })
      socket.on('error', () => {})
    })
    server.listen(port, cb)
    return server
  }
}

// ── Built-in middleware ───────────────────────────────────────────────────────

function logger(req, res, next) {
  const start = Date.now()
  const orig  = res._send.bind(res)
  res._send   = (...args) => {
    const ms    = Date.now() - start
    const code  = args[0]
    const color = code >= 500 ? '\x1b[31m' : code >= 400 ? '\x1b[33m' : '\x1b[32m'
    console.log(`  ${color}${code}\x1b[0m  ${req.method.padEnd(7)} ${req.path.padEnd(30)} +${ms}ms`)
    orig(...args)
  }
  next()
}

function cors(origins = '*') {
  return function(req, res, next) {
    const origin = typeof origins === 'string' ? origins
      : (origins.includes(req.headers['origin']) ? req.headers['origin'] : origins[0])

    if (req.method === 'OPTIONS') {
      res._send(204, {
        'Access-Control-Allow-Origin':  origin,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Max-Age':       '86400',
      }, '')
      return
    }
    const orig = res._send.bind(res)
    res._send  = (s, h, b) => orig(s, { ...h, 'Access-Control-Allow-Origin': origin }, b)
    next()
  }
}

function rateLimit({ windowMs = 60000, max = 100, message = 'Too many requests' } = {}) {
  const store = new Map()

  setInterval(() => {
    const now = Date.now()
    for (const [ip, rec] of store) {
      if (now - rec.start > windowMs) store.delete(ip)
    }
  }, windowMs).unref()

  return function(req, res, next) {
    const ip  = req.headers['x-forwarded-for'] || 'local'
    const now = Date.now()
    let   rec = store.get(ip)
    if (!rec || now - rec.start > windowMs) { rec = { count: 0, start: now }; store.set(ip, rec) }
    rec.count++
    res.setHeader('X-RateLimit-Limit',     String(max))
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - rec.count)))
    if (rec.count > max) return res.status(429).json({ error: message })
    next()
  }
}

function requestId(req, res, next) {
  req.id    = crypto.randomBytes(8).toString('hex')
  const orig = res._send.bind(res)
  res._send  = (s, h, b) => orig(s, { ...h, 'X-Request-Id': req.id }, b)
  next()
}

module.exports = { App, Router, WSSocket, logger, cors, rateLimit, requestId }
