/**
 * Suite-wide environment pin: JARPEEK_BUILD_TOOL exported in a developer's
 * shell must not flip strategy convergence in unrelated suites (dozens of
 * tests write "auto"-hashed manifests). Tests that exercise the env layer
 * stub it explicitly with vi.stubEnv.
 */
delete process.env.JARPEEK_BUILD_TOOL;
