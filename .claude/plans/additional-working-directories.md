# Plan: Additional Working Directories Support for bash-leash

## Overview

Add support for Claude Code's "additional working directories" feature. When users add directories via `/add-dir`, those directories should also be allowed for dangerous commands.

**Scope:** Claude Code adapter only (other adapters unchanged)

---

## The Problem

Currently bash-leash only allows dangerous commands within `cwd`. But Claude Code users can configure additional trusted directories in `{project_dir}/.claude/settings.json`.

The challenge: We receive `transcript_path` with a sanitized project path, but not the actual project directory.

## The Solution

**Sanitization function** (from Claude Code source):
```javascript
function bc(A) {
    return A.replace(/[^a-zA-Z0-9]/g, "-");
}
```

**Algorithm to find project directory:**
1. Extract sanitized name from `transcript_path` (the directory name under `/projects/`)
2. Walk UP from `cwd` toward root
3. Sanitize each ancestor using the same function
4. When sanitized matches → that's the project directory
5. Read `{project_dir}/.claude/settings.local.json`
6. Extract `permissions.additionalDirectories` (array of paths)

This is O(depth) ≈ 5-10 iterations. Very fast!

---

## Implementation Steps

### Step 1: Create `packages/core/project-resolver.ts`

New module with pure functions:

```typescript
import { dirname, basename, resolve } from "path";
import { readFileSync, existsSync } from "fs";

/** Sanitize path using Claude Code's pattern (all non-alphanumeric → "-") */
export function sanitizePath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Find project directory by walking up from cwd and matching sanitized name */
export function findProjectDirectory(cwd: string, transcriptPath: string): string | null {
  // Extract sanitized name: /.../.claude/projects/-home-jan-src-foo/session.jsonl
  const projectsDir = dirname(transcriptPath);
  const sanitizedName = basename(projectsDir);

  // Walk up from cwd
  let current = resolve(cwd);
  while (current !== "/" && current.length > 1) {
    if (sanitizePath(current) === sanitizedName) {
      return current;
    }
    current = dirname(current);
  }

  // Check root
  if (sanitizePath(current) === sanitizedName) {
    return current;
  }

  return null;
}

/** Read additional directories from project settings */
export function getAdditionalDirectories(projectDir: string): string[] {
  const settingsPath = resolve(projectDir, ".claude", "settings.local.json");

  if (!existsSync(settingsPath)) {
    return [];
  }

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const dirs = settings?.permissions?.additionalDirectories;
    return Array.isArray(dirs) ? dirs : [];
  } catch {
    return [];
  }
}

/** Resolve all working directories for Claude Code hook */
export function resolveWorkingDirectories(cwd: string, transcriptPath?: string): string[] {
  const directories = [cwd];

  if (!transcriptPath) return directories;

  const projectDir = findProjectDirectory(cwd, transcriptPath);
  if (!projectDir) return directories;

  const additional = getAdditionalDirectories(projectDir);
  return [...directories, ...additional];
}
```

### Step 2: Modify `packages/core/path-validator.ts`

Change constructor to accept array (backward-compatible):

```typescript
constructor(workingDirectories: string | string[]) {
  this.workingDirectories = Array.isArray(workingDirectories)
    ? workingDirectories
    : [workingDirectories];
}
```

Update `isWithinWorkingDir()` to check ANY directory:

```typescript
isWithinWorkingDir(path: string): boolean {
  try {
    const realPath = this.resolveReal(path);

    for (const workDir of this.workingDirectories) {
      try {
        const realWorkDir = realpathSync(workDir);
        if (realPath === realWorkDir) return true;

        const rel = relative(realWorkDir, realPath);
        if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
          return true;
        }
      } catch {
        continue; // Skip non-existent directories
      }
    }
    return false;
  } catch {
    return false;
  }
}
```

### Step 3: Modify `packages/core/command-analyzer.ts`

Update constructor to accept array:

```typescript
constructor(workingDirectories: string | string[]) {
  const dirs = Array.isArray(workingDirectories) ? workingDirectories : [workingDirectories];
  this.workingDirectory = dirs[0]; // Primary for $PWD expansion
  this.pathValidator = new PathValidator(dirs);
}
```

### Step 4: Update `packages/core/index.ts`

Add exports for new module:

```typescript
export {
  sanitizePath,
  findProjectDirectory,
  getAdditionalDirectories,
  resolveWorkingDirectories,
} from "./project-resolver.js";
```

### Step 5: Modify `packages/claude-code/leash.ts`

Update interface and wire it together:

```typescript
import { CommandAnalyzer } from "../core/index.js";
import { resolveWorkingDirectories } from "../core/project-resolver.js";

interface ClaudeCodeHookInput {
  tool_name: string;
  tool_input: { command?: string; file_path?: string; };
  cwd: string;
  transcript_path?: string;  // NEW
}

// In main():
const { tool_name, tool_input, cwd, transcript_path } = input;
const workingDirectories = resolveWorkingDirectories(cwd, transcript_path);
const analyzer = new CommandAnalyzer(workingDirectories);

// Update error messages to show all directories
```

### Step 6: Build and Test

```bash
npm run build
# Test with actual Claude Code hook input containing transcript_path
```

---

## Files to Modify

| File | Action |
|------|--------|
| `packages/core/project-resolver.ts` | **CREATE** - New module |
| `packages/core/path-validator.ts` | Modify constructor + `isWithinWorkingDir()` |
| `packages/core/command-analyzer.ts` | Modify constructor signature |
| `packages/core/index.ts` | Add exports |
| `packages/claude-code/leash.ts` | Wire up resolution, update interface |

---

## Error Handling

All failures are silent and graceful — fall back to cwd only:
- No `transcript_path` → use cwd only
- Project dir not found → use cwd only
- Settings file missing → use cwd only
- Settings malformed → use cwd only
- Additional dir doesn't exist → skip it, use others

---

## Testing Checklist

- [ ] `sanitizePath()` matches Claude Code's behavior
- [ ] `findProjectDirectory()` finds correct dir when cwd is project root
- [ ] `findProjectDirectory()` finds correct dir when cwd is subdirectory
- [ ] `findProjectDirectory()` returns null when no match
- [ ] `getAdditionalDirectories()` handles missing file
- [ ] `getAdditionalDirectories()` handles malformed JSON
- [ ] `PathValidator` allows paths in primary directory
- [ ] `PathValidator` allows paths in additional directories
- [ ] `PathValidator` blocks paths outside all directories
- [ ] Backward compatibility: single string argument still works
