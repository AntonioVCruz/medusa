import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

const state = new URL("./.runtime/", import.meta.url)
const environmentPath = new URL("environment.env", state)
const entries = (existsSync(environmentPath)
  ? readFileSync(environmentPath, "utf8").trim().split(/\r?\n/)
  : [])
  .map((line) => {
    const separator = line.indexOf("=")
    return [line.slice(0, separator), line.slice(separator + 1)]
  })
const environment = Object.fromEntries(entries)
const adminEmail = process.env.E2E_ADMIN_EMAIL || environment.E2E_ADMIN_EMAIL
const adminPassword = process.env.E2E_ADMIN_PASSWORD || environment.E2E_ADMIN_PASSWORD
if (!adminEmail || !adminPassword) {
  throw new Error("Fixture administrator credentials are required")
}
const fixturePath =
  process.env.MEDUSA_E2E_FIXTURE_STATE || new URL("commerce-fixture.json", state)
const commerce = existsSync(fixturePath)
  ? JSON.parse(readFileSync(fixturePath, "utf8")).variables || {}
  : {}
const orderPath =
  process.env.MEDUSA_E2E_ORDER_STATE || new URL("order-infrastructure.json", state)
const orders = existsSync(orderPath)
  ? JSON.parse(readFileSync(orderPath, "utf8")).variables || {}
  : {}
mkdirSync(state, { recursive: true })
writeFileSync(
  new URL("variables.json", state),
  JSON.stringify({
    ...commerce,
    ...orders,
    adminEmail,
    adminPassword,
  }),
  { mode: 0o600 }
)
