import { useState } from "react";
import { clsx } from "clsx";
import { Copy, Check } from "lucide-react";

export function CopyButton({
  text,
  className,
}: {
  text: string;
  className?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      title={copied ? "已复制" : "复制"}
      aria-label={copied ? "已复制" : "复制"}
      className={clsx(
        "z-10 rounded p-1 text-dim transition-colors hover:bg-surface-hover hover:text-primary",
        className,
      )}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
