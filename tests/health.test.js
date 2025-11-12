const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

process.env.NODE_ENV = "test";
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    "postgres://postgres:postgres@localhost:5432/testdb";
}

const { app, pool } = require("../server");
const packageJson = require("../package.json");

test("GET /health reports ok status", async (t) => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [{ result: 1 }] });

  const server = app.listen(0);
  t.after(() => server.close());
  t.after(() => {
    pool.query = originalQuery;
  });

  await once(server, "listening");
  const port = server.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await response.json();

  assert.equal(response.status, 200, "health route should return HTTP 200");
  assert.equal(body.status, "ok");
  assert.equal(body.database, "connected");
  assert.equal(body.version, packageJson.version);
});
