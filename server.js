'use strict'
// nanohttp — HTTP/1.1 server, zero dependencies.
// Implements: request parsing, routing with params, middleware chain,
// keep-alive connections, JSON + static file responses.

const net  = require('net')
const fs   = require('fs')
const path = require('path')

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
    const key = lines[i].slice(0, colon).trim().toLowerCase()
    headers[key] = lines[i].slice(colon + 1).trim()
  }

  const contentLen = parseInt(headers['content-length'] || '0', 10)
  if (bodyRaw.length < contentLen) return null   // incomplete body

  const [pathname, search] = rawPath.split('?')
  const query = {}
  if (search) {
    for (const pair of search.split('&')) {
      const [k, v] = pair.split('=').map(decodeURIComponent)
      query[k] = v ?? ''
    }
  }

  let body = null
  if (contentLen > 0) {
    const raw = bodyRaw.slice(0, contentLen)
    const ct  = headers['content-type'] || ''
    body = ct.includes('application/json') ? JSON.parse(raw) : raw
  }

  return { method, path: pathname, query, headers, body, proto }
}

// ── Response builder ───────────────────────────────────────────────────────────

const STATUS = {
  200: 'OK', 201: 'Created', 204: 'No Content',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict',
  500: 'Internal Server Error',
}

class Response {
  constructor(socket, keepAlive) {
    this._socket    = socket
    this._keepAlive = keepAlive
    this._sent      = false
  }

  _send(status, headers, body) {
    if (this._sent) return
    this._sent = true
    const bodyBuf   = typeof body === 'string' ? Buffer.from(body) : (body || Buffer.alloc(0))
    const conn      = this._keepAlive ? 'keep-alive' : 'close'
    const head      = [
      `HTTP/1.1 ${status} ${STATUS[status] || 'Unknown'}`,
      `Content-Length: ${bodyBuf.length}`,
      `Connection: ${conn}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      '', '',
    ].join('\r\n')
    this._socket.write(head)
    if (bodyBuf.length) this._socket.write(bodyBuf)
    if (!this._keepAlive) this._socket.end()
  }

  json(data, status = 200) {
    this._send(status, { 'Content-Type': 'application/json' }, JSON.stringify(data))
  }

  text(str, status = 200) {
    this._send(status, { 'Content-Type': 'text/plain' }, str)
  }

  html(str, status = 200) {
    this._send(status, { 'Content-Type': 'text/html' }, str)
  }

  status(code) { return { json: (d) => this.json(d, code), text: (s) => this.text(s, code) } }

  file(filePath) {
    const abs = path.resolve(filePath)
    if (!fs.existsSync(abs)) return this._send(404, {}, 'Not Found')
    const ext  = path.extname(abs)
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
                   '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' }
    const body = fs.readFileSync(abs)
    this._send(200, { 'Content-Type': mime[ext] || 'application/octet-stream' }, body)
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

class Router {
  constructor() { this._routes = [] }

  _add(method, pattern, ...handlers) {
    const keys  = []
    const regex = new RegExp('^' +
      pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)' })
             .replace(/\*/g, '.*') + '$')
    this._routes.push({ method, regex, keys, handlers })
    return this
  }

  get(p, ...h)    { return this._add('GET',    p, ...h) }
  post(p, ...h)   { return this._add('POST',   p, ...h) }
  put(p, ...h)    { return this._add('PUT',    p, ...h) }
  delete(p, ...h) { return this._add('DELETE', p, ...h) }
  patch(p, ...h)  { return this._add('PATCH',  p, ...h) }
  all(p, ...h)    { return this._add('*',      p, ...h) }

  handle(req, res) {
    for (const route of this._routes) {
      if (route.method !== '*' && route.method !== req.method) continue
      const m = req.path.match(route.regex)
      if (!m) continue
      req.params = {}
      route.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]) })
      let i = 0
      const next = () => {
        const handler = route.handlers[i++]
        if (handler) handler(req, res, next)
      }
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

  _dispatch(req, socket, keepAlive) {
    const res   = new Response(socket, keepAlive)
    let   mi    = 0

    const runMiddleware = () => {
      if (mi < this._middlewares.length) {
        this._middlewares[mi++](req, res, runMiddleware)
      } else {
        const handled = this.router.handle(req, res)
        if (!handled) res.status(404).json({ error: `${req.method} ${req.path} not found` })
      }
    }
    runMiddleware()
  }

  listen(port, cb) {
    const server = net.createServer((socket) => {
      let buf = ''

      socket.on('data', (chunk) => {
        buf += chunk.toString()
        while (true) {
          const req = parseRequest(buf)
          if (!req) break
          const keepAlive = (req.headers['connection'] || '').toLowerCase() !== 'close'
          const consumed  = buf.indexOf('\r\n\r\n') + 4 + parseInt(req.headers['content-length'] || '0', 10)
          buf = buf.slice(consumed)
          try { this._dispatch(req, socket, keepAlive) }
          catch (e) { new Response(socket, false).status(500).json({ error: e.message }) }
        }
      })

      socket.on('error', () => {})
    })

    server.listen(port, cb)
    return server
  }
}

// ── Built-in middleware ────────────────────────────────────────────────────────

function logger(req, res, next) {
  const start = Date.now()
  const orig  = res._send.bind(res)
  res._send   = (...args) => {
    console.log(`  ${req.method.padEnd(7)} ${req.path.padEnd(30)} ${args[0]}  +${Date.now()-start}ms`)
    orig(...args)
  }
  next()
}

function cors(req, res, next) {
  if (req.method === 'OPTIONS') {
    res._send(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    }, '')
    return
  }
  const orig = res._send.bind(res)
  res._send  = (s, h, b) => orig(s, { ...h, 'Access-Control-Allow-Origin': '*' }, b)
  next()
}

module.exports = { App, Router, logger, cors }
