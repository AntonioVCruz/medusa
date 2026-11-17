import { defineConfig } from "@medusajs/framework/utils"

module.exports = defineConfig({
  admin: { disable: false },
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: "http://127.0.0.1:19000",
      adminCors: "http://127.0.0.1:19000",
      authCors: "http://127.0.0.1:19000",
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    },
  },
})
