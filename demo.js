'use strict'
// nanohttp demo — fully working REST API for a note-taking app.
// Test: curl localhost:4000/notes

const { App, logger, cors } = require('./server')

const app   = new App()
const notes = new Map()
let   seq   = 1

app.use(logger)
app.use(cors)

app.get('/health', (req, res) => {
  res.json({ status: 'ok', notes: notes.size })
})

app.get('/notes', (req, res) => {
  const list = [...notes.values()]
  const { q } = req.query
  res.json(q ? list.filter(n => n.body.includes(q) || n.title.includes(q)) : list)
})

app.get('/notes/:id', (req, res) => {
  const note = notes.get(Number(req.params.id))
  note ? res.json(note) : res.status(404).json({ error: 'not found' })
})

app.post('/notes', (req, res) => {
  const { title, body } = req.body || {}
  if (!title || !body) return res.status(400).json({ error: 'title and body required' })
  const note = { id: seq++, title, body, createdAt: new Date().toISOString() }
  notes.set(note.id, note)
  res.json(note, 201)
})

app.put('/notes/:id', (req, res) => {
  const id   = Number(req.params.id)
  const note = notes.get(id)
  if (!note) return res.status(404).json({ error: 'not found' })
  Object.assign(note, req.body, { updatedAt: new Date().toISOString() })
  res.json(note)
})

app.delete('/notes/:id', (req, res) => {
  const id = Number(req.params.id)
  notes.has(id) ? (notes.delete(id), res.status(204).text('')) : res.status(404).json({ error: 'not found' })
})

app.listen(4000, () => {
  console.log('\n  nanohttp demo on :4000\n')
  console.log('  GET    /notes')
  console.log('  POST   /notes        {"title":"...","body":"..."}')
  console.log('  GET    /notes/:id')
  console.log('  PUT    /notes/:id')
  console.log('  DELETE /notes/:id')
  console.log('  GET    /health\n')
})
