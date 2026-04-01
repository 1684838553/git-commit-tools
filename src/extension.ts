import * as vscode from 'vscode';
import {
  getRepoRoot,
  getCommitLog,
  editCommitMessage,
  squashCommits,
  hasUncommittedChanges,
  isRebaseInProgress,
  CommitInfo,
} from './git';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gitCommitTools.editCommitMessage', cmdEditCommitMessage),
    vscode.commands.registerCommand('gitCommitTools.squashCommits', cmdSquashCommits),
  );
}

export function deactivate() { }

// ─── Edit Commit Message ───────────────────────────────────────────

async function cmdEditCommitMessage() {
  const cwd = getWorkspaceRoot();
  if (!cwd) { return; }

  const err = await preflightCheck(cwd);
  if (err) {
    vscode.window.showErrorMessage(err);
    return;
  }

  const commits = await safeGetLog(cwd);
  if (!commits) { return; }

  const picked = await pickOneCommit(commits, 'Select a commit to edit its message');
  if (!picked) { return; }

  const newMessage = await vscode.window.showInputBox({
    prompt: 'Enter new commit message',
    value: picked.message,
    validateInput: v => v.trim() ? null : 'Message cannot be empty',
  });

  if (!newMessage) { return; }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Editing commit message...' },
    async () => {
      try {
        await editCommitMessage(cwd, picked.hash, newMessage);
        vscode.window.showInformationMessage(`Commit message updated: ${picked.shortHash}`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to edit commit: ${e.message}`);
      }
    },
  );
}

// ─── Squash Commits ────────────────────────────────────────────────

async function cmdSquashCommits() {
  const cwd = getWorkspaceRoot();
  if (!cwd) { return; }

  const err = await preflightCheck(cwd);
  if (err) {
    vscode.window.showErrorMessage(err);
    return;
  }

  const commits = await safeGetLog(cwd);
  if (!commits) { return; }

  // Multi-select: user picks any number of commits
  const selected = await pickManyCommits(commits, 'Select commits to squash (pick 2 or more)');
  if (!selected || selected.length < 2) {
    if (selected && selected.length === 1) {
      vscode.window.showWarningMessage('Please select at least 2 commits to squash.');
    }
    return;
  }

  // Show summary of selected commits
  const summary = selected.map(c => `  ${c.shortHash} ${c.message}`).join('\n');
  const defaultMessage = selected.map(c => c.message).join('\n');

  // Open a temp document for editing the squash message
  const doc = await vscode.workspace.openTextDocument({
    content: [
      `# Squash ${selected.length} commits`,
      `# Lines starting with # will be ignored.`,
      `# Edit the commit message below, then close this tab and confirm.`,
      ``,
      defaultMessage,
    ].join('\n'),
    language: 'git-commit',
  });
  await vscode.window.showTextDocument(doc);

  const confirmed = await vscode.window.showInformationMessage(
    `Squash these ${selected.length} commits?\n${summary}`,
    { modal: true },
    'Squash',
  );

  if (confirmed !== 'Squash') { return; }

  const fullText = doc.getText();
  const message = fullText
    .split('\n')
    .filter(line => !line.startsWith('#'))
    .join('\n')
    .trim();

  if (!message) {
    vscode.window.showErrorMessage('Commit message cannot be empty.');
    return;
  }

  const selectedHashes = selected.map(c => c.hash);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Squashing commits...' },
    async () => {
      try {
        await squashCommits(cwd, selectedHashes, message);
        vscode.window.showInformationMessage(
          `Squashed ${selected.length} commits into one.`,
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to squash: ${e.message}`);
      }
    },
  );
}

// ─── Helpers ───────────────────────────────────────────────────────

function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return undefined;
  }
  return folders[0].uri.fsPath;
}

async function preflightCheck(cwd: string): Promise<string | undefined> {
  try {
    await getRepoRoot(cwd);
  } catch {
    return 'Not a git repository.';
  }

  if (await isRebaseInProgress(cwd)) {
    return 'A rebase is already in progress. Please finish or abort it first.';
  }

  if (await hasUncommittedChanges(cwd)) {
    return 'You have uncommitted changes. Please commit or stash them first.';
  }

  return undefined;
}

async function safeGetLog(cwd: string): Promise<CommitInfo[] | undefined> {
  try {
    const commits = await getCommitLog(cwd);
    if (commits.length === 0) {
      vscode.window.showInformationMessage('No commits found.');
      return undefined;
    }
    return commits;
  } catch (e: any) {
    vscode.window.showErrorMessage(`Failed to read git log: ${e.message}`);
    return undefined;
  }
}

function commitToQuickPickItem(c: CommitInfo) {
  return {
    label: `$(git-commit) ${c.shortHash}`,
    description: c.message,
    detail: `${c.author} | ${c.date}`,
    commit: c,
  };
}

async function pickOneCommit(
  commits: CommitInfo[],
  placeholder: string,
): Promise<CommitInfo | undefined> {
  const items = commits.map(commitToQuickPickItem);
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: placeholder,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.commit;
}

async function pickManyCommits(
  commits: CommitInfo[],
  placeholder: string,
): Promise<CommitInfo[] | undefined> {
  const items = commits.map(commitToQuickPickItem);
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: placeholder,
    matchOnDescription: true,
    matchOnDetail: true,
    canPickMany: true,
  });
  if (!picked || picked.length === 0) {
    return undefined;
  }
  return picked.map(p => p.commit);
}
