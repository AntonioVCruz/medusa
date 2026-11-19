// HTTP-only probe for the exact pinned CLI tunnel; no suite API or browser run.
const fs = require("node:fs")
const path = require("node:path")
const http = require("node:http")
const net = require("node:net")
const dns = require("node:dns/promises")
const crypto = require("node:crypto")
const cp = require("node:child_process")
const { createRequire } = require("node:module")

function tcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const started = Date.now()
    const finish = (result) => {
      socket.destroy()
      resolve({ host, port, duration_ms: Date.now() - started, ...result })
    }
    socket.once("connect", () => finish({ connected: true }))
    socket.once("error", (error) => finish({ connected: false, error: error.code }))
    socket.setTimeout(8000, () => finish({ connected: false, error: "TIMEOUT" }))
  })
}

function probe(target, expected, proxy) {
  return new Promise((resolve) => {
    const url = new URL(target)
    const started = Date.now()
    let connected = false
    const options = proxy
      ? { hostname: proxy.host, port: proxy.port, path: target, headers: { Host: url.host } }
      : { hostname: url.hostname, port: url.port, path: url.pathname }
    const request = http.get({ ...options, agent: false }, (response) => {
      let body = ""
      response.on("data", (chunk) => { body += chunk.toString().slice(0, 4096) })
      response.on("error", (error) => finish({ error: error.code }))
      response.on("end", () => finish({
        http: response.statusCode,
        sentinel_matches: body === expected,
        passed: response.statusCode === 200 && body === expected,
      }))
    })
    const timer = setTimeout(() => request.destroy(new Error("TIMEOUT")), 10000)
    const finish = (result) => {
      clearTimeout(timer)
      resolve({ target, via: proxy ? "tunnel" : "direct", tcp_connected: connected,
        duration_ms: Date.now() - started, ...result })
    }
    request.on("socket", (socket) => socket.once("connect", () => { connected = true }))
    request.on("error", (error) => finish({ passed: false, error: error.code || error.message }))
  })
}

async function main() {
  const report = { timestamp: new Date().toISOString(), cli_version: null,
    cloud_runs: 0, suite_api_calls: 0, registration_succeeded: false, results: [] }
  const sentinel = "medusa-http-probe-" + crypto.randomBytes(16).toString("hex")
  const server = http.createServer((request, response) => response.end(sentinel))
  const children = []
  const spawn = cp.spawn
  let tunnel
  let deadline
  // Capture only processes created by this isolated diagnostic for bounded cleanup.
  cp.spawn = function (...args) {
    const child = spawn.apply(this, args)
    if (path.basename(String(args[0])).match(/^trtc(?:\.exe)?$/)) {
      children.push(child)
    }
    return child
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const port = server.address().port
    const targets = ["127.0.0.1", "localhost"].map((host) => `http://${host}:${port}/app`)
    report.results.push(...await Promise.all(targets.map((target) => probe(target, sentinel))))
    const requireCli = createRequire(process.env.TESTRIGOR_CLI_PACKAGE)
    const version = requireCli("./package.json").version
    report.cli_version = version
    if (version !== "3.0.0") throw new Error("Unexpected CLI version")
    const Tunnel = requireCli("./dist/util/tunnel.js").default
    tunnel = new Tunnel()
    await Promise.race([
      (async () => {
        await tunnel.initialize()
        await tunnel.start(47000, 47999)
      })(),
      new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Tunnel startup timeout")), 90000)
      }),
    ])
    clearTimeout(deadline)
    report.registration_succeeded = true
    report.proxy_port = tunnel.getPort()
    const host = "tunnel.testrigor.com"
    report.proxy_dns = await dns.lookup(host, { all: true })
    report.tcp = await Promise.all([tcp(host, 443), tcp(host, tunnel.getPort())])
    report.results.push(...await Promise.all(targets.map((target) =>
      probe(target, sentinel, { host, port: tunnel.getPort() }))))
    report.http_tunnel_passed = report.results.some((result) => result.via === "tunnel" && result.passed)
    if (!report.http_tunnel_passed) process.exitCode = 1
  } catch (error) {
    report.error = error.code || error.message
    process.exitCode = 1
  } finally {
    clearTimeout(deadline)
    await tunnel?.stop()
    for (const child of children) child.kill("SIGINT")
    cp.spawn = spawn
    await new Promise((resolve) => server.close(resolve))
    const output = path.join(__dirname, ".run/tunnel-diagnostic.json")
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n")
    console.log(JSON.stringify(report, null, 2))
  }
}

module.exports = { tcp, probe }
if (require.main === module) main().catch(() => { process.exitCode = 1 })
