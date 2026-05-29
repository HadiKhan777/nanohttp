# nanohttp

[hadikhan777.github.io/portfolio](https://hadikhan777.github.io/portfolio/)

HTTP/1.1 + WebSocket server from scratch — zero dependencies. Reads RFC 7230 and RFC 6455 directly into code.

## What's built

**HTTP/1.1**
- Request parser: method, path, query string, headers, body (JSON auto-parsed)
- Response builder: status codes, keep-alive connections, gzip compression via zlib
- Router: parametric routes (`:id`), middleware chain, `next()`
- Built-in middleware: `logger`, `cors()`, `rateLimit()`, `requestId`

**WebSocket (RFC 6455)**
- Full handshake: SHA-1 `Sec-WebSocket-Accept` computation
- Frame encoder/decoder: all payload lengths (< 126, < 65536, 64-bit), client-side masking
- `WSSocket` class: `on('message')`, `on('close')`, `send()`, `close()`
- `app.ws(path, handler)` — register WebSocket endpoints alongside HTTP routes

**Server-Sent Events**
- `res.sse()` — returns a stream object with `send(event, data)` and `comment()`
- Used for live push without polling

**auth.js — JWT HS256**
- `sign(payload, secret, { expiresIn })` — HMAC-SHA256, base64url encoded
- `verify(token, secret)` — timing-safe signature compare, checks `exp`
- `middleware(secret)` — reads `Authorization: Bearer <token>`, sets `req.user`
- Zero dependencies — uses Node's built-in `crypto`

## Demo: Task Manager API

```bash
node demo.js
```

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | — | Returns JWT token |
| GET | `/auth/me` | Bearer | Current user |
| GET | `/tasks` | Bearer | List tasks (`?status=todo&priority=high&q=search`) |
| POST | `/tasks` | Bearer | Create task |
| PUT | `/tasks/:id` | Bearer | Update task |
| DELETE | `/tasks/:id` | Bearer | Delete task |
| GET | `/events` | — | SSE live feed (task:created / updated / deleted) |
| WS | `/chat` | — | WebSocket chat room |
| GET | `/health` | — | Uptime, task count, connection counts |

```bash
# Login and get token
TOKEN=$(curl -s -X POST localhost:4000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | jq -r .token)

# Create a task
curl -X POST localhost:4000/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Ship it","priority":"high"}'

# Connect to SSE stream
curl -N localhost:4000/events

# Connect to WebSocket chat
wscat -c ws://localhost:4000/chat
> {"type":"join","username":"hadi"}
> {"type":"message","text":"hello"}
```

## Using as a framework

```javascript
const { App, logger, cors, rateLimit } = require('./server')
const { sign, middleware: jwtAuth }    = require('./auth')

const app = new App()

app.use(logger)
app.use(cors())
app.use(rateLimit({ windowMs: 60000, max: 100 }))

app.get('/users/:id', jwtAuth('secret'), (req, res) => {
  res.json({ id: req.params.id, user: req.user })
})

// WebSocket endpoint
app.ws('/live', (ws, req) => {
  ws.on('message', msg => ws.send(`echo: ${msg}`))
  ws.on('close', () => console.log('disconnected'))
})

// SSE endpoint
app.get('/stream', (req, res) => {
  const stream = res.sse()
  setInterval(() => stream.send('tick', { time: Date.now() }), 1000)
})

app.listen(3000, () => console.log('listening on :3000'))
```
