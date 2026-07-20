# Tessera

![CI](https://github.com/Tha1kur/tessera/actions/workflows/ci.yml/badge.svg)
![Tests](https://img.shields.io/badge/tests-139%20passing-3f6b47)
![License](https://img.shields.io/badge/license-MIT-b4532a)

A version control system built from first principles — content-addressed storage, real commit graphs, and Myers diffing. No wrapper around Git; the internals are implemented here.

```
tess init
tess add .
tess commit -m "First commit"
tess log --oneline
```

---

## Why this exists

Most "build a Git clone" projects copy files into a folder and call it a commit. That produces something that cannot answer the questions version control exists to answer: *what changed*, *when did it break*, *what did this look like last Tuesday*.

Tessera implements the model properly. Every piece of content is named by the SHA-256 of its own bytes, history is a directed acyclic graph of immutable commits, and diffs come from Myers' shortest-edit-script algorithm rather than a line-by-line guess.

## The one idea everything rests on

**Name every object by the hash of its own contents.**

That single decision buys four properties that would otherwise each need their own machinery:

| Property | Why it follows |
|---|---|
| **Deduplication** | Identical content hashes identically, so it is stored once no matter how many files or commits contain it. |
| **Integrity** | If stored bytes ever stop hashing to the name they are filed under, corruption is detectable. `tess verify` does exactly this. |
| **Cheap comparison** | Two directories are identical iff their tree ids match — one 64-character comparison instead of a recursive walk. |
| **Cheap branching** | A branch is one file holding one commit id. Creating one writes 65 bytes regardless of project size. |

Verifiable in about ten seconds:

```console
$ tess add . && tess commit -m "First"
$ cp README.md README-copy.md          # identical content, second file
$ tess add . && tess commit -m "Copy"
# object count grows by 2 — a tree and a commit. No second blob.
```

## The object model

Three object types. Everything in a repository's history is one of them.

```
commit ──tree──▶ tree ──▶ blob   "the contents of app.js"
   │               └────▶ tree ──▶ blob   "the contents of src/util.js"
   │
   └──parent──▶ commit ──▶ ...
```

- **blob** — the raw bytes of one file. Knows nothing of its own name.
- **tree** — a directory listing: names pointing at blobs and other trees. This is where filenames live, which is why renaming a file creates no new blob.
- **commit** — one root tree, an author, a message, and pointers to the commits that came before.

Objects are stored framed and compressed:

```
<type> <payload-length>\0<payload>        → zlib → .tess/objects/ab/cdef…
```

The header is not decoration. Without the type in the hashed bytes, a blob containing the bytes of a tree would hash identically to that tree and the store would conflate them. `tests/objects.test.ts` asserts this directly.

## Why commits are cheap

Trees are written bottom-up. A directory whose contents did not change re-derives the identical id, so the existing object is reused untouched.

A one-line fix in a 50,000-file project writes: **one blob**, **one tree per directory on the path to it**, and **one commit**. Not 50,000 of anything. This is asserted in `workflow.test.ts` — the test proves an untouched directory keeps its exact tree id across commits.

## Why the staging area exists

Three states, not two:

```
working tree  ──add──▶  index  ──commit──▶  history
```

Without the index, a commit could only ever mean "everything currently on disk." The index is what lets you touch five files and commit two. It is also why `tess status` can legitimately report the same file as both staged and modified — you staged it, then kept editing.

Each index entry caches the size and mtime a file had when staged. That cache is purely an optimisation: matching stats let a file skip being re-read. A stale cache costs one unnecessary hash — never a wrong recorded id, because the id always comes from bytes actually read.

## Why diffing uses Myers

The obvious approach is a longest-common-subsequence table: O(N×M) in **both** time and memory. On two 10,000-line files that is 100 million cells, which is where hand-rolled diffs fall over.

Myers reframes it as a shortest-path problem. Model the files as axes of a grid — right deletes a line, down inserts one, diagonal keeps a match. Order the search by edit distance and stop the moment the far corner is reached: **O((N+M)×D)** where D is the number of edits actually needed.

For the normal case — a few changed lines in a large file — D is tiny. `diff.test.ts` runs 20,000 lines with one change and asserts it completes in under two seconds; the quadratic version would allocate 400 million cells for the same input.

## How merging works

Two-way comparison cannot merge anything. Given "this line says A" and "this line says B", there is no way to tell whether A is a change to keep or the original that B replaced. The missing information is the **base** — the common ancestor both sides started from.

With the base, every region of the file answers one question: *which sides changed it?*

| ours | theirs | result |
|---|---|---|
| unchanged | unchanged | keep the base |
| changed | unchanged | take ours |
| unchanged | changed | take theirs |
| changed identically | changed identically | take it once — agreement is not a conflict |
| changed differently | changed differently | **conflict** — only a human can decide |

This is why `mergeBase` exists, and why merging without it degenerates into "pick a winner and lose work."

Three outcomes, and telling them apart is most of the work:

- **Up to date** — the target is already an ancestor. Nothing to do.
- **Fast-forward** — our history is entirely contained in theirs, so the branch pointer just moves. No merge commit is created, which is why tidy histories often have none.
- **Three-way merge** — both sides moved. Non-overlapping edits combine automatically; overlapping ones stop for the human.

```console
$ tess merge hotfix
Automatic merge failed - 1 conflict(s):
  auth.js  both sides changed the same lines

$ tess commit -m "sneaking markers into history"
error: these files still contain conflict markers:
  auth.js
```

That refusal is deliberate. Conflict markers committed as source code only surface as a syntax error on someone else's machine. The unresolved paths are recorded in `MERGE_CONFLICTS`, and `commit` checks them before writing anything.

The second parent lives in `MERGE_HEAD` until the merge finishes, so the resolving commit becomes a genuine two-parent merge rather than an ordinary commit that silently drops one side's history from the graph.

## Safety properties

These are deliberate, and each is covered by a test:

- **Crash-safe commits.** Objects are written first; the ref moves only once every object is durable. A crash mid-commit leaves unreferenced objects — wasted bytes, nothing more. The reverse order would leave a branch pointing at a commit that was never written, which is unrecoverable.
- **Atomic ref updates.** Every ref write lands via a temp file and `rename`, so a concurrent reader never sees a half-written branch.
- **Path-escape rejection.** A tree entry like `../../.ssh/authorized_keys` is rejected at checkout. Branch names are validated for the same reason — `tess branch ../../escape` is refused.
- **Symlinks are never followed.** A link pointing at `/` would otherwise turn a repository scan into a walk of the entire filesystem.
- **Checkout refuses to destroy work.** Uncommitted changes block a branch switch unless explicitly forced, because there is no undo for work that was never committed.
- **Conflict markers cannot be committed.** `commit` refuses while any recorded conflicted path still contains them.
- **A merge can always be abandoned.** `tess merge --abort` restores the pre-merge state exactly.

## The API

An HTTP layer over the same engine, in `packages/server`. Express + Prisma + PostgreSQL, all TypeScript.

**Authentication** — two tokens doing deliberately different jobs:

| | Access token | Refresh token |
|---|---|---|
| Form | signed JWT | opaque random 256-bit string |
| Lifetime | 15 minutes | 30 days |
| Stored | client memory, response body | httpOnly cookie; **hashed** in the database |
| Verified by | signature only — no DB round trip | database lookup |
| Revocable | no (hence short) | yes, instantly |

The split covers each half's weakness: an XSS bug cannot read the httpOnly cookie, and CSRF cannot use the access token because the browser never attaches it automatically.

**Refresh rotation with reuse detection.** Every refresh swaps the token for a new one and marks the old one spent, so a token is redeemable exactly once. If an already-spent token reappears, two parties hold the same token — one of them stole it. Since there is no way to tell victim from thief, the entire token family from that login is revoked and both must sign in again. Briefly annoying the real user beats leaving an attacker with a live session.

**What the original project got wrong, and what replaced it:**

| Original | Now |
|---|---|
| `authMiddleware.js` and `authorizeMiddleware.js` were **empty files** — every route public | `requireAuth` (who are you) and ownership checks (may you) as separate concerns |
| `GET /allUsers` returned raw documents **including password hashes**, unauthenticated | Responses are allow-lists; `passwordHash` is named by no serialiser, so it cannot ship |
| bcrypt | argon2id, memory-hard, explicit OWASP parameters |
| JWT signed `{ id: result.insertId }` — a field that does not exist, so every signup token had `id: undefined` | Typed claims, verified with pinned algorithms |
| Repository `name` globally unique — the first "portfolio" blocked everyone else's | Unique per owner |
| `cors({ origin: "*" })` alongside token auth | Explicit origin allow-list, credentials enabled, wildcard rejected in production |
| Every failure: `500 "Server error"` | Typed errors with stable codes; internals never leak to clients |
| No validation, no rate limiting, no pagination | Zod on every input, tiered rate limits, bounded pages |

**A deliberate choice worth defending:** a private repository you may not see returns **404, not 403**. A 403 confirms it exists, which is precisely what its owner marked private.

**Running it:**

```bash
# Postgres - either Docker...
docker compose up -d

# ...or Homebrew, if you would rather not run Docker:
brew install postgresql@16 && brew services start postgresql@16
createuser -s tessera && createdb -O tessera tessera

cp packages/server/.env.example packages/server/.env
# Generate TWO DIFFERENT secrets and paste them in:
#   openssl rand -base64 48

npm run db:migrate                 # apply the schema
npm run dev:api                    # http://localhost:4000
curl localhost:4000/api/health     # {"status":"ok","database":"up"}
```

Integration tests need their own database:

```bash
createdb -O tessera tessera_test
DATABASE_URL="postgresql://tessera:tessera@localhost:5432/tessera_test" npx prisma migrate deploy -w @tessera/server
npm test
```

## The web app

`packages/web` — React 18 + TypeScript + Vite, routed with React Router. No component library: the interface is built on a small set of design tokens, so light and dark are the same design with different values rather than two designs maintained in parallel.

**The interesting problem — and it is created by the backend's own security feature.**

Token rotation means each refresh token may be redeemed exactly once, and replaying a spent one is treated as theft. So consider a page that fires three requests at the moment the access token expires. The naive client sends three refreshes with the same cookie: the first succeeds, the second and third replay a now-spent token, the server correctly concludes it was stolen, and the user is signed out.

**The security feature would attack its own users.**

The fix is single-flight refresh — every caller that arrives while a refresh is running awaits the same promise instead of starting another:

```ts
async function refreshOnce(): Promise<boolean> {
  inFlightRefresh ??= (async () => { /* ...one refresh... */ })();
  return inFlightRefresh;
}
```

This is not an optimisation. Without it the app logs people out at random under normal use.

Two more decisions worth defending:

- **The access token lives in memory, never `localStorage`.** Anything in `localStorage` is readable by any script on the page, so one XSS bug would hand it over. Losing it on reload is fine — the httpOnly refresh cookie silently gets a new one.
- **Auth status is three states, not a boolean.** "Not checked yet" is not "not signed in". Collapsing them makes the app flash the login page before the session restores.

```bash
npm run dev:api    # http://localhost:4000
npm run dev:web    # http://localhost:5173
```

Vite proxies `/api` to the server so the refresh cookie stays same-site in development exactly as it will in production.

## Architecture

```
packages/core/src/
  objects/
    types.ts        blob, tree, commit — the vocabulary
    codec.ts        serialisation; the framing that makes hashes meaningful
    store.ts        the content-addressed database, atomic writes, verification
  repository.ts     on-disk layout, discovery, path safety
  refs.ts           HEAD and branches; revision syntax (main~2, HEAD^)
  staging.ts        the index
  trees.ts          flat file list ⇄ nested tree objects
  ignore.ts         .tessignore glob matching
  worktree.ts       scanning and restoring the working directory
  diff.ts           Myers' algorithm and unified diff output
  merge.ts          three-way line merging and conflict rendering
  mergestate.ts     MERGE_HEAD and unresolved-path tracking
  status.ts         the three-way comparison
  commands/         add, commit, log, branch, checkout, diff, merge

packages/cli/src/
  main.ts           argument parsing and command dispatch
  format.ts         terminal output

packages/server/src/
  env.ts            configuration, validated at startup
  app.ts            middleware assembly
  lib/              errors, tokens, password hashing, db client
  http/             auth, validation, rate limiting, error handling
  modules/          auth, users, repositories, issues
  prisma/schema.prisma

packages/web/src/
  lib/api.ts        the client: single-flight refresh, typed responses
  lib/auth.tsx      session state and restoration
  styles/           design tokens; light and dark from one set of values
  components/       shared primitives and the app shell
  pages/            explore, auth, profile, repository, new repository
```

`core` has **zero runtime dependencies**. The CLI is a thin presentation layer over it — which is what makes the engine equally usable from a web server.

## Commands

```
tess init [path]                  Create a repository
tess add <path...>                Stage files
tess status                       Show what has changed
tess commit -m <message>          Record the staged snapshot
tess log [-n <count>] [--oneline] Show history
tess show [rev]                   Show what a commit changed
tess diff [--staged] [rev] [rev]  Compare working tree, index, or commits
tess branch [name] [-d name]      List, create, or delete branches
tess checkout <target>            Switch branch or commit
tess restore <path...>            Discard changes to specific files
tess merge <branch>               Merge another branch into this one
tess merge --abort                Abandon a conflicted merge
tess verify                       Re-hash every object, report corruption
tess config user.name <value>     Set commit identity
```

Revision syntax: `HEAD`, `<branch>`, `<id prefix>` (≥4 chars), with `~n` and `^` walking to ancestors.

## Running the whole stack

```bash
export ACCESS_TOKEN_SECRET=$(openssl rand -base64 48)
export REFRESH_TOKEN_SECRET=$(openssl rand -base64 48)

docker compose up -d --build
open http://localhost:8080
```

Three containers: Postgres, the API, and nginx serving the built client. nginx proxies `/api` to the API so the refresh cookie stays same-site in production exactly as the Vite proxy does in development — `SameSite=strict` would silently drop it across origins.

Both images are multi-stage. The build stage has the compilers, dev dependencies and source; the runtime stage has none of them. The API image runs as a non-root user and declares a healthcheck against `/api/health`, so an orchestrator restarts it when it cannot reach the database rather than routing traffic into a black hole.

The compose file deliberately provides **no default** for either token secret. A missing secret stops the stack instead of falling back to something guessable.

## Continuous integration

`.github/workflows/ci.yml` runs four jobs on every push and pull request:

| Job | What it covers |
|---|---|
| **engine** | The 99 engine tests across a matrix — Linux, macOS and Windows, on Node 20 and 22. The engine touches path separators, file modes and atomic rename semantics constantly, and those are exactly the things that differ per platform. |
| **server** | Typecheck plus all 40 server tests against a real Postgres service container, including the transaction-rollback behaviour a mocked client cannot reproduce. |
| **web** | Typecheck and production build. |
| **audit** | Fails on any known high or critical advisory. |

## Deploying it

The API is a standard container listening on `$PORT` and needing `DATABASE_URL` plus two token secrets, so it runs anywhere that accepts a Dockerfile — Fly.io, Render, Railway, Cloud Run.

Set in production:

```
NODE_ENV=production
DATABASE_URL=<managed Postgres connection string>
ACCESS_TOKEN_SECRET=<openssl rand -base64 48>
REFRESH_TOKEN_SECRET=<a different one>
CORS_ORIGINS=https://your-domain
```

Two production details that are easy to get wrong:

- **Serve the client and the API from one origin.** The refresh cookie is `SameSite=strict`; split across two domains it is never sent, and users appear to be logged out on every reload.
- **`secure: true` on cookies requires HTTPS.** It is already conditional on `NODE_ENV=production`, so a plain-HTTP production deploy will silently drop the cookie.

`prisma migrate deploy` runs at container start-up, so application code can never land against a schema that has not been migrated yet.

## Development

```bash
npm install
npm run build      # core, then cli
npm test           # 139 tests (99 engine, 40 server)
npm run typecheck  # strict mode, noUncheckedIndexedAccess
```

Requires Node 20+. The server also needs PostgreSQL — `docker compose up -d`.

## Test coverage

139 tests. The engine's 99 need nothing but a filesystem. The server has 31 unit tests that need no database, plus 9 integration tests that require Postgres because the behaviour they cover *is* database behaviour - a mocked client reports success for writes a real transaction discards, which is exactly how one bug reached a running server. The ones that matter most:

- **Reconstruction** — filter deletions out of a diff and you get the new file back exactly; filter insertions and you get the old one. This is the property that proves a diff is *correct*, not merely plausible.
- **Minimality** — the textbook Myers case is asserted to produce exactly five edits.
- **Tree reuse** — an untouched directory keeps its identical tree id across commits.
- **Corruption detection** — tampered object bytes are caught on read and by `verify`.
- **Branch isolation** — a file committed on one branch is gone after switching away and back.
- **Refusal to lose work** — checkout throws rather than overwriting uncommitted edits.
- **Merge correctness** — edits to different parts of one file combine automatically; edits to the same lines conflict; identical edits on both sides do *not* conflict.
- **Two-parent commits** — resolving a conflict produces a commit whose parents are both branch tips.
- **JWT forgery** — a token claiming `alg: none` is rejected, as is one signed with the wrong secret or issued by another issuer.
- **No hash leakage** — serialisers are asserted never to emit `passwordHash`, including when the row carries extra fields.
- **Timing safety** — token comparison is constant-time, and a login for a non-existent email still spends hashing time.
- **Token theft detection** — replaying a spent refresh token revokes the entire family, and the revocation survives the transaction rollback that rejecting the request causes. Verified by re-introducing the bug and watching the test fail.

## Roadmap

- [ ] Packfiles — delta-compress related blobs
- [ ] Remotes: push and pull over HTTP

## License

MIT
