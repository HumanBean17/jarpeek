/**
 * Java declaration lexer: turns one Java source file into ParsedClass records.
 *
 * Two layers. A tokenizer (identifiers, numbers, strings including text
 * blocks, char literals, comments, operators) makes brace tracking immune to
 * literal contents — a `"}"` inside a string is one inert token. On top, a
 * declaration state machine walks class bodies one member at a time: only
 * member positions produce declarations, so method bodies (locals, anonymous
 * classes, lambdas) are skipped wholesale by brace depth. Every per-member
 * extraction is individually wrapped: one malformed member degrades to a
 * diagnostic string, and parseJavaSource never throws on any input.
 */
import type { Declaration, Visibility } from "../core/types.js";

export interface ParsedClass {
  fqn: string;
  kind: "class" | "interface" | "enum" | "record" | "annotation";
  visibility: Visibility;
  static: boolean;
  deprecated: boolean;
  signature: string;
  lineStart: number;
  lineEnd: number;
  javadocStart?: number;
  members: Declaration[];
}

export interface SourceFileDeclarations {
  file: string;
  pkg: string | null;
  classes: ParsedClass[];
  diagnostics: string[];
}

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

const MODIFIER_KEYWORDS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "abstract",
  "final",
  "sealed",
  "default",
  "transient",
  "volatile",
  "synchronized",
  "native",
  "strictfp",
]);

const CLASS_KIND_KEYWORDS = {
  class: "class",
  interface: "interface",
  enum: "enum",
  record: "record",
} as const;

/** The ParsedClass kind a token introduces, or undefined if it is not one. */
function classKindOf(t: Token | undefined): ParsedClass["kind"] | undefined {
  if (t === undefined || t.kind !== "ident") return undefined;
  return CLASS_KIND_KEYWORDS[t.text as keyof typeof CLASS_KIND_KEYWORDS];
}

const isWordChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$]/.test(c);
const isIdent = (t: Token | undefined, text?: string): boolean =>
  !!t && t.kind === "ident" && (text === undefined || t.text === text);
const isPunct = (t: Token | undefined, text: string): boolean =>
  !!t && t.kind === "punct" && t.text === text;

/** True for names like `Deprecated` or `java.lang.Deprecated`. */
const isDeprecatedAnnotation = (name: string): boolean =>
  (name.split(".").pop() ?? name) === "Deprecated";

const hasJavadocDeprecatedTag = (text: string): boolean => /^\s*\*?\s*@deprecated\b/m.test(text);

/**
 * Join token texts into one normalized type/signature fragment: whitespace is
 * collapsed away entirely except between two adjacent word tokens (`T extends
 * Foo` keeps its space; `Map<String, List<Integer>>` and `int[]` do not).
 */
function joinTokens(tokens: Token[]): string {
  let out = "";
  let prevChar: string | undefined;
  for (const token of tokens) {
    const first = token.text[0];
    if ((isWordChar(prevChar) || prevChar === "?") && isWordChar(first)) out += " ";
    out += token.text;
    prevChar = token.text[token.text.length - 1];
  }
  return out;
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
      if (text[i + 1] === '"' && text[i + 2] === '"') {
        // text block: closes at the first unescaped """
        i += 3;
        while (i < n) {
          if (text[i] === "\\" && i + 1 < n) {
            if (text[i + 1] === "\n") line++;
            i += 2;
          } else if (text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
            i += 3;
            break;
          } else {
            if (text[i] === "\n") line++;
            i++;
          }
        }
      } else {
        i++;
        while (i < n && text[i] !== '"' && text[i] !== "\n") {
          i += text[i] === "\\" ? 2 : 1;
        }
        if (text[i] === '"') i++;
      }
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
    if (c === "." && text[i + 1] === "." && text[i + 2] === ".") {
      push("punct", i, i + 3);
      i += 3;
      continue;
    }
    if (c === "-" && text[i + 1] === ">") {
      push("punct", i, i + 2);
      i += 2;
      continue;
    }
    push("punct", i, i + 1);
    i++;
  }
  return { tokens, javadocs };
}

/** Thrown by per-member parse helpers; callers convert it to a diagnostic. */
class ParseProblem extends Error {}

/**
 * Cursor over the token stream plus the declaration state machine. The cursor
 * only moves forward; the body loop guarantees progress even when a member
 * parse fails without consuming anything.
 */
class Parser {
  private readonly tokens: Token[];
  private readonly javadocs: JavadocInfo[];
  private readonly result: SourceFileDeclarations;
  /** record header component types per fqn, for compact constructors */
  private readonly recordHeaderParams = new Map<string, string[]>();
  /** next unconsumed javadoc — consumed strictly in source order */
  private javadocIdx = 0;
  private pos = 0;

  constructor(tokens: Token[], javadocs: JavadocInfo[], result: SourceFileDeclarations) {
    this.tokens = tokens;
    this.javadocs = javadocs;
    this.result = result;
  }

  parseFile(): void {
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]!;
      if (isIdent(t, "package")) {
        this.pos++;
        this.result.pkg = this.readDottedName();
        this.finishStatement();
      } else if (isIdent(t, "import")) {
        this.finishStatement();
      } else if (isPunct(t, ";")) {
        this.pos++;
      } else {
        const before = this.pos;
        this.parseTypeDeclaration(null);
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

  /**
   * Skip an initializer or clause, stopping before the next depth-0 `;` or `,`
   * (both left unconsumed). Returns that terminator's line, or the last line
   * at EOF.
   */
  private skipToSemicolon(): number {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]!;
      if (depth === 0 && (t.text === ";" || t.text === ",")) return t.line;
      this.pos++;
      if (t.text === "(" || t.text === "[" || t.text === "{") depth++;
      else if (t.text === ")" || t.text === "]" || t.text === "}") depth = Math.max(0, depth - 1);
    }
    return this.lastLine();
  }

  /** Consume the rest of a package/import statement including its `;`. */
  private finishStatement(): void {
    this.skipToSemicolon();
    if (isPunct(this.peek(), ";")) this.pos++;
  }

  /**
   * Skip a `{...}` block (method body, initializer, anonymous class) starting
   * at the current `{`. Returns the closing `}` token, or null at EOF (with a
   * diagnostic).
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

  /** Consume a balanced `(...)` group (annotation arguments, enum constant args). */
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
   * Consume a balanced `<...>` group (type parameters or type arguments) and
   * return its tokens including the angle brackets. `>` is tokenized one char
   * at a time so `List<List<T>>` closes correctly. Bails out without
   * consuming when a statement terminator shows up first (malformed source).
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

  /**
   * The javadoc sitting between the previous token (ending at `prevEnd`) and
   * the declaration's first token — the one that documents this declaration.
   * Javadocs swallowed by an earlier member's body end before `prevEnd` and
   * are dropped; when several stack up, the closest one wins.
   */
  private takeJavadoc(prevEnd: number, startOffset: number): JavadocInfo | undefined {
    while (
      this.javadocIdx < this.javadocs.length &&
      this.javadocs[this.javadocIdx]!.end <= prevEnd
    ) {
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

  /**
   * Collect the leading annotations and modifiers of a declaration. Stops at
   * the kind keyword, the member's type, `@interface`, or an initializer `{`.
   */
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
      if (isPunct(t, "@") && isIdent(this.peek(1), "interface")) break; // annotation-type declaration
      if (isPunct(t, "@") && isIdent(this.peek(1))) {
        this.pos++;
        const name = this.readDottedName();
        this.skipParenGroup();
        header.annotations.push(name);
        continue;
      }
      if (isIdent(t) && MODIFIER_KEYWORDS.has(t.text)) {
        header.modifiers.push(t.text);
        this.pos++;
        continue;
      }
      if (isIdent(t, "non") && isPunct(this.peek(1), "-") && isIdent(this.peek(2), "sealed")) {
        header.modifiers.push("non-sealed");
        this.pos += 3;
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
    return "package";
  }

  private deprecatedOf(header: MemberHeader): boolean {
    return (
      header.annotations.some(isDeprecatedAnnotation) ||
      (header.javadoc !== undefined && hasJavadocDeprecatedTag(header.javadoc.text))
    );
  }

  /** Parse a top-level or nested type declaration; garbage becomes a diagnostic. */
  private parseTypeDeclaration(parent: ParsedClass | null): void {
    const startLine = this.peek()?.line ?? this.lastLine();
    try {
      const header = this.collectHeader();
      const kw = this.peek();
      if (kw && isIdent(kw, "package") && parent === null) {
        // package-level annotations preceded the package statement
        this.pos++;
        this.result.pkg = this.readDottedName();
        this.skipToSemicolon();
        return;
      }
      if (kw && isIdent(kw, "import")) {
        this.finishStatement();
        return;
      }
      const classKind = classKindOf(kw);
      if (classKind !== undefined) {
        this.parseClassDeclaration(parent, header, classKind);
        return;
      }
      if (isPunct(kw, "@") && isIdent(this.peek(1), "interface")) {
        this.parseClassDeclaration(parent, header, "annotation");
        return;
      }
      this.result.diagnostics.push(
        `expected type declaration at line ${kw?.line ?? startLine}, found '${kw?.text ?? "end of file"}'`,
      );
      this.recover();
    } catch (e) {
      this.result.diagnostics.push(
        `failed to parse declaration at line ${startLine}: ${(e as Error).message}`,
      );
      this.recover();
    }
  }

  /** Parse `Name <TypeParams> (RecordHeader)? extends/implements/permits { body }`. */
  private parseClassDeclaration(
    parent: ParsedClass | null,
    header: MemberHeader,
    kind: ParsedClass["kind"],
  ): void {
    const kwLine = this.peek()!.line;
    // consume the kind keyword — `class`/`interface`/`enum`/`record`, or the
    // `@interface` pair for annotation declarations
    this.pos += kind === "annotation" ? 2 : 1;
    if (!isIdent(this.peek())) {
      this.result.diagnostics.push(`class declaration is missing a name at line ${kwLine}`);
      this.skipBraceBlock();
      return;
    }
    const name = this.peek()!.text;
    this.pos++;
    const typeParamTokens = isPunct(this.peek(), "<") ? this.skipAngleGroup() : [];
    const recordParams =
      kind === "record" && isPunct(this.peek(), "(") ? this.parseParamList() : [];

    // skip extends / implements / permits clauses up to the body
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (isPunct(t, "{") || isPunct(t, ";")) break;
      this.pos++;
    }
    const fqn = parent
      ? `${parent.fqn}.${name}`
      : this.result.pkg
        ? `${this.result.pkg}.${name}`
        : name;
    if (kind === "record") this.recordHeaderParams.set(fqn, recordParams);

    const keyword = kind === "annotation" ? "@interface" : kind;
    const typeParamsSig = typeParamTokens.length > 0 ? joinTokens(typeParamTokens) : "";
    const recordSig = recordParams.length > 0 ? `(${recordParams.join(",")})` : "";
    const signature = [...header.modifiers, `${keyword} ${name}${typeParamsSig}${recordSig}`]
      .filter((s) => s.length > 0)
      .join(" ");

    const cls: ParsedClass = {
      fqn,
      kind,
      visibility: this.visibilityOf(header.modifiers),
      static: header.modifiers.includes("static"),
      deprecated: this.deprecatedOf(header),
      signature,
      lineStart: header.start.line,
      lineEnd: this.lastLine(),
      ...(header.javadoc ? { javadocStart: header.javadoc.line } : {}),
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
        ...(header.javadoc ? { javadocStart: header.javadoc.line } : {}),
        ...(header.modifiers.length > 0 ? { modifiers: header.modifiers } : {}),
      });
    }

    if (isPunct(this.peek(), ";")) {
      cls.lineEnd = this.peek()!.line;
      this.pos++;
      return;
    }
    const open = this.peek();
    if (!open || !isPunct(open, "{")) {
      this.result.diagnostics.push(`class ${fqn} has no body at line ${kwLine}`);
      return;
    }
    this.parseClassBody(cls, open);
  }

  private parseClassBody(cls: ParsedClass, open: Token): void {
    this.pos++; // consume `{`
    let constantsDone = cls.kind !== "enum";
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
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
        const classKind = classKindOf(kw);
        if (classKind !== undefined) {
          this.parseClassDeclaration(cls, header, classKind);
        } else if (isPunct(kw, "@") && isIdent(this.peek(1), "interface")) {
          this.parseClassDeclaration(cls, header, "annotation");
        } else if (isPunct(kw, "{")) {
          this.skipBraceBlock(); // static/instance initializer block — not a member
        } else if (
          !constantsDone &&
          isIdent(kw) &&
          this.peek(1) !== undefined &&
          [",", ";", "(", "{", "}"].includes(this.peek(1)!.text)
        ) {
          if (this.parseEnumConstant(cls, header)) constantsDone = true;
        } else {
          this.parseMember(cls, header);
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
   * Enum constant: `NAME (args)? { body }?` terminated by `,`, `;`, or the
   * enclosing `}` (left unconsumed for the body loop). Returns true when it
   * consumed the `;` that ends the constant list.
   */
  private parseEnumConstant(cls: ParsedClass, header: MemberHeader): boolean {
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
    if (terminator && (isPunct(terminator, ",") || isPunct(terminator, ";"))) {
      lineEnd = terminator.line;
      endedConstantList = isPunct(terminator, ";");
      this.pos++;
    }
    cls.members.push({
      fqn: cls.fqn,
      file: this.result.file,
      selector: name.text,
      kind: "enum-constant",
      visibility: "public",
      static: true,
      deprecated: this.deprecatedOf(header),
      signature: name.text,
      lineStart: header.start.line,
      lineEnd,
      ...(header.javadoc ? { javadocStart: header.javadoc.line } : {}),
    });
    return endedConstantList;
  }

  /** Parse one field, method, or constructor of `cls` (never a nested type). */
  private parseMember(cls: ParsedClass, header: MemberHeader): void {
    const next = this.peek();
    // `<` introduces a generic method's type parameters — handled downstream
    if (!isIdent(next) && !isPunct(next, "<")) {
      throw new ParseProblem(`expected a member, found '${next?.text ?? "end of file"}'`);
    }
    const simpleName = cls.fqn.slice(cls.fqn.lastIndexOf(".") + 1);
    const isCtor =
      next!.text === simpleName &&
      (isPunct(this.peek(1), "(") || isPunct(this.peek(1), "{"));
    if (isCtor) {
      this.parseConstructor(cls, header);
    } else {
      this.parseFieldOrMethod(cls, header);
    }
  }

  private parseConstructor(cls: ParsedClass, header: MemberHeader): void {
    const name = this.peek()!;
    this.pos++;
    // a compact record constructor has no parameter list of its own — its
    // signature is the record header's component list
    const params = isPunct(this.peek(), "(")
      ? this.parseParamList()
      : (this.recordHeaderParams.get(cls.fqn) ?? []);
    this.skipThrowsClause();
    const lineEnd = this.parseBodyOrSemicolon();
    cls.members.push({
      fqn: cls.fqn,
      file: this.result.file,
      selector: name.text,
      kind: "constructor",
      visibility: this.visibilityOf(header.modifiers),
      static: false,
      deprecated: this.deprecatedOf(header),
      signature: [...header.modifiers, `${name.text}(${params.join(",")})`].join(" "),
      lineStart: header.start.line,
      lineEnd,
      ...(header.javadoc ? { javadocStart: header.javadoc.line } : {}),
      ...(header.modifiers.length > 0 ? { modifiers: header.modifiers } : {}),
    });
  }

  private parseFieldOrMethod(cls: ParsedClass, header: MemberHeader): void {
    const typeParamTokens = isPunct(this.peek(), "<") ? this.skipAngleGroup() : [];
    const typeTokens = this.parseTypeTokens();
    if (typeTokens.length === 0) {
      throw new ParseProblem(`expected a type, found '${this.peek()?.text ?? "end of file"}'`);
    }
    const name = this.peek();
    if (!isIdent(name)) {
      throw new ParseProblem(
        `expected a member name after type, found '${name?.text ?? "end of file"}'`,
      );
    }
    this.pos++;

    if (isPunct(this.peek(), "(")) {
      this.parseMethod(cls, header, typeParamTokens, typeTokens, name!);
    } else {
      this.parseField(cls, header, typeTokens, name!);
    }
  }

  private parseMethod(
    cls: ParsedClass,
    header: MemberHeader,
    typeParamTokens: Token[],
    returnType: Token[],
    name: Token,
  ): void {
    const params = this.parseParamList();
    this.skipThrowsClause();
    // annotation members may carry `default <value>` ending at the `;`
    let lineEnd: number;
    if (isIdent(this.peek(), "default")) {
      this.pos++;
      lineEnd = this.skipToSemicolon();
      if (isPunct(this.peek(), ";")) this.pos++;
    } else {
      lineEnd = this.parseBodyOrSemicolon();
    }
    const typeParamsSig = typeParamTokens.length > 0 ? joinTokens(typeParamTokens) : "";
    cls.members.push({
      fqn: cls.fqn,
      file: this.result.file,
      selector: name.text,
      kind: "method",
      visibility: this.visibilityOf(header.modifiers),
      static: header.modifiers.includes("static"),
      deprecated: this.deprecatedOf(header),
      signature: [
        ...header.modifiers,
        typeParamsSig,
        `${joinTokens(returnType)} ${name.text}(${params.join(",")})`,
      ]
        .filter((s) => s.length > 0)
        .join(" "),
      lineStart: header.start.line,
      lineEnd,
      ...(header.javadoc ? { javadocStart: header.javadoc.line } : {}),
      ...(header.modifiers.length > 0 ? { modifiers: header.modifiers } : {}),
    });
  }

  /** One declarator per Declaration: `int a = 1, b = 2;` yields two fields. */
  private parseField(
    cls: ParsedClass,
    header: MemberHeader,
    typeTokens: Token[],
    firstName: Token,
  ): void {
    let name = firstName;
    for (;;) {
      let lineEnd = this.lastLine();
      if (isPunct(this.peek(), "=")) {
        this.pos++;
        lineEnd = this.skipToSemicolon(); // stops before the `;` or a declarator `,`
      }
      if (isPunct(this.peek(), ";")) {
        lineEnd = this.peek()!.line;
        this.pos++;
      }
      cls.members.push({
        fqn: cls.fqn,
        file: this.result.file,
        selector: name.text,
        kind: "field",
        visibility: this.visibilityOf(header.modifiers),
        static: header.modifiers.includes("static"),
        deprecated: this.deprecatedOf(header),
        signature: [...header.modifiers, joinTokens(typeTokens), name.text].join(" "),
        lineStart: name === firstName ? header.start.line : name.line,
        lineEnd,
        ...(header.javadoc ? { javadocStart: header.javadoc.line } : {}),
        ...(header.modifiers.length > 0 ? { modifiers: header.modifiers } : {}),
      });
      if (isPunct(this.peek(), ",")) {
        this.pos++;
        const nextName = this.peek();
        if (nextName !== undefined && isIdent(nextName)) {
          name = nextName;
          this.pos++;
          continue;
        }
      }
      return;
    }
  }

  /** Consume `(...)` and return the normalized parameter type list. */
  private parseParamList(): string[] {
    if (!isPunct(this.peek(), "(")) return [];
    this.pos++; // `(`
    const groups: Token[][] = [[]];
    let angleDepth = 0;
    let parenDepth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.text === "<") angleDepth++;
      else if (t.text === ">") angleDepth = Math.max(0, angleDepth - 1);
      else if (t.text === "(") parenDepth++;
      else if (t.text === ")") {
        if (parenDepth === 0) {
          this.pos++;
          break;
        }
        parenDepth--;
      } else if (t.text === "," && angleDepth === 0 && parenDepth === 0) {
        this.pos++;
        groups.push([]);
        continue;
      }
      this.pos++;
      groups[groups.length - 1]!.push(t);
    }
    return groups.map((g) => this.paramTypeOf(g)).filter((s) => s.length > 0);
  }

  /** Strip annotations, modifiers, and the trailing parameter name. */
  private paramTypeOf(tokens: Token[]): string {
    const kept: Token[] = [];
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (isPunct(t, "@") && isIdent(tokens[i + 1])) {
        i += 2;
        while (i < tokens.length && (isIdent(tokens[i]) || isPunct(tokens[i], "."))) i++;
        if (isPunct(tokens[i], "(")) {
          let depth = 0;
          while (i < tokens.length) {
            if (tokens[i]!.text === "(") depth++;
            else if (tokens[i]!.text === ")") {
              depth--;
              if (depth === 0) {
                i++;
                break;
              }
            }
            i++;
          }
        }
        continue;
      }
      if (isIdent(t) && MODIFIER_KEYWORDS.has(t.text)) {
        i++;
        continue;
      }
      kept.push(t);
      i++;
    }
    // `Type name` — the trailing ident is the parameter name when a type root
    // remains in front of it (covers `String s`, `String[] a`, `int... n`,
    // `Map<K,V> m`, `java.util.Date d`)
    if (isIdent(kept[kept.length - 1]) && kept.slice(0, -1).some((t) => isIdent(t))) {
      kept.pop();
    }
    return joinTokens(kept);
  }

  /**
   * Consume exactly one type reference — a qualified name, optionally one
   * generic argument group, then array brackets. The member name follows and
   * must not be swallowed here. Returns its tokens; empty when the current
   * token cannot start a type.
   */
  private parseTypeTokens(): Token[] {
    const out: Token[] = [];
    if (!isIdent(this.peek())) return out;
    out.push(this.peek()!);
    this.pos++;
    while (isPunct(this.peek(), ".") && isIdent(this.peek(1))) {
      out.push(this.peek()!);
      this.pos++;
      out.push(this.peek()!);
      this.pos++;
    }
    if (isPunct(this.peek(), "<")) {
      out.push(...this.skipAngleGroup());
    }
    while (isPunct(this.peek(), "[")) {
      out.push(this.peek()!);
      this.pos++;
      if (isPunct(this.peek(), "]")) {
        out.push(this.peek()!);
        this.pos++;
      }
    }
    return out;
  }

  private skipThrowsClause(): void {
    if (!isIdent(this.peek(), "throws")) return;
    while (
      this.pos < this.tokens.length &&
      !isPunct(this.peek(), "{") &&
      !isPunct(this.peek(), ";") &&
      !isIdent(this.peek(), "default")
    ) {
      this.pos++;
    }
  }

  /**
   * Consume the declaration tail: `{ body }` (lineEnd = closing brace),
   * `;` (abstract/native members), or an annotation `default` initializer.
   * Returns the line the declaration ends on.
   */
  private parseBodyOrSemicolon(): number {
    if (isPunct(this.peek(), "{")) {
      const close = this.skipBraceBlock();
      return close ? close.line : this.lastLine();
    }
    if (isPunct(this.peek(), ";")) {
      const semi = this.peek()!;
      this.pos++;
      return semi.line;
    }
    // no recognizable tail (EOF or garbage): consume nothing, let the caller recover
    return this.lastLine();
  }

  /**
   * After a failed member parse, advance to a sane boundary: the next `;` at
   * depth 0, past a balanced block, or stop before the enclosing class's `}`
   * (left for the body loop to consume).
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

/**
 * Parse one Java source file into class records with their members. Never
 * throws: any problem — malformed syntax, unbalanced braces, garbage bytes —
 * degrades to diagnostics on the returned record.
 */
export function parseJavaSource(text: string, file: string): SourceFileDeclarations {
  const result: SourceFileDeclarations = { file, pkg: null, classes: [], diagnostics: [] };
  try {
    const { tokens, javadocs } = tokenize(text);
    new Parser(tokens, javadocs, result).parseFile();
  } catch (e) {
    result.diagnostics.push(`parse aborted: ${(e as Error).message}`);
  }
  return result;
}
