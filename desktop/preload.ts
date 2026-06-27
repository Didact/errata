/**
 * Preload bridge. Exposes a tiny, typed surface on window.errataDesktop so the renderer
 * can show the app version and drive update checks without Node access. Kept in sync with
 * the renderer-side types in src/lib/desktop.ts.
 */
import { contextBridge, ipcRenderer } from 'electron'

export interface DesktopUpdateState {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'skipped'
    | 'not-available'
    | 'error'
  version?: string
  releaseName?: string
  releaseDate?: string
  releaseNotes?: string
  percent?: number
  error?: string
}

export interface DesktopUpdatePrefs {
  autoInstall: boolean
  skippedVersion: string | null
}

const errataDesktop = {
  isDesktop: true as const,
  getVersion: (): Promise<string> => ipcRenderer.invoke('errata:app:get-version'),
  getUpdateState: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('errata:update:get-state'),
  getUpdatePrefs: (): Promise<DesktopUpdatePrefs> => ipcRenderer.invoke('errata:update:get-prefs'),
  setAutoInstall: (enabled: boolean): Promise<DesktopUpdatePrefs> =>
    ipcRenderer.invoke('errata:update:set-auto-install', enabled),
  checkForUpdates: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('errata:update:check'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('errata:update:download'),
  skipUpdate: (version: string): Promise<DesktopUpdatePrefs> =>
    ipcRenderer.invoke('errata:update:skip', version),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('errata:update:install'),
  onUpdateState: (cb: (state: DesktopUpdateState) => void): (() => void) => {
    const listener = (_event: unknown, state: DesktopUpdateState) => cb(state)
    ipcRenderer.on('errata:update:state', listener)
    return () => ipcRenderer.removeListener('errata:update:state', listener)
  },
}

contextBridge.exposeInMainWorld('errataDesktop', errataDesktop)
