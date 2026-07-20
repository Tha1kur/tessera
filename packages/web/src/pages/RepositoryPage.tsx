import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { ApiError, api } from "../lib/api";
import type { Issue, Pagination, Repository } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAsync } from "../lib/useAsync";
import { Alert, Avatar, Badge, Button, EmptyState, Field, Spinner, TextArea, TimeAgo } from "../components/ui";

interface RepositoryResponse {
  repository: Repository;
  viewerHasStarred: boolean;
}

interface IssueList {
  issues: Issue[];
  pagination: Pagination;
}

type StatusFilter = "OPEN" | "CLOSED" | "ALL";

export function RepositoryPage() {
  const { username = "", name = "" } = useParams();
  const { user: viewer, status: authStatus } = useAuth();
  const navigate = useNavigate();

  const [filter, setFilter] = useState<StatusFilter>("OPEN");
  const [composing, setComposing] = useState(false);

  const repository = useAsync<RepositoryResponse>(
    (signal) =>
      api.get<RepositoryResponse>(
        `/repositories/${encodeURIComponent(username)}/${encodeURIComponent(name)}`,
        signal,
      ),
    [username, name],
  );

  const issues = useAsync<IssueList>(
    (signal) =>
      api.get<IssueList>(
        `/repositories/${encodeURIComponent(username)}/${encodeURIComponent(name)}/issues?status=${filter}`,
        signal,
      ),
    [username, name, filter],
  );

  const [starred, setStarred] = useState<boolean | null>(null);
  const [stars, setStars] = useState<number | null>(null);

  if (repository.loading) return <Spinner label="Loading repository" />;

  if (repository.error || !repository.data) {
    return (
      <div className="page">
        {/* A private repository the viewer cannot see is indistinguishable from
            one that does not exist - deliberately, so its existence stays
            secret. The message has to cover both cases honestly. */}
        <EmptyState
          title="Repository not found"
          action={<Link to="/" className="button">Back to explore</Link>}
        >
          It may not exist, or it may be private.
        </EmptyState>
      </div>
    );
  }

  const repo = repository.data.repository;
  const isOwner = viewer?.id === repo.ownerId;
  const isStarred = starred ?? repository.data.viewerHasStarred;
  const starCount = stars ?? repo.starCount ?? 0;

  async function toggleStar() {
    const next = !isStarred;
    // Optimistic: the button responds immediately, and is corrected by the
    // server's count when the request lands.
    setStarred(next);
    setStars(starCount + (next ? 1 : -1));

    try {
      const result = await api[next ? "put" : "delete"]<{ starred: boolean; starCount: number }>(
        `/repositories/${encodeURIComponent(username)}/${encodeURIComponent(name)}/star`,
      );
      setStarred(result.starred);
      setStars(result.starCount);
    } catch {
      // Roll the optimistic update back rather than leave a lie on screen.
      setStarred(!next);
      setStars(starCount);
    }
  }

  async function remove() {
    if (!confirm(`Delete ${username}/${name}? Its issues go with it. This cannot be undone.`)) return;

    try {
      await api.delete(`/repositories/${encodeURIComponent(username)}/${encodeURIComponent(name)}`);
      navigate(`/${username}`);
    } catch (error) {
      alert(error instanceof ApiError ? error.message : "Could not delete the repository.");
    }
  }

  return (
    <div className="page stack stack--loose">
      <header className="stack stack--tight">
        <div className="row row--between row--wrap">
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <h1 style={{ fontSize: "var(--text-xl)" }}>
              <Link to={`/${username}`}>{username}</Link>
              <span className="subtle"> / </span>
              <span>{repo.name}</span>
            </h1>
            {repo.visibility === "PRIVATE" && <Badge variant="private">Private</Badge>}
          </div>

          <div className="row">
            {authStatus === "authenticated" && (
              <Button onClick={toggleStar} aria-pressed={isStarred}>
                {isStarred ? "★ Starred" : "☆ Star"} {starCount > 0 && <span className="subtle">{starCount}</span>}
              </Button>
            )}
            {isOwner && (
              <Button variant="danger" onClick={remove}>
                Delete
              </Button>
            )}
          </div>
        </div>

        {repo.description && <p className="muted">{repo.description}</p>}

        <p className="subtle">
          Created <TimeAgo value={repo.createdAt} /> · Updated <TimeAgo value={repo.updatedAt} />
        </p>
      </header>

      <hr className="divider" />

      <section className="stack">
        <div className="row row--between row--wrap">
          <h2>Issues</h2>

          <div className="row">
            <div className="row" role="group" aria-label="Filter issues by status">
              {(["OPEN", "CLOSED", "ALL"] as StatusFilter[]).map((option) => (
                <Button
                  key={option}
                  variant={filter === option ? "default" : "ghost"}
                  onClick={() => setFilter(option)}
                  aria-pressed={filter === option}
                >
                  {option === "ALL" ? "All" : option === "OPEN" ? "Open" : "Closed"}
                </Button>
              ))}
            </div>

            {authStatus === "authenticated" && (
              <Button variant="primary" onClick={() => setComposing((value) => !value)}>
                {composing ? "Cancel" : "New issue"}
              </Button>
            )}
          </div>
        </div>

        {composing && (
          <NewIssueForm
            username={username}
            name={name}
            onCreated={() => {
              setComposing(false);
              issues.reload();
            }}
          />
        )}

        {issues.error && <Alert>{issues.error}</Alert>}
        {issues.loading && <Spinner label="Loading issues" />}

        {!issues.loading && issues.data?.issues.length === 0 && (
          <EmptyState title={filter === "OPEN" ? "No open issues" : "No issues here"}>
            {filter === "OPEN" ? "Everything is closed, or nothing has been reported yet." : null}
          </EmptyState>
        )}

        {!issues.loading && (issues.data?.issues.length ?? 0) > 0 && (
          <ul className="stack stack--tight" style={{ listStyle: "none" }}>
            {issues.data?.issues.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                username={username}
                name={name}
                canClose={isOwner || issue.author?.id === viewer?.id}
                onChanged={issues.reload}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function IssueRow({
  issue,
  username,
  name,
  canClose,
  onChanged,
}: {
  issue: Issue;
  username: string;
  name: string;
  canClose: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await api.patch(
        `/repositories/${encodeURIComponent(username)}/${encodeURIComponent(name)}/issues/${issue.number}`,
        { status: issue.status === "OPEN" ? "CLOSED" : "OPEN" },
      );
      onChanged();
    } catch (error) {
      alert(error instanceof ApiError ? error.message : "Could not update the issue.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="card card--flat card--interactive">
      <div className="row row--between row--wrap">
        <div className="stack stack--tight" style={{ flex: 1, minWidth: "16rem" }}>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <Badge variant={issue.status === "OPEN" ? "open" : "closed"}>
              {issue.status === "OPEN" ? "Open" : "Closed"}
            </Badge>
            <span className="strong">{issue.title}</span>
          </div>

          <div className="row subtle" style={{ gap: "var(--space-2)" }}>
            <span className="mono">#{issue.number}</span>
            <span>·</span>
            {issue.author && (
              <>
                <Avatar user={issue.author} size={16} />
                <Link to={`/${issue.author.username}`}>{issue.author.username}</Link>
                <span>·</span>
              </>
            )}
            <span>
              opened <TimeAgo value={issue.createdAt} />
            </span>
          </div>

          {issue.body && (
            <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {issue.body}
            </p>
          )}
        </div>

        {canClose && (
          <Button onClick={toggle} loading={busy}>
            {issue.status === "OPEN" ? "Close" : "Reopen"}
          </Button>
        )}
      </div>
    </li>
  );
}

function NewIssueForm({
  username,
  name,
  onCreated,
}: {
  username: string;
  name: string;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await api.post(
        `/repositories/${encodeURIComponent(username)}/${encodeURIComponent(name)}/issues`,
        { title, ...(body ? { body } : {}) },
      );
      setTitle("");
      setBody("");
      onCreated();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not open the issue.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      {error && <Alert>{error}</Alert>}

      <Field
        label="Title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Something is not right…"
        autoFocus
        required
      />

      <TextArea
        label="Description"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        hint="Optional. What happened, and what did you expect?"
        rows={4}
      />

      <div className="row">
        <Button type="submit" variant="primary" loading={submitting} disabled={!title.trim()}>
          Open issue
        </Button>
      </div>
    </form>
  );
}
