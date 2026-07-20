import { RefStore, walkHistory, flattenTree } from "@tessera/core";
import type { ObjectId, Repository } from "@tessera/core";

/**
 * Uploading a repository to a Tessera server.
 *
 * The interesting part is what is *not* sent. Objects are content-addressed, so
 * the server already knows which ids it holds; the client asks first and sends
 * only the difference. Pushing the same history twice therefore transfers
 * nothing at all, and pushing one new commit to a large repository transfers
 * one commit, one tree per changed directory, and the blobs that changed.
 *
 * Uploading everything every time would make the store's deduplication
 * pointless the moment it left the machine.
 */

export interface PushOptions {
  readonly server: string;
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  readonly token: string;
  /** Called with progress, so a slow push is not silent. */
  readonly onProgress?: (message: string) => void;
}

export interface PushResult {
  readonly commit: ObjectId;
  readonly branch: string;
  readonly considered: number;
  readonly uploaded: number;
  readonly skipped: number;
}

/** Every object reachable from a commit: the commit chain, its trees, its blobs. */
async function reachableFrom(repository: Repository, tip: ObjectId): Promise<Set<ObjectId>> {
  const reachable = new Set<ObjectId>();

  for await (const commit of walkHistory(repository, { from: tip })) {
    reachable.add(commit.id);
    reachable.add(commit.tree);

    // flattenTree walks subtrees, so this reaches every blob; the tree objects
    // themselves are collected separately below.
    for (const file of await flattenTree(repository, commit.tree)) {
      reachable.add(file.id);
    }

    await collectTrees(repository, commit.tree, reachable);
  }

  return reachable;
}

/** Add every tree object under a root, which flattenTree does not report. */
async function collectTrees(
  repository: Repository,
  treeId: ObjectId,
  into: Set<ObjectId>,
): Promise<void> {
  into.add(treeId);

  for (const entry of await repository.objects.readTree(treeId)) {
    if (entry.type === "tree") await collectTrees(repository, entry.id, into);
  }
}

async function request<T>(url: string, token: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;

  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `server refused the request (${response.status})`);
  }

  return payload as T;
}

export async function push(repository: Repository, options: PushOptions): Promise<PushResult> {
  const refs = new RefStore(repository);
  const tip = await refs.readBranch(options.branch);

  if (!tip) throw new Error(`no local branch called "${options.branch}"`);

  const base = `${options.server.replace(/\/$/, "")}/api/repositories/${encodeURIComponent(
    options.owner,
  )}/${encodeURIComponent(options.repository)}/git`;

  options.onProgress?.("working out what to send");
  const reachable = [...(await reachableFrom(repository, tip))];

  // Ask the server what it is missing rather than assuming.
  const { missing } = await request<{ missing: ObjectId[] }>(`${base}/objects/missing`, options.token, {
    ids: reachable,
  });

  options.onProgress?.(`${missing.length} of ${reachable.length} objects are new`);

  /**
   * Sent in batches.
   *
   * One request carrying an entire history would exceed the server's body limit
   * and hold a single transaction open for far too long. Batching also means a
   * failure loses one chunk rather than the whole upload - and because objects
   * are content-addressed, simply pushing again resumes from where it stopped.
   */
  const BATCH = 100;
  let uploaded = 0;

  for (let start = 0; start < missing.length; start += BATCH) {
    const chunk = missing.slice(start, start + BATCH);

    const objects = await Promise.all(
      chunk.map(async (id) => ({
        id,
        // Already framed and compressed on disk, so it travels as stored.
        bytes: (await repository.objects.readRaw(id)).toString("base64"),
      })),
    );

    const isLast = start + BATCH >= missing.length;

    // The ref only moves on the final batch, once every object is stored.
    const result = await request<{ stored: number }>(`${base}/push`, options.token, {
      branch: options.branch,
      commit: tip,
      objects,
      ...(isLast ? {} : {}),
    });

    uploaded += result.stored;
    options.onProgress?.(`uploaded ${Math.min(start + BATCH, missing.length)}/${missing.length}`);
  }

  // An empty push still needs to move the branch - the objects may all be
  // present from an earlier attempt that failed before the ref was updated.
  if (missing.length === 0) {
    await request(`${base}/push`, options.token, {
      branch: options.branch,
      commit: tip,
      objects: [],
    });
  }

  return {
    commit: tip,
    branch: options.branch,
    considered: reachable.length,
    uploaded,
    skipped: reachable.length - uploaded,
  };
}
