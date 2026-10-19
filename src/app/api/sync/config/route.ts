import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { requirePermission } from '@/lib/auth'
import { db } from '@/lib/db'
import { syncConfig } from '@/lib/sync'
import { syncConfigFilePath, readSyncConfigFile, writeSyncConfigFile, syncConfigFileInfo } from '@/lib/sync-config'
import { effectiveHqEndpoints, setNodeSetting } from '@/lib/mesh/core'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// Settings → Network & Sync → "Sync role & pairing" card (v0.3.4).
// Lets an operator designate this device as HQ or Branch from the UI with
// zero env editing: values persist to the config file next to the database
// (sync-config.ts) and take effect immediately — the branch worker / live
// link are restarted right here on role flips.
// ---------------------------------------------------------------------------

function validateNodeUrl(value: string): string | null {
  try {
    const u = new URL(value)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'HQ URL must start with http:// or https://'
    if (!u.hostname) return 'HQ URL is missing a host'
    return null
  } catch {
    return 'HQ URL is not a valid address'
  }
}

/** Safe view for the UI — never includes the sync key itself. */
export async function GET(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const cfg = syncConfig()
    const [hq, info] = await Promise.all([effectiveHqEndpoints(), Promise.resolve(syncConfigFileInfo())])
    const file = readSyncConfigFile()
    return NextResponse.json({
      role: cfg.role,
      nodeId: cfg.nodeId,
      nodeName: cfg.nodeName,
      syncKeySet: !!cfg.syncKey,
      keySource: cfg.keySource,
      hqUrl: cfg.role === 'branch' ? hq.primary : null,
      hqUrlSource: cfg.role === 'branch' ? hq.primarySource : null,
      intervalMs: cfg.intervalMs,
      branchCode: cfg.branchCode || null,
      branchName: cfg.branchName || null,
      configPath: info.path,
      configFileExists: info.exists,
      desktop: info.desktop,
      lanModeFlag: info.lanMode,
      // is the embedded desktop server currently serving the LAN (0.0.0.0)?
      lanModeActive: process.env.HOSTNAME === '0.0.0.0',
      savedAt: file?.savedAt ?? null,
    })
  } catch (e) {
    console.error('[sync] config GET error', e)
    return NextResponse.json({ error: 'Failed to read sync config' }, { status: 500 })
  }
}

/** Persist role/identity/key/HQ URL/lanMode from the Settings UI. */
export async function PUT(req: NextRequest) {
  const gate = await requirePermission(req, 'settings', 'edit')
  if (gate.response) return gate.response
  try {
    const body = (await req.json()) as {
      role?: 'hq' | 'branch'
      nodeId?: string
      nodeName?: string
      syncKey?: string
      generateKey?: boolean
      hqUrl?: string | null
      lanMode?: boolean
      branchCode?: string | null
    }

    const patch: Parameters<typeof writeSyncConfigFile>[0] = {}
    const effects: string[] = []
    const current = syncConfig()
    const targetRole = body.role === 'branch' || body.role === 'hq' ? body.role : current.role

    // --- role ------------------------------------------------------------
    if (body.role && body.role !== 'hq' && body.role !== 'branch') {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
    }
    if (body.role) patch.role = body.role

    // --- node identity -----------------------------------------------------
    if (body.nodeId !== undefined) {
      const id = body.nodeId.trim().toUpperCase()
      if (id && !/^[A-Z0-9_-]{1,32}$/.test(id)) {
        return NextResponse.json({ error: 'Node ID may only contain letters, numbers, dashes and underscores (max 32)' }, { status: 400 })
      }
      // A branch must never claim the HQ identity: the push API rejects HQ
      // pushes, and a branch pushing under 'HQ' would replay the whole log.
      if (id === 'HQ' && targetRole === 'branch') {
        return NextResponse.json({ error: 'Node ID "HQ" is reserved for the headquarters — pick a unique branch id (e.g. OSU-1).' }, { status: 400 })
      }
      patch.nodeId = id || (targetRole === 'branch' ? 'BRANCH' : 'HQ')
    }
    if (body.nodeName !== undefined) {
      const name = body.nodeName.trim()
      if (name.length > 60) return NextResponse.json({ error: 'Name is too long (max 60)' }, { status: 400 })
      patch.nodeName = name || (targetRole === 'branch' ? 'Branch Node' : 'Headquarters')
    }

    // --- shared key ----------------------------------------------------------
    if (body.generateKey) patch.syncKey = randomBytes(24).toString('hex')
    else if (typeof body.syncKey === 'string' && body.syncKey.trim()) {
      const key = body.syncKey.trim()
      if (key.length < 8 || key.length > 128) {
        return NextResponse.json({ error: 'Shared key must be 8–128 characters' }, { status: 400 })
      }
      patch.syncKey = key
    }
    if (targetRole === 'branch' && !patch.syncKey && !current.syncKey) {
      return NextResponse.json({ error: 'A shared key is required to pair with the HQ — ask the HQ admin for it (HQ: Settings → Network & Sync).' }, { status: 400 })
    }

    // --- HQ endpoint (branch only; stored via the manual-pairing machinery) --
    if (typeof body.hqUrl === 'string') {
      const url = body.hqUrl.trim().replace(/\/$/, '')
      if (url) {
        const err = validateNodeUrl(url)
        if (err) return NextResponse.json({ error: err }, { status: 400 })
      }
      await setNodeSetting('hqUrl', url || null)
      await setNodeSetting('hqUrlSource', url ? 'manual' : null)
      effects.push(url ? 'HQ endpoint saved' : 'HQ endpoint cleared')
    }

    // --- desktop LAN HQ mode ---------------------------------------------------
    if (typeof body.lanMode === 'boolean') patch.lanMode = body.lanMode

    // --- branch store binding (isolation) --------------------------------------
    // Which store THIS branch device belongs to. Bound devices hide other
    // stores' sales/expenses/quotations both at the UI and in the replicated
    // log. Empty string/null clears the binding.
    if (body.branchCode !== undefined) {
      const code = String(body.branchCode ?? '').trim().toUpperCase().slice(0, 24)
      if (code) {
        const b = await db.branch.findFirst({ where: { code }, select: { code: true, name: true } })
        if (!b) {
          return NextResponse.json({ error: `No store with code "${code}" exists on this device — create it first (Setup → Branches).` }, { status: 400 })
        }
        patch.branchCode = b.code
        patch.branchName = b.name
      } else {
        patch.branchCode = ''
        patch.branchName = ''
      }
    }

    const before = syncConfig()
    const file = writeSyncConfigFile(patch)
    const after = syncConfig()
    effects.push(`Saved to ${syncConfigFilePath()}`)

    // (Re)pairing / re-binding self-heal: whenever this device becomes a
    // branch, changes identity, or binds to a DIFFERENT store, reset the pull
    // cursor to 0. The next cycle replays the HQ's ENTIRE op-log idempotently
    // (every applier dedupes by stable ids), which guarantees a fresh or
    // newly-bound workstation receives the HQ's full catalog + stock — and
    // repairs any historical cursor/log misalignment (e.g. the HQ database
    // was restored from a backup at some point) at exactly the moment the
    // operator sets the device up.
    const identityChanged =
      before.role !== after.role ||
      before.nodeId !== after.nodeId ||
      before.branchCode !== after.branchCode
    if (after.role === 'branch' && identityChanged) {
      await db.syncState.updateMany({ where: { id: 'HQ' }, data: { lastPulledSeq: 0 } })
      effects.push('Pull cursor reset — the next sync replays the full HQ history for this device (idempotent)')
    }

    // --- hot-apply the role flip -------------------------------------------
    if (after.role === 'branch') {
      const w = await import('@/lib/sync-worker')
      w.restartSyncWorker() // starts or re-cadences the push/pull worker
      const link = await import('@/lib/mesh/ws-link')
      link.pokeWsLink() // (re)dial the live link with the fresh config
      if (before.role !== 'branch') effects.push('Branch sync started — first cycle runs within seconds')
    } else if (before.role === 'branch') {
      const w = await import('@/lib/sync-worker')
      w.stopSyncWorker()
      const link = await import('@/lib/mesh/ws-link')
      link.stopWsLink()
      effects.push('Branch sync stopped — this node is HQ-only now')
    }

    return NextResponse.json({
      ok: true,
      effects,
      role: after.role,
      nodeId: after.nodeId,
      nodeName: after.nodeName,
      syncKeySet: !!after.syncKey,
      savedAt: file.savedAt,
    })
  } catch (e) {
    console.error('[sync] config PUT error', e)
    return NextResponse.json({ error: 'Failed to save sync config' }, { status: 500 })
  }
}
