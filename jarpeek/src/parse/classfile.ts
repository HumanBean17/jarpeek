/**
 * JVM class-file reader: turns one compiled `.class` buffer into the same
 * declaration records the source lexers produce, minus line ranges.
 *
 * A positional big-endian reader walks the constant pool (every tag at its
 * exact size, Long/Double double-slot), header, fields, methods, and the
 * class attributes the declaration model needs: `Signature` for generics,
 * `Deprecated` (+ `RuntimeVisibleAnnotations` ending `Deprecated;`),
 * `InnerClasses` for nested-class static-ness, and `Record` for record
 * components. Everything malformed — bad magic, truncation, a bad pool index,
 * an unknown tag — is a named ClassFileError, never a crash; indexer callers
 * catch it per entry. Type names from descriptors and signatures are fully
 * qualified (`Ljava/lang/String;` → `java.lang.String`, `[I` → `int[]`), and
 * `$` in binary names maps to `.` nesting like everywhere else in jarpeek.
 */
import type { Declaration, Visibility } from "../core/types.js";

export interface ParsedClassFile {
  fqn: string;
  kind: "class" | "interface" | "enum" | "record" | "annotation";
  visibility: Visibility;
  static: boolean;
  deprecated: boolean;
  signature: string;
  members: Declaration[];
}

export class ClassFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassFileError";
  }
}

// class access flags (JVMS 4.1)
const ACC_PUBLIC = 0x0001;
const ACC_PRIVATE = 0x0002;
const ACC_PROTECTED = 0x0004;
const ACC_STATIC = 0x0008;
const ACC_FINAL = 0x0010;
const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;
const ACC_ANNOTATION = 0x2000;
const ACC_ENUM = 0x4000;
const ACC_RECORD = 0x10000;
// member-only flags
const ACC_SYNCHRONIZED = 0x0020; // methods
const ACC_VOLATILE = 0x0040; // fields
const ACC_TRANSIENT = 0x0080; // fields
const ACC_NATIVE = 0x0100; // methods
const ACC_STRICT = 0x0800; // methods

// constant-pool tags (JVMS 4.4)
const TAG_UTF8 = 1;
const TAG_INTEGER = 3;
const TAG_FLOAT = 4;
const TAG_LONG = 5;
const TAG_DOUBLE = 6;
const TAG_CLASS = 7;
const TAG_STRING = 8;
const TAG_FIELDREF = 9;
const TAG_METHODREF = 10;
const TAG_INTERFACE_METHODREF = 11;
const TAG_NAME_AND_TYPE = 12;
const TAG_METHOD_HANDLE = 15;
const TAG_METHOD_TYPE = 16;
const TAG_DYNAMIC = 17;
const TAG_INVOKE_DYNAMIC = 18;
const TAG_MODULE = 19;
const TAG_PACKAGE = 20;

const MAGIC = 0xcafebabe;

const PRIMITIVE_TYPES: Record<string, string> = {
  B: "byte",
  C: "char",
  D: "double",
  F: "float",
  I: "int",
  J: "long",
  S: "short",
  Z: "boolean",
};

/**
 * Big-endian cursor over the class-file buffer. Every read is bounds-checked
 * so any truncation surfaces as a ClassFileError instead of a Buffer
 * RangeError or — worse — a silent short read.
 */
class Reader {
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  private need(n: number, what: string): void {
    if (this.pos + n > this.buf.length) {
      throw new ClassFileError(
        `truncated class file: ${what} wants ${n} bytes at offset ${this.pos}, ` +
          `only ${this.buf.length - this.pos} remain`,
      );
    }
  }

  u1(what = "u1"): number {
    this.need(1, what);
    return this.buf[this.pos++]!;
  }

  u2(what = "u2"): number {
    this.need(2, what);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  u4(what = "u4"): number {
    this.need(4, what);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  /** Consume and return `n` raw bytes. */
  bytes(n: number, what = "bytes"): Buffer {
    this.skip(n, what);
    const out = this.buf.subarray(this.pos - n, this.pos);
    return out;
  }

  /** Advance past `n` bytes without materializing them. */
  skip(n: number, what = "bytes"): void {
    if (n < 0) throw new ClassFileError(`negative byte count for ${what}`);
    this.need(n, what);
    this.pos += n;
  }
}

interface ConstantPool {
  readonly size: number;
  /** utf8 constants by index; undefined = not a Utf8 entry (or Long/Double hole) */
  readonly utf8s: ReadonlyArray<string | undefined>;
  /** Class-entry binary names (`com/example/Demo$Worker`) by index */
  readonly classNames: ReadonlyArray<string | undefined>;
}

/**
 * Read the constant pool, keeping only what the declaration model needs:
 * Utf8 strings and Class names. Every other tag is skipped at its exact size
 * (MethodHandle 3 payload bytes, Dynamic/InvokeDynamic 4, Module/Package 2,
 * Long/Double 8 and double-slot) so later indexes stay aligned.
 */
function readConstantPool(r: Reader): ConstantPool {
  const size = r.u2("constant-pool count");
  const utf8s: Array<string | undefined> = new Array(size);
  const classNameIndexes: Array<number | undefined> = new Array(size);
  for (let i = 1; i < size; i++) {
    const tag = r.u1(`constant-pool tag at index ${i}`);
    switch (tag) {
      case TAG_UTF8: {
        const length = r.u2(`Utf8 length at index ${i}`);
        // modified-UTF8 differs from standard UTF-8 only for U+0000 and
        // supplementary chars; toString("utf8") is close enough for names
        utf8s[i] = r.bytes(length, `Utf8 bytes at index ${i}`).toString("utf8");
        break;
      }
      case TAG_INTEGER:
      case TAG_FLOAT:
      case TAG_FIELDREF:
      case TAG_METHODREF:
      case TAG_INTERFACE_METHODREF:
      case TAG_NAME_AND_TYPE:
      case TAG_DYNAMIC:
      case TAG_INVOKE_DYNAMIC:
        r.skip(4, `constant-pool entry ${i} (tag ${tag})`);
        break;
      case TAG_LONG:
      case TAG_DOUBLE:
        r.skip(8, `constant-pool entry ${i} (tag ${tag})`);
        i++; // 8-byte constants occupy two pool slots
        break;
      case TAG_CLASS:
        classNameIndexes[i] = r.u2(`Class name index at index ${i}`);
        break;
      case TAG_STRING:
      case TAG_METHOD_TYPE:
      case TAG_MODULE:
      case TAG_PACKAGE:
        r.skip(2, `constant-pool entry ${i} (tag ${tag})`);
        break;
      case TAG_METHOD_HANDLE:
        r.skip(3, `constant-pool entry ${i} (MethodHandle)`);
        break;
      default:
        throw new ClassFileError(`unknown constant-pool tag ${tag} at index ${i}`);
    }
  }
  // resolve Class names after the whole pool is read: entries may reference
  // Utf8 constants declared later in the pool
  const classNames: Array<string | undefined> = new Array(size);
  for (let i = 1; i < size; i++) {
    const nameIndex = classNameIndexes[i];
    if (nameIndex !== undefined) {
      classNames[i] = utf8At({ size, utf8s, classNames }, nameIndex, `Class_${i}`);
    }
  }
  return { size, utf8s, classNames };
}

/** Dereference a Utf8 constant with full validation. */
function utf8At(pool: ConstantPool, index: number, what: string): string {
  if (index < 1 || index >= pool.size) {
    throw new ClassFileError(
      `${what}: constant-pool index ${index} is out of range (1..${pool.size - 1})`,
    );
  }
  const value = pool.utf8s[index];
  if (value === undefined) {
    throw new ClassFileError(`${what}: constant-pool index ${index} is not a Utf8 entry`);
  }
  return value;
}

/** Dereference a Class constant to its binary name (`com/example/Demo$Worker`). */
function classNameAt(pool: ConstantPool, index: number, what: string): string {
  if (index < 1 || index >= pool.size) {
    throw new ClassFileError(
      `${what}: constant-pool index ${index} is out of range (1..${pool.size - 1})`,
    );
  }
  const name = pool.classNames[index];
  if (name === undefined) {
    throw new ClassFileError(`${what}: constant-pool index ${index} is not a Class entry`);
  }
  return name;
}

/** Binary name → dotted fqn: `/` and `$` both become `.` (nesting style). */
function dottedName(binaryName: string): string {
  return binaryName.replaceAll("/", ".").replaceAll("$", ".");
}

/** Visibility from class or member access flags. */
function visibilityOf(flags: number): Visibility {
  if (flags & ACC_PUBLIC) return "public";
  if (flags & ACC_PRIVATE) return "private";
  if (flags & ACC_PROTECTED) return "protected";
  return "package";
}

/**
 * Source-level modifiers for a member signature, in canonical order. Flag
 * bits without a source spelling (bridge, varargs, synthetic, enum-on-field)
 * are deliberately omitted.
 */
function memberModifiers(flags: number, isMethod: boolean): string[] {
  const out: string[] = [];
  const visibility = visibilityOf(flags);
  if (visibility !== "package") out.push(visibility);
  if (flags & ACC_STATIC) out.push("static");
  if (flags & ACC_FINAL) out.push("final");
  if (isMethod && flags & ACC_ABSTRACT) out.push("abstract");
  if (!isMethod && flags & ACC_TRANSIENT) out.push("transient");
  if (!isMethod && flags & ACC_VOLATILE) out.push("volatile");
  if (isMethod && flags & ACC_SYNCHRONIZED) out.push("synchronized");
  if (isMethod && flags & ACC_NATIVE) out.push("native");
  if (isMethod && flags & ACC_STRICT) out.push("strictfp");
  return out;
}

/**
 * Expand one field-descriptor type starting at `start`. Returns the rendered
 * Java type and the index just past it: `Ljava/lang/String;` →
 * `java.lang.String`, `[I` → `int[]`.
 */
function expandDescriptorType(desc: string, start: number): [string, number] {
  let i = start;
  let dims = 0;
  while (desc[i] === "[") {
    dims++;
    i++;
  }
  const c = desc[i]!;
  let type: string;
  if (c === "L") {
    const end = desc.indexOf(";", i);
    if (end === -1) throw new ClassFileError(`unterminated class descriptor at ${i}: ${desc}`);
    type = dottedName(desc.slice(i + 1, end));
    i = end + 1;
  } else if (c !== "V" && PRIMITIVE_TYPES[c] !== undefined) {
    type = PRIMITIVE_TYPES[c]!;
    i++;
  } else {
    throw new ClassFileError(`bad type descriptor character '${c}' at ${i} in ${desc}`);
  }
  return [type + "[]".repeat(dims), i];
}

/** Parse a method descriptor `(params)ret` into rendered parameter and return types. */
function expandMethodDescriptor(desc: string): { params: string[]; ret: string } {
  if (!desc.startsWith("(")) {
    throw new ClassFileError(`method descriptor does not start with '(': ${desc}`);
  }
  const params: string[] = [];
  let i = 1;
  while (i < desc.length && desc[i] !== ")") {
    const [type, next] = expandDescriptorType(desc, i);
    params.push(type);
    i = next;
  }
  if (desc[i] !== ")") {
    throw new ClassFileError(`unterminated parameter list in descriptor: ${desc}`);
  }
  if (desc[i + 1] === "V") return { params, ret: "void" };
  const [ret] = expandDescriptorType(desc, i + 1);
  return { params, ret };
}

/**
 * Cursor over a `Signature` attribute string (JVMS 4.7.9.1). Rendering rules:
 * `L…;` class wrappers become dotted names (with `$` → `.`), type variables
 * keep their identifier, arrays gain `[]`, `*`/`+`/`-` become `?` /
 * `? extends` / `? super`, and `<…>` type arguments stay attached.
 */
class SigReader {
  private pos = 0;

  constructor(private readonly sig: string) {}

  peek(): string {
    return this.sig[this.pos] ?? "";
  }

  private fail(what: string): never {
    throw new ClassFileError(`malformed signature at offset ${this.pos} (${what}): ${this.sig}`);
  }

  expect(ch: string): void {
    if (this.peek() !== ch) this.fail(`expected '${ch}', saw '${this.peek()}'`);
    this.pos++;
  }

  eof(): boolean {
    return this.pos >= this.sig.length;
  }

  identifier(what: string): string {
    const start = this.pos;
    while (/[A-Za-z0-9_$]/.test(this.peek())) this.pos++;
    if (this.pos === start) this.fail(`expected identifier (${what})`);
    return this.sig.slice(start, this.pos);
  }

  /** Render one JavaTypeSignature: base type, class type, type variable, or array. */
  type(allowVoid: boolean): string {
    const c = this.peek();
    if (c === "L") return this.classType();
    if (c === "T") {
      this.pos++;
      const name = this.identifier("type variable");
      this.expect(";");
      return name;
    }
    if (c === "[") {
      this.pos++;
      return this.type(allowVoid) + "[]";
    }
    if (c === "V" && allowVoid) {
      this.pos++;
      return "void";
    }
    if (c !== "" && c !== "V" && PRIMITIVE_TYPES[c] !== undefined) {
      this.pos++;
      return PRIMITIVE_TYPES[c]!;
    }
    this.fail("expected a type");
  }

  /** ClassTypeSignature `L pkg/Name<args>.Inner<args>;` → `pkg.Name<args>.Inner<args>`. */
  private classType(): string {
    this.expect("L");
    let out = this.identifier("class name");
    while (this.peek() === "/") {
      this.pos++;
      out += "." + this.identifier("package name");
    }
    if (this.peek() === "<") out += this.typeArguments();
    while (this.peek() === ".") {
      this.pos++;
      out += "." + this.identifier("nested class name");
      if (this.peek() === "<") out += this.typeArguments();
    }
    this.expect(";");
    // `$` inside class-name identifiers maps to `.` nesting like this_class
    return out.replaceAll("$", ".");
  }

  private typeArguments(): string {
    this.expect("<");
    const parts: string[] = [];
    while (this.peek() !== ">") {
      if (this.eof()) this.fail("unterminated type arguments");
      const c = this.peek();
      if (c === "*") {
        this.pos++;
        parts.push("?");
      } else if (c === "+") {
        this.pos++;
        parts.push("? extends " + this.type(false));
      } else if (c === "-") {
        this.pos++;
        parts.push("? super " + this.type(false));
      } else {
        parts.push(this.type(false));
      }
    }
    this.pos++; // `>`
    return `<${parts.join(",")}>`;
  }

  /** Formal type parameters `<T:LFoo;U::LBar;>` → `<T extends Foo,U>`. */
  typeParameters(): string {
    this.expect("<");
    const parts: string[] = [];
    while (this.peek() !== ">") {
      if (this.eof()) this.fail("unterminated type parameters");
      const name = this.identifier("type parameter");
      let bounds: string[] = [];
      this.expect(":");
      // the ClassBound may be absent: a bare `:` followed by `:` or `>`
      if (this.peek() !== ":" && this.peek() !== ">") bounds.push(this.type(false));
      while (this.peek() === ":") {
        this.pos++;
        bounds.push(this.type(false));
      }
      // the implicit Object class bound is not spelled out, like javap
      if (bounds.length === 1 && bounds[0] === "java.lang.Object") bounds = [];
      parts.push(bounds.length > 0 ? `${name} extends ${bounds.join(" & ")}` : name);
    }
    this.pos++; // `>`
    return `<${parts.join(",")}>`;
  }
}

/** Render a field Signature attribute (`[TypeParams] ReferenceTypeSignature`). */
function renderFieldSignature(signature: string): string {
  const r = new SigReader(signature);
  if (signature.startsWith("<")) r.typeParameters();
  const type = r.type(false);
  if (!r.eof()) throw new ClassFileError(`trailing characters in field signature: ${signature}`);
  return type;
}

/** Render a method Signature attribute: `[TypeParams](params)ret` (throws skipped). */
function renderMethodSignature(signature: string): { typeParams: string; params: string[]; ret: string } {
  const r = new SigReader(signature);
  let typeParams = "";
  if (signature.startsWith("<")) typeParams = r.typeParameters();
  r.expect("(");
  const params: string[] = [];
  while (r.peek() !== ")") {
    if (r.eof()) throw new ClassFileError(`unterminated parameters in signature: ${signature}`);
    params.push(r.type(false));
  }
  r.expect(")");
  return { typeParams, params, ret: r.type(true) };
}

interface RawAttribute {
  name: string;
  bytes: Buffer;
}

interface RawMember {
  flags: number;
  name: string;
  descriptor: string;
  attributes: RawAttribute[];
}

/** Read an attribute table into name→bytes pairs, bounds-checked per attribute. */
function readAttributes(r: Reader, pool: ConstantPool, what: string): RawAttribute[] {
  const count = r.u2(`${what} attribute count`);
  const attributes: RawAttribute[] = [];
  for (let i = 0; i < count; i++) {
    const name = utf8At(pool, r.u2(`${what} attribute ${i} name`), `${what} attribute ${i} name`);
    const length = r.u4(`${what} attribute ${name} length`);
    attributes.push({ name, bytes: r.bytes(length, `${what} attribute ${name}`) });
  }
  return attributes;
}

/** Read a fields or methods table (same layout: flags, name, descriptor, attributes). */
function readMemberTable(r: Reader, pool: ConstantPool, what: string): RawMember[] {
  const count = r.u2(`${what} count`);
  const members: RawMember[] = [];
  for (let i = 0; i < count; i++) {
    const flags = r.u2(`${what}[${i}] access flags`);
    const name = utf8At(pool, r.u2(`${what}[${i}] name index`), `${what}[${i}] name`);
    const descriptor = utf8At(pool, r.u2(`${what}[${i}] descriptor index`), `${what}[${i}] descriptor`);
    members.push({ flags, name, descriptor, attributes: readAttributes(r, pool, `${what}[${i}]`) });
  }
  return members;
}

/**
 * True when the attributes carry the `Deprecated` marker or a runtime-visible
 * annotation whose type descriptor ends `Deprecated;` — that covers
 * `Ljava/lang/Deprecated;` and custom `L…/Deprecated;` types alike. Other
 * annotations are skipped via a full element_value walk, so a nested value
 * can never be mistaken for an annotation type.
 */
function attributesAreDeprecated(attributes: RawAttribute[], pool: ConstantPool): boolean {
  if (attributes.some((a) => a.name === "Deprecated")) return true;
  const attr = attributes.find((a) => a.name === "RuntimeVisibleAnnotations");
  if (!attr) return false;
  const r = new Reader(attr.bytes);
  const count = r.u2("annotation count");
  for (let i = 0; i < count; i++) {
    if (readAnnotation(r, pool).endsWith("Deprecated;")) return true;
  }
  return false;
}

/** Read one annotation, returning its type descriptor and skipping its values. */
function readAnnotation(r: Reader, pool: ConstantPool): string {
  const type = utf8At(pool, r.u2("annotation type index"), "annotation type");
  skipAnnotationValues(r);
  return type;
}

/** Skip an annotation without resolving its type (used for nested values). */
function skipAnnotation(r: Reader): void {
  r.u2("annotation type index");
  skipAnnotationValues(r);
}

function skipAnnotationValues(r: Reader): void {
  const pairs = r.u2("annotation value pair count");
  for (let i = 0; i < pairs; i++) {
    r.u2("element name index");
    skipElementValue(r);
  }
}

/** Skip one element_value (JVMS 4.7.16.1), recursing into annotations and arrays. */
function skipElementValue(r: Reader): void {
  const tag = String.fromCharCode(r.u1("element_value tag"));
  switch (tag) {
    case "e": // enum constant: type_name_index + const_name_index
      r.skip(4, "enum element_value");
      return;
    case "c": // class literal: one index
      r.skip(2, "class element_value");
      return;
    case "@":
      skipAnnotation(r);
      return;
    case "[": {
      const count = r.u2("array element_value count");
      for (let i = 0; i < count; i++) skipElementValue(r);
      return;
    }
    default: // B C D F I J S Z s — one constant_index
      r.skip(2, "constant element_value");
  }
}

/** The Signature attribute's payload is one u2 pool index to the signature string. */
function signatureTextOf(attributes: RawAttribute[], pool: ConstantPool): string | undefined {
  const attr = attributes.find((a) => a.name === "Signature");
  if (!attr) return undefined;
  const index = new Reader(attr.bytes).u2("Signature index");
  return utf8At(pool, index, "Signature string");
}

/**
 * This class's own entry in the InnerClasses attribute, if any: nested-class
 * access flags (static, visibility) live there, not on the class-level flags.
 */
function innerClassSelfFlags(
  attributes: RawAttribute[],
  pool: ConstantPool,
  thisBinaryName: string,
): number | null {
  const attr = attributes.find((a) => a.name === "InnerClasses");
  if (!attr) return null;
  const r = new Reader(attr.bytes);
  const count = r.u2("InnerClasses count");
  for (let i = 0; i < count; i++) {
    const innerIndex = r.u2("inner_class_info index");
    r.u2("outer_class_info index"); // 0 for anonymous/member entries — never resolved
    r.u2("inner_name index");
    const flags = r.u2("inner_class_access_flags");
    if (classNameAt(pool, innerIndex, "inner_class_info") === thisBinaryName) return flags;
  }
  return null;
}

/** Record component types from the `Record` attribute, e.g. Point → ["int","int"]. */
function recordComponentTypes(attributes: RawAttribute[], pool: ConstantPool): string[] {
  const attr = attributes.find((a) => a.name === "Record");
  if (!attr) return [];
  const r = new Reader(attr.bytes);
  const count = r.u2("record component count");
  const types: string[] = [];
  for (let i = 0; i < count; i++) {
    r.u2(`record component ${i} name index`);
    const descriptor = utf8At(
      pool,
      r.u2(`record component ${i} descriptor index`),
      `record component ${i} descriptor`,
    );
    // a component may carry its own Signature attribute with the generic type
    let generic: string | undefined;
    const attrCount = r.u2(`record component ${i} attribute count`);
    for (let j = 0; j < attrCount; j++) {
      const name = utf8At(pool, r.u2("component attribute name index"), "component attribute name");
      const length = r.u4("component attribute length");
      const bytes = r.bytes(length, "component attribute");
      if (name === "Signature") {
        const index = new Reader(bytes).u2("component Signature index");
        generic = utf8At(pool, index, "component Signature");
      }
    }
    if (generic !== undefined) {
      try {
        types.push(renderFieldSignature(generic));
        continue;
      } catch (e) {
        if (!(e instanceof ClassFileError)) throw e;
      }
    }
    types.push(expandDescriptorType(descriptor, 0)[0]!);
  }
  return types;
}

/** One method → Declaration, or null for `<clinit>` (skipped by contract). */
function methodDeclaration(
  fqn: string,
  simpleName: string,
  member: RawMember,
  pool: ConstantPool,
): Declaration | null {
  if (member.name === "<clinit>") return null;
  const isConstructor = member.name === "<init>";
  const selector = isConstructor ? simpleName : member.name;
  const modifiers = memberModifiers(member.flags, true);

  let params: string[];
  let ret: string;
  let typeParams = "";
  const generic = signatureTextOf(member.attributes, pool);
  if (generic !== undefined) {
    try {
      ({ typeParams, params, ret } = renderMethodSignature(generic));
    } catch (e) {
      if (!(e instanceof ClassFileError)) throw e;
      ({ params, ret } = expandMethodDescriptor(member.descriptor));
    }
  } else {
    ({ params, ret } = expandMethodDescriptor(member.descriptor));
  }
  const signature = [
    ...modifiers,
    typeParams,
    isConstructor ? `${selector}(${params.join(",")})` : `${ret} ${selector}(${params.join(",")})`,
  ]
    .filter((s) => s.length > 0)
    .join(" ");

  return {
    fqn,
    file: "",
    selector,
    kind: isConstructor ? "constructor" : "method",
    visibility: visibilityOf(member.flags),
    static: (member.flags & ACC_STATIC) !== 0,
    deprecated: attributesAreDeprecated(member.attributes, pool),
    signature,
    ...(modifiers.length > 0 ? { modifiers } : {}),
  };
}

/** One field → Declaration; ACC_ENUM fields are the enum's constants. */
function fieldDeclaration(fqn: string, member: RawMember, pool: ConstantPool): Declaration {
  const isEnumConstant = (member.flags & ACC_ENUM) !== 0;
  const modifiers = memberModifiers(member.flags, false);

  let type: string;
  if (isEnumConstant) {
    type = ""; // constants render as their bare name, like the source lexer
  } else {
    const generic = signatureTextOf(member.attributes, pool);
    try {
      type = generic !== undefined ? renderFieldSignature(generic) : expandDescriptorType(member.descriptor, 0)[0]!;
    } catch (e) {
      if (!(e instanceof ClassFileError)) throw e;
      type = expandDescriptorType(member.descriptor, 0)[0]!;
    }
  }
  const signature = isEnumConstant ? member.name : [...modifiers, type, member.name].join(" ");

  return {
    fqn,
    file: "",
    selector: member.name,
    kind: isEnumConstant ? "enum-constant" : "field",
    visibility: visibilityOf(member.flags),
    static: (member.flags & ACC_STATIC) !== 0,
    deprecated: attributesAreDeprecated(member.attributes, pool),
    signature,
    ...(!isEnumConstant && modifiers.length > 0 ? { modifiers } : {}),
  };
}

/** Parse one compiled class buffer into a ParsedClassFile. Throws ClassFileError on malformed input. */
export function parseClassFile(buf: Buffer): ParsedClassFile {
  if (buf.length < 4 || buf.readUInt32BE(0) !== MAGIC) {
    throw new ClassFileError(`bad magic: buffer of ${buf.length} bytes is not a class file`);
  }
  const r = new Reader(buf);
  r.skip(4, "magic");
  r.u2("minor version");
  r.u2("major version");
  const pool = readConstantPool(r);

  const flags = r.u2("class access flags");
  const thisBinaryName = classNameAt(pool, r.u2("this_class index"), "this_class");
  const superIndex = r.u2("super_class index");
  const superName = superIndex === 0 ? null : classNameAt(pool, superIndex, "super_class");
  const interfaceCount = r.u2("interfaces count");
  r.skip(interfaceCount * 2, "interface list");

  const fields = readMemberTable(r, pool, "fields");
  const methods = readMemberTable(r, pool, "methods");
  const classAttributes = readAttributes(r, pool, "class");

  const isAnnotation = (flags & ACC_ANNOTATION) !== 0;
  const isEnum = (flags & ACC_ENUM) !== 0;
  const isInterface = (flags & ACC_INTERFACE) !== 0;
  // javac never sets ACC_RECORD (0x10000); records carry java/lang/Record as
  // their superclass, so both signals are honored
  const isRecord = (flags & ACC_RECORD) !== 0 || superName === "java/lang/Record";
  const kind = isAnnotation
    ? "annotation"
    : isEnum
      ? "enum"
      : isInterface
        ? "interface"
        : isRecord
          ? "record"
          : "class";

  const fqn = dottedName(thisBinaryName);
  const simpleName = fqn.slice(fqn.lastIndexOf(".") + 1);
  const innerFlags = innerClassSelfFlags(classAttributes, pool, thisBinaryName);
  const isStatic = (flags & ACC_STATIC) !== 0 || ((innerFlags ?? 0) & ACC_STATIC) !== 0;

  // class signature in the source lexer's shape: `public static class Worker`,
  // `public enum Colors`, `public record Point(int,int)`, `public @interface Res`.
  // `final`/`abstract` carry no source meaning on enums, records, and
  // interfaces (always set by javac), and neither does `static` — nested
  // enums, records, interfaces, and annotations are implicitly static.
  const classModifiers: string[] = [];
  const visibility = visibilityOf(flags);
  if (visibility !== "package") classModifiers.push(visibility);
  if (kind === "class" && isStatic) classModifiers.push("static");
  if (kind === "class") {
    if (flags & ACC_FINAL) classModifiers.push("final");
    if (flags & ACC_ABSTRACT) classModifiers.push("abstract");
  }
  let generics = "";
  const classSignature = signatureTextOf(classAttributes, pool);
  if (classSignature !== undefined && classSignature.startsWith("<")) {
    try {
      generics = new SigReader(classSignature).typeParameters();
    } catch {
      // a malformed generic signature degrades to the erased name-only form
    }
  }
  const components = isRecord ? recordComponentTypes(classAttributes, pool) : [];
  const keyword = kind === "annotation" ? "@interface" : kind;
  const signature = [
    ...classModifiers,
    `${keyword} ${simpleName}${generics}${components.length > 0 ? `(${components.join(",")})` : ""}`,
  ].join(" ");

  const members: Declaration[] = [];
  for (const field of fields) members.push(fieldDeclaration(fqn, field, pool));
  for (const method of methods) {
    const declaration = methodDeclaration(fqn, simpleName, method, pool);
    if (declaration !== null) members.push(declaration);
  }

  return {
    fqn,
    kind,
    visibility,
    static: isStatic,
    deprecated: attributesAreDeprecated(classAttributes, pool),
    signature,
    members,
  };
}
