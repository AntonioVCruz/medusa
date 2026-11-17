import { readFileSync, writeFileSync } from "node:fs"

const state = new URL("./.runtime/", import.meta.url)
const entries = readFileSync(new URL("environment.env", state), "utf8")
  .trim()
  .split(/\r?\n/)
  .map((line) => {
    const separator = line.indexOf("=")
    return [line.slice(0, separator), line.slice(separator + 1)]
  })
const environment = Object.fromEntries(entries)
writeFileSync(
  new URL("variables.json", state),
  JSON.stringify({
    adminEmail: environment.E2E_ADMIN_EMAIL,
    adminPassword: environment.E2E_ADMIN_PASSWORD,
  }),
  { mode: 0o600 }
)
