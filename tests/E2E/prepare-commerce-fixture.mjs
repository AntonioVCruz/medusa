import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const directory = path.dirname(fileURLToPath(import.meta.url))
const statePath =
  process.env.MEDUSA_E2E_FIXTURE_STATE ||
  path.join(directory, ".runtime/commerce-fixture.json")
const base = (process.env.MEDUSA_E2E_URL || "http://127.0.0.1:19000/app")
  .replace(/\/app\/?$/, "")
  .replace(/\/$/, "")
const owner = "medusa-admin-e2e-04-07"
const names = {
  e2eRegion: "E2E EUR region",
  e2eWarehouse: "E2E reservation warehouse",
  e2eInventory: "E2E reservation item",
  e2eSku: "e2e-reservation-sku",
  e2eGroup: "E2E membership group",
  e2eCustomer: "e2e-membership@medusa-e2e.test",
  e2eDraftCustomer: "e2e-draft@medusa-e2e.test",
  e2eDraftItem: "E2E draft item",
}
let bearer
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { owner, base, records: [] }
if (state.owner !== owner || state.base !== base) {
  throw new Error("Fixture state belongs to another target")
}
function checkpoint() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n")
}
async function api(route, body, method = body === undefined ? "GET" : "POST", missing = false) {
  const response = await fetch(base + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  if (missing && response.status === 404) return null
  if (!response.ok) {
    throw new Error(`${method} ${route.split("?")[0]} failed: HTTP ${response.status}`)
  }
  return response.json()
}
async function create(resource, payload, responseKey) {
  const result = await api(`/admin/${resource}`, { ...payload, metadata: { e2e_owner: owner } })
  const record = result[responseKey]
  state.records.push({ resource, id: record.id })
  checkpoint()
  return record
}
async function infrastructure(resource, name, payload, responseKey, listKey) {
  const found = (await api(`/admin/${resource}?limit=100`))[listKey].filter((item) => item.name === name)
  if (found.length > 1 || (found[0] && found[0].metadata?.e2e_owner !== owner)) {
    throw new Error("Fixture name collides with an unowned record")
  }
  const record = found[0] || (await api(`/admin/${resource}`, { name, ...payload, metadata: { e2e_owner: owner } }))[responseKey]
  return record.id
}
async function main() {
  const credentials = process.env.E2E_ADMIN_PASSWORD
    ? { adminEmail: process.env.E2E_ADMIN_EMAIL, adminPassword: process.env.E2E_ADMIN_PASSWORD }
    : JSON.parse(fs.readFileSync(path.join(directory, ".runtime/variables.json"), "utf8"))
  bearer = (await api("/auth/user/emailpass", { email: credentials.adminEmail, password: credentials.adminPassword })).token
  const action = process.argv[2] || "prepare"
  if (action === "prepare") {
    if (state.records.length) throw new Error("Clean the previous test-owned fixture before preparing another run")
    state.variables = names
    state.started_at = new Date().toISOString()
    state.baseline_products = (await api("/admin/products?limit=100")).products.map((item) => item.id)
    state.region_id = await infrastructure("regions", names.e2eRegion,
      { currency_code: "eur", countries: ["de"], automatic_taxes: false, is_tax_inclusive: false, payment_providers: ["pp_system_default"] }, "region", "regions")
    state.location_id = await infrastructure("stock-locations", names.e2eWarehouse, {}, "stock_location", "stock_locations")
    checkpoint()
    const item = await create("inventory-items", { title: names.e2eInventory, sku: names.e2eSku }, "inventory_item")
    state.inventory_id = item.id
    await api(`/admin/inventory-items/${item.id}/location-levels`, { location_id: state.location_id, stocked_quantity: 10 })
    state.customer_id = (await create("customers", { email: names.e2eCustomer, first_name: "E2E", last_name: "Membership" }, "customer")).id
    state.group_id = (await create("customer-groups", { name: names.e2eGroup }, "customer_group")).id
    const draftCustomer = await create("customers", { email: names.e2eDraftCustomer, first_name: "E2E", last_name: "Draft" }, "customer")
    const channel = (await api("/admin/stores")).stores[0].default_sales_channel_id
    const address = { first_name: "E2E", last_name: "Draft", address_1: "1 Test Street", city: "Berlin", postal_code: "10115", country_code: "de" }
    state.draft_id = (await create("draft-orders", { region_id: state.region_id, sales_channel_id: channel, customer_id: draftCustomer.id,
      shipping_address: address, billing_address: address, items: [{ title: names.e2eDraftItem, unit_price: 25, quantity: 2, requires_shipping: false, is_discountable: false }] }, "draft_order")).id
    checkpoint()
    const draft = (await api(`/admin/draft-orders/${state.draft_id}?fields=+total,+tax_total,+shipping_total,+items.*`)).draft_order
    if (Number(draft.total) !== 50 || Number(draft.tax_total) !== 0 || Number(draft.shipping_total) !== 0) throw new Error("Draft seed is not the expected EUR 50 baseline")
    console.log(JSON.stringify({ state: "prepared", variables: names, region_id: state.region_id, location_id: state.location_id }))
  } else if (action === "inspect") {
    const draft = (await api(`/admin/draft-orders/${state.draft_id}?fields=+total,+tax_total,+shipping_total,+items.*`)).draft_order
    const item = (await api(`/admin/inventory-items/${state.inventory_id}`)).inventory_item
    console.log(JSON.stringify({ variables: names, region_id: state.region_id, location_id: state.location_id, draft: { total: draft.total, tax_total: draft.tax_total, shipping_total: draft.shipping_total, items: draft.items?.map((line) => ({ title: line.title, quantity: line.quantity, unit_price: line.unit_price })) }, inventory: item.location_levels }))
  } else if (action === "check") {
    const products = (await api("/admin/products?limit=100")).products
    const remaining = products.filter((entry) => !state.baseline_products.includes(entry.id))
    if (remaining.length) throw new Error("Product lifecycle left new products in the catalog")
    const item = (await api(`/admin/inventory-items/${state.inventory_id}`)).inventory_item
    const level = item.location_levels.find((entry) => entry.location_id === state.location_id)
    if (Number(level.stocked_quantity) !== 10 || Number(level.reserved_quantity) !== 0 || Number(level.available_quantity) !== 10) throw new Error("Reservation did not restore the initial stock")
    const draft = (await api(`/admin/draft-orders/${state.draft_id}?fields=+total,+tax_total,+shipping_total,+items.*`)).draft_order
    if (Number(draft.total) !== 75 || Number(draft.items[0].quantity) !== 3) throw new Error("Draft edit did not persist expected quantity/total")
    const customer = (await api(`/admin/customers/${state.customer_id}?fields=*groups`)).customer
    if (customer.groups.some((group) => group.id === state.group_id)) throw new Error("Customer membership was not removed")
    console.log(JSON.stringify({ state: "verified", stock: 10, available: 10, reserved: 0, draft_total: 75, membership_removed: true, customer_preserved: true }))
  } else if (action === "cleanup") {
    const reservations = (await api("/admin/reservations?limit=100")).reservations
    for (const reservation of reservations.filter((entry) => entry.inventory_item_id === state.inventory_id)) {
      await api(`/admin/reservations/${reservation.id}`, undefined, "DELETE")
    }
    const products = (await api("/admin/products?limit=100")).products
    for (const product of products.filter((entry) => !state.baseline_products?.includes(entry.id) && /^e2etc04[a-z]{16}$/.test(entry.title) && entry.created_at >= state.started_at)) {
      await api(`/admin/products/${product.id}`, undefined, "DELETE")
    }
    while (state.records.length) {
      const record = state.records[state.records.length - 1]
      await api(`/admin/${record.resource}/${record.id}`, undefined, "DELETE", true)
      state.records.pop()
      checkpoint()
    }
    console.log(JSON.stringify({ state: "cleaned", retained_infrastructure: [state.region_id, state.location_id] }))
  } else throw new Error("Expected prepare, inspect, check or cleanup")
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
