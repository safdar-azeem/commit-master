import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const version = process.argv[2]
if (!version) throw new Error('A release version is required')
const main = JSON.parse(readFileSync('package.json', 'utf8'))
if (main.version !== version) throw new Error('Tag and main package versions differ')
const cargoManifest = readFileSync('native/linux-file-clipboard/Cargo.toml', 'utf8')
if (!cargoManifest.includes(`version = "${version}"`)) {
   throw new Error('Native helper version differs from release tag')
}
for (const arch of ['x64', 'arm64']) {
   const directory = join('packages', `clipboard-linux-${arch}`)
   const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
   const binary = join(directory, 'bin', 'commit-master-file-clipboard')
   if (pkg.version !== version || main.optionalDependencies[pkg.name] !== version) {
      throw new Error(`Version mismatch for ${pkg.name}`)
   }
   if (pkg.os?.[0] !== 'linux' || pkg.cpu?.[0] !== arch) {
      throw new Error(`Incorrect platform metadata for ${pkg.name}`)
   }
   const bytes = readFileSync(binary)
   if (bytes.length < 20 || bytes.toString('hex', 0, 4) !== '7f454c46') {
      throw new Error(`Missing or invalid ELF binary for ${pkg.name}`)
   }
   const machine = bytes.readUInt16LE(18)
   if (machine !== (arch === 'x64' ? 0x3e : 0xb7)) {
      throw new Error(`Wrong ELF architecture for ${pkg.name}`)
   }
   if (!(statSync(binary).mode & 0o111)) {
      throw new Error(`Binary is not executable for ${pkg.name}`)
   }
}
