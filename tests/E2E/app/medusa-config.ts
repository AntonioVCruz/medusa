import { defineConfig } from "@medusajs/framework/utils"

const corsOrigins = [
  "http://127.0.0.1:19000",
  "http://localhost:19000",
  "http://localhost:18443",
  "https://localhost:18443",
].join(",")

module.exports = defineConfig({
  admin: { disable: false },
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: corsOrigins,
      adminCors: corsOrigins,
      authCors: corsOrigins,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    },
  },
})
