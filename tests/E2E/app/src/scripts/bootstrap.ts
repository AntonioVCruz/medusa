import type { ExecArgs } from "@medusajs/framework/types"
import { MedusaModule } from "@medusajs/framework/modules-sdk"
import {
  Modules,
  MedusaError,
  RBAC_SUPER_ADMIN_ROLE_ID,
} from "@medusajs/framework/utils"
import { createUsersWorkflow } from "@medusajs/medusa/core-flows"

export default async function bootstrap({ container }: ExecArgs) {
  const email = process.env.E2E_ADMIN_EMAIL!
  const password = process.env.E2E_ADMIN_PASSWORD!
  if (!email || !password) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "E2E administrator credentials are required"
    )
  }

  const users = container.resolve(Modules.USER)
  const auth = container.resolve(Modules.AUTH)
  const existing = await users.listUsers({ email })
  if (existing.length) {
    const result = await auth.authenticate("emailpass", {
      body: { email, password },
    })
    if (!result.success) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Existing E2E administrator credentials do not match"
      )
    }
    return
  }

  const roles = MedusaModule.isInstalled(Modules.RBAC)
    ? await container
        .resolve(Modules.RBAC)
        .listRbacRoles({ id: RBAC_SUPER_ADMIN_ROLE_ID })
    : []
  const { result } = await createUsersWorkflow(container).run({
    input: {
      users: [{ email, roles: roles.map((role) => ({ role_id: role.id })) }],
    },
  })
  const registered = await auth.register("emailpass", {
    body: { email, password },
  })
  if (!registered.success || !registered.authIdentity) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Could not register the E2E administrator"
    )
  }
  await auth.updateAuthIdentities({
    id: registered.authIdentity.id,
    app_metadata: { user_id: result[0].id },
  })
}
