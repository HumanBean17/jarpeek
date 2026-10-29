/**
 * A workspace: the directory (or directories) an agent works in, mapped to
 * the Gradle/Maven builds it contains — and the QueryContext a query runs
 * against.
 *
 * - One build (the workspace is inside it, or holds exactly one): that
 *   build's own context — behavior identical to a single-project jarpeek.
 * - Several builds (a monorepo or multi-repo root) and no `project` hint:
 *   a merged context answering over the union of every build's dependency
 *   set, each build resolved lazily on first use (two at a time) and
 *   cached machine-wide like any other manifest. Hits name the builds they
 *   come from (`projects`), so the agent can scope a follow-up.
 * - A `project` hint (any path inside a build, or a build's
 *   workspace-relative path or unique suffix): that build only.
 * - No build anywhere: the directory itself, exactly as before discovery
 *   existed (the resolver's cache-scan fallback included).
 *
 * Contexts are opened once per build root and share one listing service
 * and one decompiler, so a jar listed for one build is never re-listed for
 * another.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { createDecompiler, type DecompileFn } from "../decompile/cfr.js";
import { ListingService } from "../core/listing.js";
import { mapWithPool } from "../core/query/locate.js";
import { openContext, type OpenContextOptions, type QueryContext } from "../core/query/context.js";
import type { Manifest } from "../index/manifest.js";
import type { DegradedEntry } from "../resolver/index.js";
import type { DependencyArtifact } from "../core/types.js";
import { detectBuildSystems } from "../resolver/detect.js";
import { buildsBelow, discoverBuilds, enclosingBuild, type DiscoveredBuild } from "./discover.js";

/** How many builds a merged context resolves at once. */
export const RESOLVE_CONCURRENCY = 2;

/** Heartbeats from concurrently resolving builds collapse to one line per this interval. */
const HEARTBEAT_THROTTLE_MS = 25_000;

/**
 * The workspace's notice channel. Alone, a build speaks for itself. In a
 * merged batch the batch announces itself once ("resolving dependencies
 * for 3 builds: ...") and the members' own first-run/stale lines are
 * swallowed; heartbeats from builds resolving side by side collapse to one
 * line per interval — the CLI's three-stderr-line budget holds no matter
 * how many builds a monorepo has.
 */
class NoticeChannel {
  /** The running batch's announcement, emitted on its first member resolve (none when every build is fresh or backing off). */
  private batch: { announcement: string; announced: boolean } | undefined;
  private lastHeartbeat = 0;
  constructor(private readonly sink: ((msg: string) => void) | undefined) {}

  async inBatch<T>(announcement: string, body: () => Promise<T>): Promise<T> {
    const outer = this.batch;
    this.batch = { announcement, announced: false };
    try {
      return await body();
    } finally {
      this.batch = outer;
    }
  }

  fromMember(msg: string): void {
    if (this.batch === undefined) return this.sink?.(msg);
    if (msg.startsWith("resolving dependencies")) {
      if (!this.batch.announced) {
        this.batch.announced = true;
        this.sink?.(this.batch.announcement);
      }
      return;
    }
    if (msg.startsWith("still resolving")) {
      const now = Date.now();
      if (now - this.lastHeartbeat < HEARTBEAT_THROTTLE_MS) return;
      this.lastHeartbeat = now;
    }
    this.sink?.(msg);
  }
}

/** A `project` hint that names no build: a usage error listing what exists. */
export class ProjectHintError extends Error {
  constructor(
    readonly hint: string,
    readonly projects: string[],
  ) {
    super(
      projects.length > 0
        ? `no Gradle/Maven build matches project "${hint}"; builds in this workspace: ${projects.join(", ")}`
        : `no Gradle/Maven build matches project "${hint}"`,
    );
  }
}

export interface WorkspaceInfo {
  dirs: string[];
  builds: DiscoveredBuild[];
  truncated: boolean;
}

export class Workspace {
  private readonly contexts = new Map<string, QueryContext>();
  private readonly listings: ListingService;
  private readonly decompiler: DecompileFn;
  private discovered: WorkspaceInfo | undefined;
  private readonly notices: NoticeChannel;
  private merged: QueryContext | undefined;

  constructor(
    /** Workspace directories (MCP roots, `--project`, or cwd); the first is the base for relative hints. */
    readonly dirs: string[],
    private readonly opts: OpenContextOptions = {},
  ) {
    this.listings = opts.listings ?? new ListingService();
    this.decompiler = opts.decompiler ?? createDecompiler();
    this.notices = new NoticeChannel(opts.onNotice);
  }

  /** The builds this workspace holds (discovered once, on first use). */
  info(): WorkspaceInfo {
    if (this.discovered === undefined) {
      const builds: DiscoveredBuild[] = [];
      let truncated = false;
      const multiRoot = this.dirs.length > 1;
      for (const dir of this.dirs) {
        const found = discoverBuilds(dir);
        truncated ||= found.truncated;
        for (const build of found.builds) {
          if (builds.some((b) => b.root === build.root)) continue;
          // with several workspace roots, labels stay unambiguous as absolute paths
          builds.push(multiRoot ? { ...build, rel: build.root } : build);
        }
      }
      this.discovered = { dirs: this.dirs, builds, truncated };
    }
    return this.discovered;
  }

  /** The context for one build root, opened once and reused. */
  private contextFor(root: string): QueryContext {
    let ctx = this.contexts.get(root);
    if (ctx === undefined) {
      ctx = openContext(root, {
        ...this.opts,
        listings: this.listings,
        decompiler: this.decompiler,
        onNotice: (msg) => this.notices.fromMember(msg),
      });
      this.contexts.set(root, ctx);
    }
    return ctx;
  }

  /**
   * The context a query runs against: the hinted build, else the only
   * build, else a merged context over every build, else (no build at all)
   * the first workspace directory itself.
   */
  context(project?: string): QueryContext {
    if (project !== undefined && project.trim().length > 0) return this.hinted(project.trim());
    const { builds } = this.info();
    if (builds.length === 0) return this.contextFor(resolve(this.dirs[0]!));
    if (builds.length === 1) return this.contextFor(builds[0]!.root);
    this.merged ??= mergeContexts(
      resolve(this.dirs[0]!),
      builds.map((b) => ({ project: b.rel, ctx: this.contextFor(b.root) })),
      this.notices,
    );
    return this.merged;
  }

  private hinted(hint: string): QueryContext {
    const { builds } = this.info();
    const labels = builds.map((b) => b.rel);
    // a build's label, or a unique suffix of one ("api" for "services/api")
    const normalized = hint.replaceAll("\\", "/").replace(/\/+$/, "");
    const byLabel = builds.filter((b) => b.rel === normalized || b.rel.endsWith(`/${normalized}`));
    if (byLabel.length === 1) return this.contextFor(byLabel[0]!.root);

    // a path: inside a build, or above several
    const path = isAbsolute(hint) ? hint : resolve(this.dirs[0]!, hint);
    if (existsSync(path)) {
      const enclosing = enclosingBuild(path);
      if (enclosing !== null) return this.contextFor(enclosing);
      const below = buildsBelow(path);
      if (below.length === 1) return this.contextFor(below[0]!);
      if (below.length > 1) {
        const base = resolve(this.dirs[0]!);
        return mergeContexts(
          path,
          below.map((root) => ({ project: relLabel(base, root), ctx: this.contextFor(root) })),
          this.notices,
        );
      }
    }
    throw new ProjectHintError(hint, byLabel.length > 1 ? byLabel.map((b) => b.rel) : labels);
  }
}

function relLabel(base: string, root: string): string {
  if (root === base) return ".";
  return root.startsWith(base + sep) ? root.slice(base.length + 1).split(sep).join("/") : root;
}

/** One build's view inside a merged context. */
interface Member {
  project: string;
  ctx: QueryContext;
}

/**
 * A context answering over several builds at once. Every member keeps its
 * own manifest, freshness and backoff; this layer only unions what they
 * serve: artifacts in member order (deduplicated by coordinates — the same
 * external jar is the same artifact in every build), warnings labeled with
 * their build, incompleteness from any member — a member with nothing to
 * serve makes the union non-exhaustive (GH#18's honesty rule).
 */
export function mergeContexts(dir: string, members: Member[], notices?: NoticeChannel): QueryContext {
  const first = members[0]!.ctx;
  /** coordinates → the builds holding them, memoized per member-manifest generation. */
  let index: { stamp: string; byCoordinates: Map<string, string[]> } | undefined;

  async function manifests(): Promise<Array<Manifest | null>> {
    return Promise.all(members.map((m) => m.ctx.manifest()));
  }

  async function merged(): Promise<Manifest | null> {
    const parts = await manifests();
    if (parts.every((m) => m === null)) return null;
    const seen = new Set<string>();
    const artifacts: DependencyArtifact[] = [];
    const incomplete: DegradedEntry[] = [];
    let resolvedAt: string | undefined;
    parts.forEach((m, i) => {
      const project = members[i]!.project;
      if (m === null) {
        incomplete.push({
          from: detectBuildSystems(members[i]!.ctx.projectRoot)[0] ?? "maven",
          reason: `${project}: not resolved`,
        });
        return;
      }
      if (resolvedAt === undefined || m.resolvedAt < resolvedAt) resolvedAt = m.resolvedAt;
      for (const artifact of m.artifacts) {
        if (seen.has(artifact.coordinates)) continue;
        seen.add(artifact.coordinates);
        artifacts.push(artifact);
      }
      for (const entry of m.incomplete ?? []) incomplete.push({ ...entry, reason: `${project}: ${entry.reason}` });
    });
    const hash = createHash("sha256")
      .update(parts.map((m) => m?.dependencySetHash ?? "-").join("\n"))
      .digest("hex");
    return {
      version: 2,
      resolvedAt: resolvedAt!,
      dependencySetHash: hash,
      artifacts,
      ...(incomplete.length > 0 ? { incomplete } : {}),
    };
  }

  return {
    projectRoot: dir,
    resolvers: first.resolvers,
    buildTool: first.buildTool,
    roots: first.roots,
    listings: first.listings,
    decompiler: first.decompiler,
    members,
    async ensureReady() {
      // one announcement for the batch: which builds are about to resolve
      const pending: string[] = [];
      for (const m of members) {
        if ((await m.ctx.manifest()) === null || (await m.ctx.stale())) pending.push(m.project);
      }
      const shown = pending.slice(0, 3).join(", ");
      const more = pending.length > 3 ? `, +${pending.length - 3} more` : "";
      const announcement =
        pending.length <= 1
          ? `resolving dependencies for ${shown || "workspace"}`
          : `resolving dependencies for ${pending.length} builds (${shown}${more})`;
      const run = async () => {
        const results = await mapWithPool(members, RESOLVE_CONCURRENCY, (m) => m.ctx.ensureReady());
        return {
          bootstrapped: results.some((r) => r.bootstrapped),
          stale: results.some((r) => r.stale),
        };
      };
      return notices === undefined ? run() : notices.inBatch(announcement, run);
    },
    manifest: merged,
    async artifacts() {
      return (await merged())?.artifacts ?? [];
    },
    async bootstrapWarnings() {
      const labeled: string[] = [];
      for (const m of members) {
        for (const warning of await m.ctx.bootstrapWarnings()) labeled.push(`${m.project}: ${warning}`);
      }
      return [...new Set(labeled)];
    },
    async stale() {
      const flags = await Promise.all(members.map((m) => m.ctx.stale()));
      return flags.some(Boolean);
    },
    async projectsOf(coordinates: string) {
      const parts = await manifests();
      const stamp = parts.map((m) => `${m?.dependencySetHash ?? "-"}@${m?.resolvedAt ?? ""}`).join("\n");
      if (index?.stamp !== stamp) {
        const byCoordinates = new Map<string, string[]>();
        parts.forEach((m, i) => {
          for (const artifact of m?.artifacts ?? []) {
            const list = byCoordinates.get(artifact.coordinates) ?? [];
            if (!list.includes(members[i]!.project)) list.push(members[i]!.project);
            byCoordinates.set(artifact.coordinates, list);
          }
        });
        index = { stamp, byCoordinates };
      }
      return index.byCoordinates.get(coordinates) ?? [];
    },
  };
}
