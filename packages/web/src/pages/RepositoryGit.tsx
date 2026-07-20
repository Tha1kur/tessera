import { useState } from "react";

import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Alert, Avatar, Button, EmptyState, Spinner, TimeAgo } from "../components/ui";
import { DiffView } from "../components/Diff";
import type { FileDiff } from "../components/Diff";

/**
 * The version control views: history, a single commit's diff, and the files.
 *
 * Everything shown here is produced by the same engine the CLI runs. The server
 * walks the commit graph and computes diffs with Myers' algorithm against a
 * Postgres-backed object store; this component only lays the results out.
 */

interface CommitSummary {
  id: string;
  subject: string;
  message: string;
  author: { name: string; email: string; timestamp: number };
  parents: string[];
}

interface CommitList {
  commits: CommitSummary[];
  branch: string;
  empty: boolean;
}

interface CommitDetail {
  commit: CommitSummary & { tree: string };
  files: FileDiff[];
}

interface TreeListing {
  empty: boolean;
  commit?: string;
  files: { path: string; id: string; mode: string }[];
}

const base = (username: string, name: string) =>
  `/repositories/${encodeURIComponent(username)}/${encodeURIComponent(name)}/git`;

/** How to get history in here, for a repository nobody has pushed to yet. */
function PushInstructions({ owner, name }: { owner: string; name: string }) {
  return (
    <EmptyState title="Nothing pushed yet">
      <span>Create some history locally, then send it here:</span>
      <pre
        className="mono"
        style={{
          textAlign: "left",
          marginTop: "var(--space-4)",
          padding: "var(--space-4)",
          background: "var(--surface-sunken)",
          borderRadius: "var(--radius-md)",
          overflowX: "auto",
          fontSize: "var(--text-xs)",
          lineHeight: 1.8,
        }}
      >
        {`tess init
tess add .
tess commit -m "First commit"
tess push ${owner}/${name} --token <your access token>`}
      </pre>
    </EmptyState>
  );
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

export function CommitsTab({ username, name }: { username: string; name: string }) {
  const [selected, setSelected] = useState<string | null>(null);

  const history = useAsync<CommitList>(
    (signal) => api.get<CommitList>(`${base(username, name)}/commits?limit=50`, signal),
    [username, name],
  );

  if (history.loading) return <Spinner label="Loading history" />;
  if (history.error) return <Alert>{history.error}</Alert>;
  if (!history.data || history.data.empty) return <PushInstructions owner={username} name={name} />;

  if (selected) {
    return <CommitDetailView username={username} name={name} id={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="stack">
      <p className="subtle">
        {history.data.commits.length} commit{history.data.commits.length === 1 ? "" : "s"} on{" "}
        <span className="mono">{history.data.branch}</span>
      </p>

      <div className="commitlist">
        {history.data.commits.map((commit) => (
          <button key={commit.id} className="commitrow" onClick={() => setSelected(commit.id)}>
            <Avatar user={{ username: commit.author.name }} size={26} />

            <span className="stack stack--tight" style={{ flex: 1, gap: 0, minWidth: 0 }}>
              <span className="strong" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {commit.subject}
              </span>
              <span className="subtle">
                {commit.author.name} committed <TimeAgo value={new Date(commit.author.timestamp).toISOString()} />
                {commit.parents.length > 1 && " · merge"}
              </span>
            </span>

            <span className="mono subtle">{commit.id.slice(0, 8)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function CommitDetailView({
  username,
  name,
  id,
  onBack,
}: {
  username: string;
  name: string;
  id: string;
  onBack: () => void;
}) {
  const detail = useAsync<CommitDetail>(
    (signal) => api.get<CommitDetail>(`${base(username, name)}/commits/${id}`, signal),
    [username, name, id],
  );

  if (detail.loading) return <Spinner label="Loading commit" />;
  if (detail.error) return <Alert>{detail.error}</Alert>;
  if (!detail.data) return null;

  const { commit, files } = detail.data;
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);

  return (
    <div className="stack stack--loose">
      <Button variant="ghost" onClick={onBack}>
        ← Back to history
      </Button>

      <div className="card stack stack--tight">
        <h3>{commit.subject}</h3>

        {/* Only shown when there is a body beyond the subject line. */}
        {commit.message.includes("\n") && (
          <pre className="muted" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
            {commit.message.split("\n").slice(1).join("\n").trim()}
          </pre>
        )}

        <div className="row subtle row--wrap" style={{ gap: "var(--space-3)" }}>
          <span className="mono">{commit.id.slice(0, 12)}</span>
          <span>·</span>
          <span>{commit.author.name}</span>
          <span>·</span>
          <TimeAgo value={new Date(commit.author.timestamp).toISOString()} />
          <span>·</span>
          <span>
            {files.length} file{files.length === 1 ? "" : "s"}{" "}
            <span className="diff__plus">+{added}</span> <span className="diff__minus">−{removed}</span>
          </span>
        </div>
      </div>

      {files.length === 0 ? (
        <EmptyState title="No changes in this commit" />
      ) : (
        <div className="stack">
          {files.map((file) => (
            <DiffView key={file.path} file={file} />
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Files                                                                      */
/* -------------------------------------------------------------------------- */

export function FilesTab({ username, name }: { username: string; name: string }) {
  const [open, setOpen] = useState<{ path: string; id: string } | null>(null);

  const tree = useAsync<TreeListing>(
    (signal) => api.get<TreeListing>(`${base(username, name)}/tree`, signal),
    [username, name],
  );

  if (tree.loading) return <Spinner label="Loading files" />;
  if (tree.error) return <Alert>{tree.error}</Alert>;
  if (!tree.data || tree.data.empty) return <PushInstructions owner={username} name={name} />;

  if (open) {
    return <FileView username={username} name={name} file={open} onBack={() => setOpen(null)} />;
  }

  return (
    <div className="stack">
      <p className="subtle">
        {tree.data.files.length} file{tree.data.files.length === 1 ? "" : "s"} at{" "}
        <span className="mono">{tree.data.commit?.slice(0, 8)}</span>
      </p>

      <div className="filelist">
        {tree.data.files.map((file) => (
          <button
            key={file.path}
            className="filerow"
            onClick={() => setOpen({ path: file.path, id: file.id })}
          >
            <span aria-hidden="true">📄</span>
            <span className="mono" style={{ flex: 1 }}>
              {file.path}
            </span>
            {/* Only worth surfacing when it differs from an ordinary file. */}
            {file.mode === "100755" && <span className="subtle">executable</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function FileView({
  username,
  name,
  file,
  onBack,
}: {
  username: string;
  name: string;
  file: { path: string; id: string };
  onBack: () => void;
}) {
  const contents = useAsync<{ binary: boolean; size: number; content: string | null }>(
    (signal) => api.get(`${base(username, name)}/blob/${file.id}`, signal),
    [username, name, file.id],
  );

  return (
    <div className="stack">
      <Button variant="ghost" onClick={onBack}>
        ← Back to files
      </Button>

      <div className="fileview">
        <div className="diff__header">
          <span className="diff__path mono">{file.path}</span>
          {contents.data && <span className="subtle">{contents.data.size} bytes</span>}
        </div>

        {contents.loading && <Spinner label="Loading file" />}
        {contents.error && <Alert>{contents.error}</Alert>}

        {contents.data?.binary && <p className="diff__binary subtle">Binary file — contents not shown.</p>}

        {contents.data && !contents.data.binary && (
          <pre className="fileview__body">{contents.data.content}</pre>
        )}
      </div>
    </div>
  );
}
