import { useEffect, useRef, useState } from "react";
import { KeyRound, ShieldAlert } from "lucide-react";
import { useAppStore } from "../store";
import type { AuthPromptPayload } from "../../../shared/embedded-agent-protocol";

/**
 * Secure modal for the embedded SDK's auth interaction prompts.
 *
 * Only api_key logins reach the renderer, so the prompt shapes are text,
 * secret, and select. The entered value lives in component state only until
 * it is relayed once through main into the admin helper — it is never stored
 * in the zustand store, logged, or persisted.
 */
export function AuthPromptModal(): React.JSX.Element | null {
  const authPrompt = useAppStore((state) => state.authPrompt);
  const authNotice = useAppStore((state) => state.authNotice);
  const setAuthPrompt = useAppStore((state) => state.setAuthPrompt);
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const prompt: AuthPromptPayload | null = authPrompt?.prompt ?? null;

  useEffect(() => {
    if (!authPrompt) {
      setValue("");
      setSelected(null);
      return;
    }
    // Fresh prompt: focus the field and reset any previous draft answer.
    setValue("");
    setSelected(null);
    const timer = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [authPrompt]);

  if (!authPrompt || !prompt) return null;

  const submit = (): void => {
    const answer =
      prompt.type === "select" ? (selected ?? "") : value;
    void window.piDesktop.auth.answerPrompt(authPrompt.loginId, answer);
    setAuthPrompt(null);
  };

  const cancel = (): void => {
    void window.piDesktop.auth.cancelLogin(authPrompt.loginId);
    setAuthPrompt(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        if (e.key === "Escape") cancel();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border-strong bg-surface p-5 shadow-xl">
        <div className="mb-4 flex items-center gap-2">
          <KeyRound size={16} className="text-muted" />
          <h2 className="text-sm font-semibold text-primary">提供商登录</h2>
        </div>

        {prompt.type === "select" ? (
          <div className="mb-4">
            <p className="mb-2 text-sm text-primary">{prompt.message}</p>
            <div className="flex flex-col gap-1">
              {prompt.options.map((option) => (
                <button
                  key={option.id}
                  onClick={() => setSelected(option.id)}
                  className={
                    "rounded-md border px-3 py-2 text-left text-sm transition-colors " +
                    (selected === option.id
                      ? "border-focus bg-surface-hover text-primary"
                      : "border-border-strong text-primary hover:bg-surface-hover")
                  }
                >
                  <div>{option.label}</div>
                  {option.description && (
                    <div className="text-xs text-dim">{option.description}</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mb-4">
            <p className="mb-2 text-sm text-primary">{prompt.message}</p>
            <input
              ref={inputRef}
              type={prompt.type === "secret" ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={prompt.placeholder ?? ""}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary focus:border-focus focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            {prompt.type === "secret" && (
              <div className="mt-2 flex items-start gap-1 text-xs text-dim">
                <ShieldAlert size={12} className="mt-0.5 shrink-0" />
                <span>
                  密钥只经过一次转发写入 Pi 的 auth.json，不会被记录到日志或设置。
                </span>
              </div>
            )}
          </div>
        )}

        {authNotice && (
          <div className="mb-3 text-xs text-dim" aria-live="polite">
            {authNotice}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={cancel}
            className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors"
          >
            取消登录
          </button>
          <button
            onClick={submit}
            disabled={prompt.type === "select" ? selected === null : !value.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
