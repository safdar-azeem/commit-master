import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const runNpm = (args, allowMissingVersion = false) => {
   const result = spawnSync('npm', args, { encoding: 'utf8', shell: false })
   if (result.error) throw result.error
   if (result.status === 0) return result.stdout.trim()
   const detail = `${result.stderr}\n${result.stdout}`
   if (allowMissingVersion && /\bE404\b|\b404 Not Found\b/i.test(detail)) return null
   throw new Error(`npm ${args[0]} failed: ${detail.trim() || `exit ${result.status}`}`)
}

export const publicationAction = (localIntegrity, publishedIntegrity) => {
   if (publishedIntegrity === null) return 'publish'
   if (typeof publishedIntegrity !== 'string' || !publishedIntegrity.startsWith('sha512-')) {
      throw new Error('The published package has no usable SHA-512 integrity value.')
   }
   if (publishedIntegrity !== localIntegrity) {
      throw new Error('The published package differs from the prepared release tarball; refusing to overwrite or skip it.')
   }
   return 'skip'
}

export const publishReleasePackage = (directory) => {
   const packageDirectory = resolve(directory)
   const pkg = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
   if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
      throw new Error(`Invalid package name or version in ${packageDirectory}`)
   }
   const identity = `${pkg.name}@${pkg.version}`
   const outputDirectory = mkdtempSync(join(tmpdir(), 'commit-master-release-pack-'))
   try {
      const packed = JSON.parse(runNpm(['pack', packageDirectory, '--json', '--pack-destination', outputDirectory]))
      if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== 'string') {
         throw new Error(`npm pack returned an unexpected result for ${identity}`)
      }
      const tarball = join(outputDirectory, packed[0].filename)
      const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
      const published = runNpm(['view', identity, 'dist.integrity', '--json'], true)
      const publishedIntegrity = published === null ? null : JSON.parse(published)
      const action = publicationAction(integrity, publishedIntegrity)
      if (action === 'skip') {
         process.stdout.write(`${identity} already exists with identical artifact; skipping.\n`)
         return
      }
      // Publish exactly the tarball whose integrity was computed above.
      runNpm(['publish', tarball, '--access', 'public'])
      process.stdout.write(`${identity} published.\n`)
   } catch (error) {
      throw new Error(`${identity}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
   } finally {
      rmSync(outputDirectory, { recursive: true, force: true })
   }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
   if (process.argv.length !== 3) {
      throw new Error('Usage: node scripts/publish-release-package.mjs <package-directory>')
   }
   publishReleasePackage(process.argv[2])
}
