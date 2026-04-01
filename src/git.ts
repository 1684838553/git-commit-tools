import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

function exec(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout.trimEnd());
      }
    });
  });
}

export async function getRepoRoot(cwd: string): Promise<string> {
  return exec('git rev-parse --show-toplevel', cwd);
}

export async function getCommitLog(cwd: string, count: number = 50): Promise<CommitInfo[]> {
  const SEP = '<<SEP>>';
  const format = `%H${SEP}%h${SEP}%s${SEP}%an${SEP}%ad`;
  const raw = await exec(
    `git log -n ${count} --format="${format}" --date=short`,
    cwd,
  );
  if (!raw) {
    return [];
  }
  return raw.split('\n').map(line => {
    const [hash, shortHash, message, author, date] = line.split(SEP);
    return { hash, shortHash, message, author, date };
  });
}

export async function editCommitMessage(cwd: string, hash: string, newMessage: string): Promise<void> {
  const headHash = await exec('git rev-parse HEAD', cwd);

  if (headHash === hash) {
    await exec(`git commit --amend -m ${shellEscape(newMessage)}`, cwd);
  } else {
    // Write a script that replaces 'pick' with 'reword' for the target commit
    const shortHash = hash.substring(0, 7);
    const seqScript = writeTempScript(
      `sed -i '' 's/^pick ${shortHash}/reword ${shortHash}/' "$1"`,
    );
    // Write a script that writes the new message into the editor file
    const msgScript = writeTempScript(
      `printf ${shellEscape(newMessage)} > "$1"`,
    );

    try {
      await exec(
        `GIT_SEQUENCE_EDITOR="${seqScript}" GIT_EDITOR="${msgScript}" git rebase -i ${hash}~1`,
        cwd,
      );
    } finally {
      cleanupTemp(seqScript);
      cleanupTemp(msgScript);
    }
  }
}

/**
 * Squash arbitrary (possibly non-contiguous) commits.
 *
 * Strategy:
 * 1. Sort selected commits in log order (oldest first).
 * 2. Use interactive rebase from the oldest commit's parent.
 * 3. Generate a rebase-todo editor script that:
 *    a. Reorders selected commits to be contiguous (right after the first selected one).
 *    b. Marks all but the first selected as 'fixup'.
 * 4. Uses a message editor script to set the final commit message.
 */
export async function squashCommits(
  cwd: string,
  selectedHashes: string[],
  message: string,
): Promise<void> {
  if (selectedHashes.length < 2) {
    throw new Error('Need at least 2 commits to squash');
  }

  // Get full log to determine order
  const log = await getCommitLog(cwd, 200);
  const logIndex = new Map(log.map((c, i) => [c.hash, i]));

  // Sort selected commits by their position in log (newest first in git log, so higher index = older)
  const sorted = [...selectedHashes].sort((a, b) => {
    const ia = logIndex.get(a) ?? 0;
    const ib = logIndex.get(b) ?? 0;
    return ib - ia; // oldest first
  });

  const oldestHash = sorted[0];
  const selectedShorts = sorted.map(h => h.substring(0, 7));
  const firstShort = selectedShorts[0];
  const restShorts = selectedShorts.slice(1);

  // Check if this is a simple HEAD squash (all selected are the most recent N commits)
  const headHash = await exec('git rev-parse HEAD', cwd);
  const headIdx = logIndex.get(headHash) ?? -1;
  const selectedIndices = selectedHashes.map(h => logIndex.get(h) ?? -1).sort((a, b) => a - b);
  const isTopN = selectedIndices[0] === headIdx &&
    selectedIndices.every((idx, i) => idx === headIdx + i);

  if (isTopN) {
    // Simple case: selected commits are the top N contiguous commits
    await exec(`git reset --soft ${oldestHash}~1`, cwd);
    await exec(`git commit -m ${shellEscape(message)}`, cwd);
    return;
  }

  // Complex case: use interactive rebase with a custom todo rewriter
  // The script will:
  // 1. Collect all lines from the todo
  // 2. Move selected commits right after the first selected commit
  // 3. Change the moved ones to 'fixup'
  const todoScript = writeTempScript(generateTodoRewriterScript(firstShort, restShorts));
  const msgScript = writeTempScript(`printf ${shellEscape(message)} > "$1"`);

  try {
    await exec(
      `GIT_SEQUENCE_EDITOR="${todoScript}" GIT_EDITOR="${msgScript}" git rebase -i ${oldestHash}~1`,
      cwd,
    );
  } finally {
    cleanupTemp(todoScript);
    cleanupTemp(msgScript);
  }
}

/**
 * Generate a bash script that rewrites the rebase todo list:
 * - Keeps the first selected commit as 'pick'
 * - Moves all other selected commits right after it, marked as 'fixup'
 * - Preserves all non-selected commits in their original positions
 */
function generateTodoRewriterScript(firstShort: string, restShorts: string[]): string {
  // Build a Python script for reliable todo rewriting (awk/sed gets messy with this logic)
  const restShortsStr = restShorts.map(s => `"${s}"`).join(', ');

  return `#!/bin/bash
python3 - "$1" << 'PYEOF'
import sys

todo_file = sys.argv[1]
first_short = "${firstShort}"
rest_shorts = set([${restShortsStr}])

with open(todo_file, 'r') as f:
    lines = f.readlines()

first_line = None
rest_lines = []
other_lines = []

for line in lines:
    stripped = line.strip()
    if not stripped or stripped.startswith('#'):
        other_lines.append(line)
        continue

    parts = stripped.split(None, 2)
    if len(parts) < 2:
        other_lines.append(line)
        continue

    action, commit_hash = parts[0], parts[1]
    short = commit_hash[:7]

    if short == first_short:
        first_line = line
    elif short in rest_shorts:
        # Change action to fixup
        rest_lines.append("fixup " + " ".join(parts[1:]) + "\\n")
    else:
        other_lines.append(line)

# Rebuild: insert first_line and rest_lines at the position of first_line
result = []
first_inserted = False
for line in lines:
    stripped = line.strip()
    if not stripped or stripped.startswith('#'):
        result.append(line)
        continue

    parts = stripped.split(None, 2)
    if len(parts) < 2:
        result.append(line)
        continue

    short = parts[1][:7]

    if short == first_short and not first_inserted:
        result.append(first_line)
        result.extend(rest_lines)
        first_inserted = True
    elif short not in rest_shorts:
        result.append(line)

with open(todo_file, 'w') as f:
    f.writelines(result)
PYEOF`;
}

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const status = await exec('git status --porcelain', cwd);
  return status.length > 0;
}

export async function isRebaseInProgress(cwd: string): Promise<boolean> {
  try {
    await exec('git rev-parse --verify --quiet REBASE_HEAD', cwd);
    return true;
  } catch {
    return false;
  }
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function writeTempScript(content: string): string {
  const tmpFile = path.join(os.tmpdir(), `git-commit-tools-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(tmpFile, content, { mode: 0o755 });
  return tmpFile;
}

function cleanupTemp(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore cleanup errors
  }
}
