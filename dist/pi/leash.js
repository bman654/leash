// packages/core/command-analyzer.ts
import { basename } from "path";

// packages/core/path-validator.ts
import { resolve, relative } from "path";
import { homedir } from "os";
import { realpathSync } from "fs";

// packages/core/constants.ts
var DANGEROUS_COMMANDS = /* @__PURE__ */ new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "mv",
  "cp",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "dd",
  "ln"
]);
var REDIRECT_PATTERN = />\s*([~\/][^\s;|&>]*)/g;
var DEVICE_PATHS = ["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"];
var TEMP_PATHS = [
  "/tmp",
  "/var/tmp",
  "/private/tmp",
  "/private/var/tmp"
];
var SAFE_WRITE_PATHS = [...DEVICE_PATHS, ...TEMP_PATHS];

// packages/core/path-validator.ts
var PathValidator = class {
  workingDirectories;
  primaryWorkingDirectory;
  /**
   * Create a PathValidator for one or more working directories.
   *
   * @param workingDirectories - Single directory or array of directories
   */
  constructor(workingDirectories) {
    this.workingDirectories = Array.isArray(workingDirectories) ? workingDirectories : [workingDirectories];
    this.primaryWorkingDirectory = this.workingDirectories[0];
  }
  /** Expand ~ and environment variables in path */
  expand(path) {
    return path.replace(/^~(?=\/|$)/, homedir()).replace(/\$\{?(\w+)\}?/g, (_, name) => {
      if (name === "HOME") return homedir();
      if (name === "PWD") return this.primaryWorkingDirectory;
      return process.env[name] || "";
    });
  }
  /** Resolve path following all symlinks (including parent directories) */
  resolveReal(path) {
    const expanded = this.expand(path);
    const resolved = resolve(this.primaryWorkingDirectory, expanded);
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
  /**
   * Check if a path is within any of the working directories.
   *
   * @param path - The path to check
   * @returns true if the path is within any working directory
   */
  isWithinWorkingDir(path) {
    try {
      const realPath = this.resolveReal(path);
      for (const workDir of this.workingDirectories) {
        try {
          const realWorkDir = realpathSync(workDir);
          if (realPath === realWorkDir) {
            return true;
          }
          const rel = relative(realWorkDir, realPath);
          if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
            return true;
          }
        } catch {
          continue;
        }
      }
      return false;
    } catch {
      return false;
    }
  }
  matchesAny(resolved, paths) {
    return paths.some((p) => resolved === p || resolved.startsWith(p + "/"));
  }
  isSafeForWrite(path) {
    const resolved = this.resolveReal(path);
    return this.matchesAny(resolved, SAFE_WRITE_PATHS);
  }
  isTempPath(path) {
    const resolved = this.resolveReal(path);
    return this.matchesAny(resolved, TEMP_PATHS);
  }
};

// packages/core/command-analyzer.ts
var CommandAnalyzer = class {
  pathValidator;
  workingDirectory;
  /**
   * Create a CommandAnalyzer for one or more working directories.
   *
   * @param workingDirectories - Single directory or array of directories
   */
  constructor(workingDirectories) {
    const dirs = Array.isArray(workingDirectories) ? workingDirectories : [workingDirectories];
    this.workingDirectory = dirs[0];
    this.pathValidator = new PathValidator(dirs);
  }
  /** Extract potential paths from command string */
  extractPaths(command) {
    const paths = [];
    const quoted = command.match(/["']([^"']+)["']/g) || [];
    quoted.forEach((q) => paths.push(q.slice(1, -1)));
    const tokens = command.replace(/["'][^"']*["']/g, "").split(/\s+/).filter((t) => !t.startsWith("-"));
    tokens.forEach((t) => {
      if (t.includes("/") || t.startsWith("~") || t.startsWith(".") || t.startsWith("$")) {
        paths.push(t);
      }
    });
    return paths;
  }
  /** Get the base command name */
  getBaseCommand(command) {
    const firstWord = command.trim().split(/\s+/)[0] || "";
    return basename(firstWord);
  }
  /** Split command by chain operators while respecting quotes */
  splitCommands(command) {
    const commands = [];
    let current = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let i = 0;
    while (i < command.length) {
      const char = command[i];
      const nextChar = command[i + 1];
      if (char === "\\" && !inSingleQuote) {
        current += char + (nextChar || "");
        i += 2;
        continue;
      }
      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        current += char;
        i++;
        continue;
      }
      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        current += char;
        i++;
        continue;
      }
      if (!inSingleQuote && !inDoubleQuote) {
        if (char === "&" && nextChar === "&" || char === "|" && nextChar === "|") {
          if (current.trim()) commands.push(current.trim());
          current = "";
          i += 2;
          continue;
        }
        if (char === ";" || char === "|" && nextChar !== "|") {
          if (current.trim()) commands.push(current.trim());
          current = "";
          i++;
          continue;
        }
      }
      current += char;
      i++;
    }
    if (current.trim()) commands.push(current.trim());
    return commands;
  }
  checkRedirects(command) {
    const matches = command.matchAll(REDIRECT_PATTERN);
    for (const match of matches) {
      const path = match[1];
      if (path && !this.pathValidator.isSafeForWrite(path) && !this.pathValidator.isWithinWorkingDir(path)) {
        return {
          blocked: true,
          reason: `Redirect to path outside allowed directories: ${path}`
        };
      }
    }
    return { blocked: false };
  }
  /** Check if path is allowed for the operation */
  isPathAllowed(path, allowDevicePaths) {
    if (this.pathValidator.isWithinWorkingDir(path)) return true;
    return allowDevicePaths ? this.pathValidator.isSafeForWrite(path) : this.pathValidator.isTempPath(path);
  }
  /**
   * Extract search paths from find command
   * find [options] [path...] [expression]
   * Paths come after 'find' and before first flag/expression
   * Handles quoted paths by stripping quotes
   */
  extractFindPaths(command) {
    const tokens = command.trim().split(/\s+/);
    const paths = [];
    for (let i = 1; i < tokens.length; i++) {
      let token = tokens[i];
      if (token.startsWith('"') && token.endsWith('"') || token.startsWith("'") && token.endsWith("'")) {
        token = token.slice(1, -1);
      }
      if (token.startsWith("-") || token === "!" || token === "(" || token === "\\(") {
        break;
      }
      paths.push(token);
    }
    return paths.length > 0 ? paths : ["."];
  }
  /**
   * Check find command for destructive actions (-delete, -exec, -ok, etc.)
   * Validates search paths if destructive action is present
   */
  checkFindCommand(command) {
    const hasDelete = /\s-delete\b/.test(command);
    const execPattern = /-(?:exec|ok)(?:dir)?\s+(\S+)/g;
    const execMatches = [...command.matchAll(execPattern)];
    const dangerousExec = execMatches.find(
      (match) => DANGEROUS_COMMANDS.has(basename(match[1]))
    );
    if (!hasDelete && !dangerousExec) {
      return { blocked: false };
    }
    const paths = this.extractFindPaths(command);
    for (const path of paths) {
      if (!this.isPathAllowed(path, false)) {
        const action = hasDelete ? "-delete" : `-exec ${dangerousExec?.[1]}`;
        return {
          blocked: true,
          reason: `Command "find" with ${action} targets path outside allowed directories: ${path}`
        };
      }
    }
    return { blocked: false };
  }
  /**
   * Check xargs command for dangerous commands
   * Cannot validate piped input, so block if dangerous command detected
   */
  checkXargsCommand(command) {
    const tokens = command.trim().split(/\s+/);
    const optsWithArgs = /* @__PURE__ */ new Set(["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a"]);
    let i = 1;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token.startsWith("-")) {
        if (optsWithArgs.has(token) && i + 1 < tokens.length) {
          i++;
        }
        i++;
        continue;
      }
      const cmd = basename(token);
      if (DANGEROUS_COMMANDS.has(cmd)) {
        return {
          blocked: true,
          reason: `Command "xargs ${cmd}" blocked - cannot validate piped input`
        };
      }
      break;
    }
    return { blocked: false };
  }
  /** Check dangerous commands for external paths */
  checkDangerousCommand(command) {
    const baseCmd = this.getBaseCommand(command);
    if (baseCmd === "find") {
      return this.checkFindCommand(command);
    }
    if (baseCmd === "xargs") {
      return this.checkXargsCommand(command);
    }
    if (!DANGEROUS_COMMANDS.has(baseCmd)) {
      return { blocked: false };
    }
    const paths = this.extractPaths(command);
    if (baseCmd === "cp" && paths.length > 0) {
      const dest = paths[paths.length - 1];
      if (!this.isPathAllowed(dest, true)) {
        return {
          blocked: true,
          reason: `Command "${baseCmd}" targets path outside allowed directories: ${dest}`
        };
      }
      return { blocked: false };
    }
    const isWriteCommand = baseCmd === "truncate" || baseCmd === "dd";
    for (const path of paths) {
      if (!this.isPathAllowed(path, isWriteCommand)) {
        return {
          blocked: true,
          reason: `Command "${baseCmd}" targets path outside allowed directories: ${path}`
        };
      }
    }
    return { blocked: false };
  }
  /** Analyze command for dangerous operations */
  analyze(command) {
    const redirectResult = this.checkRedirects(command);
    if (redirectResult.blocked) return redirectResult;
    const baseCmd = this.getBaseCommand(command);
    if (baseCmd === "find") {
      const findResult = this.checkFindCommand(command);
      if (findResult.blocked) return findResult;
    }
    const commands = this.splitCommands(command);
    for (const cmd of commands) {
      const trimmed = cmd.trim();
      if (!trimmed) continue;
      const result = this.checkDangerousCommand(trimmed);
      if (result.blocked) return result;
    }
    return { blocked: false };
  }
  validatePath(path) {
    if (!path) return { blocked: false };
    if (!this.pathValidator.isSafeForWrite(path) && !this.pathValidator.isWithinWorkingDir(path)) {
      return {
        blocked: true,
        reason: `File operation targets path outside allowed directories: ${path}`
      };
    }
    return { blocked: false };
  }
};

// packages/pi/leash.ts
function leash_default(pi) {
  let analyzer = null;
  pi.on("session_start", async (_event, ctx) => {
    analyzer = new CommandAnalyzer(ctx.cwd);
    ctx.ui.notify("\u{1F512} Leash active", "info");
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!analyzer) {
      analyzer = new CommandAnalyzer(ctx.cwd);
    }
    if (event.toolName === "bash") {
      const command = event.input.command || "";
      const result = analyzer.analyze(command);
      if (result.blocked) {
        if (ctx.hasUI) {
          ctx.ui.notify(`\u{1F6AB} Command blocked: ${result.reason}`, "warning");
        }
        return {
          block: true,
          reason: `Command blocked: ${command}
Reason: ${result.reason}
Working directory: ${ctx.cwd}
Action: Guide the user to run the command manually.`
        };
      }
    }
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = event.input.path || "";
      const result = analyzer.validatePath(path);
      if (result.blocked) {
        if (ctx.hasUI) {
          ctx.ui.notify(`\u{1F6AB} File operation blocked: ${result.reason}`, "warning");
        }
        return {
          block: true,
          reason: `File operation blocked: ${path}
Reason: ${result.reason}
Working directory: ${ctx.cwd}
Action: Guide the user to perform this operation manually.`
        };
      }
    }
    return void 0;
  });
}
export {
  leash_default as default
};
