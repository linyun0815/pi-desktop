import { AlertCircle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { SessionRuntimeInfo } from "../../../shared/ipc-contracts";
import { DEFAULT_AGENT_ENGINE_LABEL } from "../../../shared/agent-engine-label";

export function SessionRuntimeIndicator({
  runtime,
}: {
  runtime: SessionRuntimeInfo;
}): React.JSX.Element | null {
  const working =
    runtime.activity === "working" || runtime.status === "starting";
  const needsApproval = runtime.activity === "needs-approval";
  const completed = runtime.activity === "completed";
  const failed = runtime.activity === "failed" || runtime.status === "error";
  const agent = DEFAULT_AGENT_ENGINE_LABEL;

  if (working) {
    return (
      <Loader2
        size={12}
        className="shrink-0 animate-spin text-accent-fg"
        aria-label={`${agent} 正在工作`}
      />
    );
  }
  if (needsApproval) {
    return (
      <AlertCircle
        size={12}
        className="shrink-0 text-warning"
        aria-label={`${agent} 正在等待审批`}
      />
    );
  }
  if (completed) {
    return (
      <CheckCircle2
        size={12}
        className="shrink-0 text-success"
        aria-label={`${agent} 已完成`}
      />
    );
  }
  if (failed) {
    return (
      <XCircle
        size={12}
        className="shrink-0 text-error"
        aria-label={`${agent} 因错误停止`}
      />
    );
  }
  return null;
}
