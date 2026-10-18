import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { dbFilePath } from '@/lib/system'

// ---------------------------------------------------------------------------
// Tier 1 cloud backup — dependency-free S3-compatible client (AWS SigV4).
//
// Works with any S3-compatible endpoint: AWS S3 (path-style), Cloudflare R2,
// MinIO, Backblaze B2. No SDK: the standalone build stays lean and nothing
// extra gets traced into the desktop bundle.
//
// Credentials live in a local JSON file NEXT TO THE DATABASE — deliberately
// NOT in the settings table, so they (a) never sync to branch nodes through
// the sync layer and (b) follow the same lifecycle as the data they protect
// (desktop: userData/data/cloud-backup.json, web: db/cloud-backup.json).
// ---------------------------------------------------------------------------

export interface CloudBackupConfig {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  prefix: string
  enabled: boolean
  lastUploadAt?: string
  lastUploadKey?: string
  lastUploadBytes?: number
  lastError?: string
}

export function cloudConfigPath(): string {
  return path.join(path.dirname(dbFilePath()), 'cloud-backup.json')
}

export function loadCloudConfig(): CloudBackupConfig | null {
  try {
    const file = cloudConfigPath()
    if (!fs.existsSync(file)) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return {
      endpoint: String(raw.endpoint ?? ''),
      region: String(raw.region ?? 'us-east-1'),
      bucket: String(raw.bucket ?? ''),
      accessKeyId: String(raw.accessKeyId ?? ''),
      secretAccessKey: String(raw.secretAccessKey ?? ''),
      prefix: String(raw.prefix ?? '').replace(/^\/+|\/+$/g, ''),
      enabled: !!raw.enabled,
      lastUploadAt: raw.lastUploadAt ? String(raw.lastUploadAt) : undefined,
      lastUploadKey: raw.lastUploadKey ? String(raw.lastUploadKey) : undefined,
      lastUploadBytes: typeof raw.lastUploadBytes === 'number' ? raw.lastUploadBytes : undefined,
      lastError: raw.lastError ? String(raw.lastError) : undefined,
    }
  } catch {
    return null
  }
}

export function saveCloudConfig(cfg: CloudBackupConfig): void {
  const file = cloudConfigPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch {}
}

/** GET responses show a masked secret; PUT with an empty/masked secret keeps the stored one. */
export function maskConfig(cfg: CloudBackupConfig) {
  const secret = cfg.secretAccessKey
  const masked = secret ? `****${secret.slice(-4)}` : ''
  return { ...cfg, secretAccessKey: masked, hasSecret: !!secret }
}

export function mergeSecret(existing: CloudBackupConfig | null, incoming: Partial<CloudBackupConfig>): CloudBackupConfig {
  const secret = incoming.secretAccessKey?.trim() ?? ''
  const keepExisting = !secret || (existing?.secretAccessKey ? secret === `****${existing.secretAccessKey.slice(-4)}` : false)
  return {
    endpoint: (incoming.endpoint ?? existing?.endpoint ?? '').trim().replace(/\/+$/, ''),
    region: (incoming.region ?? existing?.region ?? 'us-east-1').trim() || 'us-east-1',
    bucket: (incoming.bucket ?? existing?.bucket ?? '').trim(),
    accessKeyId: (incoming.accessKeyId ?? existing?.accessKeyId ?? '').trim(),
    secretAccessKey: keepExisting ? existing?.secretAccessKey ?? '' : secret,
    prefix: (incoming.prefix ?? existing?.prefix ?? '').trim().replace(/^\/+|\/+$/g, ''),
    enabled: incoming.enabled ?? existing?.enabled ?? false,
  }
}

export function validateConfig(cfg: Pick<CloudBackupConfig, 'endpoint' | 'bucket' | 'accessKeyId' | 'secretAccessKey'>): string | null {
  try {
    const u = new URL(cfg.endpoint)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Endpoint must be http(s)'
  } catch {
    return 'Endpoint is not a valid URL'
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,62}$/.test(cfg.bucket)) return 'Bucket name looks invalid'
  if (!cfg.accessKeyId || !cfg.secretAccessKey) return 'Access key and secret are both required'
  return null
}

export function dailyBackupKey(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${prefix ? prefix + '/' : ''}medipos-${stamp}.db`
}

// --- AWS SigV4 ---------------------------------------------------------------

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest()
}

function sha256hex(data: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** AWS URI encoding: everything except unreserved chars, '/' kept for keys when encodePath=false. */
function awsUriEncode(str: string, keepSlash = false): string {
  let out = ''
  for (const ch of Buffer.from(str, 'utf8').toString('hex').match(/../g) ?? []) {
    const c = String.fromCharCode(parseInt(ch, 16))
    if (/[A-Za-z0-9]/.test(c) || c === '-' || c === '.' || c === '_' || c === '~' || (keepSlash && c === '/')) out += c
    else out += `%${ch.toUpperCase()}`
  }
  return out
}

interface S3RequestOptions {
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD'
  key?: string
  query?: Record<string, string>
  body?: Buffer
  timeoutMs?: number
}

/**
 * Minimal path-style S3 request with SigV4 signing. Returns the raw Response
 * so callers decide how to consume it. Throws with a readable message on
 * non-2xx responses (S3 error XML included, truncated).
 */
export async function s3Request(cfg: CloudBackupConfig, opts: S3RequestOptions): Promise<Response> {
  const url = new URL(cfg.endpoint)
  const host = url.host
  const canonicalUri =
    '/' +
    [cfg.bucket, opts.key ?? '']
      .map((part) => awsUriEncode(part, true))
      .filter(Boolean)
      .join('/')

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '') // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256hex(opts.body ?? Buffer.alloc(0))

  const queryPairs = Object.entries(opts.query ?? {})
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join('&')

  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n')

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, cfg.region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const target = `${cfg.endpoint}${canonicalUri}${canonicalQuery ? '?' + canonicalQuery : ''}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000)
  try {
    const res = await fetch(target, {
      method: opts.method,
      headers: {
        Host: host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        Authorization: authorization,
        ...(opts.body ? { 'Content-Length': String(opts.body.length) } : {}),
      },
      body: opts.body ? new Uint8Array(opts.body) : undefined,
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`S3 ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 220) || res.statusText}`)
    }
    return res
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('Connection timed out (endpoint unreachable or too slow)')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export async function putObject(cfg: CloudBackupConfig, key: string, body: Buffer): Promise<void> {
  await s3Request(cfg, { method: 'PUT', key, body })
}

export interface CloudFile {
  key: string
  name: string
  sizeBytes: number
  lastModified: string
}

export async function listObjects(cfg: CloudBackupConfig, maxKeys = 60): Promise<CloudFile[]> {
  const prefix = cfg.prefix ? `${cfg.prefix}/` : ''
  const res = await s3Request(cfg, {
    method: 'GET',
    query: { 'list-type': '2', prefix, 'max-keys': String(maxKeys) },
    timeoutMs: 15000,
  })
  const xml = await res.text()
  const files: CloudFile[] = []
  const re = /<Contents>([\s\S]*?)<\/Contents>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const block = m[1]
    const get = (tag: string) => {
      const t = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
      return t ? t[1] : ''
    }
    const key = get('Key')
    if (!key || !key.endsWith('.db')) continue
    files.push({
      key,
      name: key.split('/').pop() ?? key,
      sizeBytes: parseInt(get('Size') || '0', 10),
      lastModified: get('LastModified'),
    })
  }
  files.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
  return files
}

export async function getObject(cfg: CloudBackupConfig, key: string): Promise<Buffer> {
  const res = await s3Request(cfg, { method: 'GET', key })
  return Buffer.from(await res.arrayBuffer())
}

/** Cheap connectivity + credential probe: ListObjectsV2 with max-keys=1. */
export async function testConnection(cfg: CloudBackupConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await s3Request(cfg, {
      method: 'GET',
      query: { 'list-type': '2', prefix: cfg.prefix ? `${cfg.prefix}/` : '', 'max-keys': '1' },
      timeoutMs: 12000,
    })
    await res.text()
    return { ok: true, message: `Connected to ${cfg.bucket}` }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}
