/**
 * Suite-wide environment pin: JARPEEK_BUILD_TOOL exported in a developer's
 * shell must not flip strategy convergence in unrelated suites (dozens of
 * tests write "auto"-hashed manifests). Tests that exercise the env layer
 * stub it explicitly with vi.stubEnv.
 */
delete process.env.JARPEEK_BUILD_TOOL;

/**
 * Suite-wide cache isolation: manifests, locks and the Gradle init script
 * live in the machine-wide cache, so every test file gets its own empty one
 * — no test reads a developer's real cache or another file's entries.
 * Spawned CLI children inherit it through process.env.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.JARPEEK_CACHE_DIR = mkdtempSync(join(tmpdir(), "jarpeek-cache-"));

/**
 * Suite-wide home isolation: `init` wires machine-wide by default, so every
 * test file gets a scratch JARPEEK_HOME — no test can write the developer's
 * real ~/.claude, ~/.gemini, ~/.codex or ~/.config/jarpeek. (The real
 * `claude mcp add` never runs while JARPEEK_HOME relocates home.) Tests
 * that exercise the home layer stub it explicitly with vi.stubEnv.
 */
process.env.JARPEEK_HOME = mkdtempSync(join(tmpdir(), "jarpeek-home-"));
