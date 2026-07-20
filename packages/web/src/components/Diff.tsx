import "./diff.css";

/**
 * Rendering a unified diff.
 *
 * The patch text arrives from the engine already in unified format, so this
 * only has to classify each line and colour it. Line numbers are recovered from
 * the `@@` hunk headers rather than being sent separately - the header already
 * states where each side starts, and deriving them here keeps the API response
 * small and the two representations impossible to disagree.
 */

interface Line {
  readonly kind: "hunk" | "add" | "remove" | "context";
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

const HUNK = /^@@ -(\d+),?\d* \+(\d+),?\d* @@/;

export function parsePatch(patch: string): Line[] {
  const lines: Line[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    // The +++/--- file headers are already shown as the filename above.
    if (raw.startsWith("+++") || raw.startsWith("---") || raw === "") continue;

    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: "hunk", text: raw, oldLine: null, newLine: null });
      continue;
    }

    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), oldLine: null, newLine: newLine++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "remove", text: raw.slice(1), oldLine: oldLine++, newLine: null });
    } else {
      lines.push({ kind: "context", text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }

  return lines;
}

export interface FileDiff {
  path: string;
  kind: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  binary: boolean;
  patch: string;
}

export function DiffView({ file }: { file: FileDiff }) {
  const lines = file.binary ? [] : parsePatch(file.patch);

  return (
    <div className="diff">
      <div className="diff__header">
        <span className="diff__path mono">{file.path}</span>
        <span className="row" style={{ gap: "var(--space-2)" }}>
          <span className={`diff__kind diff__kind--${file.kind}`}>{file.kind}</span>
          {!file.binary && (
            <span className="subtle mono">
              <span className="diff__plus">+{file.added}</span>{" "}
              <span className="diff__minus">−{file.removed}</span>
            </span>
          )}
        </span>
      </div>

      {file.binary ? (
        <p className="diff__binary subtle">Binary file — contents not shown.</p>
      ) : lines.length === 0 ? (
        <p className="diff__binary subtle">No textual changes.</p>
      ) : (
        // Horizontal scrolling lives on the table, not the page: a long line in
        // a diff must never make the whole layout scroll sideways.
        <div className="diff__scroll">
          <table className="diff__table">
            <tbody>
              {lines.map((line, index) => (
                <tr key={index} className={`diff__row diff__row--${line.kind}`}>
                  <td className="diff__num">{line.oldLine ?? ""}</td>
                  <td className="diff__num">{line.newLine ?? ""}</td>
                  <td className="diff__marker">
                    {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
                  </td>
                  <td className="diff__code">{line.text || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
