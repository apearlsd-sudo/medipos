import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { moduleDef } from '@/lib/permissions'

// ---------------------------------------------------------------------------
// Password hashing (scrypt, no external deps)
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = crypto.scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)
}

// ---------------------------------------------------------------------------
// Signed session tokens (HMAC-SHA256, stateless)
// ---------------------------------------------------------------------------

// Session-signing secret. AUTH_SECRET is REQUIRED in any real deployment —
// the pre-hardening static dev fallback became public knowledge when the repo
// went to GitHub, so a missing secret now falls back to an EPHEMERAL random
// key (safe: nothing is forgeable; sessions reset on restart) with a loud
// warning telling the operator to set AUTH_SECRET.
const PROVIDED_SECRET = (process.env.AUTH_SECRET ?? '').trim()
const SECRET = PROVIDED_SECRET || crypto.randomBytes(48).toString('base64url')
if (!PROVIDED_SECRET && process.env.NODE_ENV === 'production') {
  console.warn(
    '[auth] AUTH_SECRET is not set — using an ephemeral random signing secret. ' +
      'Sessions will not survive restarts. Persist one via relaunch.sh (.secrets/auth-secret) ' +
      'or export AUTH_SECRET explicitly.',
  )
}
const COOKIE_NAME = 'medipos_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url')

function sign(payload: string): string {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
}

export function createSessionToken(userId: string): string {
  const payload = b64url(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_MS }))
  return `${payload}.${sign(payload)}`
}

function parseSessionToken(token: string): { uid: string } | null {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = sign(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { uid: string; exp: number }
    if (!data.uid || !data.exp || data.exp < Date.now()) return null
    return { uid: data.uid }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Session helpers for API routes
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string
  username: string
  name: string
  email: string | null
  phone: string | null
  role: string // denormalized role slug
  roleId: string | null
  roleName: string // display name of the role
  isSuperAdmin: boolean
  permissions: string[] // permission keys; ['*'] = super admin wildcard
  status: string
  branchId: string | null // assigned branch (null = all branches)
  branchName: string | null
  twoFactorEnabled: boolean
}

export const ROLE_WEIGHT: Record<string, number> = { cashier: 1, pharmacist: 2, admin: 3 }

const FALLBACK_ROLE_NAME: Record<string, string> = {
  admin: 'Administrator',
  pharmacist: 'Pharmacist',
  cashier: 'Cashier',
}

export async function getSessionUser(req: NextRequest): Promise<SessionUser | null> {
  const token = req.cookies.get(COOKIE_NAME)?.value
  if (!token) return null
  const session = parseSessionToken(token)
  if (!session) return null
  const user = await db.user.findUnique({
    where: { id: session.uid },
    include: {
      roleRef: { include: { permissions: { select: { key: true } } } },
      branchRef: { select: { id: true, name: true } },
    },
  })
  if (!user || user.status !== 'active') return null
  const isSuperAdmin = user.role === 'admin' || user.roleRef?.slug === 'admin'
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.roleRef?.slug ?? user.role,
    roleId: user.roleId,
    roleName: user.roleRef?.name ?? FALLBACK_ROLE_NAME[user.role] ?? user.role,
    isSuperAdmin,
    permissions: isSuperAdmin ? ['*'] : (user.roleRef?.permissions ?? []).map((p) => p.key),
    status: user.status,
    branchId: user.branchId,
    branchName: user.branchRef?.name ?? null,
    twoFactorEnabled: user.twoFactorEnabled,
  }
}

export function hasRole(user: SessionUser | null, roles: string[]): boolean {
  return !!user && roles.includes(user.role)
}

/** Granular permission check. Super admin (wildcard) always passes. */
export function can(
  user: Pick<SessionUser, 'permissions' | 'isSuperAdmin'> | null | undefined,
  module: string,
  action: string,
): boolean {
  if (!user) return false
  if (user.isSuperAdmin || user.permissions.includes('*')) return true
  return user.permissions.includes(`${module}:${action}`)
}

// Response shortcuts ---------------------------------------------------------

export function unauthorized() {
  return NextResponse.json({ error: 'Authentication required. Please sign in.' }, { status: 401 })
}

export function forbidden(role?: string) {
  return NextResponse.json(
    { error: role ? `Access denied — requires ${role.replace('_', ' ')} privileges.` : 'Access denied.' },
    { status: 403 },
  )
}

/**
 * Returns the session user, or a 401 NextResponse to bail with.
 * Usage: const gate = await requireUser(req); if ('response' in gate) return gate.response;
 */
export async function requireUser(req: NextRequest): Promise<{ user: SessionUser; response?: never } | { user?: never; response: NextResponse }> {
  const user = await getSessionUser(req)
  if (!user) return { response: unauthorized() }
  return { user }
}

/** Requires one of the given roles; returns user or a 401/403 response. */
export async function requireRole(req: NextRequest, roles: string[]): Promise<{ user: SessionUser; response?: never } | { user?: never; response: NextResponse }> {
  const user = await getSessionUser(req)
  if (!user) return { response: unauthorized() }
  if (!roles.includes(user.role)) return { response: forbidden() }
  return { user }
}

/** Requires a granular permission; returns user or a 401/403 response. */
export async function requirePermission(req: NextRequest, module: string, action: string): Promise<{ user: SessionUser; response?: never } | { user?: never; response: NextResponse }> {
  const user = await getSessionUser(req)
  if (!user) return { response: unauthorized() }
  if (!can(user, module, action)) {
    const label = moduleDef(module)?.label ?? module
    return {
      response: NextResponse.json(
        { error: `Access denied — your role (${user.roleName}) is missing the "${label} · ${action}" permission.` },
        { status: 403 },
      ),
    }
  }
  return { user }
}

// Two-factor login challenge tokens (short-lived, purpose-bound) ---------------

const CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export function createChallengeToken(userId: string): string {
  const payload = b64url(JSON.stringify({ uid: userId, exp: Date.now() + CHALLENGE_TTL_MS, p: '2fa' }))
  return `${payload}.${sign(payload)}`
}

export function parseChallengeToken(token: string): { uid: string } | null {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = sign(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { uid: string; exp: number; p: string }
    if (!data.uid || !data.exp || data.exp < Date.now() || data.p !== '2fa') return null
    return { uid: data.uid }
  } catch {
    return null
  }
}

// Cookie helpers -------------------------------------------------------------

export const sessionCookie = {
  name: COOKIE_NAME,
  options: (token: string) => ({
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    value: token,
  }),
}

export function clearSessionCookie() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
    value: '',
  }
}

type UserWithRole = {
  id: string
  username: string
  name: string
  email: string | null
  phone: string | null
  role: string
  roleId: string | null
  status: string
  lastLoginAt: Date | null
  twoFactorEnabled?: boolean
  branchId?: string | null
  branchRef?: { id: string; name: string } | null
  roleRef?: {
    name: string
    slug: string
    permissions: { key: string }[]
  } | null
}

export function sanitizeUser(user: UserWithRole) {
  const isSuperAdmin = user.role === 'admin' || user.roleRef?.slug === 'admin'
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.roleRef?.slug ?? user.role,
    roleId: user.roleId,
    roleName: user.roleRef?.name ?? FALLBACK_ROLE_NAME[user.role] ?? user.role,
    isSuperAdmin,
    permissions: isSuperAdmin ? ['*'] : (user.roleRef?.permissions ?? []).map((p) => p.key),
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    branchId: user.branchId ?? null,
    branchName: user.branchRef?.name ?? null,
    twoFactorEnabled: user.twoFactorEnabled ?? false,
  }
}
