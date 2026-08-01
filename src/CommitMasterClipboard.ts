import { spawn } from 'node:child_process'
import { ClipboardInterruptedError, CommitMasterError } from './CommitMasterErrors.js'

export interface ClipboardProgram {
   command: string
   args: readonly string[]
}

export type ClipboardProgramWriter = (
   program: ClipboardProgram,
   content: string,
   signal?: AbortSignal
) => Promise<boolean>

const POWERSHELL_CLIPBOARD_SCRIPT =
   '[Console]::InputEncoding=[Text.Encoding]::UTF8; $content=[Console]::In.ReadToEnd(); Set-Clipboard -Value $content'

const clipboardPrograms = (platform: NodeJS.Platform): readonly ClipboardProgram[] => {
   switch (platform) {
      case 'darwin':
         return [{ command: 'pbcopy', args: [] }]
      case 'win32':
         return [
            {
               command: 'powershell.exe',
               args: ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_CLIPBOARD_SCRIPT],
            },
            { command: 'clip.exe', args: [] },
         ]
      default:
         return [
            { command: 'wl-copy', args: [] },
            { command: 'xclip', args: ['-selection', 'clipboard'] },
            { command: 'xsel', args: ['--clipboard', '--input'] },
            {
               command: 'powershell.exe',
               args: ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_CLIPBOARD_SCRIPT],
            },
            { command: 'clip.exe', args: [] },
            { command: 'termux-clipboard-set', args: [] },
         ]
   }
}

const writeWithProgram = (
   program: ClipboardProgram,
   content: string,
   signal?: AbortSignal
): Promise<boolean> =>
   new Promise((resolve, reject) => {
      let settled = false
      let inputFailed = false
      const child = spawn(program.command, [...program.args], {
         shell: false,
         windowsHide: true,
         signal,
         stdio: ['pipe', 'ignore', 'pipe'],
      })
      const stderr: Buffer[] = []
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.stdin.on('error', () => {
         inputFailed = true
      })
      child.once('error', (error) => {
         if (settled) return
         settled = true
         if (signal?.aborted) reject(error)
         else resolve(false)
      })
      child.once('close', (exitCode) => {
         if (settled) return
         settled = true
         resolve(exitCode === 0 && !inputFailed)
      })
      child.stdin.end(content)
   })

export const copyToClipboard = async (
   content: string,
   signal?: AbortSignal,
   platform: NodeJS.Platform = process.platform,
   write: ClipboardProgramWriter = writeWithProgram
): Promise<void> => {
   for (const program of clipboardPrograms(platform)) {
      if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
      try {
         if (await write(program, content, signal)) return
      } catch (error) {
         if (signal?.aborted) throw new ClipboardInterruptedError({ cause: error })
      }
   }
   const guidance =
      platform === 'linux'
         ? '\nInstall wl-copy, xclip, or xsel.'
         : platform === 'aix' || platform === 'freebsd' || platform === 'openbsd' || platform === 'sunos'
           ? '\nInstall a supported clipboard provider such as wl-copy, xclip, or xsel.'
           : ''
   throw new CommitMasterError(`Unable to copy to the clipboard.${guidance}`)
}
