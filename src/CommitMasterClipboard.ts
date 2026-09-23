import { spawn } from 'node:child_process'
import { ClipboardInterruptedError, CommitMasterError } from './CommitMasterErrors.js'
import { resolveLinuxClipboardHelper } from './CommitMasterLinuxClipboardHelper.js'

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

const JXA_FILE_CLIPBOARD_SCRIPT = `ObjC.import('AppKit')
function run(argv) {
   const pasteboard = $.NSPasteboard.generalPasteboard
   pasteboard.clearContents
   const fileURL = $.NSURL.fileURLWithPath(argv[0])
   if (!pasteboard.writeObjects([fileURL.js])) {
      throw new Error('Unable to copy file to clipboard')
   }
}`

interface FileClipboardAttempt {
   program: ClipboardProgram
   content: string
}

const fileClipboardPrograms = (
   filePath: string,
   platform: NodeJS.Platform
): readonly FileClipboardAttempt[] => {
   if (platform === 'darwin') {
      return [{
         program: {
            command: 'osascript',
            args: ['-l', 'JavaScript', '-e', JXA_FILE_CLIPBOARD_SCRIPT, filePath],
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
         if (exitCode === 0 && !inputFailed) resolve(true)
         else reject(new CommitMasterError(
            Buffer.concat(stderr).toString('utf8').trim() ||
               `Clipboard provider exited with status ${exitCode ?? 'unknown'}.`
         ))
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
   write: ClipboardProgramWriter = writeWithProgram,
   environment: NodeJS.ProcessEnv = process.env,
   arch: string = process.arch,
   resolveHelper: typeof resolveLinuxClipboardHelper = resolveLinuxClipboardHelper
): Promise<void> => {
   if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
   if (platform === 'linux') {
      if (!environment.WAYLAND_DISPLAY && !environment.DISPLAY) {
         throw new CommitMasterError('No graphical Linux clipboard session is available (WAYLAND_DISPLAY and DISPLAY are unset).')
      }
      const helper = resolveHelper(platform, arch)
      if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
      let failure: unknown
      try {
         if (await write({ command: helper, args: [filePath] }, '', signal)) return
      } catch (error) {
         if (signal?.aborted) throw new ClipboardInterruptedError({ cause: error })
         failure = error
      }
      if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
      const detail = failure instanceof Error ? ` ${failure.message}` : ''
      throw new CommitMasterError(`The bundled Linux file clipboard helper could not copy the file.${detail}`, { cause: failure })
   }
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
      platform === 'darwin' || platform === 'win32'
           ? ' Check that the system clipboard is available.'
           : ' File clipboard copying is not supported on this platform.'
   throw new CommitMasterError(`Unable to copy the Markdown file to the clipboard.${guidance}`)
}
