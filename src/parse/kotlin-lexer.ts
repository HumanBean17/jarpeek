/**
 * Kotlin declaration lexer: turns one .kt source file into ParsedClass records.
 *
 * Same two-layer architecture as the Java lexer: a tokenizer (identifiers
 * including backticked keywords, numbers, strings with raw `"""` forms and
 * `$` template interpolation, char literals, comments) makes brace tracking
 * immune to literal contents, and a declaration state machine walks file and
 * class bodies one member at a time. The Kotlin differences live in the
 * grammar rules: top-level functions and properties are collected into the
 * synthetic file facade class (`Sample.kt` -> `SampleKt`), statements are
 * newline-terminated so initializers stop at the next declaration keyword,
 * and `val`/`var` primary-constructor parameters become property members.
 * Every declaration parse is individually wrapped: one malformed declaration
 * degrades to a diagnostic string, and parseKotlinSource never throws.
 */
import type { Declaration, Visibility } from "../core/types.js";
import type { ParsedClass, SourceFileDeclarations } from "./declarations.js";

type TokenKind = "ident" | "number" | "string" | "char" | "punct";

interface Token {
  kind: TokenKind;
  text: string;
  /** start offset in the source text */
  offset: number;
  /** end offset (exclusive) */
  end: number;
  /** 1-based line */
  line: number;
}

interface JavadocInfo {
  start: number;
  end: number;
  /** 1-based line of the `/**` */
  line: number;
  text: string;
}

interface MemberHeader {
  javadoc?: JavadocInfo;
  annotations: string[];
  modifiers: string[];
  /** first token of the declaration (annotations included, javadoc excluded) */
  start: Token;
}

/** A primary-constructor `val`/`var` parameter, held until the class exists. */
interface CtorProperty {
  selector: string;
  visibility: Visibility;
  signature: string;
  lineStart: number;
  lineEnd: number;
  modifiers: string[];
}

const MODIFIER_KEYWORDS = new Set([
  "public",
  "protected",
  "internal",
  "private",
  "open",
  "abstract",
  "final",
  "sealed",
  "const",
  "lateinit",
  "data",
  "value",
  "inner",
  "companion",
  "enum",
  "annotation",
  "override",
  "suspend",
  "inline",
  "operator",
  "infix",
  "tailrec",
  "external",
  "vararg",
  "noinline",
  "crossinline",
  "expect",
  "actual",
]);

const DECLARATION_KEYWORDS = new Set([
  "fun",
  "val",
  "var",
  "class",
  "object",
  "interface",
  "constructor",
  "init",
  "typealias",
]);

const PARAM_MODIFIERS = new Set([
  "public",
  "protected",
  "internal",
  "private",
  "vararg",
  "noinline",
  "crossinline",
  "override",
]);

const VISIBILITY_KEYWORDS = new Set(["public", "protected", "internal", "private"]);

const isWordChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$]/.test(c);
const isIdent = (t: Token | undefined, text?: string): boolean =>
  !!t && t.kind === "ident" && (text === undefined || t.text === text);
const isPunct = (t: Token | undefined, text: string): boolean =>
  !!t && t.kind === "punct" && t.text === text;

const stripBackticks = (name: string): string => name.replace(/`/g, "");

/** True for names like `Deprecated` or `java.lang.Deprecated`. */
const isDeprecatedAnnotation = (name: string): boolean =>
  (name.split(".").pop() ?? name) === "Deprecated";

const hasJavadocDeprecatedTag = (text: string): boolean => /^\s*\*?\s*@deprecated\b/m.test(text);

/**
 * Join token texts into one normalized type/signature fragment with Kotlin
 * spacing: `,` and `:` get one trailing space, `->` is spaced on both sides,
 * `suspend (` keeps its space, and everything else (`.`, `<`, `>`, `?`, parens)
 * hugs its neighbor.
 */
function joinTokens(tokens: Token[]): string {
  let out = "";
  let prev: string | undefined;
  for (const token of tokens) {
    if (prev !== undefined && spaceBetween(prev, token.text)) out += " ";
    out += token.text;
    prev = token.text;
  }
  return out;
}

function spaceBetween(prev: string, next: string): boolean {
  const p = prev[prev.length - 1];
  const f = next[0];
  if (p === undefined || f === undefined) return false;
  if (isWordChar(p) && isWordChar(f)) return true;
  if (prev === "suspend" && f === "(") return true;
  if (f === ":" && isWordChar(p)) return true; // `<T : Any>` keeps its inner spaces
  if (p === "," || p === ":") return f !== ")" && f !== ",";
  if (next === "->" && p !== "(") return true;
  return prev === "->";
}

/** True when the token can be the last token of an expression. */
function endsExpression(t: Token): boolean {
  if (t.kind !== "punct") return true;
  return t.text === ")" || t.text === "]" || t.text === "}" || t.text === "?";
}

/**
 * The facade class name for a file: base name sanitized to [A-Za-z0-9_]+ plus
 * `Kt` (`Sample.kt` -> `SampleKt`, `weird-name 2.kt` -> `weird_name_2Kt`).
 */
function facadeBaseName(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.kts?$/i, "");
  const sanitized = base.replace(/[^A-Za-z0-9_]/g, "_");
  return sanitized.length > 0 ? sanitized : "File";
}

function tokenize(text: string): { tokens: Token[]; javadocs: JavadocInfo[] } {
  const tokens: Token[] = [];
  const javadocs: JavadocInfo[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;

  const push = (kind: TokenKind, start: number, end: number): void => {
    tokens.push({ kind, text: text.slice(start, end), offset: start, end, line });
  };

  /**
   * Skip one string literal (plain or raw `"""`). `$` templates switch to an
   * expression frame so braces and nested strings inside `${...}` never end
   * the literal early; the whole literal becomes one inert token. A raw
   * literal may span lines, but a plain one (or a `${...}` template inside
   * one) legally cannot — so when a plain frame is still open at a line
   * break, the literal ends there: one unterminated string costs one
   * declaration, not the rest of the file.
   */
  const skipString = (): void => {
    const raw = text[i + 1] === '"' && text[i + 2] === '"';
    const frames: { kind: "str" | "raw" | "expr"; depth: number }[] = [
      { kind: raw ? "raw" : "str", depth: 0 },
    ];
    i += raw ? 3 : 1;
    while (i < n && frames.length > 0) {
      const c = text[i]!;
      const top = frames[frames.length - 1]!;
      if (c === "\n" || c === "\r") {
        if (frames.some((frame) => frame.kind === "str")) break; // unterminated plain string
        line++;
        i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
        continue;
      }
      if (top.kind === "expr") {
        if (c === "{") {
          top.depth++;
          i++;
        } else if (c === "}") {
          top.depth--;
          i++;
          if (top.depth <= 0) frames.pop();
        } else if (c === "$" && text[i + 1] === "{") {
          frames.push({ kind: "expr", depth: 0 });
          i += 2;
        } else if (c === '"') {
          const innerRaw = text[i + 1] === '"' && text[i + 2] === '"';
          frames.push({ kind: innerRaw ? "raw" : "str", depth: 0 });
          i += innerRaw ? 3 : 1;
        } else if (c === "'") {
          i++;
          while (i < n && text[i] !== "'" && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
          if (text[i] === "'") i++;
        } else {
          i++;
        }
      } else if (top.kind === "str") {
        if (c === "\\" && i + 1 < n) {
          i += 2;
        } else if (c === '"') {
          i++;
          frames.pop();
        } else if (c === "$" && text[i + 1] === "{") {
          frames.push({ kind: "expr", depth: 0 });
          i += 2;
        } else if (c === "$" && isWordChar(text[i + 1])) {
          i += 2;
          while (i < n && isWordChar(text[i])) i++;
        } else {
          i++;
        }
      } else {
        if (c === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
          i += 3;
          frames.pop();
        } else if (c === "$" && text[i + 1] === "{") {
          frames.push({ kind: "expr", depth: 0 });
          i += 2;
        } else if (c === "$" && isWordChar(text[i + 1])) {
          i += 2;
          while (i < n && isWordChar(text[i])) i++;
        } else {
          i++;
        }
      }
    }
  };

  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === "\r") {
      line++;
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const start = i;
      const startLine = line;
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n" || (text[i] === "\r" && text[i + 1] !== "\n")) line++;
        i++;
      }
      const end = i < n ? i + 2 : n;
      i = end;
      const body = text.slice(start, end);
      if (body.startsWith("/**") && body !== "/**/") {
        javadocs.push({ start, end, line: startLine, text: body });
      }
      continue;
    }
    if (c === '"') {
      const start = i;
      skipString();
      push("string", start, i);
      continue;
    }
    if (c === "'") {
      const start = i;
      i++;
      while (i < n && text[i] !== "'" && text[i] !== "\n" && i - start < 12) {
        i += text[i] === "\\" ? 2 : 1;
      }
      if (text[i] === "'") i++;
      push("char", start, i);
      continue;
    }
    if (c === "`") {
      const start = i;
      i++;
      while (i < n && text[i] !== "`" && text[i] !== "\n") i++;
      if (text[i] === "`") i++;
      push("ident", start, i);
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      i++;
      while (i < n) {
        const d = text[i]!;
        if (/[0-9A-Za-z_.]/.test(d)) {
          i++;
        } else if ((d === "+" || d === "-") && /[eEpP]/.test(text[i - 1] ?? "")) {
          i++;
        } else {
          break;
        }
      }
      push("number", start, i);
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      i++;
      while (i < n && /[A-Za-z0-9_$]/.test(text[i]!)) i++;
      push("ident", start, i);
      continue;
    }
    if ((c === "-" && text[i + 1] === ">") || (c === ":" && text[i + 1] === ":")) {
      push("punct", i, i + 2);
      i += 2;
      continue;
    }
    push("punct", i, i + 1);
    i++;
  }
  return { tokens, javadocs };
}

/** Thrown by per-declaration parse helpers; callers convert it to a diagnostic. */
class ParseProblem extends Error {}

class Parser {
  private readonly tokens: Token[];
  private readonly javadocs: JavadocInfo[];
  private readonly result: SourceFileDeclarations;
  private readonly fileBase: string;
  private facade: ParsedClass | null = null;
  /** next unconsumed javadoc — consumed strictly in source order */
  private javadocIdx = 0;
  private pos = 0;

  constructor(tokens: Token[], javadocs: JavadocInfo[], result: SourceFileDeclarations, file: string) {
    this.tokens = tokens;
    this.javadocs = javadocs;
    this.result = result;
    this.fileBase = facadeBaseName(file);
  }

  parseFile(): void {
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]!;
      if (isIdent(t, "package")) {
        this.pos++;
        this.result.pkg = this.readDottedName();
        this.finishLine();
      } else if (isIdent(t, "import")) {
        this.result.imports.push(this.readImportStatement());
      } else if (isIdent(t, "typealias")) {
        this.finishLine();
      } else if (isPunct(t, ";")) {
        this.pos++;
      } else {
        const before = this.pos;
        this.parseTopLevelDeclaration();
        if (this.pos === before) this.pos++; // hard progress guarantee
      }
    }
  }

  private peek(k = 0): Token | undefined {
    return this.tokens[this.pos + k];
  }

  private lastLine(): number {
    return this.tokens.length > 0 ? this.tokens[this.tokens.length - 1]!.line : 1;
  }

  private lastConsumedLine(): number {
    return this.pos > 0 ? this.tokens[this.pos - 1]!.line : 1;
  }

  private readDottedName(): string {
    const parts: string[] = [];
    while (isIdent(this.peek()) && parts.length < 128) {
      parts.push(this.peek()!.text);
      this.pos++;
      if (isPunct(this.peek(), ".")) {
        this.pos++;
      } else {
        break;
      }
    }
    return parts.join(".");
  }

  /** Consume the rest of a newline-terminated statement (package/import/typealias). */
  private finishLine(): void {
    const line = this.lastConsumedLine();
    while (
      this.pos < this.tokens.length &&
      this.tokens[this.pos]!.line === line &&
      !isPunct(this.tokens[this.pos], ";")
    ) {
      this.pos++;
    }
    if (isPunct(this.peek(), ";")) this.pos++;
  }

  /**
   * Consume one `import a.b.C as D` statement starting at its `import`
   * keyword and return it verbatim (whitespace-normalized, no semicolon —
   * Kotlin imports are newline-terminated; a rare trailing `;` is consumed
   * but kept out of the text). The keyword is consumed first, so even a
   * stray `import` on its own line advances — the old branch delegated to
   * finishLine before consuming anything and looped forever.
   */
  private readImportStatement(): string {
    const parts: Token[] = [this.tokens[this.pos]!];
    this.pos++;
    const line = parts[0]!.line;
    while (
      this.pos < this.tokens.length &&
      this.tokens[this.pos]!.line === line &&
      !isPunct(this.tokens[this.pos], ";")
    ) {
      parts.push(this.tokens[this.pos]!);
      this.pos++;
    }
    if (isPunct(this.peek(), ";")) this.pos++;
    return joinTokens(parts);
  }

  /** Consume a balanced `(...)` group (annotation arguments, accessor parameters). */
  private skipParenGroup(): void {
    if (!isPunct(this.peek(), "(")) return;
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]!;
      this.pos++;
      if (t.text === "(") depth++;
      else if (t.text === ")") {
        depth--;
        if (depth === 0) return;
      }
    }
  }

  /**
   * Consume an explicit primary-constructor keyword with its leading
   * annotations and visibility modifiers (`class Solo private
   * constructor(x: Int)`), leaving pos at the `(`. Restores pos when no
   * `constructor` keyword follows, so ordinary class headers are untouched.
   */
  private skipExplicitCtorKeyword(): void {
    const save = this.pos;
    for (;;) {
      const t = this.peek();
      if (t !== undefined && isPunct(t, "@") && this.peek(1) !== undefined) {
        this.pos++;
        // use-site target such as `field:` between @ and the name
        if (isIdent(this.peek()) && isPunct(this.peek(1), ":")) this.pos += 2;
        this.readDottedName();
        this.skipParenGroup();
        continue;
      }
      if (t !== undefined && isIdent(t) && VISIBILITY_KEYWORDS.has(t.text)) {
        this.pos++;
        continue;
      }
      break;
    }
    if (!isIdent(this.peek(), "constructor")) {
      this.pos = save;
      return;
    }
    this.pos++; // the constructor keyword itself
  }

  /** Consume annotations and visibility modifiers preceding an accessor keyword. */
  private skipAccessorPrefix(): void {
    for (;;) {
      const t = this.peek();
      if (t !== undefined && isPunct(t, "@") && this.peek(1) !== undefined) {
        this.pos++;
        // use-site target such as `set:` between @ and the name
        if (isIdent(this.peek()) && isPunct(this.peek(1), ":")) this.pos += 2;
        this.readDottedName();
        this.skipParenGroup();
        continue;
      }
      if (t !== undefined && isIdent(t) && VISIBILITY_KEYWORDS.has(t.text)) {
        this.pos++;
        continue;
      }
      return;
    }
  }

  /**
   * Skip a `{...}` block (function body, accessor body, initializer) starting
   * at the current `{`. Returns the closing `}` token, or null at EOF.
   */
  private skipBraceBlock(): Token | null {
    if (!isPunct(this.peek(), "{")) return null;
    const open = this.peek()!;
    this.pos++;
    let depth = 1;
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]!;
      this.pos++;
      if (t.text === "{") depth++;
      else if (t.text === "}") {
        depth--;
        if (depth === 0) return t;
      }
    }
    this.result.diagnostics.push(`unbalanced braces at line ${open.line}: block is never closed`);
    return null;
  }

  /**
   * Consume a balanced `<...>` group (type parameters or type arguments) and
   * return its tokens including the angle brackets. Bails out without
   * consuming when a declaration terminator shows up first.
   */
  private skipAngleGroup(): Token[] {
    const out: Token[] = [];
    if (!isPunct(this.peek(), "<")) return out;
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]!;
      if (t.text === ";" || t.text === "{" || t.text === "}" || t.text === "=") return out;
      this.pos++;
      out.push(t);
      if (t.text === "<") depth++;
      else if (t.text === ">") {
        depth--;
        if (depth === 0) return out;
      }
    }
    return out;
  }

  /** Consume a balanced `(...)` group and return its tokens including the parens. */
  private parenTokens(): Token[] {
    const out: Token[] = [];
    if (!isPunct(this.peek(), "(")) return out;
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]!;
      this.pos++;
      out.push(t);
      if (t.text === "(") depth++;
      else if (t.text === ")") {
        depth--;
        if (depth === 0) return out;
      }
    }
    return out;
  }

  /** The javadoc sitting directly above the declaration starting at `startOffset`. */
  private takeJavadoc(prevEnd: number, startOffset: number): JavadocInfo | undefined {
    while (this.javadocIdx < this.javadocs.length && this.javadocs[this.javadocIdx]!.end <= prevEnd) {
      this.javadocIdx++;
    }
    let found: JavadocInfo | undefined;
    while (
      this.javadocIdx < this.javadocs.length &&
      this.javadocs[this.javadocIdx]!.start >= prevEnd &&
      this.javadocs[this.javadocIdx]!.end <= startOffset
    ) {
      found = this.javadocs[this.javadocIdx]!;
      this.javadocIdx++;
    }
    return found;
  }

  /** Collect the leading annotations and modifiers of a declaration. */
  private collectHeader(): MemberHeader {
    const startIdx = this.pos;
    const start = this.peek()!;
    const prevEnd = startIdx > 0 ? this.tokens[startIdx - 1]!.end : 0;
    const header: MemberHeader = {
      annotations: [],
      modifiers: [],
      start,
      javadoc: this.takeJavadoc(prevEnd, start.offset),
    };
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (isPunct(t, "@") && this.peek(1) !== undefined) {
        this.pos++;
        // use-site target such as `file:` or `get:` between @ and the name
        if (isIdent(this.peek()) && isPunct(this.peek(1), ":")) this.pos += 2;
        const name = this.readDottedName();
        this.skipParenGroup();
        if (name.length > 0) header.annotations.push(name);
        continue;
      }
      if (isIdent(t) && !t.text.startsWith("`") && MODIFIER_KEYWORDS.has(t.text)) {
        header.modifiers.push(t.text);
        this.pos++;
        continue;
      }
      break;
    }
    return header;
  }

  private visibilityOf(modifiers: string[]): Visibility {
    if (modifiers.includes("public")) return "public";
    if (modifiers.includes("protected")) return "protected";
    if (modifiers.includes("private")) return "private";
    if (modifiers.includes("internal")) return "package"; // internal == JVM package-private-ish
    return "public"; // Kotlin's default visibility
  }

  private deprecatedOf(header: MemberHeader): boolean {
    return (
      header.annotations.some(isDeprecatedAnnotation) ||
      (header.javadoc !== undefined && hasJavadocDeprecatedTag(header.javadoc.text))
    );
  }

  /** Lazily create the file facade that owns top-level functions and properties. */
  private ensureFacade(): ParsedClass {
    if (this.facade === null) {
      const base = this.fileBase;
      this.facade = {
        fqn: this.result.pkg ? `${this.result.pkg}.${base}Kt` : `${base}Kt`,
        kind: "class",
        visibility: "public",
        static: false,
        deprecated: false,
        signature: `class ${base}Kt`,
        lineStart: 1,
        lineEnd: 1,
        members: [],
      };
      this.result.classes.unshift(this.facade);
    }
    return this.facade;
  }

  private updateFacadeSpan(facade: ParsedClass, lineStart: number, lineEnd: number | undefined): void {
    facade.lineStart = Math.min(facade.lineStart, lineStart);
    facade.lineEnd = Math.max(facade.lineEnd, lineEnd ?? lineStart);
  }

  private isClassKindKeyword(t: Token | undefined): boolean {
    return isIdent(t, "class") || isIdent(t, "interface") || isIdent(t, "object");
  }

  private parseTopLevelDeclaration(): void {
    const startLine = this.peek()?.line ?? this.lastLine();
    try {
      const header = this.collectHeader();
      const kw = this.peek();
      if (kw !== undefined && isIdent(kw, "package")) {
        // file annotations preceded the package statement
        this.pos++;
        this.result.pkg = this.readDottedName();
        this.finishLine();
        return;
      }
      if (kw !== undefined && isIdent(kw, "import")) {
        this.result.imports.push(this.readImportStatement());
        return;
      }
      if (kw === undefined) return;
      if (this.isClassKindKeyword(kw)) {
        this.parseClassDeclaration(null, header, kw.text as "class" | "interface" | "object", false);
      } else if (isIdent(kw, "fun") && isIdent(this.peek(1), "interface")) {
        this.pos++; // `fun` is a modifier here; `interface` is the kind keyword
        header.modifiers.push("fun");
        this.parseClassDeclaration(null, header, "interface", false);
      } else if (isIdent(kw, "fun")) {
        const facade = this.ensureFacade();
        const m = this.parseFunction(facade, header, true);
        this.updateFacadeSpan(facade, header.start.line, m.lineEnd);
      } else if (isIdent(kw, "val") || isIdent(kw, "var")) {
        const facade = this.ensureFacade();
        const m = this.parseProperty(facade, header, true);
        this.updateFacadeSpan(facade, header.start.line, m.lineEnd);
      } else {
        this.result.diagnostics.push(
          `expected declaration at line ${kw.line}, found '${kw.text}'`,
        );
        this.recover();
      }
    } catch (e) {
      this.result.diagnostics.push(
        `failed to parse declaration at line ${startLine}: ${(e as Error).message}`,
      );
      this.recover();
    }
  }

  /** Parse `class|interface|object Name <T> (primary ctor)? : supertypes { body }`. */
  private parseClassDeclaration(
    parent: ParsedClass | null,
    header: MemberHeader,
    kindKeyword: "class" | "interface" | "object",
    parentStatic: boolean,
  ): void {
    const kwLine = this.peek()!.line;
    this.pos++; // class | interface | object
    const isCompanion = header.modifiers.includes("companion");
    let name: string;
    if (isIdent(this.peek())) {
      name = stripBackticks(this.peek()!.text);
      this.pos++;
    } else if (kindKeyword === "object") {
      name = "Companion"; // an anonymous `companion object` has no name
    } else {
      this.result.diagnostics.push(`class declaration is missing a name at line ${kwLine}`);
      this.skipBraceBlock();
      return;
    }
    const typeParamTokens = isPunct(this.peek(), "<") ? this.skipAngleGroup() : [];
    // `class Solo private constructor(x: Int)` — the explicit keyword (with
    // modifiers/annotations) precedes the parameter list
    this.skipExplicitCtorKeyword();
    // primary constructor: plain params feed the signature, val/var params
    // become property members
    const primary = isPunct(this.peek(), "(")
      ? this.parsePrimaryCtor()
      : { paramTypes: [] as string[], properties: [] as CtorProperty[], explicit: false };
    if (isPunct(this.peek(), ":") || isIdent(this.peek(), "where")) this.skipToBody();

    const kind = header.modifiers.includes("enum")
      ? "enum"
      : header.modifiers.includes("annotation")
        ? "annotation"
        : kindKeyword === "object"
          ? "object"
          : kindKeyword;
    // enum/annotation/companion are expressed through kind and the signature
    // keyword, not repeated in modifiers
    const recordedModifiers = header.modifiers.filter(
      (m) => m !== "enum" && m !== "annotation",
    );
    const sigModifiers = recordedModifiers.filter((m) => m !== "companion");
    const sigKeyword =
      kind === "enum"
        ? "enum class"
        : kind === "annotation"
          ? "annotation class"
          : kindKeyword === "object"
            ? isCompanion
              ? "companion object"
              : "object"
            : kindKeyword;
    const typeParamsSig = typeParamTokens.length > 0 ? joinTokens(typeParamTokens) : "";
    const primarySig =
      primary.paramTypes.length > 0 || primary.explicit ? `(${primary.paramTypes.join(",")})` : "";
    const signature = [...sigModifiers, `${sigKeyword} ${name}${typeParamsSig}${primarySig}`]
      .filter((s) => s.length > 0)
      .join(" ");

    const fqn = parent
      ? `${parent.fqn}.${name}`
      : this.result.pkg
        ? `${this.result.pkg}.${name}`
        : name;
    const cls: ParsedClass = {
      fqn,
      kind,
      visibility: this.visibilityOf(header.modifiers),
      // nested objects are static; anything nested in an interface is too
      // (JVM ACC_STATIC — kotlinc marks it, so the class-file reader and this
      // lexer must agree); otherwise inherit the enclosing static context
      static:
        parent !== null &&
        (kindKeyword === "object" || parentStatic || parent.kind === "interface"),
      deprecated: this.deprecatedOf(header),
      signature,
      lineStart: header.start.line,
      lineEnd: this.lastConsumedLine(),
      ...(header.javadoc ? { javadocStart: header.javadoc.line, javadoc: header.javadoc.text } : {}),
      members: [],
    };
    this.result.classes.push(cls);
    if (parent) {
      parent.members.push({
        fqn: parent.fqn,
        file: this.result.file,
        selector: name,
        kind,
        visibility: cls.visibility,
        static: cls.static,
        deprecated: cls.deprecated,
        signature,
        lineStart: cls.lineStart,
        lineEnd: cls.lineEnd,
        ...(header.javadoc ? { javadocStart: header.javadoc.line, javadoc: header.javadoc.text } : {}),
        ...(recordedModifiers.length > 0 ? { modifiers: recordedModifiers } : {}),
      });
    }
    for (const p of primary.properties) {
      cls.members.push({
        fqn: cls.fqn,
        file: this.result.file,
        selector: p.selector,
        kind: "property",
        visibility: p.visibility,
        static: false,
        deprecated: false,
        signature: p.signature,
        lineStart: p.lineStart,
        lineEnd: p.lineEnd,
        ...(p.modifiers.length > 0 ? { modifiers: p.modifiers } : {}),
      });
    }

    if (isPunct(this.peek(), ";")) {
      cls.lineEnd = this.peek()!.line;
      this.pos++;
      return;
    }
    const open = this.peek();
    if (open === undefined || !isPunct(open, "{")) return; // body-less class is legal
    this.parseClassBody(cls, open, kindKeyword === "object");
  }

  /**
   * Split a `(...)` parameter list into per-parameter token groups, consuming
   * the parens. Commas inside nested parens, generics, or braces do not
   * split — braces because a default value may be a lambda literal whose
   * parameter list has its own commas (`= { a, b -> ... }`).
   */
  private paramGroups(): Token[][] {
    if (!isPunct(this.peek(), "(")) return [];
    this.pos++;
    const groups: Token[][] = [[]];
    let parenDepth = 0;
    let angleDepth = 0;
    let braceDepth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.text === "(") parenDepth++;
      else if (t.text === ")") {
        if (parenDepth === 0) {
          this.pos++;
          break;
        }
        parenDepth--;
      } else if (t.text === "<") angleDepth++;
      else if (t.text === ">") angleDepth = Math.max(0, angleDepth - 1);
      else if (t.text === "{") braceDepth++;
      else if (t.text === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (t.text === "," && parenDepth === 0 && angleDepth === 0 && braceDepth === 0) {
        this.pos++;
        groups.push([]);
        continue;
      }
      this.pos++;
      groups[groups.length - 1]!.push(t);
    }
    return groups.filter((g) => g.length > 0);
  }

  /** Consume the parameter list and return the normalized parameter type strings. */
  private parseParamList(): string[] {
    return this.paramGroups()
      .map((g) => {
        const p = this.splitParam(g);
        return [p.mods.join(" "), p.typeSig].filter((s) => s.length > 0).join(" ");
      })
      .filter((s) => s.length > 0);
  }

  /**
   * Parse a primary-constructor parameter list: plain params feed the class
   * signature, `val`/`var` params additionally become property members.
   */
  private parsePrimaryCtor(): {
    paramTypes: string[];
    properties: CtorProperty[];
    /** true when a parameter list was written at all (`class Foo()`) */
    explicit: boolean;
  } {
    const paramTypes: string[] = [];
    const properties: CtorProperty[] = [];
    const groups = this.paramGroups();
    for (const group of groups) {
      const p = this.splitParam(group);
      paramTypes.push([p.mods.join(" "), p.typeSig].filter((s) => s.length > 0).join(" "));
      if (p.kw !== undefined && p.name !== undefined) {
        properties.push({
          selector: p.name,
          visibility: this.visibilityOf(p.mods),
          signature:
            `${[...p.mods, p.kw].filter(Boolean).join(" ")} ${p.name}` +
            `${p.typeSig !== "" ? `: ${p.typeSig}` : ""}`.trim(),
          lineStart: p.lineStart,
          lineEnd: p.lineEnd,
          modifiers: p.mods,
        });
      }
    }
    return { paramTypes, properties, explicit: true };
  }

  /**
   * Decompose one parameter group: annotations and the default value are
   * dropped, `val`/`var` is flagged, and the declared type is normalized.
   */
  private splitParam(group: Token[]): {
    mods: string[];
    kw?: "val" | "var";
    name?: string;
    typeSig: string;
    lineStart: number;
    lineEnd: number;
  } {
    const lineStart = group[0]?.line ?? this.lastLine();
    const lineEnd = group[group.length - 1]?.line ?? lineStart;
    let toks = this.stripAnnotations(group);
    // drop `= default value` — commas and parens inside it are already inert
    let depth = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (depth === 0 && isPunct(t, "=")) {
        toks = toks.slice(0, i);
        break;
      }
      if (t.text === "(" || t.text === "[" || t.text === "{" || t.text === "<") depth++;
      else if (t.text === ")" || t.text === "]" || t.text === "}" || t.text === ">") {
        depth = Math.max(0, depth - 1);
      }
    }
    // split head (modifiers, optional val/var, name) from the type at the
    // top-level `:`
    let colonIdx = -1;
    depth = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (depth === 0 && isPunct(t, ":")) {
        colonIdx = i;
        break;
      }
      if (t.text === "(" || t.text === "[" || t.text === "{" || t.text === "<") depth++;
      else if (t.text === ")" || t.text === "]" || t.text === "}" || t.text === ">") {
        depth = Math.max(0, depth - 1);
      }
    }
    const head = colonIdx >= 0 ? toks.slice(0, colonIdx) : toks;
    let type = colonIdx >= 0 ? toks.slice(colonIdx + 1) : [];

    const mods: string[] = [];
    let i = 0;
    while (i < head.length && isIdent(head[i]) && PARAM_MODIFIERS.has(head[i]!.text)) {
      mods.push(head[i]!.text);
      i++;
    }
    let kw: "val" | "var" | undefined;
    if (isIdent(head[i], "val") || isIdent(head[i], "var")) {
      kw = head[i]!.text as "val" | "var";
      i++;
    }
    let name: string | undefined;
    if (i < head.length && isIdent(head[i])) {
      name = stripBackticks(head[i]!.text);
      i++;
    }
    if (colonIdx < 0 && name !== undefined && i > 1) {
      type = head.slice(0, i - 1); // `Type name` without a colon — tolerate
    }
    return { mods, kw, name, typeSig: joinTokens(type), lineStart, lineEnd };
  }

  private stripAnnotations(tokens: Token[]): Token[] {
    const kept: Token[] = [];
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (isPunct(t, "@") && tokens[i + 1] !== undefined) {
        i += 2; // @ + first name segment
        while (i < tokens.length && (isIdent(tokens[i]) || isPunct(tokens[i], "."))) i++;
        if (isPunct(tokens[i], "(")) {
          let d = 0;
          while (i < tokens.length) {
            if (tokens[i]!.text === "(") d++;
            else if (tokens[i]!.text === ")") {
              d--;
              if (d === 0) {
                i++;
                break;
              }
            }
            i++;
          }
        }
        continue;
      }
      kept.push(t);
      i++;
    }
    return kept;
  }

  /**
   * Consume a supertype/delegation/where clause, stopping before the body `{`,
   * after a `;`, at an enclosing `}`, or at a token that clearly starts the
   * next declaration.
   */
  private skipToBody(): void {
    let last = this.tokens[this.pos - 1];
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]!;
      if (depth === 0 && isPunct(t, "{")) return;
      if (depth === 0 && (isPunct(t, ";") || isPunct(t, "}"))) {
        if (isPunct(t, ";")) this.pos++;
        return;
      }
      if (depth === 0 && last !== undefined && this.atMemberBoundary(last, t)) return;
      this.pos++;
      last = t;
      if (t.text === "(" || t.text === "[" || t.text === "{") depth++;
      else if (t.text === ")" || t.text === "]" || t.text === "}") depth = Math.max(0, depth - 1);
    }
  }

  /**
   * Consume an initializer or expression body up to its real end: a depth-0
   * `;` or `}`, or the next declaration keyword on a fresh line after a token
   * that can complete an expression. Kotlin has no semicolons, so the newline
   * rule is what terminates `val x = 10` before `fun next()` while keeping
   * `foo()\n.bar()` chains together.
   */
  private skipInitializer(): number {
    let last = this.tokens[this.pos - 1];
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]!;
      if (depth === 0 && (isPunct(t, ";") || isPunct(t, "}"))) {
        if (isPunct(t, ";")) this.pos++;
        return last?.line ?? this.lastLine();
      }
      if (depth === 0 && last !== undefined && this.atMemberBoundary(last, t)) {
        return last.line;
      }
      this.pos++;
      last = t;
      if (t.text === "(" || t.text === "[" || t.text === "{") depth++;
      else if (t.text === ")" || t.text === "]" || t.text === "}") depth = Math.max(0, depth - 1);
    }
    return last !== undefined ? last.line : this.lastLine();
  }

  private atMemberBoundary(prev: Token, t: Token): boolean {
    return t.line > prev.line && endsExpression(prev) && this.isDeclStart(t);
  }

  private isDeclStart(t: Token): boolean {
    return (
      isPunct(t, "@") ||
      (isIdent(t) &&
        !t.text.startsWith("`") &&
        (DECLARATION_KEYWORDS.has(t.text) || MODIFIER_KEYWORDS.has(t.text)))
    );
  }

  /**
   * Consume exactly one type reference: a name with optional generic
   * arguments, a parenthesized function type (with `suspend`), nullability
   * markers, and `->` chains. Stops before a receiver dot followed by a name
   * so callers can tell `String.shout` apart from a plain name.
   */
  private parseTypeTokens(): Token[] {
    const out: Token[] = [];
    for (;;) {
      const t = this.peek();
      if (t === undefined) break;
      if (isPunct(t, "(")) {
        out.push(...this.parenTokens());
      } else if (isIdent(t, "suspend") && isPunct(this.peek(1), "(")) {
        out.push(t);
        this.pos++;
        continue; // the parenthesized function type follows
      } else if (isIdent(t)) {
        out.push(t);
        this.pos++;
        if (isPunct(this.peek(), "<")) out.push(...this.skipAngleGroup());
      } else {
        break;
      }
      while (isPunct(this.peek(), "?")) {
        out.push(this.peek()!);
        this.pos++;
      }
      const dot = this.peek();
      if (dot !== undefined && isPunct(dot, ".") && isPunct(this.peek(1), "(")) {
        out.push(dot); // receiver-typed function type: T.(A) -> B
        this.pos++;
        continue;
      }
      if (isPunct(this.peek(), "->")) {
        out.push(this.peek()!);
        this.pos++;
        continue;
      }
      break;
    }
    return out;
  }

  /**
   * After a leading type read, decide whether it was the declaration name or
   * an extension receiver: a following `. name` makes it the receiver.
   */
  private parseCallableName(
    typeTokens: Token[],
  ): { receiver?: string; name?: { raw: string; plain: string } } {
    if (isPunct(this.peek(), ".") && isIdent(this.peek(1))) {
      if (typeTokens.length === 0) return {};
      const receiver = joinTokens(typeTokens);
      this.pos++; // the dot
      const t = this.peek()!;
      this.pos++;
      return { receiver, name: { raw: t.text, plain: stripBackticks(t.text) } };
    }
    if (typeTokens.length === 1 && isIdent(typeTokens[0])) {
      return { name: { raw: typeTokens[0]!.text, plain: stripBackticks(typeTokens[0]!.text) } };
    }
    if (typeTokens.length === 0) {
      const t = this.peek();
      if (t === undefined || !isIdent(t)) return {};
      this.pos++;
      return { name: { raw: t.text, plain: stripBackticks(t.text) } };
    }
    return {};
  }

  /** Consume the declaration tail: `{ body }`, `= expression`, `;`, or nothing. */
  private parseTail(): number {
    if (isPunct(this.peek(), "{")) {
      const close = this.skipBraceBlock();
      return close ? close.line : this.lastLine();
    }
    if (isPunct(this.peek(), "=")) {
      this.pos++;
      return this.skipInitializer();
    }
    if (isPunct(this.peek(), ";")) {
      const semi = this.peek()!;
      this.pos++;
      return semi.line;
    }
    return this.lastConsumedLine();
  }

  private pushMember(
    owner: ParsedClass,
    header: MemberHeader,
    rec: Omit<Declaration, "fqn" | "file" | "deprecated">,
  ): Declaration {
    const decl: Declaration = {
      fqn: owner.fqn,
      file: this.result.file,
      deprecated: this.deprecatedOf(header),
      ...rec,
    };
    owner.members.push(decl);
    return decl;
  }

  private parseFunction(owner: ParsedClass, header: MemberHeader, staticCtx: boolean): Declaration {
    this.pos++; // fun
    const typeParamTokens = isPunct(this.peek(), "<") ? this.skipAngleGroup() : [];
    if (typeParamTokens.some((t) => isIdent(t, "reified"))) header.modifiers.push("reified");
    const { receiver, name } = this.parseCallableName(this.parseTypeTokens());
    if (name === undefined) {
      throw new ParseProblem(`expected a function name at line ${this.lastConsumedLine()}`);
    }
    const params = this.parseParamList();
    let returnType = "";
    if (isPunct(this.peek(), ":")) {
      this.pos++;
      returnType = joinTokens(this.parseTypeTokens());
    }
    if (isIdent(this.peek(), "where")) this.skipToBody();
    const lineEnd = this.parseTail();
    const sigModifiers = header.modifiers.filter((m) => m !== "reified");
    const head = [
      sigModifiers.join(" "),
      "fun",
      typeParamTokens.length > 0 ? joinTokens(typeParamTokens) : "",
    ]
      .filter((s) => s.length > 0)
      .join(" ");
    const signature =
      `${head} ${receiver !== undefined ? receiver + "." : ""}${name.raw}(${params.join(", ")})` +
      `${returnType !== "" ? `: ${returnType}` : ""}`.trim();
    return this.pushMember(owner, header, {
      selector: name.plain,
      kind: "method",
      visibility: this.visibilityOf(header.modifiers),
      static: staticCtx,
      signature,
      lineStart: header.start.line,
      lineEnd,
      ...(header.javadoc ? { javadocStart: header.javadoc.line, javadoc: header.javadoc.text } : {}),
      ...(receiver !== undefined ? { receiverType: receiver } : {}),
      ...(header.modifiers.length > 0 ? { modifiers: header.modifiers } : {}),
      ...platformOf(header),
    });
  }

  private parseProperty(owner: ParsedClass, header: MemberHeader, staticCtx: boolean): Declaration {
    const kwText = this.peek()!.text; // val | var
    this.pos++;
    const { receiver, name } = this.parseCallableName(this.parseTypeTokens());
    if (name === undefined) {
      throw new ParseProblem(`expected a property name at line ${this.lastConsumedLine()}`);
    }
    let typeSig = "";
    if (isPunct(this.peek(), ":")) {
      this.pos++;
      typeSig = joinTokens(this.parseTypeTokens());
    }
    let lineEnd = this.lastConsumedLine();
    if (isPunct(this.peek(), "=")) {
      this.pos++;
      lineEnd = this.skipInitializer();
    } else if (isIdent(this.peek(), "by")) {
      this.pos++;
      lineEnd = this.skipInitializer();
    }
    // custom accessors do not create separate members; they extend lineEnd.
    // Accessors may carry modifiers/annotations (`private set`, `@Inject set`)
    // or be bare (`private set` with no explicit body)
    for (;;) {
      const t = this.peek();
      if (t === undefined) break;
      if (isIdent(t, "get") || isIdent(t, "set")) {
        const after = this.peek(1);
        const hasBody =
          after !== undefined &&
          (isPunct(after, "(") || isPunct(after, "=") || isPunct(after, "{"));
        // a bare accessor ends at a newline, `;`, `}`, or EOF
        const bare =
          after === undefined || isPunct(after, ";") || isPunct(after, "}") || after.line > t.line;
        if (!hasBody && !bare) break;
      } else if (isPunct(t, "@") || (isIdent(t) && VISIBILITY_KEYWORDS.has(t.text))) {
        // modifiers/annotations only count when an accessor follows them;
        // otherwise they start the next member and must be left in place
        const save = this.pos;
        this.skipAccessorPrefix();
        const kw = this.peek();
        if (kw === undefined || !(isIdent(kw, "get") || isIdent(kw, "set"))) {
          this.pos = save;
          break;
        }
        continue; // re-enter with pos at get/set
      } else {
        break;
      }
      this.pos++; // the accessor keyword
      if (isPunct(this.peek(), "(")) this.skipParenGroup();
      lineEnd = Math.max(lineEnd, this.parseTail());
    }
    if (isPunct(this.peek(), ";")) {
      lineEnd = this.peek()!.line;
      this.pos++;
    }
    const sigModifiers = header.modifiers.filter((m) => m !== "reified");
    const head = [sigModifiers.join(" "), kwText].filter((s) => s.length > 0).join(" ");
    const signature =
      `${head} ${receiver !== undefined ? receiver + "." : ""}${name.raw}` +
      `${typeSig !== "" ? `: ${typeSig}` : ""}`.trim();
    return this.pushMember(owner, header, {
      selector: name.plain,
      kind: "property",
      visibility: this.visibilityOf(header.modifiers),
      static: staticCtx || header.modifiers.includes("const"),
      signature,
      lineStart: header.start.line,
      lineEnd,
      ...(header.javadoc ? { javadocStart: header.javadoc.line, javadoc: header.javadoc.text } : {}),
      ...(receiver !== undefined ? { receiverType: receiver } : {}),
      ...(header.modifiers.length > 0 ? { modifiers: header.modifiers } : {}),
      ...platformOf(header),
    });
  }

  private parseSecondaryCtor(cls: ParsedClass, header: MemberHeader): Declaration {
    this.pos++; // constructor
    const params = this.parseParamList();
    if (isPunct(this.peek(), ":")) this.skipToBody(); // this(...)/super(...) delegation
    const lineEnd = this.parseTail();
    return this.pushMember(cls, header, {
      selector: cls.fqn.slice(cls.fqn.lastIndexOf(".") + 1),
      kind: "constructor",
      visibility: this.visibilityOf(header.modifiers),
      static: false,
      signature: `constructor(${params.join(", ")})`,
      lineStart: header.start.line,
      lineEnd,
      ...(header.javadoc ? { javadocStart: header.javadoc.line, javadoc: header.javadoc.text } : {}),
      ...(header.modifiers.length > 0 ? { modifiers: header.modifiers } : {}),
    });
  }

  private parseInitBlock(cls: ParsedClass, header: MemberHeader): void {
    this.pos++; // init
    const close = this.skipBraceBlock();
    this.pushMember(cls, header, {
      selector: cls.fqn.slice(cls.fqn.lastIndexOf(".") + 1),
      kind: "constructor",
      visibility: "public",
      static: false,
      signature: "init",
      lineStart: header.start.line,
      lineEnd: close ? close.line : this.lastLine(),
    });
  }

  private parseClassBody(cls: ParsedClass, open: Token, staticCtx: boolean): void {
    this.pos++; // consume `{`
    let constantsDone = cls.kind !== "enum";
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]!;
      if (isPunct(t, "}")) {
        this.pos++;
        cls.lineEnd = t.line;
        return;
      }
      if (isPunct(t, ";")) {
        this.pos++;
        constantsDone = true;
        continue;
      }
      const before = this.pos;
      try {
        const header = this.collectHeader();
        const kw = this.peek();
        if (this.isClassKindKeyword(kw)) {
          this.parseClassDeclaration(cls, header, kw!.text as "class" | "interface" | "object", staticCtx);
        } else if (isIdent(kw, "fun") && isIdent(this.peek(1), "interface")) {
          this.pos++; // `fun` is a modifier here; `interface` is the kind keyword
          header.modifiers.push("fun");
          this.parseClassDeclaration(cls, header, "interface", staticCtx);
        } else if (isIdent(kw, "fun")) {
          this.parseFunction(cls, header, staticCtx);
        } else if (isIdent(kw, "val") || isIdent(kw, "var")) {
          this.parseProperty(cls, header, staticCtx);
        } else if (isIdent(kw, "constructor")) {
          this.parseSecondaryCtor(cls, header);
        } else if (isIdent(kw, "init") && isPunct(this.peek(1), "{")) {
          this.parseInitBlock(cls, header);
        } else if (isIdent(kw, "typealias")) {
          this.finishLine();
        } else if (
          !constantsDone &&
          isIdent(kw) &&
          this.peek(1) !== undefined &&
          [",", ";", "(", "{", "}"].includes(this.peek(1)!.text)
        ) {
          if (this.parseEnumEntry(cls, header)) constantsDone = true;
        } else {
          this.result.diagnostics.push(
            `expected declaration in ${cls.fqn} at line ${t.line}, found '${kw?.text ?? "end of file"}'`,
          );
          this.recover();
        }
      } catch (e) {
        this.result.diagnostics.push(
          `failed to parse member of ${cls.fqn} at line ${t.line}: ${(e as Error).message}`,
        );
        this.recover();
      }
      if (this.pos === before) this.pos++; // hard progress guarantee
    }
    cls.lineEnd = this.lastLine();
    this.result.diagnostics.push(`unbalanced braces at line ${open.line}: class ${cls.fqn} is not closed`);
  }

  /**
   * Enum entry: `NAME (args)? { body }?` terminated by `,`, `;`, or the
   * enclosing `}`. Returns true when it consumed the `;` ending the list.
   */
  private parseEnumEntry(cls: ParsedClass, header: MemberHeader): boolean {
    const name = this.peek()!;
    this.pos++;
    let last = name;
    if (isPunct(this.peek(), "(")) {
      this.skipParenGroup();
      last = this.tokens[this.pos - 1] ?? last;
    }
    if (isPunct(this.peek(), "{")) {
      const close = this.skipBraceBlock();
      if (close) last = close;
    }
    const terminator = this.peek();
    let lineEnd = last.line;
    let endedConstantList = false;
    if (terminator !== undefined && (isPunct(terminator, ",") || isPunct(terminator, ";"))) {
      lineEnd = terminator.line;
      endedConstantList = isPunct(terminator, ";");
      this.pos++;
    }
    cls.members.push({
      fqn: cls.fqn,
      file: this.result.file,
      selector: stripBackticks(name.text),
      kind: "enum-constant",
      visibility: "public",
      static: true,
      deprecated: this.deprecatedOf(header),
      signature: name.text,
      lineStart: header.start.line,
      lineEnd,
      ...(header.javadoc ? { javadocStart: header.javadoc.line, javadoc: header.javadoc.text } : {}),
    });
    return endedConstantList;
  }

  /**
   * After a failed declaration parse, advance to a sane boundary: past a
   * depth-0 `;`, or stop before the enclosing `}`.
   */
  private recover(): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]!;
      if (depth === 0 && (t.text === ";" || t.text === ")")) {
        this.pos += t.text === ";" ? 1 : 0;
        return;
      }
      if (depth === 0 && t.text === "}") return;
      if (t.text === "(" || t.text === "[" || t.text === "{") depth++;
      else if (t.text === ")" || t.text === "]" || t.text === "}") depth = Math.max(0, depth - 1);
      this.pos++;
    }
  }
}

function platformOf(header: MemberHeader): { platform?: "expect" | "actual" } {
  if (header.modifiers.includes("expect")) return { platform: "expect" };
  if (header.modifiers.includes("actual")) return { platform: "actual" };
  return {};
}

/**
 * Parse one Kotlin source file into class records with their members. Never
 * throws: any problem — malformed syntax, unbalanced braces, garbage bytes —
 * degrades to diagnostics on the returned record.
 */
export function parseKotlinSource(text: string, file: string): SourceFileDeclarations {
  const result: SourceFileDeclarations = { file, pkg: null, imports: [], classes: [], diagnostics: [] };
  try {
    const { tokens, javadocs } = tokenize(text);
    new Parser(tokens, javadocs, result, file).parseFile();
  } catch (e) {
    result.diagnostics.push(`parse aborted: ${(e as Error).message}`);
  }
  return result;
}
