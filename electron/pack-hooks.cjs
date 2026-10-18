// ---------------------------------------------------------------------------
// electron-builder afterPack hook — build + slim the packaged server.
//
// electron-builder ignores .gitignore'd paths even inside extraResources
// filters, which silently drops the server's node_modules. So this hook does
// the whole job deterministically:
//   1. Replace resources/server with a fresh copy of .next/standalone.
//   2. Remove output-traced dev artifacts: .env (dev absolute DATABASE_URL —
//      the shell injects its own), db/ (traced dev DB copy, tens of MB),
//      scripts/ (build-machine tooling).
//   3. Prune @prisma/client/runtime/* except library.js — MediPOS is
//      SQLite-only via the native libquery engine; every other-DB WASM blob
//      (postgres/mysql/sqlserver/cockroachdb/edge, ~55 MB) is dead weight.
// Safe by construction: only touches the packed tree, never the repo.
// ---------------------------------------------------------------------------
const path = require('path')
const fs = require('fs')

function dirSize(p) {
  let total = 0
  try {
    for (const f of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, f.name)
      total += f.isDirectory() ? dirSize(fp) : fs.statSync(fp).size
    }
  } catch {}
  return total
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir
  const resourcesDir = path.join(appOutDir, 'resources')
  const serverDir = path.join(resourcesDir, 'server')
  // this file lives in electron/, project root is one level up
  const srcStandalone = path.join(__dirname, '..', '.next', 'standalone')

  if (!fs.existsSync(path.join(srcStandalone, 'server.js'))) {
    throw new Error(`[pack-hooks] .next/standalone/server.js missing — run "npm run build" first`)
  }

  rmrf(serverDir)
  fs.cpSync(srcStandalone, serverDir, { recursive: true })
  let size = dirSize(serverDir)
  console.log(`[pack-hooks] server copied: ${(size / 1048576).toFixed(0)} MB`)

  // Bundle the sync hub INTO the server tree: desktop LAN HQ mode spawns it
  // via ELECTRON_RUN_AS_NODE, and placing it under resources/server/sync-hub
  // lets its `import 'ws'` resolve against the server's own node_modules.
  const hubSrc = path.join(__dirname, '..', 'mini-services', 'sync-hub')
  const hubDst = path.join(serverDir, 'sync-hub')
  if (fs.existsSync(hubSrc)) {
    rmrf(hubDst)
    fs.cpSync(hubSrc, hubDst, { recursive: true })
    console.log(`[pack-hooks] sync-hub bundled: ${hubDst} (${(dirSize(hubDst) / 1048576).toFixed(1)} MB)`)
  } else {
    console.warn('[pack-hooks] mini-services/sync-hub missing — desktop LAN HQ live link will be unavailable')
  }
  // The Next build BUNDLES ws into its chunks (no standalone/node_modules/ws),
  // but the standalone-spawned hub imports 'ws' directly — ship it explicitly
  // (pure JS, zero runtime deps; bufferutil/utf-8-validate are optional peers).
  const wsSrc = path.join(__dirname, '..', 'node_modules', 'ws')
  const wsDst = path.join(serverDir, 'node_modules', 'ws')
  if (fs.existsSync(wsSrc)) {
    rmrf(wsDst)
    fs.cpSync(wsSrc, wsDst, { recursive: true })
    console.log(`[pack-hooks] ws bundled for sync-hub: ${(dirSize(wsDst) / 1048576).toFixed(1)} MB`)
  } else {
    console.warn('[pack-hooks] node_modules/ws missing — sync-hub will fail to start in packaged desktop builds')
  }


  for (const junk of ['.env', 'db', 'scripts']) {
    const jp = path.join(serverDir, junk)
    if (fs.existsSync(jp)) {
      const sz = dirSize(jp) || fs.statSync(jp).size
      rmrf(jp)
      console.log(`[pack-hooks] removed dev artifact server/${junk} (${(sz / 1048576).toFixed(1)} MB)`)
    }
  }

  const runtimeDir = path.join(serverDir, 'node_modules', '@prisma', 'client', 'runtime')
  if (fs.existsSync(runtimeDir)) {
    let pruned = 0
    for (const f of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
      if (f.name === 'library.js') continue // the only runtime used with the native engine
      const fp = path.join(runtimeDir, f.name)
      const sz = f.isDirectory() ? dirSize(fp) : fs.statSync(fp).size
      rmrf(fp)
      pruned += sz
    }
    console.log(`[pack-hooks] pruned @prisma/client/runtime: ${(pruned / 1048576).toFixed(1)} MB (kept library.js)`)
  }

  size = dirSize(serverDir)
  console.log(`[pack-hooks] resources/server final: ${(size / 1048576).toFixed(0)} MB`)
}
