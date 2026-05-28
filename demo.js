'use strict'
// nanohttp demo — Task Manager API
// Auth:    POST /auth/login → JWT token
// Tasks:   CRUD at /tasks (Bearer token required)
// SSE:     GET /events (live task feed)
// WS:      ws://localhost:4000/chat (real-time chat room)
// Health:  GET /health

const { App, logger, cors, rateLimit, requestId } = require('./server')
const { sign, middleware: jwtAuth }               = require('./auth')

const SECRET = process.env.JWT_SECRET || 'nanohttp-dev-secret-change-in-prod'
const app    = new App()

// ── In-memory store ───────────────────────────────────────────────────────────

const users = new Map([
  ['admin', { id: 1, username: 'admin', password: 'admin123', role: 'admin' }],
  ['user',  { id: 2, username: 'user',  password: 'user123',  role: 'user'  }],
])

const tasks     = new Map()
let   taskSeq   = 1
const ssePool   = new Set()   // active SSE streams
const wsPool    = new Set()   // active WebSocket connections

// ── Helpers ───────────────────────────────────────────────────────────────────

function broadcast(event, data) {
  for (const stream of ssePool) {
    if (stream.closed) { ssePool.delete(stream); continue }
    stream.send(event, data)
  }
}

// ── Middleware stack ──────────────────────────────────────────────────────────

app.use(requestId)
app.use(logger)
app.use(cors())
app.use(rateLimit({ windowMs: 60_000, max: 500 }))

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {}
  const user = users.get(username)
  if (!user || user.password !== password)
    return res.status(401).json({ error: 'Invalid credentials' })
  const token = sign(
    { sub: user.id, username: user.username, role: user.role },
    SECRET,
    { expiresIn: 86_400 }
  )
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } })
})

app.get('/auth/me', jwtAuth(SECRET), (req, res) => {
  res.json({ user: req.user })
})

// ── Tasks ─────────────────────────────────────────────────────────────────────

app.get('/tasks', jwtAuth(SECRET), (req, res) => {
  let list = [...tasks.values()]
  const { status, priority, q } = req.query
  if (status)   list = list.filter(t => t.status   === status)
  if (priority) list = list.filter(t => t.priority === priority)
  if (q)        list = list.filter(t =>
    t.title.includes(q) || (t.description || '').includes(q)
  )
  res.json({ tasks: list, total: list.length })
})

app.post('/tasks', jwtAuth(SECRET), (req, res) => {
  const { title, description, priority = 'medium', dueDate } = req.body || {}
  if (!title) return res.status(400).json({ error: 'title is required' })
  const task = {
    id:          taskSeq++,
    title,
    description: description || '',
    priority,
    status:      'todo',
    dueDate:     dueDate || null,
    createdBy:   req.user.username,
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  }
  tasks.set(task.id, task)
  broadcast('task:created', task)
  res.json(task, 201)
})

app.get('/tasks/:id', jwtAuth(SECRET), (req, res) => {
  const task = tasks.get(Number(req.params.id))
  task ? res.json(task) : res.status(404).json({ error: 'Task not found' })
})

app.put('/tasks/:id', jwtAuth(SECRET), (req, res) => {
  const task = tasks.get(Number(req.params.id))
  if (!task) return res.status(404).json({ error: 'Task not found' })
  const { title, description, priority, status, dueDate } = req.body || {}
  if (title)       task.title       = title
  if (description !== undefined) task.description = description
  if (priority)    task.priority    = priority
  if (status)      task.status      = status
  if (dueDate !== undefined) task.dueDate = dueDate
  task.updatedAt = new Date().toISOString()
  broadcast('task:updated', task)
  res.json(task)
})

app.delete('/tasks/:id', jwtAuth(SECRET), (req, res) => {
  const id = Number(req.params.id)
  if (!tasks.has(id)) return res.status(404).json({ error: 'Task not found' })
  tasks.delete(id)
  broadcast('task:deleted', { id })
  res.status(204).text('')
})

// ── SSE — live event feed ─────────────────────────────────────────────────────

app.get('/events', (req, res) => {
  const stream = res.sse()
  if (!stream) return
  ssePool.add(stream)
  stream.send('connected', { clientCount: ssePool.size, time: new Date().toISOString() })
  const ping = setInterval(() => {
    if (stream.closed) { clearInterval(ping); ssePool.delete(stream) }
    else stream.comment('ping')
  }, 20_000)
})

// ── WebSocket chat room ───────────────────────────────────────────────────────

app.ws('/chat', (ws, req) => {
  let username = 'anonymous'
  wsPool.add(ws)

  const emit = (msg) => {
    for (const client of wsPool) client.send(msg)
  }

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch(_) { return }

    if (msg.type === 'join') {
      username = (msg.username || 'anonymous').slice(0, 32)
      emit({ type: 'system', text: `${username} joined`, time: Date.now(), online: wsPool.size })
    } else if (msg.type === 'message' && msg.text) {
      emit({ type: 'message', from: username, text: String(msg.text).slice(0, 1000), time: Date.now() })
    }
  })

  ws.on('close', () => {
    wsPool.delete(ws)
    emit({ type: 'system', text: `${username} left`, time: Date.now(), online: wsPool.size })
  })
})

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    uptime:  Math.round(process.uptime()),
    version: process.version,
    tasks:   tasks.size,
    connections: { sse: ssePool.size, ws: wsPool.size },
  })
})

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(4000, () => {
  console.log('\n  nanohttp — Task Manager API  :4000\n')
  console.log('  Auth')
  console.log('    POST /auth/login    {"username":"admin","password":"admin123"}')
  console.log('    GET  /auth/me       Bearer <token>\n')
  console.log('  Tasks  (Bearer token required)')
  console.log('    GET    /tasks       ?status=todo&priority=high&q=search')
  console.log('    POST   /tasks       {"title":"...","priority":"high"}')
  console.log('    GET    /tasks/:id')
  console.log('    PUT    /tasks/:id   {"status":"done"}')
  console.log('    DELETE /tasks/:id\n')
  console.log('  Real-time')
  console.log('    GET /events         SSE stream  (task:created / task:updated / task:deleted)')
  console.log('    WS  /chat           WebSocket chat  ({type:"join",username:"x"} then {type:"message",text:"hi"})\n')
  console.log('  GET /health\n')
})
