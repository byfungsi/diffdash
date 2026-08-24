import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { access, chmod, cp, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { promisify } from "node:util"

import {
  DocumentLanguageSymbol,
  DocumentLanguageSymbolResult,
  LanguageAdapterId,
  LanguageId,
  LanguageOperationError,
  LanguagePosition,
  LanguageRange,
  type LanguageSymbolKind,
  RepositoryLanguageLocation,
  RepositoryLanguageLocationLink,
  RepositoryLanguageLocationResult,
  WorkspaceLanguageSymbol,
  WorkspaceLanguageSymbolResult,
} from "@diffdash/domain/language"
import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  LanguageAdapterCapabilities,
  LanguageAdapterDescriptor,
  type LanguageAdapterRegistration,
  type LanguageAdapterSession,
} from "@diffdash/language-provider"
import {
  Array as EffectArray,
  Duration,
  Effect,
  HashMap,
  HashSet,
  Option,
  Order,
  Ref,
  Schema,
} from "effect"

import { JsonRpcClient, type JsonRpcClientError } from "./json-rpc-client"

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const OPERATION_TIMEOUT = "10 seconds"
const INITIALIZE_TIMEOUT = "15 seconds"
const LOCATION_LIMIT = 100
const DOCUMENT_SYMBOL_LIMIT = 1_000
const WORKSPACE_SYMBOL_LIMIT = 100
const LANGUAGE_TREE_MAX_BYTES = 64 * 1_024 * 1_024
const LANGUAGE_TREE_MAX_FILES = 512

const NonNegativeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)
const BoundedName = Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))
const BoundedDetail = Schema.String.pipe(Schema.check(Schema.isMaxLength(1_000)))
const LspPosition = Schema.Struct({ line: NonNegativeInteger, character: NonNegativeInteger })
const LspRange = Schema.Struct({ start: LspPosition, end: LspPosition })
const LspLocation = Schema.Struct({
  _tag: Schema.tagDefaultOmit("location"),
  uri: Schema.String,
  range: LspRange,
})
const LspLocationLink = Schema.Struct({
  _tag: Schema.tagDefaultOmit("locationLink"),
  originSelectionRange: Schema.OptionFromOptionalKey(LspRange),
  targetUri: Schema.String,
  targetRange: LspRange,
  targetSelectionRange: LspRange,
})
const LspLocationResult = Schema.Union([LspLocation, LspLocationLink]).pipe(
  Schema.toTaggedUnion("_tag"),
)
const LspDefinitionResult = Schema.OptionFromNullOr(
  Schema.Union([LspLocation, Schema.Array(LspLocationResult)]),
)
const LspReferenceResult = Schema.OptionFromNullOr(Schema.Array(LspLocation))
const LspDocumentSymbol = Schema.Struct({
  _tag: Schema.tagDefaultOmit("documentSymbol"),
  name: BoundedName,
  detail: Schema.OptionFromOptionalKey(BoundedDetail),
  kind: NonNegativeInteger,
  range: LspRange,
  selectionRange: LspRange,
  children: Schema.OptionFromOptionalKey(Schema.Array(Schema.Json)),
})
const LspSymbolInformation = Schema.Struct({
  _tag: Schema.tagDefaultOmit("symbolInformation"),
  name: BoundedName,
  kind: NonNegativeInteger,
  containerName: Schema.OptionFromOptionalKey(BoundedName),
  location: LspLocation,
})
const LspDocumentSymbolItem = Schema.Union([LspDocumentSymbol, LspSymbolInformation]).pipe(
  Schema.toTaggedUnion("_tag"),
)
const LspDocumentSymbolResult = Schema.OptionFromNullOr(Schema.Array(LspDocumentSymbolItem))
const LspWorkspaceSymbolResult = Schema.OptionFromNullOr(Schema.Array(LspSymbolInformation))
const LspInitializeResult = Schema.Struct({
  capabilities: Schema.Struct({
    positionEncoding: Schema.OptionFromOptionalKey(Schema.Literal("utf-16")),
  }),
})

type LspRange = typeof LspRange.Type
type LspLocation = typeof LspLocation.Type
type LspDocumentSymbol = typeof LspDocumentSymbol.Type

const symbolKinds: readonly LanguageSymbolKind[] = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enumMember",
  "struct",
  "event",
  "operator",
  "typeParameter",
]

const languageIdsByExtension = HashMap.make(
  [".tsx", LanguageId.make("typescriptreact")],
  [".jsx", LanguageId.make("javascriptreact")],
  [".js", LanguageId.make("javascript")],
  [".mjs", LanguageId.make("javascript")],
  [".cjs", LanguageId.make("javascript")],
)

class LspUriConversionError extends Schema.TaggedError<LspUriConversionError>()(
  "LspUriConversionError",
  {},
) {}

/** One Tree-sitter grammar asset owned by the TypeScript adapter. */
export class TypeScriptLanguageGrammarAsset extends Schema.Class<TypeScriptLanguageGrammarAsset>(
  "TypeScriptLanguageGrammarAsset",
)({
  languageId: LanguageId,
  wasmPath: Schema.String,
}) {}

/** Runtime paths owned and interpreted by the TypeScript adapter. */
export class TypeScriptLanguageAdapterAssets extends Schema.Class<TypeScriptLanguageAdapterAssets>(
  "TypeScriptLanguageAdapterAssets",
)({
  grammarRuntimePath: Schema.String,
  grammars: Schema.Array(TypeScriptLanguageGrammarAsset),
  languageServerPath: Schema.String,
  languageServerRuntimePath: Schema.String,
}) {}

/** Descriptor for the bundled TypeScript, JavaScript, TSX, and JSX adapter family. */
export const typescriptLanguageAdapterDescriptor = LanguageAdapterDescriptor.make({
  id: LanguageAdapterId.make("typescript"),
  displayName: "TypeScript and JavaScript",
  languageIds: [
    LanguageId.make("typescript"),
    LanguageId.make("typescriptreact"),
    LanguageId.make("javascript"),
    LanguageId.make("javascriptreact"),
  ],
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
  capabilities: LanguageAdapterCapabilities.make({
    definitions: true,
    documentSymbols: true,
    references: true,
    workspaceSymbols: true,
  }),
})

/** Resolves only adapter-owned, version-pinned runtime assets. */
export const resolveTypeScriptLanguageAdapterAssets = (): TypeScriptLanguageAdapterAssets => {
  const bundledDirectory = join(dirname(fileURLToPath(import.meta.url)), "language", "typescript")
  if (existsSync(join(bundledDirectory, "lib", "cli.mjs"))) {
    return TypeScriptLanguageAdapterAssets.make({
      grammarRuntimePath: join(bundledDirectory, "tree-sitter.wasm"),
      grammars: [
        TypeScriptLanguageGrammarAsset.make({
          languageId: LanguageId.make("javascript"),
          wasmPath: join(bundledDirectory, "tree-sitter-javascript.wasm"),
        }),
        TypeScriptLanguageGrammarAsset.make({
          languageId: LanguageId.make("javascriptreact"),
          wasmPath: join(bundledDirectory, "tree-sitter-javascript.wasm"),
        }),
        TypeScriptLanguageGrammarAsset.make({
          languageId: LanguageId.make("typescript"),
          wasmPath: join(bundledDirectory, "tree-sitter-typescript.wasm"),
        }),
        TypeScriptLanguageGrammarAsset.make({
          languageId: LanguageId.make("typescriptreact"),
          wasmPath: join(bundledDirectory, "tree-sitter-tsx.wasm"),
        }),
      ],
      languageServerPath: join(bundledDirectory, "lib", "cli.mjs"),
      languageServerRuntimePath: join(bundledDirectory, "typescript", "lib", "tsserver.js"),
    })
  }
  const grammarRuntimePath = require.resolve("@vscode/tree-sitter-wasm")
  const grammarDirectory = dirname(grammarRuntimePath)
  return TypeScriptLanguageAdapterAssets.make({
    grammarRuntimePath: join(grammarDirectory, "tree-sitter.wasm"),
    grammars: [
      TypeScriptLanguageGrammarAsset.make({
        languageId: LanguageId.make("javascript"),
        wasmPath: join(grammarDirectory, "tree-sitter-javascript.wasm"),
      }),
      TypeScriptLanguageGrammarAsset.make({
        languageId: LanguageId.make("javascriptreact"),
        wasmPath: join(grammarDirectory, "tree-sitter-javascript.wasm"),
      }),
      TypeScriptLanguageGrammarAsset.make({
        languageId: LanguageId.make("typescript"),
        wasmPath: join(grammarDirectory, "tree-sitter-typescript.wasm"),
      }),
      TypeScriptLanguageGrammarAsset.make({
        languageId: LanguageId.make("typescriptreact"),
        wasmPath: join(grammarDirectory, "tree-sitter-tsx.wasm"),
      }),
    ],
    languageServerPath: require.resolve("typescript-language-server/lib/cli.mjs"),
    languageServerRuntimePath: require.resolve("typescript/lib/tsserver.js"),
  })
}

/** Builds a scoped TypeScript registration from an explicit set of adapter-owned assets. */
export const makeTypeScriptLanguageAdapterRegistration = (
  assets: TypeScriptLanguageAdapterAssets,
): LanguageAdapterRegistration => ({
  descriptor: typescriptLanguageAdapterDescriptor,
  probe: probeAssets(assets),
  openSession: (root) => openSession(assets, root),
})

const probeAssets: (
  assets: TypeScriptLanguageAdapterAssets,
) => Effect.Effect<void, LanguageOperationError> = Effect.fn(
  "TypeScriptLanguageAdapter.probeAssets",
)(function* (
  assets: TypeScriptLanguageAdapterAssets,
): Effect.fn.Return<void, LanguageOperationError> {
  if (packagedAssetTreeHash().length > 0) {
    return yield* verifyPackagedAssetTree(assets)
  }
  return yield* Effect.tryPromise({
    try: () =>
      Promise.all([
        access(assets.languageServerPath),
        access(assets.languageServerRuntimePath),
        execFileAsync(process.execPath, [assets.languageServerPath, "--version"], {
          env: Option.match(Option.fromNullishOr(process.versions.electron), {
            onNone: () => process.env,
            onSome: () => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1" }),
          }),
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        }),
      ]),
    catch: () =>
      operationError("probe", "serverUnavailable", "TypeScript language server probe failed"),
  }).pipe(Effect.asVoid)
})

/** Production registration backed by this package's pinned server and TypeScript runtime. */
export const typescriptLanguageAdapterRegistration: LanguageAdapterRegistration =
  makeTypeScriptLanguageAdapterRegistration(resolveTypeScriptLanguageAdapterAssets())

const openSession = Effect.fn("TypeScriptLanguageAdapter.openSession")(function* (
  assets: TypeScriptLanguageAdapterAssets,
  root: RepositoryCheckoutPath,
): Effect.fn.Return<LanguageAdapterSession, LanguageOperationError, import("effect").Scope.Scope> {
  const canonicalRoot = yield* Effect.tryPromise({
    try: () => realpath(root),
    catch: (cause) =>
      operationError(
        "initialize",
        "serverUnavailable",
        `Repository root is unavailable: ${String(cause)}`,
      ),
  })
  const sessionAssets = yield* prepareSessionAssets(assets)
  const client = yield* Effect.acquireRelease(
    JsonRpcClient.spawn({
      executable: process.execPath,
      args: [sessionAssets.languageServerPath, "--stdio"],
      cwd: canonicalRoot,
    }).pipe(Effect.mapError((error) => fromClientError("initialize", error))),
    (value) => value.close(),
  )

  yield* Effect.gen(function* () {
    const rootUri = pathToFileURL(canonicalRoot).href
    const initializeResponse = yield* request(
      client,
      "initialize",
      {
        processId: process.pid,
        rootPath: canonicalRoot,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: basename(canonicalRoot) }],
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          textDocument: {
            definition: { linkSupport: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
          workspace: { workspaceFolders: true },
        },
        initializationOptions: {
          tsserver: {
            path: sessionAssets.languageServerRuntimePath,
            useSyntaxServer: "never",
          },
        },
      },
      "initialize",
    ).pipe(
      parseResponse(LspInitializeResult, "initialize"),
      withTimeout("initialize", INITIALIZE_TIMEOUT),
    )
    if (
      Option.exists(
        initializeResponse.capabilities.positionEncoding,
        (encoding) => encoding !== "utf-16",
      )
    ) {
      return yield* operationError(
        "initialize",
        "serverFailed",
        "Language server selected an unsupported position encoding",
      )
    }
    return yield* client
      .notify("initialized", {})
      .pipe(Effect.mapError((error) => fromClientError("initialize", error)))
  }).pipe(Effect.onError(() => client.close()))

  const opened = yield* Ref.make(HashSet.empty<string>())
  const prepareDocument = Effect.fn("TypeScriptLanguageAdapter.prepareDocument")(function* (
    path: RepositoryRelativePath,
    operation: string,
  ) {
    const absolutePath = resolve(canonicalRoot, path)
    if (!isContained(canonicalRoot, absolutePath)) {
      return yield* operationError(
        operation,
        "unsafeLocation",
        "Source path escapes the repository root",
      )
    }
    const canonicalPath = yield* Effect.tryPromise({
      try: () => realpath(absolutePath),
      catch: (cause) =>
        operationError(
          operation,
          "serverUnavailable",
          `Source file is unavailable: ${String(cause)}`,
        ),
    })
    if (!isContained(canonicalRoot, canonicalPath)) {
      return yield* operationError(
        operation,
        "unsafeLocation",
        "Source file resolves outside the repository root",
      )
    }

    const uri = pathToFileURL(absolutePath).href
    if (!HashSet.has(yield* Ref.get(opened), uri)) {
      const text = yield* Effect.tryPromise({
        try: () => readFile(canonicalPath, "utf8"),
        catch: (cause) =>
          operationError(
            operation,
            "serverUnavailable",
            `Source file could not be read: ${String(cause)}`,
          ),
      })
      yield* client
        .notify("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: Option.getOrElse(HashMap.get(languageIdsByExtension, extname(path)), () =>
              LanguageId.make("typescript"),
            ),
            version: 1,
            text,
          },
        })
        .pipe(Effect.mapError((error) => fromClientError(operation, error)))
      yield* Ref.update(opened, HashSet.add(uri))
    }
    return { uri }
  })

  const definitions: LanguageAdapterSession["definitions"] = Effect.fn(
    "TypeScriptLanguageAdapter.definitions",
  )(
    function* (path, position) {
      const document = yield* prepareDocument(path, "definitions")
      const response = yield* request(
        client,
        "textDocument/definition",
        {
          textDocument: document,
          position: { line: position.line, character: position.character },
        },
        "definitions",
      ).pipe(parseResponse(LspDefinitionResult, "definitions"))
      const rawLocations = Option.match(response, {
        onNone: () => [],
        onSome: (locations) => {
          if (Array.isArray(locations)) return locations
          return [locations]
        },
      })
      const truncated = rawLocations.length > LOCATION_LIMIT
      const locations = yield* Effect.forEach(rawLocations.slice(0, LOCATION_LIMIT), (location) =>
        LspLocationResult.match(location, {
          locationLink: (link) =>
            Effect.gen(function* () {
              const target = yield* locationFromLsp(
                canonicalRoot,
                canonicalRoot,
                LspLocation.make({ uri: link.targetUri, range: link.targetRange }),
                "definitions",
              )
              return RepositoryLanguageLocationLink.make({
                originSelectionRange: Option.map(link.originSelectionRange, rangeFromLsp),
                target,
                targetSelectionRange: rangeFromLsp(link.targetSelectionRange),
              })
            }),
          location: (item) =>
            locationFromLsp(canonicalRoot, canonicalRoot, item, "definitions").pipe(
              Effect.map((target) =>
                RepositoryLanguageLocationLink.make({
                  originSelectionRange: Option.none(),
                  target,
                  targetSelectionRange: target.range,
                }),
              ),
            ),
        }),
      )
      return RepositoryLanguageLocationResult.make({ locations, truncated })
    },
    withTimeout("definitions", OPERATION_TIMEOUT),
  )

  const references: LanguageAdapterSession["references"] = Effect.fn(
    "TypeScriptLanguageAdapter.references",
  )(
    function* (path, position) {
      const document = yield* prepareDocument(path, "references")
      const response = yield* request(
        client,
        "textDocument/references",
        {
          textDocument: document,
          position: { line: position.line, character: position.character },
          context: { includeDeclaration: true },
        },
        "references",
      ).pipe(parseResponse(LspReferenceResult, "references"))
      const rawLocations = Option.getOrElse(response, () => [])
      const locations = yield* Effect.forEach(rawLocations.slice(0, LOCATION_LIMIT), (location) =>
        locationFromLsp(canonicalRoot, canonicalRoot, location, "references").pipe(
          Effect.map((target) =>
            RepositoryLanguageLocationLink.make({
              originSelectionRange: Option.none(),
              target,
              targetSelectionRange: target.range,
            }),
          ),
        ),
      )
      return RepositoryLanguageLocationResult.make({
        locations,
        truncated: rawLocations.length > LOCATION_LIMIT,
      })
    },
    withTimeout("references", OPERATION_TIMEOUT),
  )

  const documentSymbols: LanguageAdapterSession["documentSymbols"] = Effect.fn(
    "TypeScriptLanguageAdapter.documentSymbols",
  )(
    function* (path) {
      const document = yield* prepareDocument(path, "documentSymbols")
      const response = yield* request(
        client,
        "textDocument/documentSymbol",
        { textDocument: document },
        "documentSymbols",
      ).pipe(parseResponse(LspDocumentSymbolResult, "documentSymbols"))
      const nestedSymbols = yield* Effect.forEach(
        Option.getOrElse(response, () => []),
        (symbol) =>
          LspDocumentSymbolItem.match(symbol, {
            documentSymbol: (item) => convertDocumentSymbol(item, Option.none()),
            symbolInformation: (item) =>
              Effect.succeed([
                DocumentLanguageSymbol.make({
                  name: item.name,
                  detail: Option.none(),
                  kind: symbolKind(item.kind),
                  range: rangeFromLsp(item.location.range),
                  selectionRange: rangeFromLsp(item.location.range),
                  containerName: item.containerName,
                }),
              ]),
          }),
      )
      const symbols = EffectArray.flatten(nestedSymbols)
      const truncated = symbols.length > DOCUMENT_SYMBOL_LIMIT
      return DocumentLanguageSymbolResult.make({
        symbols: EffectArray.take(symbols, DOCUMENT_SYMBOL_LIMIT),
        truncated,
      })
    },
    withTimeout("documentSymbols", OPERATION_TIMEOUT),
  )

  const workspaceSymbols: LanguageAdapterSession["workspaceSymbols"] = Effect.fn(
    "TypeScriptLanguageAdapter.workspaceSymbols",
  )(
    function* (query) {
      const response = yield* request(
        client,
        "workspace/symbol",
        { query },
        "workspaceSymbols",
      ).pipe(parseResponse(LspWorkspaceSymbolResult, "workspaceSymbols"))
      const rawSymbols = Option.getOrElse(response, () => [])
      const symbols = yield* Effect.forEach(
        EffectArray.take(rawSymbols, WORKSPACE_SYMBOL_LIMIT),
        (symbol) =>
          locationFromLsp(canonicalRoot, canonicalRoot, symbol.location, "workspaceSymbols").pipe(
            Effect.map((location) =>
              WorkspaceLanguageSymbol.make({
                name: symbol.name,
                kind: symbolKind(symbol.kind),
                containerName: symbol.containerName,
                location,
              }),
            ),
          ),
      )
      return WorkspaceLanguageSymbolResult.make({
        symbols,
        truncated: rawSymbols.length > WORKSPACE_SYMBOL_LIMIT,
      })
    },
    withTimeout("workspaceSymbols", OPERATION_TIMEOUT),
  )

  return { definitions, references, documentSymbols, workspaceSymbols }
})

const request = (
  client: JsonRpcClient,
  method: string,
  params: Schema.Json,
  operation: string,
): Effect.Effect<Schema.Json, LanguageOperationError> =>
  client.request(method, params).pipe(Effect.mapError((error) => fromClientError(operation, error)))

const parseResponse =
  <A>(schema: Schema.ConstraintDecoder<A>, operation: string) =>
  (
    effect: Effect.Effect<Schema.Json, LanguageOperationError>,
  ): Effect.Effect<A, LanguageOperationError> =>
    effect.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() =>
        operationError(
          operation,
          "malformedResponse",
          `Language server returned an invalid ${operation} response`,
        ),
      ),
    )

const withTimeout =
  (operation: string, duration: Duration.Input) =>
  <A>(effect: Effect.Effect<A, LanguageOperationError>): Effect.Effect<A, LanguageOperationError> =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration,
        orElse: () =>
          Effect.fail(
            operationError(operation, "timeout", `Language operation ${operation} timed out`),
          ),
      }),
    )

const locationFromLsp = Effect.fn("TypeScriptLanguageAdapter.locationFromLsp")(
  function* (root: string, canonicalRoot: string, location: LspLocation, operation: string) {
    const url = yield* Effect.try({
      try: () => new URL(location.uri),
      catch: () => LspUriConversionError.make({}),
    })
    if (url.protocol !== "file:") {
      return yield* operationError(
        operation,
        "unsafeLocation",
        "Language server returned a non-file URI",
      )
    }
    const absolutePath = yield* Effect.try({
      try: () => fileURLToPath(url),
      catch: () => LspUriConversionError.make({}),
    })
    if (!isContained(root, absolutePath)) {
      return yield* operationError(
        operation,
        "unsafeLocation",
        "Language server location escapes the repository root",
      )
    }
    const canonicalPath = yield* Effect.tryPromise({
      try: () => realpath(absolutePath),
      catch: () =>
        operationError(operation, "unsafeLocation", "Language server location is unavailable"),
    })
    if (!isContained(canonicalRoot, canonicalPath)) {
      return yield* operationError(
        operation,
        "unsafeLocation",
        "Language server location resolves outside the repository root",
      )
    }
    const repositoryPath = relative(root, absolutePath).replaceAll("\\", "/")
    const path = yield* Schema.decodeUnknownEffect(RepositoryRelativePath)(repositoryPath).pipe(
      Effect.mapError(() =>
        operationError(
          operation,
          "unsafeLocation",
          "Language server returned an unsafe repository path",
        ),
      ),
    )
    return RepositoryLanguageLocation.make({ path, range: rangeFromLsp(location.range) })
  },
  (effect, _root, _canonicalRoot, _location, operation) =>
    effect.pipe(
      Effect.catchTag("LspUriConversionError", () =>
        operationError(operation, "malformedResponse", "Language server returned an invalid URI"),
      ),
    ),
)

const convertDocumentSymbol: (
  symbol: LspDocumentSymbol,
  containerName: Option.Option<string>,
) => Effect.Effect<readonly DocumentLanguageSymbol[], LanguageOperationError> = Effect.fn(
  "TypeScriptLanguageAdapter.convertDocumentSymbol",
)(function* (symbol, containerName) {
  const current = DocumentLanguageSymbol.make({
    name: symbol.name,
    detail: symbol.detail,
    kind: symbolKind(symbol.kind),
    range: rangeFromLsp(symbol.range),
    selectionRange: rangeFromLsp(symbol.selectionRange),
    containerName,
  })
  const children = yield* Effect.forEach(
    Option.getOrElse(symbol.children, () => []),
    (child) =>
      Schema.decodeUnknownEffect(LspDocumentSymbol)(child).pipe(
        Effect.mapError(() =>
          operationError(
            "documentSymbols",
            "malformedResponse",
            "Language server returned an invalid child symbol",
          ),
        ),
        Effect.flatMap((parsed) => convertDocumentSymbol(parsed, Option.some(symbol.name))),
      ),
  )
  return EffectArray.prepend(EffectArray.flatten(children), current)
})

const rangeFromLsp = (range: LspRange): LanguageRange =>
  LanguageRange.make({
    start: LanguagePosition.make({ line: range.start.line, character: range.start.character }),
    end: LanguagePosition.make({ line: range.end.line, character: range.end.character }),
  })

const symbolKind = (kind: number): LanguageSymbolKind =>
  Option.getOrElse(Option.fromNullishOr(symbolKinds[kind - 1]), () => "object")

const isContained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

const packagedAssetTreeHash = (): string =>
  Option.getOrElse(
    Option.fromNullishOr(process.env.DIFFDASH_TYPESCRIPT_LANGUAGE_TREE_SHA256),
    () => "",
  )

const prepareSessionAssets = Effect.fn("TypeScriptLanguageAdapter.prepareSessionAssets")(function* (
  assets: TypeScriptLanguageAdapterAssets,
): Effect.fn.Return<
  TypeScriptLanguageAdapterAssets,
  LanguageOperationError,
  import("effect").Scope.Scope
> {
  if (packagedAssetTreeHash().length === 0) return assets
  const temporaryRoot = yield* Effect.acquireRelease(
    assetVerificationIo(async () => realpath(await mkdtemp(join(tmpdir(), "diffdash-language-")))),
    (path) =>
      Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(Effect.ignore),
  )
  yield* assetVerificationIo(() => chmod(temporaryRoot, 0o700))
  const isolatedRoot = join(temporaryRoot, "typescript")
  yield* assetVerificationIo(() =>
    cp(dirname(dirname(assets.languageServerPath)), isolatedRoot, {
      recursive: true,
      errorOnExist: true,
    }),
  )
  const isolated = TypeScriptLanguageAdapterAssets.make({
    grammarRuntimePath: join(isolatedRoot, "tree-sitter.wasm"),
    grammars: [
      TypeScriptLanguageGrammarAsset.make({
        languageId: LanguageId.make("javascript"),
        wasmPath: join(isolatedRoot, "tree-sitter-javascript.wasm"),
      }),
      TypeScriptLanguageGrammarAsset.make({
        languageId: LanguageId.make("javascriptreact"),
        wasmPath: join(isolatedRoot, "tree-sitter-javascript.wasm"),
      }),
      TypeScriptLanguageGrammarAsset.make({
        languageId: LanguageId.make("typescript"),
        wasmPath: join(isolatedRoot, "tree-sitter-typescript.wasm"),
      }),
      TypeScriptLanguageGrammarAsset.make({
        languageId: LanguageId.make("typescriptreact"),
        wasmPath: join(isolatedRoot, "tree-sitter-tsx.wasm"),
      }),
    ],
    languageServerPath: join(isolatedRoot, "lib", "cli.mjs"),
    languageServerRuntimePath: join(isolatedRoot, "typescript", "lib", "tsserver.js"),
  })
  yield* verifyPackagedAssetTree(isolated)
  return isolated
})

class PackagedAssetFile extends Schema.Class<PackagedAssetFile>("PackagedAssetFile")({
  absolute: Schema.String,
  relativePath: Schema.String,
  size: NonNegativeInteger,
}) {}

const assetVerificationIo = <A>(
  evaluate: () => Promise<A>,
): Effect.Effect<A, LanguageOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: () =>
      operationError(
        "initialize",
        "serverUnavailable",
        "Language server assets failed verification",
      ),
  })

const collectPackagedAssetFiles: (
  directory: string,
  relativeDirectory: string,
) => Effect.Effect<readonly PackagedAssetFile[], LanguageOperationError> = Effect.fn(
  "TypeScriptLanguageAdapter.collectPackagedAssetFiles",
)(function* (
  directory: string,
  relativeDirectory: string,
): Effect.fn.Return<readonly PackagedAssetFile[], LanguageOperationError> {
  const entries = yield* assetVerificationIo(() => readdir(directory, { withFileTypes: true }))
  const nested = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      const absolute = join(directory, entry.name)
      let relativePath = entry.name
      if (relativeDirectory.length > 0) relativePath = `${relativeDirectory}/${entry.name}`
      const canonicalPath = yield* assetVerificationIo(() => realpath(absolute))
      if (canonicalPath !== absolute) {
        return yield* operationError(
          "initialize",
          "serverUnavailable",
          "Language server asset is not canonical",
        )
      }
      if (entry.isDirectory()) {
        return yield* collectPackagedAssetFiles(absolute, relativePath)
      }
      if (!entry.isFile()) {
        return yield* operationError(
          "initialize",
          "serverUnavailable",
          "Language server asset tree contains a non-file entry",
        )
      }
      const metadata = yield* assetVerificationIo(() => stat(absolute))
      const file = yield* Schema.decodeUnknownEffect(PackagedAssetFile)({
        absolute,
        relativePath,
        size: metadata.size,
      }).pipe(
        Effect.mapError(() =>
          operationError(
            "initialize",
            "serverUnavailable",
            "Language server asset metadata is invalid",
          ),
        ),
      )
      return [file]
    }),
  )
  return nested.flat()
})

const verifyPackagedAssetTree = Effect.fn("TypeScriptLanguageAdapter.verifyPackagedAssetTree")(
  function* (
    assets: TypeScriptLanguageAdapterAssets,
  ): Effect.fn.Return<void, LanguageOperationError> {
    const expectedHash = packagedAssetTreeHash()
    if (expectedHash.length === 0) return yield* Effect.void

    const root = dirname(dirname(assets.languageServerPath))
    const canonicalRoot = yield* assetVerificationIo(() => realpath(root))
    if (canonicalRoot !== root) {
      return yield* operationError(
        "initialize",
        "serverUnavailable",
        "Language server asset root is not canonical",
      )
    }
    const files = yield* collectPackagedAssetFiles(root, "")
    const totalBytes = files.reduce((total, file) => total + file.size, 0)
    if (files.length > LANGUAGE_TREE_MAX_FILES || totalBytes > LANGUAGE_TREE_MAX_BYTES) {
      return yield* operationError(
        "initialize",
        "resultTooLarge",
        "Language server asset tree exceeds its integrity bounds",
      )
    }

    const sortedFiles = EffectArray.sortWith(files, (file) => file.relativePath, Order.String)
    const contents = yield* Effect.forEach(sortedFiles, (file) =>
      assetVerificationIo(() => readFile(file.absolute)),
    )
    const hash = createHash("sha256")
    for (const [index, file] of sortedFiles.entries()) {
      const bytes = Option.fromNullishOr(contents[index])
      if (Option.isNone(bytes)) {
        return yield* operationError(
          "initialize",
          "serverUnavailable",
          "Language server asset disappeared during verification",
        )
      }
      hash.update(file.relativePath)
      hash.update("\0")
      hash.update(bytes.value)
    }
    if (hash.digest("hex") !== expectedHash) {
      return yield* operationError(
        "initialize",
        "serverUnavailable",
        "Language server asset integrity mismatch",
      )
    }
    return yield* Effect.void
  },
)

const fromClientError = (operation: string, error: JsonRpcClientError): LanguageOperationError =>
  operationError(operation, error.reason, error.message)

const operationError = (
  operation: string,
  reason: LanguageOperationError["reason"],
  message: string,
): LanguageOperationError => LanguageOperationError.make({ operation, reason, message })
