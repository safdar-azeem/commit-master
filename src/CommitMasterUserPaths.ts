import { homedir } from 'node:os'
import path from 'node:path'

export const commitMasterConfigDirectory = (): string => {
   const root =
      process.platform === 'win32'
         ? process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming')
         : process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config')
   return path.join(root, 'commit-master')
}

export const commitMasterFilebundleDirectory = (): string => {
   const root =
      process.platform === 'win32'
         ? process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
         : process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache')
   return path.join(root, 'commit-master', 'filebundles')
}
