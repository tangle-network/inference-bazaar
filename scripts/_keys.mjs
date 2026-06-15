// Shared ephemeral-key helper for e2e scripts (audit L1). Keys live in a
// repo-local, gitignored .keys/ dir (0700), each file 0600, and we REFUSE a
// pre-existing file that isn't owned 0600 by us — so a predictable path can't
// be pre-seeded by another user on a shared host. NOT for real funds.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { generatePrivateKey } from 'viem/accounts'

const DIR = process.env.INFERENCE_BAZAAR_KEYS_DIR || path.join(process.cwd(), '.keys')

export function ephemeralKey(name) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const file = path.join(DIR, `${name}.key`)
  if (fs.existsSync(file)) {
    const st = fs.statSync(file)
    if (st.uid !== os.userInfo().uid || (st.mode & 0o077) !== 0) {
      throw new Error(`refusing ${file}: must be owned by you and mode 0600 (got ${(st.mode & 0o777).toString(8)})`)
    }
    return fs.readFileSync(file, 'utf8').trim()
  }
  const k = generatePrivateKey()
  fs.writeFileSync(file, k, { mode: 0o600 })
  return k
}
