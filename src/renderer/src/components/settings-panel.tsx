import { useAppStore } from "../store";
import {
  DEFAULT_AGENT_ENGINE_LABEL,
  agentEngineLabel,
} from "../../../shared/agent-engine-label";
import { useState, useEffect, useRef, useCallback } from "react";
import { clsx } from "clsx";
import type {
  AgentDetectionOptions,
  AgentEngine,
  AgentInstallation,
  AppSettings,
  PermissionMode,
  CouncilConfig,
  PermissionRule,
  PermissionRulesScope,
  PermissionRulesWorkspaceStatus,
} from "../../../shared/ipc-contracts";
import type { ThemeFile } from "../../../shared/theme/theme-file";
import {
  Settings,
  Save,
  RotateCcw,
  FolderOpen,
  FolderTree,
  RefreshCw,
  Check,
  ChevronDown,
} from "lucide-react";
import { DEFAULT_SETTINGS } from "../../../shared/default-settings";
import { PermissionSelector } from "./permission-selector";
import { PermissionRulesEditor } from "./permission-rules-editor";
import {
  validateRuleList,
  shouldPersistScope,
} from "./permission-rules-editor-helpers";
import {
  applyTheme,
  getRegisteredThemes,
  registerThemes,
  setUserThemes,
} from "../utils/theme";
import { localizedThemeName } from "../utils/ui-text";
import { formatUiError } from "../utils/ipc-error";
import { BUILTIN_THEME_IDS } from "../themes";
import { CustomModelsEditor } from "./custom-models-editor";
import { ThemeEditor } from "./theme-editor";
import { ThemeGallery } from "./theme-gallery";
import type { UserThemeRecord } from "../../../shared/ipc-contracts";
import {
  MIN_TIMEOUT_SECONDS as COUNCIL_MIN_TIMEOUT,
  MAX_TIMEOUT_SECONDS as COUNCIL_MAX_TIMEOUT,
  clampTimeoutSeconds as clampCouncilTimeout,
} from "../../../shared/council-config";

// Empty `match` from the input means "no pattern" and must not be persisted
// as `""` — the main-process validator rejects unknown/empty-string quirks
// and downstream matching treats a missing key as "match anything".
function normalizedRules(rules: PermissionRule[]): PermissionRule[] {
  return rules.map((rule) => {
    const tool = rule.tool.trim();
    const match = rule.match?.trim();
    return match
      ? { action: rule.action, tool, match }
      : { action: rule.action, tool };
  });
}

interface ScopeRulesState {
  rules: PermissionRule[];
  loaded: boolean;
  loadError: string | null;
  exists: boolean;
}

const EMPTY_SCOPE_RULES: ScopeRulesState = {
  rules: [],
  loaded: false,
  loadError: null,
  exists: false,
};

export function SettingsPanel(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings);
  const loadSettings = useAppStore((state) => state.loadSettings);
  const setSettingsDraft = useAppStore((state) => state.setSettingsDraft);
  const clearSettingsDraft = useAppStore((state) => state.clearSettingsDraft);
  const activeWorkspace = useAppStore((state) => state.activeWorkspace);

  // Snapshot the unsaved draft once, for seeding initial local state. This is
  // what makes edits survive leaving/returning to Settings without saving.
  const draft0 = useAppStore.getState().settingsDraft;

  const initialPiPath =
    draft0.piExecutablePath ??
    settings?.piExecutablePath ??
    DEFAULT_SETTINGS.piExecutablePath;
  const initialPiEngine =
    draft0.piEngine ?? settings?.piEngine ?? DEFAULT_SETTINGS.piEngine;
  const [piPath, setPiPath] = useState(initialPiPath);
  const [piEngine, setPiEngine] = useState<AgentEngine>(initialPiEngine);
  // The setting above may be 'auto'; this is the engine that actually resolved,
  // which is what any sentence naming the running agent has to say.
  const runningEngineLabel = useAppStore(
    (state) => agentEngineLabel(state.piEngine) ?? DEFAULT_AGENT_ENGINE_LABEL,
  );
  const [customAgentPathMode, setCustomAgentPathMode] = useState(() => {
    const normalized = initialPiPath.trim().toLowerCase();
    return (
      Boolean(initialPiPath.trim()) &&
      normalized !== "pi" &&
      normalized !== "omp"
    );
  });
  const [detectedAgentInstalls, setDetectedAgentInstalls] = useState<
    AgentInstallation[]
  >([]);
  const [scanningAgentInstalls, setScanningAgentInstalls] = useState(false);
  const [theme, setTheme] = useState(
    draft0.theme ?? settings?.theme ?? DEFAULT_SETTINGS.theme,
  );
  const [themeActionError, setThemeActionError] = useState<string | null>(null);
  const [themeEditorState, setThemeEditorState] = useState<{
    baseTheme: ThemeFile;
    baseId: string;
    isUserTheme: boolean;
  } | null>(null);
  const [installUrl, setInstallUrl] = useState("");
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [fontSize, setFontSize] = useState(
    draft0.fontSize ?? settings?.fontSize ?? DEFAULT_SETTINGS.fontSize,
  );
  const [terminalFontSize, setTerminalFontSize] = useState(
    draft0.terminalFontSize ??
      settings?.terminalFontSize ??
      DEFAULT_SETTINGS.terminalFontSize,
  );
  const [codeEditorFontSize, setCodeEditorFontSize] = useState(
    draft0.codeEditorFontSize ??
      settings?.codeEditorFontSize ??
      DEFAULT_SETTINGS.codeEditorFontSize,
  );
  const [showThinking, setShowThinking] = useState(
    draft0.showThinking ??
      settings?.showThinking ??
      DEFAULT_SETTINGS.showThinking,
  );
  const [autoScroll, setAutoScroll] = useState(
    draft0.autoScroll ?? settings?.autoScroll ?? DEFAULT_SETTINGS.autoScroll,
  );
  const [desktopNotifications, setDesktopNotifications] = useState(
    draft0.desktopNotifications ??
      settings?.desktopNotifications ??
      DEFAULT_SETTINGS.desktopNotifications,
  );
  const [resumeLastSession, setResumeLastSession] = useState(
    draft0.resumeLastSession ??
      settings?.resumeLastSession ??
      DEFAULT_SETTINGS.resumeLastSession,
  );
  const [openToHomeOnLaunch, setOpenToHomeOnLaunch] = useState(
    draft0.openToHomeOnLaunch ??
      settings?.openToHomeOnLaunch ??
      DEFAULT_SETTINGS.openToHomeOnLaunch,
  );
  const [runOnStartup, setRunOnStartup] = useState(
    draft0.runOnStartup ??
      settings?.runOnStartup ??
      DEFAULT_SETTINGS.runOnStartup,
  );
  const [minimizeToTrayOnClose, setMinimizeToTrayOnClose] = useState(
    draft0.minimizeToTrayOnClose ??
      settings?.minimizeToTrayOnClose ??
      DEFAULT_SETTINGS.minimizeToTrayOnClose,
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    draft0.permissionMode ??
      settings?.permissionMode ??
      DEFAULT_SETTINGS.permissionMode,
  );
  const [rulesScope, setRulesScope] = useState<PermissionRulesScope>("global");
  const [scopeRules, setScopeRules] = useState<
    Record<PermissionRulesScope, ScopeRulesState>
  >({
    global: EMPTY_SCOPE_RULES,
    workspace: EMPTY_SCOPE_RULES,
  });
  const [rulesActionError, setRulesActionError] = useState<string | null>(null);
  const [workspaceRulesStatus, setWorkspaceRulesStatus] =
    useState<PermissionRulesWorkspaceStatus | null>(null);
  const [saved, setSaved] = useState(false);

  const [showCouncilWarning, setShowCouncilWarning] = useState(false);
  const [detectedAgents, setDetectedAgents] = useState<
    Record<"pi" | "claude" | "codex", boolean>
  >({
    pi: false,
    claude: false,
    codex: false,
  });
  // Free-text draft for the timeout field so the user can clear it and type a
  // new value; it is clamped and persisted only on blur / Enter (not per keystroke).
  const [timeoutDraft, setTimeoutDraft] = useState("");
  const agentScanToken = useRef(0);

  const scanAgentInstallations = useCallback(
    async (options?: AgentDetectionOptions): Promise<void> => {
      const token = ++agentScanToken.current;
      setScanningAgentInstalls(true);
      try {
        const result = await window.piDesktop.pi.detectInstallations(options);
        if (token === agentScanToken.current)
          setDetectedAgentInstalls(result.installations);
      } catch {
        if (token === agentScanToken.current) setDetectedAgentInstalls([]);
      } finally {
        if (token === agentScanToken.current) setScanningAgentInstalls(false);
      }
    },
    [],
  );

  useEffect(
    () => () => {
      agentScanToken.current++;
    },
    [],
  );

  // Detect available agent engines on mount. Cached results are fine here —
  // only the explicit Rescan below needs a fresh look at the disk.
  useEffect(() => {
    void scanAgentInstallations();
  }, [scanAgentInstallations]);

  useEffect(() => {
    const installation = detectedAgentInstalls.find(
      (candidate) => candidate.path === piPath,
    );
    if (installation && installation.kind === piEngine)
      setCustomAgentPathMode(false);
  }, [detectedAgentInstalls, piEngine, piPath]);

  // Detect available council agents on mount
  useEffect(() => {
    let cancelled = false;
    void window.piDesktop.council.detect().then((result) => {
      if (cancelled) return;
      const next: Record<"pi" | "claude" | "codex", boolean> = {
        pi: false,
        claude: false,
        codex: false,
      };
      for (const agent of result.agents) {
        next[agent.id] = agent.found;
      }
      setDetectedAgents(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load permission rules for one scope. The store draft for that scope wins
  // over the saved file so unsaved edits survive view switches. The draft is
  // read at resolve time (inside the functional update), not before the
  // await, so an edit made during the round-trip isn't visually reverted by
  // a draft snapshot that predates it.
  const loadRulesScope = useCallback(
    async (scope: PermissionRulesScope): Promise<void> => {
      const saved = await window.piDesktop.permissionRules.get(scope);
      setScopeRules((prev) => {
        const draft = useAppStore.getState().permissionRulesDrafts[scope];
        return {
          ...prev,
          [scope]: saved.ok
            ? {
                rules: draft ?? saved.rules,
                loaded: true,
                loadError: null,
                exists: saved.exists,
              }
            : // Corrupt file: only a pre-existing user draft keeps Save enabled —
              // see shouldPersistScope; an unrelated Save must not clobber it.
              {
                rules: draft ?? [],
                loaded: draft !== null,
                loadError: formatUiError(saved.error),
                exists: true,
              },
        };
      });
    },
    [],
  );

  const loadWorkspaceRulesStatus = useCallback(async (): Promise<void> => {
    const status = await window.piDesktop.permissionRules.workspaceStatus();
    setWorkspaceRulesStatus(status);
  }, []);

  const handleSetWorkspaceTrust = useCallback(
    async (trusted: boolean): Promise<void> => {
      const status =
        await window.piDesktop.permissionRules.setWorkspaceTrust(trusted);
      setWorkspaceRulesStatus(status);
    },
    [],
  );

  useEffect(() => {
    void loadRulesScope("global");
    void loadRulesScope("workspace");
    void loadWorkspaceRulesStatus();
  }, [loadRulesScope, loadWorkspaceRulesStatus]);

  // The workspace-scope rules are keyed by scope, not by workspace, so if the
  // active workspace changes while this panel stays mounted (e.g. switching
  // workspaces from the sidebar without leaving Settings), the previous
  // workspace's loaded/exists state would otherwise stick around and could
  // pass shouldPersistScope on an unrelated Save, writing it into the new
  // workspace's file. Reset and re-fetch whenever the path changes. Skipped
  // on the initial mount — the load-on-mount effect above already covers it.
  const activeWorkspacePathRef = useRef(activeWorkspace?.path ?? null);
  useEffect(() => {
    const path = activeWorkspace?.path ?? null;
    if (activeWorkspacePathRef.current === path) return;
    activeWorkspacePathRef.current = path;
    setScopeRules((prev) => ({ ...prev, workspace: EMPTY_SCOPE_RULES }));
    void loadRulesScope("workspace");
    void loadWorkspaceRulesStatus();
  }, [activeWorkspace?.path, loadRulesScope, loadWorkspaceRulesStatus]);

  // Re-read a scope's file when the user switches to its tab, so manual edits
  // to the file on disk show up — but not if there's an unsaved draft for it.
  const handleRulesScopeChange = (scope: PermissionRulesScope): void => {
    setRulesScope(scope);
    setRulesActionError(null);
    if (useAppStore.getState().permissionRulesDrafts[scope] === null)
      void loadRulesScope(scope);
  };

  // Keep the timeout draft in sync with the persisted value (e.g. after a save
  // clamps it, or when settings first load).
  const councilTimeout = settings?.council?.timeoutSeconds;
  useEffect(() => {
    if (councilTimeout !== undefined) setTimeoutDraft(String(councilTimeout));
  }, [councilTimeout]);

  // Merge a council patch into the current config and persist via the store mechanism
  const saveCouncil = async (patch: Partial<CouncilConfig>): Promise<void> => {
    if (!settings) return;
    const nextCouncil: CouncilConfig = { ...settings.council, ...patch };
    await window.piDesktop.settings.save({ council: nextCouncil });
    await loadSettings();
  };

  // Persist and apply a setting immediately, for toggles with an OS-level side
  // effect (tray behavior, login item). These must take effect the instant they
  // are flipped — staging them behind the Save button makes a toggle look "on"
  // while the behavior is still off, which is surprising and easy to miss.
  const applyImmediate = async (patch: Partial<AppSettings>): Promise<void> => {
    await window.piDesktop.settings.save(patch);
    await loadSettings();
  };

  // Populate the form once, when settings first load. We deliberately do NOT
  // re-sync on every settings change: the UI font previews live and the
  // terminal/editor sizes are staged in store state, so re-syncing would
  // clobber other unsaved edits. Save/Reset set local state directly, so the
  // form stays correct without a re-sync.
  const didInitRef = useRef(false);
  useEffect(() => {
    if (!settings || didInitRef.current) return;
    didInitRef.current = true;
    const store = useAppStore.getState();
    const draft = store.settingsDraft;
    const nextPiPath = draft.piExecutablePath ?? settings.piExecutablePath;
    const nextPiEngine = draft.piEngine ?? settings.piEngine;
    setPiPath(nextPiPath);
    setPiEngine(nextPiEngine);
    const normalizedPiPath = nextPiPath.trim().toLowerCase();
    setCustomAgentPathMode(
      Boolean(nextPiPath.trim()) &&
        normalizedPiPath !== "pi" &&
        normalizedPiPath !== "omp",
    );
    setTheme(draft.theme ?? settings.theme);
    setFontSize(draft.fontSize ?? settings.fontSize);
    setTerminalFontSize(draft.terminalFontSize ?? settings.terminalFontSize);
    setCodeEditorFontSize(
      draft.codeEditorFontSize ?? settings.codeEditorFontSize,
    );
    setShowThinking(draft.showThinking ?? settings.showThinking);
    setAutoScroll(draft.autoScroll ?? settings.autoScroll);
    setDesktopNotifications(
      draft.desktopNotifications ?? settings.desktopNotifications,
    );
    setResumeLastSession(draft.resumeLastSession ?? settings.resumeLastSession);
    setOpenToHomeOnLaunch(
      draft.openToHomeOnLaunch ?? settings.openToHomeOnLaunch,
    );
    setRunOnStartup(draft.runOnStartup ?? settings.runOnStartup);
    setMinimizeToTrayOnClose(
      draft.minimizeToTrayOnClose ?? settings.minimizeToTrayOnClose,
    );
    setPermissionMode(draft.permissionMode ?? settings.permissionMode);
  }, [settings]);

  const setAgentPath = (path: string, custom = true): void => {
    setPiPath(path);
    setCustomAgentPathMode(custom);
    setSettingsDraft({ piExecutablePath: path });
  };

  const setAgentEngine = (engine: AgentEngine): void => {
    setPiEngine(engine);
    setSettingsDraft({ piEngine: engine });
  };

  const handleAgentSelection = (value: string): void => {
    if (value === "__auto__") {
      setAgentPath("pi", false);
      setAgentEngine("auto");
      return;
    }
    if (value === "__custom__") {
      if (!customAgentPathMode) setAgentPath("", true);
      return;
    }
    const installation = detectedAgentInstalls.find(
      (candidate) => candidate.path === value,
    );
    setAgentPath(value, false);
    setAgentEngine(
      installation?.kind ?? (value.toLowerCase() === "omp" ? "omp" : "auto"),
    );
  };

  const applySelectedAgentPath = (path: string): void => {
    const installation = detectedAgentInstalls.find(
      (candidate) => candidate.path === path,
    );
    setAgentPath(path);
    if (installation) setAgentEngine(installation.kind);
  };

  const handleSelectPath = async (): Promise<void> => {
    const path = await window.piDesktop.system.openDialog({
      title: "选择代理可执行文件",
      mode: "file",
    });
    if (path) applySelectedAgentPath(path);
  };

  const handleSelectDirectory = async (): Promise<void> => {
    const path = await window.piDesktop.system.openDialog({
      title: "选择代理安装目录",
      mode: "directory",
    });
    if (path) applySelectedAgentPath(path);
  };

  const autoAgentSelection =
    !customAgentPathMode &&
    (piPath.trim().toLowerCase() === "pi" || piPath.trim() === "");
  const detectedAgentSelection =
    !customAgentPathMode &&
    detectedAgentInstalls.some((installation) => installation.path === piPath);
  const agentSelection = customAgentPathMode
    ? "__custom__"
    : autoAgentSelection
      ? "__auto__"
      : detectedAgentSelection
        ? piPath
        : piPath.trim().toLowerCase() === "omp" &&
            !detectedAgentInstalls.some(
              (installation) => installation.kind === "omp",
            )
          ? "omp"
          : "__custom__";
  const showCustomAgentPath = customAgentPathMode || agentSelection === "omp";

  const resolveEffectiveThemeId = (themeId: string): string => {
    if (themeId !== "system") return themeId;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  };

  const isBuiltinTheme = (themeId: string): boolean =>
    (BUILTIN_THEME_IDS as string[]).includes(themeId);
  const isEditableUserTheme = theme !== "system" && !isBuiltinTheme(theme);

  const openCreateThemeEditor = () => {
    const effectiveId = resolveEffectiveThemeId(theme);
    const registered = getRegisteredThemes();
    const baseTheme =
      registered.find((t) => t.id === effectiveId)?.file ??
      registered.find((t) => t.id === "dark")!.file;
    setThemeEditorState({ baseTheme, baseId: effectiveId, isUserTheme: false });
  };

  const openEditThemeEditor = () => {
    const baseTheme = getRegisteredThemes().find((t) => t.id === theme)?.file;
    if (!baseTheme) {
      setThemeActionError("找不到要编辑的当前主题");
      return;
    }
    setThemeEditorState({ baseTheme, baseId: theme, isUserTheme: true });
  };

  const handleThemeEditorSaved = async (id: string, warning?: string) => {
    setTheme(id);
    // A warning is a non-fatal post-save problem (rename cleanup failure).
    // It has to live in the panel's themeActionError, not the editor's own
    // saveError: the editor unmounts in this same commit, so only state
    // owned here survives long enough to render.
    setThemeActionError(warning ?? null);
    setThemeEditorState(null);
    // Reconcile the registry against disk so a rename drops the old id from
    // the dropdown (the editor already registered + applied the new one).
    const { themes, warnings } = await window.piDesktop.themes.list();
    for (const w of warnings) console.warn(w);
    setUserThemes(themes);
  };

  const handleImportTheme = async () => {
    const result = await window.piDesktop.themes.import();
    if (result.ok) {
      registerThemes([result.theme]);
      applyTheme(result.theme.id);
      setTheme(result.theme.id);
      setSettingsDraft({ theme: result.theme.id });
      setThemeActionError(null);
    } else if (!("canceled" in result)) {
      setThemeActionError(formatUiError(result.error));
    }
  };

  const handleExportTheme = async () => {
    const effectiveThemeId = resolveEffectiveThemeId(theme);
    const currentThemeFile = getRegisteredThemes().find(
      (t) => t.id === effectiveThemeId,
    )?.file;
    if (!currentThemeFile) {
      setThemeActionError("找不到要导出的当前主题");
      return;
    }
    const result = await window.piDesktop.themes.export(currentThemeFile);
    if (result.ok) {
      setThemeActionError(null);
    } else if (!("canceled" in result)) {
      setThemeActionError(formatUiError(result.error));
    }
  };

  const handleInstallFromUrl = async () => {
    if (!installUrl.trim()) return;
    const result = await window.piDesktop.themes.installFromUrl(
      installUrl.trim(),
    );
    if (result.ok) {
      registerThemes([result.theme]);
      applyTheme(result.theme.id);
      setTheme(result.theme.id);
      setSettingsDraft({ theme: result.theme.id });
      setThemeActionError(null);
      setInstallUrl("");
    } else if (!("canceled" in result)) {
      setThemeActionError(formatUiError(result.error));
    }
  };
  const handleGalleryInstalled = (installed: UserThemeRecord) => {
    registerThemes([installed]);
    applyTheme(installed.id);
    setTheme(installed.id);
    setSettingsDraft({ theme: installed.id });
    setThemeActionError(null);
  };

  const handleDeleteTheme = async () => {
    const themeName =
      getRegisteredThemes().find((t) => t.id === theme)?.file.name ?? theme;
    // Confirm before destructive action via the app's themed dialog, matching
    // the pattern used for session delete (context-menu.tsx) rather than the
    // native window.confirm. Deleting a theme file has no undo.
    const ok = await useAppStore.getState().requestConfirm({
      title: "删除主题",
      message: `删除主题“${themeName}”？此操作无法撤销。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    await window.piDesktop.themes.delete(theme);
    const { themes, warnings } = await window.piDesktop.themes.list();
    for (const warning of warnings) {
      console.warn(warning);
    }
    setUserThemes(themes);
    setTheme("dark");
    applyTheme("dark");
    setSettingsDraft({ theme: "dark" });
    setThemeActionError(null);
  };

  const handleRulesChange = (rules: PermissionRule[]): void => {
    setScopeRules((prev) => ({
      ...prev,
      [rulesScope]: { ...prev[rulesScope], rules, loaded: true },
    }));
    setRulesActionError(null);
    // The user edited or imported rules in this panel — Save is now allowed
    // to persist the list even if the on-disk file failed to load.
    useAppStore.getState().setPermissionRulesDraft(rulesScope, rules);
  };

  const handleRulesImport = async (): Promise<void> => {
    const result = await window.piDesktop.permissionRules.importFromFile();
    if (result.ok) {
      handleRulesChange(result.rules);
    } else if (!result.canceled) {
      setRulesActionError(formatUiError(result.error ?? "导入失败"));
    }
  };

  const handleRulesExport = async (): Promise<void> => {
    const result = await window.piDesktop.permissionRules.exportToFile(
      normalizedRules(scopeRules[rulesScope].rules),
    );
    if (!result.ok && !result.canceled) {
      setRulesActionError(formatUiError(result.error ?? "导出失败"));
    }
  };

  // Only reachable from the workspace tab (the button is scope-gated in the
  // editor), so `rulesScope` is 'workspace' when this runs.
  const handleCopyFromGlobal = (): void => {
    handleRulesChange(scopeRules.global.rules.map((rule) => ({ ...rule })));
  };

  const handleRemoveWorkspaceRules = async (): Promise<void> => {
    const confirmed = await useAppStore.getState().requestConfirm({
      title: "移除工作区规则",
      message:
        "删除此工作区的 .pi-desktop/permission-rules.json？之后将恢复使用全局权限规则。",
      confirmLabel: "移除",
      danger: true,
    });
    if (!confirmed) return;
    const result = await window.piDesktop.permissionRules.removeWorkspace();
    if (!result.ok) {
      setRulesActionError(formatUiError(result.error));
      return;
    }
    useAppStore.getState().setPermissionRulesDraft("workspace", null);
    setScopeRules((prev) => ({
      ...prev,
      workspace: { ...EMPTY_SCOPE_RULES, loaded: true },
    }));
  };

  const handleSave = async () => {
    // Validate rules before anything persists, so invalid rules abort the
    // whole save cleanly. Only scopes shouldPersistScope would actually
    // write are validated — never validate an empty list caused by a failed
    // load as if the user cleared the rules.
    const drafts = useAppStore.getState().permissionRulesDrafts;
    const scopesToPersist = (["global", "workspace"] as const).filter((scope) =>
      shouldPersistScope(
        drafts[scope],
        scopeRules[scope].loaded,
        scopeRules[scope].exists,
      ),
    );
    for (const scope of scopesToPersist) {
      const rulesError = validateRuleList(scopeRules[scope].rules);
      if (rulesError) {
        setRulesScope(scope);
        setRulesActionError(rulesError);
        return;
      }
    }

    const updated: Partial<AppSettings> = {
      piExecutablePath: piPath,
      piEngine,
      theme,
      fontSize,
      terminalFontSize,
      codeEditorFontSize,
      showThinking,
      autoScroll,
      desktopNotifications,
      resumeLastSession,
      openToHomeOnLaunch,
      runOnStartup,
      minimizeToTrayOnClose,
      permissionMode,
    };

    const result = await window.piDesktop.settings.save(updated);

    // Apply theme and font size immediately
    applyTheme(result.theme);
    document.documentElement.style.fontSize = `${result.fontSize}px`;

    // Reload settings in store
    await loadSettings();

    // Persist permission rules too (only the scopes shouldPersistScope
    // allowed — never overwrite a scope's file with an empty list because
    // loading failed and the user never touched it).
    for (const scope of scopesToPersist) {
      const rulesResult = await window.piDesktop.permissionRules.set(
        scope,
        normalizedRules(scopeRules[scope].rules),
      );
      if (!rulesResult.ok) {
        // Settings already saved above; do not report overall success and
        // do not clear either draft, so the user's rules edits survive and
        // can be retried.
        setRulesScope(scope);
        setRulesActionError(
          `设置已保存，但${scope === "global" ? "全局" : "工作区"}权限规则未保存：${formatUiError(rulesResult.error)}`,
        );
        return;
      }
      setScopeRules((prev) => ({
        ...prev,
        [scope]: { ...prev[scope], loadError: null, exists: true },
      }));
    }

    // Persisted now — drop the unsaved draft so the form and terminal/editor
    // read the saved settings (just refreshed).
    clearSettingsDraft();

    // Show saved indicator
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = async () => {
    // Reset only the fields this panel exposes; the rest (council, default
    // model/provider/cwd, collapsed groups) are left as-is by the Partial merge.
    // Values come from the shared DEFAULT_SETTINGS so there's one source of truth.
    const defaults: Partial<AppSettings> = {
      piExecutablePath: DEFAULT_SETTINGS.piExecutablePath,
      piEngine: DEFAULT_SETTINGS.piEngine,
      theme: DEFAULT_SETTINGS.theme,
      fontSize: DEFAULT_SETTINGS.fontSize,
      terminalFontSize: DEFAULT_SETTINGS.terminalFontSize,
      codeEditorFontSize: DEFAULT_SETTINGS.codeEditorFontSize,
      showThinking: DEFAULT_SETTINGS.showThinking,
      autoScroll: DEFAULT_SETTINGS.autoScroll,
      desktopNotifications: DEFAULT_SETTINGS.desktopNotifications,
      resumeLastSession: DEFAULT_SETTINGS.resumeLastSession,
      openToHomeOnLaunch: DEFAULT_SETTINGS.openToHomeOnLaunch,
      runOnStartup: DEFAULT_SETTINGS.runOnStartup,
      minimizeToTrayOnClose: DEFAULT_SETTINGS.minimizeToTrayOnClose,
      permissionMode: DEFAULT_SETTINGS.permissionMode,
    };

    setPiPath(defaults.piExecutablePath!);
    setPiEngine(defaults.piEngine!);
    setCustomAgentPathMode(false);
    setTheme(defaults.theme!);
    setFontSize(defaults.fontSize!);
    setTerminalFontSize(defaults.terminalFontSize!);
    setCodeEditorFontSize(defaults.codeEditorFontSize!);
    setShowThinking(defaults.showThinking!);
    setAutoScroll(defaults.autoScroll!);
    setDesktopNotifications(defaults.desktopNotifications!);
    setResumeLastSession(defaults.resumeLastSession!);
    setOpenToHomeOnLaunch(defaults.openToHomeOnLaunch!);
    setRunOnStartup(defaults.runOnStartup!);
    setMinimizeToTrayOnClose(defaults.minimizeToTrayOnClose!);
    setPermissionMode(defaults.permissionMode!);
    setScopeRules({ global: EMPTY_SCOPE_RULES, workspace: EMPTY_SCOPE_RULES });
    setRulesActionError(null);
    useAppStore.getState().setPermissionRulesDraft("global", null);
    useAppStore.getState().setPermissionRulesDraft("workspace", null);
    void loadRulesScope("global");
    void loadRulesScope("workspace");

    const result = await window.piDesktop.settings.save(defaults);
    applyTheme(result.theme);
    document.documentElement.style.fontSize = `${result.fontSize}px`;
    await loadSettings();
    clearSettingsDraft();

    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Settings size={20} className="text-muted" />
            <h1 className="text-lg font-semibold text-primary">设置</h1>
          </div>
        </div>

        {/* Agent Configuration */}
        <SettingsSection title="代理配置">
          <SettingsRow
            label="代理安装"
            description="自动检测 Pi 和 OMP，选择已安装的引擎，或使用自定义可执行文件/路径。"
            stack
          >
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <select
                  value={agentSelection}
                  onChange={(e) => handleAgentSelection(e.target.value)}
                  className="min-w-0 flex-1 appearance-none rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary hover:border-border-strong-hover focus:border-focus focus:outline-none"
                >
                  <option value="__auto__">
                    自动检测（优先 Pi，其次 OMP）
                  </option>
                  {detectedAgentInstalls.map((installation) => (
                    <option
                      key={`${installation.kind}:${installation.path}`}
                      value={installation.path}
                    >
                      {installation.kind === "omp" ? "OMP" : "Pi"} —{" "}
                      {installation.path}
                    </option>
                  ))}
                  {agentSelection === "omp" && (
                    <option value="omp">OMP（未找到）</option>
                  )}
                  <option value="__custom__">自定义路径…</option>
                </select>
                <button
                  onClick={handleSelectPath}
                  title="选择代理可执行文件"
                  aria-label="选择代理可执行文件"
                  className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors"
                >
                  <FolderOpen size={14} />
                </button>
                <button
                  onClick={handleSelectDirectory}
                  title="选择代理安装目录"
                  aria-label="选择代理安装目录"
                  className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors"
                >
                  <FolderTree size={14} />
                </button>
                <button
                  // Forced: the user clicks this right after installing an
                  // engine, so the cached detection result would be stale.
                  onClick={() => void scanAgentInstallations({ force: true })}
                  disabled={scanningAgentInstalls}
                  title="重新扫描已安装的代理"
                  aria-label="重新扫描已安装的代理"
                  className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors disabled:opacity-50"
                >
                  <RefreshCw
                    size={14}
                    className={
                      scanningAgentInstalls ? "animate-spin" : undefined
                    }
                  />
                </button>
              </div>
              {showCustomAgentPath && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={piPath}
                    onChange={(e) => setAgentPath(e.target.value)}
                    placeholder="可执行文件、cli.js 或安装目录的路径"
                    className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary focus:border-focus focus:outline-none"
                  />
                  <select
                    value={piEngine}
                    onChange={(e) =>
                      setAgentEngine(e.target.value as AgentEngine)
                    }
                    aria-label="代理引擎"
                    className="rounded-md border border-border-strong bg-surface px-2 py-1.5 text-sm text-primary focus:border-focus focus:outline-none"
                  >
                    <option value="auto">自动</option>
                    <option value="pi">Pi</option>
                    <option value="omp">OMP</option>
                  </select>
                </div>
              )}
              <div className="text-xs text-dim">
                {scanningAgentInstalls
                  ? "正在扫描常见安装位置和 PATH…"
                  : detectedAgentInstalls.length > 0
                    ? `检测到 ${detectedAgentInstalls.length} 个已安装的引擎`
                    : "尚未检测到 Pi 或 OMP 安装"}
              </div>
            </div>
          </SettingsRow>
        </SettingsSection>

        {/* Appearance */}
        <SettingsSection title="外观">
          <SettingsRow label="主题" description="应用配色方案">
            <div className="relative">
              <select
                value={theme}
                onChange={(e) => {
                  const newTheme = e.target.value;
                  setTheme(newTheme);
                  applyTheme(newTheme);
                  setSettingsDraft({ theme: newTheme });
                }}
                className="w-full appearance-none rounded-md border border-border-strong bg-surface py-1.5 pl-3 pr-9 text-sm text-primary hover:border-border-strong-hover focus:border-focus focus:outline-none"
              >
                <option value="system">跟随系统</option>
                {getRegisteredThemes().map((registeredTheme) => (
                  <option key={registeredTheme.id} value={registeredTheme.id}>
                    {localizedThemeName(
                      registeredTheme.id,
                      registeredTheme.file.name,
                    )}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-dim"
              />
            </div>
          </SettingsRow>

          <SettingsRow
            label="自定义主题"
            description="基于当前主题创建副本，或编辑你创建的主题"
          >
            <div className="flex gap-2">
              <button
                onClick={openCreateThemeEditor}
                className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors"
              >
                创建主题
              </button>
              {isEditableUserTheme && (
                <button
                  onClick={openEditThemeEditor}
                  className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors"
                >
                  编辑主题
                </button>
              )}
            </div>
          </SettingsRow>

          <SettingsRow
            label="主题操作"
            description="导入、导出或从 URL 安装主题"
            stack
          >
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <button
                  onClick={handleImportTheme}
                  className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors"
                >
                  导入
                </button>
                <button
                  onClick={handleExportTheme}
                  className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors"
                >
                  导出
                </button>
                <button
                  onClick={() => setGalleryOpen(true)}
                  className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors"
                >
                  浏览主题库
                </button>
                {!isBuiltinTheme(theme) && (
                  <button
                    onClick={handleDeleteTheme}
                    className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors"
                  >
                    删除
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={installUrl}
                  onChange={(e) => setInstallUrl(e.target.value)}
                  placeholder="https://example.com/theme.json"
                  className="flex-1 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary focus:border-focus focus:outline-none"
                />
                <button
                  onClick={handleInstallFromUrl}
                  className="shrink-0 rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors"
                >
                  安装
                </button>
              </div>
              {themeActionError && (
                <p className="text-xs text-error">{themeActionError}</p>
              )}
            </div>
          </SettingsRow>

          <SettingsRow
            label="界面字体大小"
            description="聊天、面板和侧边栏的字体大小，不影响终端和代码编辑器"
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={10}
                max={20}
                value={fontSize}
                onChange={(e) => {
                  const size = Number(e.target.value);
                  setFontSize(size);
                  document.documentElement.style.fontSize = `${size}px`;
                  setSettingsDraft({ fontSize: size });
                }}
                className="flex-1 accent-accent"
              />
              <span className="w-8 text-right text-sm text-muted">
                {fontSize}
              </span>
            </div>
          </SettingsRow>

          <SettingsRow label="终端字体大小" description="终端面板的字体大小">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={10}
                max={20}
                value={terminalFontSize}
                onChange={(e) => {
                  const size = Number(e.target.value);
                  setTerminalFontSize(size);
                  setSettingsDraft({ terminalFontSize: size });
                }}
                className="flex-1 accent-accent"
              />
              <span className="w-8 text-right text-sm text-muted">
                {terminalFontSize}
              </span>
            </div>
          </SettingsRow>

          <SettingsRow
            label="代码编辑器字体大小"
            description="代码编辑器/文件查看器的字体大小"
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={10}
                max={20}
                value={codeEditorFontSize}
                onChange={(e) => {
                  const size = Number(e.target.value);
                  setCodeEditorFontSize(size);
                  setSettingsDraft({ codeEditorFontSize: size });
                }}
                className="flex-1 accent-accent"
              />
              <span className="w-8 text-right text-sm text-muted">
                {codeEditorFontSize}
              </span>
            </div>
          </SettingsRow>
        </SettingsSection>

        {/* Behavior */}
        <SettingsSection title="行为">
          <SettingsRow label="权限模式" description="Pi 操作的默认安全模式">
            <PermissionSelector
              value={permissionMode}
              onChange={(mode) => {
                setPermissionMode(mode);
                setSettingsDraft({ permissionMode: mode });
              }}
              compact
            />
          </SettingsRow>

          <SettingsRow
            label="权限规则"
            description="针对上述模式的工具级细粒度覆盖规则"
            stack
          >
            <div
              className="mb-2 flex gap-1"
              role="tablist"
              aria-label="权限规则范围"
            >
              {(["global", "workspace"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  role="tab"
                  aria-selected={rulesScope === scope}
                  onClick={() => handleRulesScopeChange(scope)}
                  className={clsx(
                    "rounded-md px-2 py-1 text-xs transition-colors",
                    rulesScope === scope
                      ? "bg-surface border border-border-strong text-primary"
                      : "text-dim hover:text-primary",
                  )}
                >
                  {scope === "global" ? "全局" : "当前工作区"}
                </button>
              ))}
            </div>
            <PermissionRulesEditor
              rules={scopeRules[rulesScope].rules}
              onChange={handleRulesChange}
              onImport={() => void handleRulesImport()}
              onExport={() => void handleRulesExport()}
              scope={rulesScope}
              workspaceExists={scopeRules.workspace.exists}
              onCopyFromGlobal={handleCopyFromGlobal}
              onRemoveWorkspace={() => void handleRemoveWorkspaceRules()}
              workspaceOverride={scopeRules.workspace.exists}
              workspaceActive={!!activeWorkspace}
              workspaceTrusted={workspaceRulesStatus?.trusted ?? false}
              workspaceHasAllowRules={
                workspaceRulesStatus?.hasAllowRules ?? false
              }
              onSetWorkspaceTrust={(trusted) =>
                void handleSetWorkspaceTrust(trusted)
              }
              loadError={scopeRules[rulesScope].loadError}
              actionError={rulesActionError}
            />
          </SettingsRow>

          <SettingsRow
            label="显示思考过程"
            description="在响应中显示模型思考内容"
          >
            <Toggle
              checked={showThinking}
              onChange={(v) => {
                setShowThinking(v);
                setSettingsDraft({ showThinking: v });
              }}
            />
          </SettingsRow>

          <SettingsRow label="自动滚动" description="自动滚动到新消息">
            <Toggle
              checked={autoScroll}
              onChange={(v) => {
                setAutoScroll(v);
                setSettingsDraft({ autoScroll: v });
              }}
            />
          </SettingsRow>

          <SettingsRow
            label="桌面通知"
            description="当 Pi 在当前未查看的工作区完成、失败或等待审批时通知"
          >
            <Toggle
              checked={desktopNotifications}
              onChange={(v) => {
                setDesktopNotifications(v);
                setSettingsDraft({ desktopNotifications: v });
              }}
            />
          </SettingsRow>

          <SettingsRow
            label="启动时打开主页"
            description="开启：显示完整主页（统计、最近项目、打开文件夹）。关闭：打开带有空会话中心提示和项目选择器的聊天界面。"
          >
            <Toggle
              checked={openToHomeOnLaunch}
              onChange={(v) => {
                setOpenToHomeOnLaunch(v);
                setSettingsDraft({ openToHomeOnLaunch: v });
              }}
            />
          </SettingsRow>

          <SettingsRow
            label="恢复上次会话"
            description="打开工作区时继续最近的会话，而不是新建会话"
          >
            <Toggle
              checked={resumeLastSession}
              onChange={(v) => {
                setResumeLastSession(v);
                setSettingsDraft({ resumeLastSession: v });
              }}
            />
          </SettingsRow>

          <SettingsRow
            label="开机启动"
            description="登录电脑时自动启动 Pi Desktop（仅对已安装版本生效）"
          >
            <Toggle
              checked={runOnStartup}
              onChange={(v) => {
                setRunOnStartup(v);
                void applyImmediate({ runOnStartup: v });
              }}
            />
          </SettingsRow>

          <SettingsRow
            label="关闭时最小化到托盘"
            description="关闭窗口时保持 Pi Desktop 在系统托盘中运行，而不是退出（Windows 和 Linux）"
          >
            <Toggle
              checked={minimizeToTrayOnClose}
              onChange={(v) => {
                setMinimizeToTrayOnClose(v);
                void applyImmediate({ minimizeToTrayOnClose: v });
              }}
            />
          </SettingsRow>
        </SettingsSection>

        {/* Multi-Agent Council Planning */}
        <SettingsSection title="多代理委员会规划">
          <SettingsRow
            label="启用委员会规划"
            description="与 Pi 一起启动 Claude/Codex 来规划任务，会增加 Token 用量和积分/API 成本。"
          >
            <Toggle
              checked={settings?.council.enabled ?? false}
              onChange={(value) => {
                if (value) {
                  setShowCouncilWarning(true);
                } else {
                  void saveCouncil({ enabled: false });
                }
              }}
            />
          </SettingsRow>

          {settings?.council.enabled && (
            <>
              <SettingsRow label="成员" description="参与委员会规划的代理">
                <div className="flex flex-col gap-2">
                  {(["pi", "claude", "codex"] as const).map((id) => {
                    const detected = detectedAgents[id];
                    const label =
                      id === "pi" ? "Pi" : id === "claude" ? "Claude" : "Codex";
                    return (
                      <label
                        key={id}
                        className={`flex items-center gap-2 text-sm ${
                          detected ? "text-primary" : "text-dim"
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={!detected}
                          checked={settings.council.members[id]}
                          onChange={(e) =>
                            void saveCouncil({
                              members: {
                                ...settings.council.members,
                                [id]: e.target.checked,
                              },
                            })
                          }
                          className="accent-accent disabled:opacity-50"
                        />
                        <span>
                          {label}
                          {!detected && (
                            <span className="text-faint">（未检测到）</span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </SettingsRow>

              <SettingsRow
                label="共识模式"
                description="委员会成员达成一致的方式"
              >
                <div className="relative">
                  <select
                    value={settings.council.consensusMode}
                    onChange={(e) =>
                      void saveCouncil({
                        consensusMode: e.target
                          .value as CouncilConfig["consensusMode"],
                      })
                    }
                    className="w-full appearance-none rounded-md border border-border-strong bg-surface py-1.5 pl-3 pr-9 text-sm text-primary hover:border-border-strong-hover focus:border-focus focus:outline-none"
                  >
                    <option value="arbiter">仲裁合并（快速）</option>
                    <option value="debate">
                      一轮辩论（较慢，约 2 倍成本）
                    </option>
                  </select>
                  <ChevronDown
                    size={14}
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-dim"
                  />
                </div>
              </SettingsRow>

              <SettingsRow
                label="每个成员的超时时间（秒）"
                description={`每个代理最多等待多少秒（${COUNCIL_MIN_TIMEOUT}-${COUNCIL_MAX_TIMEOUT}）`}
              >
                <input
                  type="number"
                  min={COUNCIL_MIN_TIMEOUT}
                  max={COUNCIL_MAX_TIMEOUT}
                  value={timeoutDraft}
                  onChange={(e) => setTimeoutDraft(e.target.value)}
                  onBlur={() => {
                    const clamped = clampCouncilTimeout(Number(timeoutDraft));
                    setTimeoutDraft(String(clamped));
                    if (clamped !== settings.council.timeoutSeconds) {
                      void saveCouncil({ timeoutSeconds: clamped });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      (e.target as HTMLInputElement).blur();
                  }}
                  className="w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary focus:border-focus focus:outline-none"
                />
              </SettingsRow>
            </>
          )}
        </SettingsSection>

        {/* Custom Models */}
        <SettingsSection title="自定义模型">
          <CustomModelsEditor />
        </SettingsSection>

        {/* Actions */}
        <div className="mt-8 flex gap-3">
          <button
            onClick={handleSave}
            className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover transition-colors"
          >
            {saved ? <Check size={14} /> : <Save size={14} />}
            {saved ? "已保存！" : "保存设置"}
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-2 rounded-md border border-border-strong px-4 py-2 text-sm text-muted hover:bg-surface-hover transition-colors"
          >
            <RotateCcw size={14} />
            恢复默认设置
          </button>
        </div>
      </div>

      {galleryOpen && (
        <ThemeGallery
          onClose={() => setGalleryOpen(false)}
          onInstalled={handleGalleryInstalled}
        />
      )}

      {themeEditorState && (
        <ThemeEditor
          baseTheme={themeEditorState.baseTheme}
          baseId={themeEditorState.baseId}
          isUserTheme={themeEditorState.isUserTheme}
          onClose={() => setThemeEditorState(null)}
          onSaved={handleThemeEditorSaved}
        />
      )}

      {/* Council enable confirmation dialog */}
      {showCouncilWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-border-strong bg-surface p-6 shadow-xl">
            <h3 className="mb-3 text-base font-semibold text-primary">
              启用委员会规划？
            </h3>
            <p className="mb-6 text-sm text-muted">
              每次运行都会在 {runningEngineLabel} 之外启动 Claude 和
              Codex，可能显著增加 Token 用量和积分/API
              成本。请确认能够接受额外支出后再启用。
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowCouncilWarning(false)}
                className="rounded-md border border-border-strong px-4 py-2 text-sm text-muted hover:bg-surface-hover transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setShowCouncilWarning(false);
                  void saveCouncil({ enabled: true });
                }}
                className="rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover transition-colors"
              >
                启用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-8">
      <h2 className="mb-4 text-sm font-medium text-secondary">{title}</h2>
      <div className="space-y-4 rounded-lg border border-border bg-surface/50 p-4">
        {children}
      </div>
    </div>
  );
}

function SettingsRow({
  label,
  description,
  children,
  stack = false,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
  // Controls that are wider than the fixed control column (e.g. a URL input
  // beside a button) render below the label at full width instead of being
  // crammed into the right-hand w-64 column.
  stack?: boolean;
}): React.JSX.Element {
  if (stack) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <div className="text-sm text-primary">{label}</div>
          <div className="text-xs text-dim">{description}</div>
        </div>
        <div>{children}</div>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm text-primary">{label}</div>
        <div className="text-xs text-dim">{description}</div>
      </div>
      <div className="w-64">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-elevated"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          checked ? "translate-x-4" : "translate-x-1"
        }`}
      />
    </button>
  );
}
