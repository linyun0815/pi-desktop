import { BrowserWindow } from 'electron'
import { PiSdkManager } from '../pi-sdk-manager'
import { WorkspaceManager } from '../workspace-manager'
import { SessionTagManager } from '../session-tags'
import { ArchivedSessionsManager } from '../archived-sessions'
import { TerminalService } from '../terminal-service'
import { NotesManager } from '../notes-manager'
import { EmbeddedPiAdminManager } from '../embedded-pi-admin'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'

export interface IpcContext {
  workspaceManager: WorkspaceManager
  broadcast(channel: string, data: unknown): void
  getActivePi(): PiSdkManager
  approvedAttachmentPaths: Set<string>
  tagManager: SessionTagManager
  archivedSessions: ArchivedSessionsManager
  notesManager: NotesManager
  terminalService: TerminalService
  /** Lazy admin helper: SDK auth + package management, never sessions. */
  adminManager: EmbeddedPiAdminManager
}

export function createIpcContext(workspaceManager: WorkspaceManager): IpcContext {
  const tagManager = new SessionTagManager()
  const archivedSessions = new ArchivedSessionsManager()
  const terminalService = new TerminalService()
  const notesManager = new NotesManager()

  // Absolute paths the user explicitly picked via the native open dialog. The
  // attachment reader will only read these (or files inside the workspace), so a
  // renderer cannot ask it to read arbitrary files by path.
  const approvedAttachmentPaths = new Set<string>()

  // Helper: get the active workspace's embedded runtime manager
  function getActivePi(): PiSdkManager {
    const pi = workspaceManager.getActivePiManager()
    if (!pi) throw new Error('No active workspace or Pi not running')
    return pi
  }

  // Helper: broadcast to all renderer windows
  function broadcast(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data)
      }
    }
  }

  return {
    workspaceManager,
    broadcast,
    getActivePi,
    approvedAttachmentPaths,
    tagManager,
    archivedSessions,
    notesManager,
    terminalService,
    adminManager: new EmbeddedPiAdminManager({
      onAuthPrompt: (loginId, prompt) => broadcast(IPC_CHANNELS.EVENT_AUTH_PROMPT, { loginId, prompt }),
      onAuthNotify: (loginId, event) => broadcast(IPC_CHANNELS.EVENT_AUTH_NOTIFY, { loginId, event }),
      cwd: () => workspaceManager.getActiveWorkspace()?.path ?? process.env.HOME ?? process.cwd(),
    }),
  }
}
