# extractPaths Order-Preservation Fix

Session: 58a0ae94 | 2026-01-25

## The Bug

```typescript
// Current extractPaths:
// 1. Extract ALL quoted strings first
// 2. Then extract unquoted paths
// Result: order is [quoted..., unquoted...] not [first..., last...]
```

For `cp SOURCE "DEST"`:
- paths = ["DEST", "SOURCE"] (wrong order)
- paths[-1] = "SOURCE" (we validate the source as destination!)

## Approaches Considered

### A. Make extractPaths order-preserving
- Single pass, maintain argument order
- **Pros**: Fixes the root cause, benefits all commands
- **Cons**: Need to rewrite the function

### B. Special-case cp parsing
- Keep extractPaths, add dedicated cp parser
- **Pros**: More semantically accurate (handles -t flag etc)
- **Cons**: Adds specialized code, cp-specific logic

### C. Return paths with positions
- `{path: string, position: number}[]`
- **Pros**: Flexible
- **Cons**: Over-engineered, changes interface

### D. Check ALL paths for cp
- No order needed, just validate everything
- **Cons**: WRONG - we WANT to copy FROM outside TO inside

## Decision: Approach A

**Rationale**: The bug is in extractPaths. Fix extractPaths.

Current code does TWO passes (quoted first, then unquoted).
New code does ONE pass, extracting arguments in order.

## The Fix

Replace two-pass extraction with single-pass regex:

```typescript
private extractPaths(command: string): string[] {
  // Single regex matches arguments in command order:
  // - Quoted strings: "..." or '...'
  // - Unquoted tokens: non-whitespace sequences
  const argPattern = /["']([^"']+)["']|(\S+)/g;
  const paths: string[] = [];
  let match;

  while ((match = argPattern.exec(command)) !== null) {
    // Group 1 = quoted content (without quotes)
    // Group 2 = unquoted token
    const arg = match[1] ?? match[2];

    // Skip flags
    if (arg.startsWith("-")) continue;

    // Filter for path-like arguments
    if (
      arg.includes("/") ||
      arg.startsWith("~") ||
      arg.startsWith(".") ||
      arg.startsWith("$")
    ) {
      paths.push(arg);
    }
  }

  return paths;
}
```

## Why This Is KISS

1. **Same filtering logic** - no semantic change to what counts as a path
2. **Single pass** - actually simpler than the two-pass original
3. **Order-preserving** - regex.exec matches left-to-right
4. **No new interfaces** - same return type
5. **Benefits all commands** - mv would have the same bug with quotes

## Edge Cases

| Case | Result | Correct? |
|------|--------|----------|
| `cp src dest` | [src, dest] | ✓ |
| `cp src "dest with spaces"` | [src, dest with spaces] | ✓ |
| `cp "src" dest` | [src, dest] | ✓ |
| `cp -r src dest` | [src, dest] | ✓ |
| `cp -t dest src1 src2` | [dest, src1, src2] | ⚠️ -t not handled |

**Note**: `-t TARGET_DIR` handling is a pre-existing gap, not introduced by this fix.
Can be addressed separately if needed.

## Not Addressed (Out of Scope)

- Complex shell escaping (wasn't handled before either)
- `cp -t` flag semantics (wasn't handled before either)
- Subshell expansion (wasn't handled before either)

This fix is minimal: it fixes what's broken without scope creep.

## Related Issue Found (Separate Fix)

`mv` is in DANGEROUS_COMMANDS but lacks dest-only checking like `cp` has.
This means `mv SOURCE DEST` validates BOTH paths, blocking legitimate
"move from outside to inside" operations.

**Not caused by this fix** - pre-existing.
**Should be addressed separately** - add same dest-only logic as cp.

## Final Verdict

Single-pass regex extraction is:
- Simpler (one pass vs two)
- Correct (preserves order)
- Safe (same filtering logic)
- Minimal (fixes only what's broken)

Ready to implement.
