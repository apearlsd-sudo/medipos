import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'

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

const SECRET = process.env.AUTH_SECRET ?? 'medipos-pro-dev-secret-key-2026'
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
  role: string
  status: string
}

export const ROLE_WEIGHT: Record<string, number> = { cashier: 1, pharmacist: 2, admin: 3 }

export async function getSessionUser(req: NextRequest): Promise<SessionUser | null> {
  const token = req.cookies.get(COOKIE_NAME)?.value
  if (!token) return null
  const session = parseSessionToken(token)
  if (!session) return null
  const user = await db.user.findUnique({ where: { id: session.uid } })
  if (!user || user.status !== 'active') return null
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
  }
}

export function hasRole(user: SessionUser | null, roles: string[]): boolean {
  return !!user && roles.includes(user.role)
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

export function sanitizeUser(user: { id: string; username: string; name: string; email: string | null; phone: string | null; role: string; status: string; lastLoginAt: Date | null }) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
  }
}
