/**
 * Seed roles & permissions for MediPOS Pro.
 * - Upserts all 48 catalog permissions
 * - Creates the 3 system roles (Super Admin / Pharmacist / Cashier) with default grants
 * - Links existing users to their role by the legacy `role` slug
 * Re-runnable.
 *
 * Run: bunx tsx scripts/seed-roles.ts
 */
import { PrismaClient } from '@prisma/client'
import { ALL_PERMISSIONS, SYSTEM_ROLE_PERMISSIONS } from '../src/lib/permissions'

const db = new PrismaClient()

const SYSTEM_ROLES = [
  {
    slug: 'admin',
    name: 'Super Admin',
    description: 'Unrestricted access to every module, setting and permission. This role cannot be modified or deleted.',
  },
  {
    slug: 'pharmacist',
    name: 'Pharmacist',
    description: 'Pharmacy management: inventory, purchases, prescriptions, stock takes, reports and POS.',
  },
  {
    slug: 'cashier',
    name: 'Cashier',
    description: 'Front-of-house: POS terminal, own shifts, sales, customers and medicine lookup.',
  },
] as const

async function main() {
  // 1. Upsert permission catalog
  for (const p of ALL_PERMISSIONS) {
    await db.permission.upsert({
      where: { key: p.key },
      create: { key: p.key, module: p.module, action: p.action },
      update: { module: p.module, action: p.action },
    })
  }
  console.log(`✓ ${ALL_PERMISSIONS.length} permissions ensured`)

  // 2. Create/refresh system roles + permission grants
  for (const role of SYSTEM_ROLES) {
    const keys = SYSTEM_ROLE_PERMISSIONS[role.slug]
    const perms = await db.permission.findMany({ where: { key: { in: keys } }, select: { id: true } })
    const existing = await db.role.findUnique({ where: { slug: role.slug } })
    if (existing) {
      await db.role.update({
        where: { slug: role.slug },
        data: {
          name: role.name,
          description: role.description,
          isSystem: true,
          permissions: { set: perms.map((p) => ({ id: p.id })) },
        },
      })
    } else {
      await db.role.create({
        data: {
          slug: role.slug,
          name: role.name,
          description: role.description,
          isSystem: true,
          permissions: { connect: perms.map((p) => ({ id: p.id })) },
        },
      })
    }
    console.log(`✓ role ${role.slug} → ${keys.length} permissions`)
  }

  // 3. Link users to roles by legacy slug
  const roles = await db.role.findMany({ select: { id: true, slug: true } })
  const bySlug = new Map(roles.map((r) => [r.slug, r.id]))
  const users = await db.user.findMany({ where: { roleId: null }, select: { id: true, role: true } })
  for (const u of users) {
    const roleId = bySlug.get(u.role)
    if (roleId) {
      await db.user.update({ where: { id: u.id }, data: { roleId } })
      console.log(`✓ user ${u.id} linked to role ${u.role}`)
    }
  }

  console.log('Done.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
