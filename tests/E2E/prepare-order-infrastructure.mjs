import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const directory = path.dirname(fileURLToPath(import.meta.url))
const statePath = process.env.MEDUSA_E2E_ORDER_STATE || path.join(directory, ".runtime/order-infrastructure.json")
const base = (process.env.MEDUSA_E2E_URL || "http://127.0.0.1:19000/app").replace(/\/app\/?$/, "").replace(/\/$/, "")
const owner = "medusa-admin-e2e-08-09"
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { owner, base }
if (state.owner !== owner || state.base !== base) throw new Error("Order infrastructure belongs to another target")
let bearer
function checkpoint() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n")
}
async function api(route, body, method = body === undefined ? "GET" : "POST", missing = false) {
  const response = await fetch(base + route, {
    method,
    headers: { "Content-Type": "application/json", Origin: base, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  if (missing && response.status === 404) return null
  if (!response.ok) throw new Error(`${method} ${route.split("?")[0]} failed: HTTP ${response.status}`)
  return response.json()
}
async function owned(resource, key) {
  const result = await api(`/admin/${resource}?limit=100`)
  return result[key].filter((item) => item.metadata?.e2e_owner === owner && item.created_at >= state.started_at)
}
async function cleanup() {
  const orders = await owned("orders", "orders")
  for (const summary of orders) {
    const order = (await api(`/admin/orders/${summary.id}?fields=id,status,metadata,*items,*fulfillments`)).order
    if (order.status !== "canceled") {
      await api(`/admin/orders/${order.id}`, { metadata: { ...order.metadata, e2e_retired: true } })
    }
    const shipped = order.fulfillments.some((fulfillment) => fulfillment.shipped_at && !fulfillment.canceled_at)
    if (!shipped && order.status !== "canceled") {
      for (const fulfillment of order.fulfillments.filter((item) => !item.canceled_at)) {
        await api(`/admin/orders/${order.id}/fulfillments/${fulfillment.id}/cancel`, {})
      }
      await api(`/admin/orders/${order.id}/cancel`, {})
    }
    const lineIds = order.items.map((item) => item.id)
    const reservations = (await api("/admin/reservations?limit=100")).reservations
    for (const reservation of reservations.filter((item) => lineIds.includes(item.line_item_id))) {
      await api(`/admin/reservations/${reservation.id}`, undefined, "DELETE")
    }
  }
  const drafts = (await api("/admin/draft-orders?limit=100")).draft_orders
  for (const draft of drafts.filter((item) => item.metadata?.e2e_owner === owner && item.created_at >= state.started_at)) {
    await api(`/admin/draft-orders/${draft.id}`, undefined, "DELETE")
  }
  const promotions = (await api("/admin/promotions?limit=100")).promotions
  for (const promotion of promotions.filter((item) => /^e2etc08promo[a-z]{16}$/.test(item.code) && item.created_at >= state.started_at)) {
    await api(`/admin/promotions/${promotion.id}`, undefined, "DELETE")
  }
  for (const [resource, key] of [["products", "products"], ["customers", "customers"], ["inventory-items", "inventory_items"]]) {
    for (const item of await owned(resource, key)) {
      if (resource === "inventory-items") {
        const reservations = (await api("/admin/reservations?limit=100")).reservations
        for (const reservation of reservations.filter((entry) => entry.inventory_item_id === item.id)) {
          await api(`/admin/reservations/${reservation.id}`, undefined, "DELETE")
        }
      }
      await api(`/admin/${resource}/${item.id}`, undefined, "DELETE")
    }
  }
  state.cleaned_at = new Date().toISOString()
  checkpoint()
  return { state: "cleaned", retained_order_ids: orders.map((item) => item.id), retained_infrastructure: state.variables }
}
async function main() {
  const credentials = process.env.E2E_ADMIN_PASSWORD
    ? { adminEmail: process.env.E2E_ADMIN_EMAIL, adminPassword: process.env.E2E_ADMIN_PASSWORD }
    : JSON.parse(fs.readFileSync(path.join(directory, ".runtime/variables.json"), "utf8"))
  bearer = (await api("/auth/user/emailpass", { email: credentials.adminEmail, password: credentials.adminPassword })).token
  const action = process.argv[2] || "prepare"
  if (action === "cleanup") {
    if (!state.started_at) throw new Error("Missing run boundary for cleanup")
    console.log(JSON.stringify(await cleanup()))
    return
  }
  if (action === "check") {
    const orders = await owned("orders", "orders")
    if (orders.length !== 1) throw new Error("Expected one test-owned partial fulfillment order")
    const order = (await api(`/admin/orders/${orders[0].id}?fields=*items,*items.detail,*fulfillments,*fulfillments.items`)).order
    const line = order.items[0]
    if (Number(line.quantity) !== 3 || Number(line.detail.fulfilled_quantity) !== 2 || Number(line.detail.shipped_quantity) !== 2) {
      throw new Error("Partial order quantities do not match ordered 3 / fulfilled 2 / shipped 2")
    }
    if (order.fulfillments.length !== 1 || !order.fulfillments[0].shipped_at) throw new Error("Expected one shipped fulfillment")
    const products = await owned("products", "products")
    if (products.length) throw new Error("Cases did not remove their test products")
    console.log(JSON.stringify({ state: "verified", order_id: order.id, ordered: 3, fulfilled: 2, shipped: 2, unfulfilled: 1, new_products_remaining: 0 }))
    return
  }
  if (action !== "prepare") throw new Error("Expected prepare, check or cleanup")
  if (state.started_at) {
    for (const [resource, key] of [["products", "products"], ["customers", "customers"], ["inventory-items", "inventory_items"]]) {
      if ((await owned(resource, key)).length) throw new Error("Clean the preceding order fixtures before preparing another run")
    }
  }
  const regions = (await api("/admin/regions?limit=100")).regions
  const region = regions.find((item) => item.name === "E2E EUR region" && item.metadata?.e2e_owner === "medusa-admin-e2e-04-07")
  if (!region || region.currency_code !== "eur") throw new Error("Prepare the commerce fixture's owned EUR region first")
  const store = (await api("/admin/stores")).stores[0]
  const profiles = (await api("/admin/shipping-profiles?limit=100")).shipping_profiles
  const profile = profiles.find((item) => item.type === "default")
  if (!profile) throw new Error("Missing default shipping profile")
  const providers = (await api("/admin/fulfillment-providers?limit=100")).fulfillment_providers
  const provider = providers.find((item) => item.id === "manual_manual")
  if (!provider) throw new Error("Missing built-in manual fulfillment provider")
  const name = "E2E partial fulfillment warehouse"
  const locations = (await api("/admin/stock-locations?limit=100&fields=*fulfillment_sets,*fulfillment_sets.service_zones,metadata,name")).stock_locations
  let location = locations.find((item) => item.name === name)
  if (location && location.metadata?.e2e_owner !== owner) throw new Error("Warehouse name is owned by another fixture")
  if (!location) location = (await api("/admin/stock-locations", { name, metadata: { e2e_owner: owner } })).stock_location
  state.location_id = location.id
  checkpoint()
  await api(`/admin/stock-locations/${location.id}/sales-channels`, { add: [store.default_sales_channel_id] })
  await api(`/admin/stock-locations/${location.id}/fulfillment-providers`, { add: [provider.id] })
  let fulfillmentSet = location.fulfillment_sets?.find((item) => item.name === "E2E partial shipping")
  if (!fulfillmentSet) {
    const result = await api(`/admin/stock-locations/${location.id}/fulfillment-sets?fields=*fulfillment_sets`, { name: "E2E partial shipping", type: "shipping" })
    fulfillmentSet = result.stock_location.fulfillment_sets.find((item) => item.name === "E2E partial shipping")
  }
  let zone = fulfillmentSet.service_zones?.find((item) => item.name === "E2E DE shipping")
  if (!zone) {
    const result = await api(`/admin/fulfillment-sets/${fulfillmentSet.id}/service-zones`, { name: "E2E DE shipping", geo_zones: [{ type: "country", country_code: "de" }] })
    zone = result.fulfillment_set.service_zones.find((item) => item.name === "E2E DE shipping")
  }
  let option = (await api("/admin/shipping-options?limit=100")).shipping_options.find((item) => item.name === "E2E manual shipping" && item.service_zone_id === zone.id)
  if (!option) option = (await api("/admin/shipping-options", {
    name: "E2E manual shipping", service_zone_id: zone.id, shipping_profile_id: profile.id,
    provider_id: provider.id, price_type: "flat", type: { label: "E2E manual", description: "Isolated E2E shipping", code: "e2e-manual" },
    prices: [{ currency_code: "eur", amount: 0 }], rules: [], data: {},
  })).shipping_option
  state.variables = {
    e2eApiBase: base, e2eOrderRegionId: region.id, e2eOrderChannelId: store.default_sales_channel_id,
    e2eFulfillmentLocationId: location.id, e2eFulfillmentWarehouse: name,
    e2eShippingOptionId: option.id, e2eShippingOption: option.name, e2eShippingProfileId: profile.id,
  }
  state.started_at = new Date().toISOString()
  checkpoint()
  console.log(JSON.stringify({ state: "prepared", variables: state.variables }))
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
