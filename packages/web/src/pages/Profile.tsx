import { Link, useParams } from "react-router-dom";

import { api } from "../lib/api";
import type { Pagination, Repository, User } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAsync } from "../lib/useAsync";
import { Alert, Avatar, EmptyState, Spinner, TimeAgo } from "../components/ui";
import { RepositoryCard } from "./Explore";

interface ProfileResponse {
  user: User;
  counts: { repositories: number; followers: number; following: number };
  viewerFollows: boolean;
}

interface RepositoryList {
  repositories: Repository[];
  pagination: Pagination;
}

export function ProfilePage() {
  const { username = "" } = useParams();
  const { user: viewer } = useAuth();
  const isMe = viewer?.username === username;

  const profile = useAsync<ProfileResponse>(
    (signal) => api.get<ProfileResponse>(`/users/${encodeURIComponent(username)}`, signal),
    [username],
  );

  const repositories = useAsync<RepositoryList>(
    (signal) =>
      api.get<RepositoryList>(`/users/${encodeURIComponent(username)}/repositories?perPage=50`, signal),
    [username],
  );

  if (profile.loading) return <Spinner label="Loading profile" />;

  if (profile.error || !profile.data) {
    return (
      <div className="page">
        <EmptyState title="No such user" action={<Link to="/" className="button">Back to explore</Link>}>
          {profile.error ?? `Nobody here goes by “${username}”.`}
        </EmptyState>
      </div>
    );
  }

  const { user, counts } = profile.data;

  return (
    <div className="page stack stack--loose">
      <header className="row row--wrap" style={{ gap: "var(--space-5)" }}>
        <Avatar user={user} size={72} />

        <div className="stack stack--tight" style={{ flex: 1, minWidth: "14rem" }}>
          <div>
            <h1>{user.displayName ?? user.username}</h1>
            {user.displayName && <p className="muted">{user.username}</p>}
          </div>

          {user.bio && <p>{user.bio}</p>}

          <div className="row subtle" style={{ gap: "var(--space-4)" }}>
            <span>
              <span className="strong">{counts.repositories}</span> repositories
            </span>
            <span>
              <span className="strong">{counts.followers}</span> followers
            </span>
            <span>
              <span className="strong">{counts.following}</span> following
            </span>
            <span>
              Joined <TimeAgo value={user.createdAt} />
            </span>
          </div>
        </div>

        {isMe && (
          <Link to="/new" className="button button--primary">
            New repository
          </Link>
        )}
      </header>

      <hr className="divider" />

      <section className="stack">
        <h2>Repositories</h2>

        {repositories.error && <Alert>{repositories.error}</Alert>}
        {repositories.loading && <Spinner label="Loading repositories" />}

        {!repositories.loading && repositories.data?.repositories.length === 0 && (
          <EmptyState
            title={isMe ? "You have no repositories yet" : "Nothing to see here"}
            action={
              isMe ? (
                <Link to="/new" className="button button--primary">
                  Create your first
                </Link>
              ) : undefined
            }
          >
            {isMe
              ? "Create one to start tracking a project."
              : `${username} has no repositories you can see.`}
          </EmptyState>
        )}

        {!repositories.loading && (repositories.data?.repositories.length ?? 0) > 0 && (
          <div className="grid">
            {repositories.data?.repositories.map((repository) => (
              <RepositoryCard key={repository.id} repository={repository} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
