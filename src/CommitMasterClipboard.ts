import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
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

const POWERSHELL_FILE_CLIPBOARD_SCRIPT =
   '[Console]::InputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $items=New-Object System.Collections.Specialized.StringCollection; [void]$items.Add([Console]::In.ReadToEnd()); [System.Windows.Forms.Clipboard]::SetFileDropList($items)'

const fileClipboardPrograms = (
   filePath: string,
   platform: NodeJS.Platform
): readonly { program: ClipboardProgram; content: string }[] => {
   if (platform === 'darwin') {
      return [{
         program: {
            command: 'osascript',
            args: [
               '-e', 'on run argv',
               '-e', 'set the clipboard to (POSIX file (item 1 of argv) as alias)',
               '-e', 'end run',
               filePath,
            ],
         },
         content: '',
      }]
   }
   if (platform === 'win32') {
      return [{
         program: {
            command: 'powershell.exe',
            args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', POWERSHELL_FILE_CLIPBOARD_SCRIPT],
         },
         content: filePath,
      }]
   }
   if (platform === 'linux') {
      const uriList = `${pathToFileURL(filePath).href}\r\n`
      return [
         { program: { command: 'wl-copy', args: ['--type', 'text/uri-list'] }, content: uriList },
         { program: { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'text/uri-list'] }, content: uriList },
      ]
   }
   return []
}

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

/** Copies a file reference, using a native file item or a file URI clipboard type. */
export const copyFileToClipboard = async (
   filePath: string,
   signal?: AbortSignal,
   platform: NodeJS.Platform = process.platform,
   write: ClipboardProgramWriter = writeWithProgram
): Promise<void> => {
   for (const { program, content } of fileClipboardPrograms(filePath, platform)) {
      if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
      try {
         if (await write(program, content, signal)) return
      } catch (error) {
         if (signal?.aborted) throw new ClipboardInterruptedError({ cause: error })
      }
   }
   if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
   const guidance =
      platform === 'linux'
         ? ' Install wl-copy or xclip with file URI clipboard support.'
         : platform === 'darwin' || platform === 'win32'
           ? ' Check that the system clipboard is available.'
           : ' File clipboard copying is not supported on this platform.'
   throw new CommitMasterError(`Unable to copy the Markdown file to the clipboard.${guidance}`)
}
