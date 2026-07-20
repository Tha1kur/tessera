import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../lib/api";
import type { Pagination, Repository } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAsync } from "../lib/useAsync";
import { Alert, Avatar, Badge, Button, EmptyState, Spinner, TimeAgo } from "../components/ui";

interface RepositoryList {
  repositories: Repository[];
  pagination: Pagination;
}

export function ExplorePage() {
  const { status } = useAuth();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  /**
   * Debounce the search box.
   *
   * Without this every keystroke is a request: typing "tessera" fires seven,
   * six of which are already stale by the time they land. Waiting for a pause
   * in typing sends one.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, loading, error } = useAsync<RepositoryList>(
    (signal) =>
      api.get<RepositoryList>(
        `/repositories?page=${page}&perPage=12${query ? `&q=${encodeURIComponent(query)}` : ""}`,
        signal,
      ),
    [page, query],
  );

  return (
    <div className="page stack stack--loose">
      <section className="stack stack--tight">
        <h1>Explore</h1>
        <p className="muted">
          {status === "authenticated"
            ? "Public repositories, plus your own private work."
            : "Public repositories on this Tessera instance."}
        </p>
      </section>

      <div className="row">
        <input
          className="input"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search repositories…"
          aria-label="Search repositories"
        />
      </div>

      {error && <Alert>{error}</Alert>}
      {loading && <Spinner />}

      {!loading && data && data.repositories.length === 0 && (
        <EmptyState
          title={query ? `Nothing matches “${query}”` : "No repositories yet"}
          action={
            status === "authenticated" ? (
              <Link to="/new" className="button button--primary">
                Create the first one
              </Link>
            ) : (
              <Link to="/signup" className="button button--primary">
                Create an account
              </Link>
            )
          }
        >
          {query ? "Try a different search." : "Repositories created here will show up in this list."}
        </EmptyState>
      )}

      {!loading && data && data.repositories.length > 0 && (
        <>
          <div className="grid">
            {data.repositories.map((repository) => (
              <RepositoryCard key={repository.id} repository={repository} />
            ))}
          </div>

          {data.pagination.pages > 1 && (
            <nav className="row" style={{ justifyContent: "center" }} aria-label="Pagination">
              <Button onClick={() => setPage((value) => value - 1)} disabled={page <= 1}>
                Previous
              </Button>
              <span className="subtle">
                Page {data.pagination.page} of {data.pagination.pages}
              </span>
              <Button
                onClick={() => setPage((value) => value + 1)}
                disabled={page >= data.pagination.pages}
              >
                Next
              </Button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

export function RepositoryCard({ repository }: { repository: Repository }) {
  const owner = repository.owner?.username ?? "";

  return (
    <article className="card card--flat card--interactive stack stack--tight">
      <div className="row row--between">
        <Link to={`/${owner}/${repository.name}`} className="strong">
          {repository.name}
        </Link>
        {repository.visibility === "PRIVATE" && <Badge variant="private">Private</Badge>}
      </div>

      <p className="muted" style={{ fontSize: "var(--text-sm)", minHeight: "1.5em" }}>
        {repository.description ?? <span className="subtle">No description</span>}
      </p>

      <div className="row subtle" style={{ gap: "var(--space-4)" }}>
        {repository.owner && (
          <span className="row" style={{ gap: "var(--space-2)" }}>
            <Avatar user={repository.owner} size={18} />
            <Link to={`/${owner}`}>{owner}</Link>
          </span>
        )}
        {repository.starCount !== undefined && <span>★ {repository.starCount}</span>}
        <span>
          Updated <TimeAgo value={repository.updatedAt} />
        </span>
      </div>
    </article>
  );
}
