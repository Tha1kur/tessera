#!/usr/bin/env node
import {
  Repository,
  add,
  checkout,
  commit,
  createBranch,
  diffCommit,
  diffCommits,
  diffStaged,
  diffUnstaged,
  isClean,
  listBranches,
  log,
  merge,
  restore,
  status,
  summarise,
} from "@tessera/core";
import { RefStore, abortMerge } from "@tessera/core";
import type { FileDiff } from "@tessera/core";

import { formatDate, paintPatch, pad, relativeTime, shortId, style } from "./format.js";
import { push } from "./push.js";

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

interface Args {
  readonly positional: string[];
  readonly flags: Map<string, string | true>;
}

/**
 * A small argument parser, deliberately hand-written.
 *
 * Supports `--flag`, `--flag=value`, `--flag value`, short `-m value`, and `--`
 * to stop parsing so filenames beginning with a dash still work.
 */
function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  /**
   * Flags that consume the next argument.
   *
   * This has to be explicit: `--force file.txt` means a boolean flag and a
   * path, while `--message fix` means a flag and its value, and nothing in the
   * text distinguishes them. Any new flag taking a value must be listed here -
   * omitting one silently turns its value into a positional argument.
   */
  const valued = new Set([
    "message", "m",
    "number", "n",
    "source",
    "delete", "d",
    "context",
    "token",
    "server",
    "branch",
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;

    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");

      if (equals !== -1) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
      } else if (valued.has(body) && argv[i + 1] !== undefined) {
        flags.set(body, argv[i + 1] as string);
        i += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const body = token.slice(1);
      if (valued.has(body) && argv[i + 1] !== undefined) {
        flags.set(body, argv[i + 1] as string);
        i += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    positional.push(token);
  }

  return { positional, flags };
}

function flagString(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
}

function flagBoolean(args: Args, ...names: string[]): boolean {
  return names.some((name) => args.flags.has(name));
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

const HELP = `${style.bold("tess")} - version control, from first principles

${style.bold("USAGE")}
  tess <command> [options]

${style.bold("STARTING OUT")}
  init [path]                 Create a repository here (or at path)
  status                      Show what has changed
  add <path...>               Stage files for the next commit
  commit -m <message>         Record the staged snapshot

${style.bold("LOOKING AROUND")}
  log [-n <count>] [rev]      Show history, newest first
  show [rev]                  Show what a commit changed
  diff [--staged] [rev] [rev] Compare working tree, index or commits
  verify                      Re-hash every object and report corruption

${style.bold("BRANCHING")}
  branch                      List branches
  branch <name> [start]       Create a branch
  branch -d <name>            Delete a branch
  checkout <target>           Switch to a branch or commit
  restore <path...>           Discard changes to specific files
  merge <branch>              Merge another branch into this one
  merge --abort               Abandon a conflicted merge

${style.bold("SHARING")}
  push <owner/repo>           Upload this repository to a Tessera server
                              --server <url>   default https://tessera-web-8rl9.onrender.com
                              --token <token>  access token from the site
                              --branch <name>  default: the branch you are on

${style.bold("CONFIGURATION")}
  config user.name <value>    Set the name recorded on your commits
  config user.email <value>   Set the email recorded on your commits

${style.bold("REVISIONS")}
  HEAD          the commit you are on         main~2   two before main's tip
  <branch>      the tip of a branch           HEAD^    the previous commit
  <id prefix>   any commit, abbreviated to at least four characters
`;

async function open(): Promise<Repository> {
  return Repository.discover();
}

async function commandInit(args: Args): Promise<void> {
  const repository = await Repository.initialise(args.positional[0] ?? process.cwd());
  console.log(`Initialised an empty Tessera repository in ${style.bold(repository.tesseraDirectory)}`);
  console.log(style.dim("Next: tess add . && tess commit -m \"First commit\""));
}

async function commandAdd(args: Args): Promise<void> {
  if (args.positional.length === 0) {
    throw new UsageError("nothing specified - try `tess add .` to stage everything");
  }

  const repository = await open();
  const result = await add(repository, args.positional, { force: flagBoolean(args, "force", "f") });

  for (const path of result.staged) console.log(`${style.green("staged")}  ${path}`);
  for (const path of result.removed) console.log(`${style.red("removed")} ${path}`);
  for (const path of result.unmatched) {
    console.error(style.yellow(`warning: '${path}' did not match any file`));
  }

  if (result.staged.length === 0 && result.removed.length === 0) {
    console.log(style.dim("nothing new to stage"));
  }
}

async function commandStatus(): Promise<void> {
  const repository = await open();
  const report = await status(repository);

  const location =
    report.head.kind === "attached"
      ? `On branch ${style.bold(report.head.branch)}`
      : `${style.yellow("HEAD detached")} at ${style.bold(shortId(report.head.commit))}`;
  console.log(location);

  if (!report.headCommit) console.log(style.dim("No commits yet"));

  if (report.mergingWith) {
    console.log(
      `${style.yellow("Merging in")} ${style.bold(shortId(report.mergingWith))} ` +
        style.dim("- resolve the conflicts, stage them, then commit"),
    );
  }

  if (isClean(report)) {
    console.log(style.green("\nNothing to commit - the working tree is clean"));
    return;
  }

  const describe = (kind: string) =>
    kind === "added" ? style.green("new file") : kind === "deleted" ? style.red("deleted ") : style.yellow("modified");

  if (report.staged.length > 0) {
    console.log(`\n${style.bold("Changes to be committed:")}`);
    for (const change of report.staged) console.log(`  ${describe(change.kind)}  ${change.path}`);
  }

  if (report.unstaged.length > 0) {
    console.log(`\n${style.bold("Changes not staged for commit:")}`);
    for (const change of report.unstaged) console.log(`  ${describe(change.kind)}  ${change.path}`);
    console.log(style.dim('  (use "tess add <path>" to stage, "tess restore <path>" to discard)'));
  }

  if (report.untracked.length > 0) {
    console.log(`\n${style.bold("Untracked files:")}`);
    for (const path of report.untracked) console.log(`  ${style.red(path)}`);
    console.log(style.dim('  (use "tess add <path>" to start tracking)'));
  }
}

async function commandCommit(args: Args): Promise<void> {
  const message = flagString(args, "message", "m");
  if (!message) throw new UsageError("a message is required - use `tess commit -m \"what changed\"`");

  const repository = await open();
  const created = await commit(repository, {
    message,
    allowEmpty: flagBoolean(args, "allow-empty"),
  });

  const refs = new RefStore(repository);
  const head = await refs.readHead();
  const where = head.kind === "attached" ? head.branch : "detached HEAD";
  const subject = created.message.split("\n")[0];

  console.log(`[${style.bold(where)} ${style.yellow(shortId(created.id))}] ${subject}`);
}

async function commandLog(args: Args): Promise<void> {
  const repository = await open();
  const limit = Number(flagString(args, "number", "n") ?? "0");
  const oneline = flagBoolean(args, "oneline");

  const history = await log(repository, {
    ...(args.positional[0] ? { from: args.positional[0] } : {}),
    ...(limit > 0 ? { limit } : {}),
  });

  if (history.length === 0) {
    console.log(style.dim("no commits yet"));
    return;
  }

  for (const entry of history) {
    const subject = entry.message.split("\n")[0] ?? "";

    if (oneline) {
      console.log(`${style.yellow(shortId(entry.id))} ${subject}`);
      continue;
    }

    console.log(style.yellow(`commit ${entry.id}`));
    console.log(`Author: ${entry.author.name} <${entry.author.email}>`);
    console.log(
      `Date:   ${formatDate(entry.author.timestamp)} ${style.dim(`(${relativeTime(entry.author.timestamp)})`)}`,
    );
    if (entry.parents.length > 1) {
      console.log(`Merge:  ${entry.parents.map(shortId).join(" ")}`);
    }
    console.log(`\n    ${entry.message.split("\n").join("\n    ")}\n`);
  }
}

function printDiffs(diffs: readonly FileDiff[]): void {
  if (diffs.length === 0) {
    console.log(style.dim("no changes"));
    return;
  }

  for (const diff of diffs) {
    console.log(style.bold(`\n${diff.kind}: ${diff.path}`));
    if (diff.binary) {
      console.log(style.dim("  binary file - contents not shown"));
      continue;
    }
    console.log(paintPatch(diff.patch.trimEnd()));
  }

  const total = summarise(diffs);
  console.log(
    style.dim(
      `\n${total.files} file${total.files === 1 ? "" : "s"} changed, ` +
        `${total.added} insertion${total.added === 1 ? "" : "s"}(+), ` +
        `${total.removed} deletion${total.removed === 1 ? "" : "s"}(-)`,
    ),
  );
}

async function commandDiff(args: Args): Promise<void> {
  const repository = await open();
  const [first, second] = args.positional;

  if (flagBoolean(args, "staged", "cached")) {
    printDiffs(await diffStaged(repository));
  } else if (first && second) {
    printDiffs(await diffCommits(repository, first, second));
  } else if (first) {
    printDiffs(await diffCommits(repository, first, "HEAD"));
  } else {
    printDiffs(await diffUnstaged(repository));
  }
}

async function commandShow(args: Args): Promise<void> {
  const repository = await open();
  const revision = args.positional[0] ?? "HEAD";

  const refs = new RefStore(repository);
  const id = await refs.resolve(revision);
  const entry = await repository.objects.readCommit(id);

  console.log(style.yellow(`commit ${id}`));
  console.log(`Author: ${entry.author.name} <${entry.author.email}>`);
  console.log(`Date:   ${formatDate(entry.author.timestamp)}`);
  console.log(`\n    ${entry.message.split("\n").join("\n    ")}`);

  printDiffs(await diffCommit(repository, revision));
}

async function commandBranch(args: Args): Promise<void> {
  const repository = await open();

  const toDelete = flagString(args, "delete", "d");
  if (toDelete) {
    const { deleteBranch } = await import("@tessera/core");
    await deleteBranch(repository, toDelete);
    console.log(`Deleted branch ${style.bold(toDelete)}`);
    return;
  }

  const [name, startPoint] = args.positional;

  if (!name) {
    const branches = await listBranches(repository);
    if (branches.length === 0) {
      console.log(style.dim("no branches yet - make a commit to create one"));
      return;
    }

    const width = Math.max(...branches.map((branch) => branch.name.length));
    for (const branch of branches) {
      const marker = branch.isCurrent ? style.green("*") : " ";
      const label = branch.isCurrent ? style.bold(pad(branch.name, width)) : pad(branch.name, width);
      console.log(`${marker} ${label}  ${style.yellow(shortId(branch.commit))}  ${style.dim(branch.subject)}`);
    }
    return;
  }

  const created = await createBranch(repository, name, startPoint ?? "HEAD");
  console.log(`Created branch ${style.bold(created.name)} at ${style.yellow(shortId(created.commit))}`);
  console.log(style.dim(`Switch to it with: tess checkout ${created.name}`));
}

async function commandCheckout(args: Args): Promise<void> {
  const target = args.positional[0];
  if (!target) throw new UsageError("which branch or commit? try `tess checkout main`");

  const repository = await open();
  const result = await checkout(repository, target, { force: flagBoolean(args, "force", "f") });

  if (result.branch) {
    console.log(`Switched to branch ${style.bold(result.branch)}`);
  } else {
    console.log(`${style.yellow("HEAD is now detached")} at ${style.bold(shortId(result.commit))}`);
    console.log(style.dim("You are looking at a point in history. Commits here belong to no branch."));
  }

  if (result.updated.length > 0 || result.removed.length > 0) {
    console.log(
      style.dim(`${result.updated.length} file(s) updated, ${result.removed.length} file(s) removed`),
    );
  }
}

async function commandRestore(args: Args): Promise<void> {
  if (args.positional.length === 0) throw new UsageError("which files? try `tess restore src/app.ts`");

  const repository = await open();
  const result = await restore(repository, args.positional, flagString(args, "source") ?? "HEAD");

  for (const path of result.restored) console.log(`${style.green("restored")} ${path}`);
  for (const path of result.missing) {
    console.error(style.yellow(`warning: '${path}' is not in that commit`));
  }
}

async function commandMerge(args: Args): Promise<void> {
  const repository = await open();

  if (flagBoolean(args, "abort")) {
    await abortMerge(repository);
    console.log("Merge aborted - the working tree is back where it started.");
    return;
  }

  const target = args.positional[0];
  if (!target) throw new UsageError("which branch? try `tess merge feature`");

  const report = await merge(repository, target, {
    noFastForward: flagBoolean(args, "no-ff"),
    ...(flagString(args, "message", "m") ? { message: flagString(args, "message", "m") as string } : {}),
  });

  switch (report.outcome) {
    case "up-to-date":
      console.log(style.dim(`Already up to date - ${target} is an ancestor of where you are.`));
      return;

    case "fast-forward":
      console.log(`${style.green("Fast-forward")} to ${style.yellow(shortId(report.target))}`);
      console.log(style.dim("Your history was already contained in theirs, so the branch just moved."));
      return;

    case "merged":
      console.log(
        `${style.green("Merged")} ${style.bold(target)} - created ${style.yellow(shortId(report.commit as string))}`,
      );
      if (report.merged.length > 0) {
        console.log(style.dim(`${report.merged.length} file(s) combined automatically`));
      }
      return;

    case "conflicted": {
      console.error(style.red(`Automatic merge failed - ${report.conflicts.length} conflict(s):`));
      for (const conflict of report.conflicts) {
        const explanation =
          conflict.reason === "binary"
            ? "binary file - there are no lines to merge"
            : conflict.reason === "modified-and-deleted"
              ? "changed on one side, deleted on the other"
              : "both sides changed the same lines";
        console.error(`  ${style.bold(conflict.path)}  ${style.dim(explanation)}`);
      }
      if (report.merged.length > 0) {
        console.error(style.dim(`\n${report.merged.length} other file(s) merged cleanly.`));
      }
      console.error(
        style.dim(
          "\nEdit the marked files, then: tess add <path> && tess commit -m \"Merge\"" +
            "\nOr give up on it with: tess merge --abort",
        ),
      );
      process.exitCode = 1;
      return;
    }
  }
}

async function commandPush(args: Args): Promise<void> {
  const target = args.positional[0];
  if (!target || !target.includes("/")) {
    throw new UsageError("which repository? try `tess push yourname/yourrepo`");
  }

  const [owner, repositoryName] = target.split("/");
  if (!owner || !repositoryName) throw new UsageError("expected owner/repository");

  const token = flagString(args, "token") ?? process.env.TESSERA_TOKEN;
  if (!token) {
    throw new UsageError(
      "an access token is required - pass --token, or set TESSERA_TOKEN\n" +
        "(sign in on the site, then read it from the login response)",
    );
  }

  const repository = await open();
  const refs = new RefStore(repository);
  const head = await refs.readHead();

  const branch =
    flagString(args, "branch") ?? (head.kind === "attached" ? head.branch : undefined);
  if (!branch) {
    throw new UsageError("HEAD is detached - name a branch with --branch");
  }

  const result = await push(repository, {
    server: flagString(args, "server") ?? "https://tessera-web-8rl9.onrender.com",
    owner,
    repository: repositoryName,
    branch,
    token,
    onProgress: (message) => console.log(style.dim(`  ${message}`)),
  });

  console.log(
    `${style.green("Pushed")} ${style.bold(branch)} to ${style.bold(target)} at ${style.yellow(
      shortId(result.commit),
    )}`,
  );
  console.log(
    style.dim(
      `${result.uploaded} object(s) uploaded, ${result.skipped} already present out of ${result.considered} reachable`,
    ),
  );
}

async function commandVerify(): Promise<void> {
  const repository = await open();
  const result = await repository.objects.verify();

  if (result.corrupt.length === 0) {
    console.log(style.green(`All ${result.checked} objects verified - every one hashes to its own name.`));
    return;
  }

  console.error(style.red(`${result.corrupt.length} of ${result.checked} objects are corrupt:`));
  for (const id of result.corrupt) console.error(`  ${id}`);
  process.exitCode = 1;
}

async function commandConfig(args: Args): Promise<void> {
  const repository = await open();
  const [key, value] = args.positional;
  const config = await repository.readConfig();

  if (!key) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (key !== "user.name" && key !== "user.email") {
    throw new UsageError(`unknown setting '${key}' - try user.name or user.email`);
  }

  if (value === undefined) {
    console.log(key === "user.name" ? (config.user?.name ?? "") : (config.user?.email ?? ""));
    return;
  }

  const field = key === "user.name" ? "name" : "email";
  await repository.writeConfig({ ...config, user: { ...config.user, [field]: value } });
  console.log(`${key} = ${style.bold(value)}`);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

class UsageError extends Error {}

const COMMANDS: Record<string, (args: Args) => Promise<void>> = {
  init: commandInit,
  add: commandAdd,
  status: async () => commandStatus(),
  commit: commandCommit,
  log: commandLog,
  diff: commandDiff,
  show: commandShow,
  branch: commandBranch,
  checkout: commandCheckout,
  restore: commandRestore,
  merge: commandMerge,
  push: commandPush,
  verify: async () => commandVerify(),
  config: commandConfig,
};

async function main(): Promise<void> {
  const [, , name, ...rest] = process.argv;

  if (!name || name === "help" || name === "--help" || name === "-h") {
    console.log(HELP);
    return;
  }

  if (name === "--version" || name === "-v") {
    console.log("tess 0.1.0");
    return;
  }

  const handler = COMMANDS[name];
  if (!handler) {
    console.error(style.red(`unknown command: ${name}`));
    console.error(style.dim("run `tess help` to see what is available"));
    process.exitCode = 1;
    return;
  }

  await handler(parseArgs(rest));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof UsageError) {
    console.error(style.red(message));
    console.error(style.dim("run `tess help` for usage"));
  } else {
    console.error(`${style.red("error:")} ${message}`);
  }

  process.exitCode = 1;
});
