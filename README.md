# nanohttp

HTTP/1.1 server from scratch — zero dependencies. Reads RFC 7230 directly into code.

## What's built

- **HTTP/1.1 parser** — method, path, query string, headers, body (JSON auto-parsed)
- **Router** — path params (`:id`), wildcard routes, method matching
- **Middleware chain** — composable `(req, res, next)` functions
- **Keep-alive** — persistent connections, multiple requests per socket
- **Response helpers** — `res.json()`, `res.text()`, `res.html()`, `res.file()`, `res.status(code)`
- **Built-in middleware** — `logger` (method + path + status + latency), `cors`

## Run

```bash
node demo.js
```

Starts a fully working REST API for a notes app on port 4000.

```bash
curl -X POST localhost:4000/notes \
  -H 'Content-Type: application/json' \
  -d '{"title":"Hello","body":"World"}'

curl localhost:4000/notes
curl localhost:4000/notes/1
curl -X DELETE localhost:4000/notes/1
```

## Use in your own code

```javascript
const { App, logger, cors } = require('./server')

const app = new App()
app.use(logger)
app.use(cors)

app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id })
})

app.post('/users', (req, res) => {
  const { name } = req.body
  res.json({ id: 1, name }, 201)
})

app.listen(3000, () => console.log('listening on :3000'))
```
