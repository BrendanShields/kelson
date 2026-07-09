import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  benchView,
  DEFAULT_DB_PATH,
  evalView,
  loopView,
  openDb,
  telemetryView,
  traceView,
} from "@kelson/kernel";
import {
  UiBenchView,
  UiEvalView,
  UiLoopView,
  UiTelemetryView,
  UiTraceView,
} from "@kelson/schemas";
import type { ZodType } from "zod";
import { write } from "../components/sink.js";

export const DEFAULT_UI_PORT = 4553;

interface UiServerOptions {
  dbPath?: string;
  changelogPath?: string;
  staticDir?: string;
  port?: number;
}

// UX-11: every route declares its schema here — a route cannot exist
// without one. Responses are parsed before serialization; failure → 500
// with a fixed envelope, the invalid body never reaches the socket.
const routes: Record<
  string,
  { schema: ZodType; build: (ctx: RouteCtx) => unknown }
> = {
  "/api/telemetry": {
    schema: UiTelemetryView,
    build: (ctx) => telemetryView(ctx.db),
  },
  "/api/evals": { schema: UiEvalView, build: (ctx) => evalView(ctx.db) },
  // UX-25: bench runs in the eval surface (bench_run/bench_task_result only —
  // the EVP-11 ledger fence keeps them out of /api/evals)
  "/api/bench": { schema: UiBenchView, build: (ctx) => benchView(ctx.db) },
  "/api/loop": {
    schema: UiLoopView,
    build: (ctx) => loopView(ctx.db, ctx.changelogPath),
  },
  "/api/trace": { schema: UiTraceView, build: (ctx) => traceView(ctx.db) },
};

interface RouteCtx {
  db: ReturnType<typeof openDb>;
  changelogPath: string;
}

export const API_PATHS = Object.keys(routes);

// UX-13: repo-first store resolution — ./.kelson/kelson.db when present,
// else the user store; --db overrides both.
export const resolveUiDbPath = (cwd = process.cwd()): string => {
  const repoDb = join(cwd, ".kelson", "kelson.db");
  return existsSync(repoDb) ? repoDb : DEFAULT_DB_PATH;
};

// SEC-7: containment is by realpath + segment boundary, never string prefix —
// a prefix comparison admits siblings (`dist2`) and symlinks pointing out.
// The lexical check runs first so an escaping path is refused without any
// filesystem access; realpath then catches symlink escapes on existing paths.
type Containment =
  | { kind: "serve"; path: string }
  | { kind: "outside" }
  | { kind: "missing" };

const escapes = (rel: string): boolean =>
  rel === "" || isAbsolute(rel) || rel.split(sep).includes("..");

const containStatic = (root: string, asset: string): Containment => {
  if (escapes(relative(root, asset))) return { kind: "outside" };
  let realRoot: string;
  let realAsset: string;
  try {
    realRoot = realpathSync(root);
    realAsset = realpathSync(asset);
  } catch {
    return { kind: "missing" };
  }
  if (escapes(relative(realRoot, realAsset))) return { kind: "outside" };
  return { kind: "serve", path: realAsset };
};

export const createUiServer = (opts: UiServerOptions = {}) => {
  const dbPath = opts.dbPath ?? resolveUiDbPath();
  const changelogPath =
    opts.changelogPath ?? join(process.cwd(), ".kelson", "changelog.jsonl");
  const staticDir =
    opts.staticDir ?? join(import.meta.dir, "..", "..", "..", "ui", "dist");

  const server = Bun.serve({
    hostname: "127.0.0.1", // UX-10: loopback only
    port: opts.port ?? DEFAULT_UI_PORT,
    fetch(req) {
      if (req.method !== "GET")
        return Response.json({ error: "method_not_allowed" }, { status: 405 });
      const path = new URL(req.url).pathname;

      const route = routes[path];
      if (route) {
        const db = openDb(dbPath);
        try {
          const body = route.build({ db, changelogPath });
          const parsed = route.schema.safeParse(body);
          if (!parsed.success) {
            console.error(
              `kelson ui: response validation failed (UX-11) on ${path}: ${parsed.error.message}`,
            );
            return Response.json(
              { error: "response_validation_failed", route: path },
              { status: 500 },
            );
          }
          return Response.json(parsed.data);
        } catch (e) {
          console.error(`kelson ui: ${path}: ${(e as Error).message}`);
          return Response.json(
            { error: "response_build_failed", route: path },
            { status: 500 },
          );
        } finally {
          db.close();
        }
      }
      if (path.startsWith("/api/"))
        return Response.json({ error: "not_found" }, { status: 404 });

      // static SPA: exact asset if present, else index.html (client routing).
      // Assets are addressed by the DECODED segment — %2e%2e-style traversal
      // arrives undecoded (the runtime only strips literal dot segments), so
      // SEC-7 containment must be judged post-decode.
      let segment = path === "/" ? "index.html" : path.slice(1);
      if (path !== "/") {
        try {
          segment = decodeURIComponent(segment);
        } catch {
          // malformed percent-encoding: fall through with the literal segment
        }
      }
      const contained = containStatic(staticDir, join(staticDir, segment));
      if (contained.kind === "outside")
        return Response.json({ error: "not_found" }, { status: 404 });
      if (contained.kind === "serve")
        return new Response(Bun.file(contained.path));
      const index = join(staticDir, "index.html");
      if (existsSync(index)) return new Response(Bun.file(index));
      return new Response(
        "kelson ui: web assets not built — run `bun run build` in packages/ui",
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    },
  });
  return server;
};

export const uiCommand = (argv: string[]): void => {
  const portFlag = argv.indexOf("--port");
  const port =
    portFlag !== -1 && argv[portFlag + 1]
      ? Number(argv[portFlag + 1])
      : DEFAULT_UI_PORT;
  const dbFlag = argv.indexOf("--db");
  const server = createUiServer({
    port,
    ...(dbFlag !== -1 && argv[dbFlag + 1]
      ? { dbPath: argv[dbFlag + 1] as string }
      : {}),
  });
  write(
    `kelson ui serving on http://127.0.0.1:${server.port} (read-only; ctrl-c to stop)`,
  );
};
