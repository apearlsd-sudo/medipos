/**
 * Boot-time data guard — runs once per server start, before the first request.
 *
 * WHY: the preview platform periodically resets the workspace to the last git
 * commit. When that happens mid-flight, the SQLite database can come back in a
 * stale state (e.g. branchId stamps lost, roles missing) while the CODE is fine
 * — which looked like "features were deleted". This guard detects the known
 * data regressions at boot and repairs them automatically using the same
 * idempotent scripts from the manual recovery runbook:
 *
 *   seed.ts → seed-roles.ts → migrate-branches.ts → seed-osu-products.ts
 *
 * Design rules:
 * - Never crash the server: every step is wrapped in try/catch.
 * - Healthy DB ⇒ ~a few count() queries and out (no startup penalty).
 * - On a user's own PC (standalone bundle without scripts/) it silently skips.
 */

interface BootGuardResult {
  healthy: boolean
  repaired: string[]
}

const guardGlobal = globalThis as unknown as { __mediposBootGuard?: Promise<BootGuardResult> }

async function runBootGuard(): Promise<BootGuardResult> {
  const { PrismaClient } = await import('@prisma/client')
  const { spawnSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const path = await import('node:path')

  const prisma = new PrismaClient({ log: [] })
  const repaired: string[] = []

  const runScript = (script: string): boolean => {
    const abs = path.join(process.cwd(), 'scripts', script)
    if (!fs.existsSync(abs)) {
      console.log(`[boot-guard] scripts/${script} not present here — skipping (standalone deploy?)`)
      return false
    }
    const r = spawnSync('bun', ['run', abs], { timeout: 120_000, encoding: 'utf8' })
    const ok = r.status === 0
    console.log(`[boot-guard] bun run scripts/${script} → ${ok ? 'OK' : `FAILED (${r.status})`}`)
    if (!ok && r.stderr) console.log(`[boot-guard] stderr: ${String(r.stderr).slice(0, 400)}`)
    return ok
  }

  try {
    const [users, roles, branches, medsNull, medsTotal, medsOsu] = await Promise.all([
      prisma.user.count(),
      prisma.role.count(),
      prisma.branch.count(),
      prisma.medicine.count({ where: { branchId: null } }),
      prisma.medicine.count(),
      prisma.medicine.count({ where: { branchRef: { code: 'OSU' } } }),
    ])

    if (users > 0 && roles > 0 && medsNull === 0 && medsTotal > 0 && medsOsu > 0) {
      console.log('[boot-guard] DB invariants healthy — no repair needed')
      return { healthy: true, repaired }
    }

    console.log(
      `[boot-guard] DB regression detected (users:${users} roles:${roles} branches:${branches} meds:${medsTotal} medsNull:${medsNull} medsOsu:${medsOsu}) — running idempotent repair chain`
    )

    // Order matters — this is the documented recovery runbook, each step idempotent.
    if (users === 0) {
      if (runScript('seed.ts')) repaired.push('seed.ts')
      if (runScript('seed-roles.ts')) repaired.push('seed-roles.ts')
    }
    if (roles === 0) {
      if (runScript('seed-roles.ts')) repaired.push('seed-roles.ts')
    }
    if (medsNull > 0) {
      if (runScript('migrate-branches.ts')) repaired.push('migrate-branches.ts')
    }
    if (branches >= 2 && medsTotal > 0 && medsOsu === 0) {
      if (runScript('seed-osu-products.ts')) repaired.push('seed-osu-products.ts')
    }

    // Post-repair verification
    const [users2, medsNull2, medsOsu2] = await Promise.all([
      prisma.user.count(),
      prisma.medicine.count({ where: { branchId: null } }),
      prisma.medicine.count({ where: { branchRef: { code: 'OSU' } } }),
    ])
    const healthy = users2 > 0 && medsNull2 === 0 && medsOsu2 > 0
    console.log(
      `[boot-guard] post-repair: users:${users2} medsNull:${medsNull2} medsOsu:${medsOsu2} → ${healthy ? 'HEALTHY' : 'STILL DEGRADED (run scripts/auto-recover.sh)'}`
    )
    return { healthy, repaired }
  } catch (e) {
    console.error('[boot-guard] unexpected error (server continues):', e)
    return { healthy: false, repaired }
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  // Run exactly once per process, even if register() is called twice.
  if (!guardGlobal.__mediposBootGuard) {
    guardGlobal.__mediposBootGuard = runBootGuard().catch((e) => {
      console.error('[boot-guard] fatal (server continues):', e)
      return { healthy: false, repaired: [] }
    })
  }
  await applyPendingRestore()

  await guardGlobal.__mediposBootGuard

  startDailyBackupTimer()
}

// ---------------------------------------------------------------------------
// Tier 1 cloud backup — daily auto-backup timer.
// Every 6h tick: if the newest local snapshot is older than 24h, create one
// (VACUUM INTO); if cloud backup is configured + enabled, upload it. All
// failures are logged and remembered in the config meta (lastError) — the
// timer never throws into the server loop. Production only.
// ---------------------------------------------------------------------------
const timerGlobal = globalThis as unknown as { __mediposBackupTimer?: NodeJS.Timeout }

function startDailyBackupTimer() {
  if (process.env.NODE_ENV !== 'production') return
  if (timerGlobal.__mediposBackupTimer) return
  timerGlobal.__mediposBackupTimer = setInterval(() => {
    dailyBackupTick().catch((e) => console.error('[auto-backup] unexpected:', e))
  }, 6 * 60 * 60 * 1000)
  // First pass shortly after boot so a machine that only runs during the day
  // still gets its snapshot (and the 24h guard makes reboots idempotent).
  setTimeout(() => dailyBackupTick().catch(() => {}), 2 * 60 * 1000)
  console.log('[auto-backup] daily timer armed (tick 6h, snapshot every ≥24h)')
}

async function dailyBackupTick() {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { backupsDir, createLocalBackup } = await import('@/lib/system')
  const { loadCloudConfig, saveCloudConfig, dailyBackupKey, putObject } = await import('@/lib/cloud-backup')
  const { logAudit } = await import('@/lib/audit')

  // 24h guard: read newest existing snapshot mtime from the backups dir.
  const dir = backupsDir()
  const snaps = fs.readdirSync(dir).filter((f) => f.startsWith('medipos-') && f.endsWith('.db'))
  const newest = snaps
    .map((f) => fs.statSync(path.join(dir, f)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0)
  if (newest && Date.now() - newest < 24 * 60 * 60 * 1000) return

  const local = await createLocalBackup()
  console.log(`[auto-backup] snapshot created ${local.file} (${(local.sizeBytes / 1024 / 1024).toFixed(2)} MB)`)

  const cfg = loadCloudConfig()
  if (!cfg || !cfg.enabled) return
  const key = dailyBackupKey(cfg.prefix)
  try {
    const buf = fs.readFileSync(path.join(dir, local.file))
    await putObject(cfg, key, buf)
    saveCloudConfig({ ...cfg, lastUploadAt: new Date().toISOString(), lastUploadKey: key, lastUploadBytes: buf.length, lastError: undefined })
    console.log(`[auto-backup] uploaded ${key}`)
    await logAudit({
      actor: null,
      action: 'system.cloudBackup.uploaded',
      targetType: 'system',
      targetName: key,
      summary: `Auto cloud backup uploaded ${key} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`,
      changes: { key, bytes: buf.length, auto: true },
    })
  } catch (e) {
    const msg = (e as Error).message
    saveCloudConfig({ ...cfg, lastError: msg })
    console.error(`[auto-backup] upload failed: ${msg}`)
  }
}


// ---------------------------------------------------------------------------
// Pending-restore applier (setup backup upload). Runs before the boot guard:
// if a staged restore exists, swap the database file over the live DATABASE_URL
// path, then set the generated temporary admin password inside the restored DB
// so the owner can sign in without the backup's old credentials.
// ---------------------------------------------------------------------------
const restoreGlobal = globalThis as unknown as { __mediposRestoreApplied?: boolean }

async function applyPendingRestore() {
  if (restoreGlobal.__mediposRestoreApplied) return
  restoreGlobal.__mediposRestoreApplied = true
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { dbFilePath } = await import('@/lib/system')
    const markerPath = path.join(path.dirname(dbFilePath()), 'pending-restore.json')
    if (!fs.existsSync(markerPath)) return
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    const dbPath = dbFilePath()

    if (!marker.stagedFile || !fs.existsSync(marker.stagedFile)) {
      console.error('[restore] staged file missing — clearing the marker:', marker.stagedFile)
      fs.rmSync(markerPath)
      return
    }

    // Swap: live db (if any) moves aside into backups/, staged file becomes live.
    try {
      if (fs.existsSync(dbPath)) {
        const aside = path.join(path.dirname(dbPath), 'backups', `pre-restore-${Date.now()}.db`)
        fs.mkdirSync(path.dirname(aside), { recursive: true })
        fs.renameSync(dbPath, aside)
        console.log(`[restore] previous database kept as ${path.basename(aside)}`)
      }
      fs.copyFileSync(marker.stagedFile, dbPath)
      fs.rmSync(marker.stagedFile)
    } catch (e) {
      console.error('[restore] file swap failed (continuing with the current db):', e)
      return
    }

    // Inject the temporary admin password into the restored database.
    const { PrismaClient } = await import('@prisma/client')
    const prisma = new PrismaClient({ log: [] })
    try {
      const admin = await prisma.user.findFirst({ where: { role: 'admin' }, orderBy: { createdAt: 'asc' } })
        ?? await prisma.user.findFirst({ where: { username: 'admin' } })
      if (admin) {
        await prisma.user.update({
          where: { id: admin.id },
          data: { passwordHash: marker.tempHash, twoFactorEnabled: false, twoFactorSecret: null },
        })
        console.log(`[restore] temporary password applied to admin user "${admin.username}" (shown once at staging time)`)
      } else {
        console.error('[restore] no admin user found in the restored database — original credentials still apply')
      }
    } finally {
      await prisma.$disconnect().catch(() => {})
    }

    fs.rmSync(markerPath)
    console.log('[restore] pending restore applied successfully')
  } catch (e) {
    console.error('[restore] unexpected error (server continues):', e)
  }
}