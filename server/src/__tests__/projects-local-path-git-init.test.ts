import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureLocalPathWorkspaceGitInitialized } from "../services/projects.ts";

// NET-7494: project spin-up creates non-git `local_path` primary workspaces
// which then break git-required adapters (`claude_local`) at launch with
// `workspace_validation_failed`. The helper inside `createWorkspace` runs
// `git init` on the workspace's cwd right after the row lands so the next
// agent launch finds `.git` in place.

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "net-7494-local-path-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("ensureLocalPathWorkspaceGitInitialized", () => {
  it("is a no-op when cwd is null", async () => {
    await expect(
      ensureLocalPathWorkspaceGitInitialized(null, "ws-1", "proj-1"),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when the path does not exist on disk", async () => {
    const missing = path.join(home, "does-not-exist");
    await expect(
      ensureLocalPathWorkspaceGitInitialized(missing, "ws-2", "proj-2"),
    ).resolves.toBeUndefined();
    await expect(stat(missing)).rejects.toThrow();
  });

  it("is a no-op when cwd points at a regular file", async () => {
    const filePath = path.join(home, "not-a-dir.txt");
    await writeFile(filePath, "hi", { mode: 0o600 });
    await expect(
      ensureLocalPathWorkspaceGitInitialized(filePath, "ws-3", "proj-3"),
    ).resolves.toBeUndefined();
    // .git must NOT have been created alongside the file.
    await expect(stat(path.join(home, ".git"))).rejects.toThrow();
  });

  it("initializes an empty directory as a git repo", async () => {
    const cwd = path.join(home, "fresh");
    await mkdir(cwd, { recursive: true });

    await ensureLocalPathWorkspaceGitInitialized(cwd, "ws-4", "proj-4");

    const gitStat = await stat(path.join(cwd, ".git"));
    expect(gitStat.isDirectory()).toBe(true);
  });

  it("leaves an existing git repo untouched (idempotent)", async () => {
    const cwd = path.join(home, "already");
    await mkdir(cwd, { recursive: true });
    // Seed a marker file inside .git so we can detect that we did NOT
    // clobber it with a fresh `git init`.
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    await writeFile(path.join(cwd, ".git", "MARKER"), "do-not-touch");

    await ensureLocalPathWorkspaceGitInitialized(cwd, "ws-5", "proj-5");

    const marker = await stat(path.join(cwd, ".git", "MARKER"));
    expect(marker.isFile()).toBe(true);
  });
});