import { clsx } from "clsx";
import {
  highlightCodeToSegments,
  splitHighlightSegments,
  type HighlightSegment,
} from "./chat-code-highlight";

/**
 * Renders code as line-numbered, syntax-highlighted rows. Shared by file-read
 * tool results and markdown fenced blocks so both look identical.
 *
 * The highlighter returns React-friendly segments split into self-contained
 * lines; when no parser matches it falls back to plain text. Base text color is
 * inherited from the caller; only the gutter is styled here.
 *
 * `onFirstLineClick`, when given, makes the first row a click target (used to
 * collapse the tool-result view).
 */
export function LineNumberedCode({
  content,
  lang,
  onFirstLineClick,
}: {
  content: string;
  lang: string;
  onFirstLineClick?: () => void;
}): React.JSX.Element {
  const highlighted = highlightCodeToSegments(content, lang);
  const highlightedLines = highlighted
    ? splitHighlightSegments(highlighted)
    : null;
  const plainLines = highlightedLines ? null : content.split("\n");
  const lineCount = highlightedLines?.length ?? plainLines!.length;
  const gutter = `${String(lineCount).length}ch`;

  return (
    <>
      {Array.from({ length: lineCount }, (_unused, i) => {
        const clickable = i === 0 && onFirstLineClick;
        return (
          <div
            key={i}
            className={clsx(
              "flex",
              clickable && "cursor-pointer hover:bg-surface-hover/40",
            )}
            onClick={clickable ? onFirstLineClick : undefined}
            title={clickable ? "收起" : undefined}
          >
            <span
              className="mr-3 shrink-0 select-none text-right text-faint"
              style={{ minWidth: gutter }}
            >
              {i + 1}
            </span>
            {highlightedLines ? (
              <span className="whitespace-pre">
                {renderHighlightedLine(highlightedLines[i] ?? [])}
              </span>
            ) : (
              <span className="whitespace-pre">{plainLines?.[i] || " "}</span>
            )}
          </div>
        );
      })}
    </>
  );
}

function renderHighlightedLine(segments: HighlightSegment[]): React.ReactNode {
  if (segments.length === 0) return " ";
  return segments.map((segment, index) =>
    segment.classes ? (
      <span key={index} className={segment.classes}>
        {segment.text}
      </span>
    ) : (
      <span key={index}>{segment.text}</span>
    ),
  );
}
