import { type ColumnSpec, type FieldAnswer, type FieldSpec, MAX_ROWS } from "./fields.ts";
import { canonicalText, daysBetween, isReferenceLike, parseDate, withoutNoise } from "./values.ts";

/**
 * A small Python the remote model writes and this code runs over values it never sees. It is
 * an interpreter, not a sandbox around a real Python, so there is nothing to escape from: no
 * import, a fixed few attributes, no input or output, and finite loops under a step limit.
 */

export const MAX_PROGRAM_CHARS = 4_000;
const MAX_STEPS = 400_000;
/** Everything a run builds, counted as it is built and never given back. */
const MAX_ITEMS = 200_000;
const MAX_DEPTH = 40;
const MAX_TEXT = 2_000;
const MAX_EXPONENT = 64;
const MAX_LEAVES = 2_000;
const MAX_RESULT_DEPTH = 8;
const KEY_ORDER = new Intl.Collator("en", { numeric: true });

/** A fault found in the program's text, before any value is read. Safe to show the model. */
export class ProgramSyntaxError extends Error {
  readonly line: number;
  constructor(message: string, line: number, options?: ErrorOptions) {
    super(message, options);
    this.line = line;
  }
}

/** A fault met while running. What it says can depend on a value, so the model is not told. */
class ProgramRuntimeError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

type Expr =
  | { k: "num"; v: number; line: number }
  | { k: "str"; v: string; line: number }
  | { k: "const"; v: boolean | null; line: number }
  | { k: "name"; id: string; line: number }
  | { k: "unary"; op: string; e: Expr; line: number }
  | { k: "bin"; op: string; l: Expr; r: Expr; line: number }
  | { k: "bool"; op: "and" | "or"; l: Expr; r: Expr; line: number }
  | { k: "cmp"; first: Expr; rest: ReadonlyArray<readonly [string, Expr]>; line: number }
  | { k: "tern"; test: Expr; a: Expr; b: Expr; line: number }
  | {
      k: "call";
      fn: Expr;
      args: ReadonlyArray<Expr>;
      kwargs: ReadonlyArray<readonly [string, Expr]>;
      line: number;
    }
  | { k: "sub"; obj: Expr; index: Expr; line: number }
  | { k: "slice"; obj: Expr; lo: Expr | null; hi: Expr | null; line: number }
  | { k: "attr"; obj: Expr; name: string; line: number }
  | { k: "list"; items: ReadonlyArray<Expr>; tuple: boolean; distinct?: true; line: number }
  | { k: "dict"; pairs: ReadonlyArray<readonly [Expr, Expr]>; line: number }
  | {
      k: "comp";
      key: Expr | null;
      elt: Expr;
      clauses: ReadonlyArray<{ target: Expr; iter: Expr; ifs: ReadonlyArray<Expr> }>;
      line: number;
    }
  | { k: "lambda"; params: ReadonlyArray<Param>; body: Expr; line: number };

interface Param {
  readonly name: string;
  readonly fallback: Expr | null;
}

type Stmt =
  | { k: "assign"; targets: ReadonlyArray<Expr>; value: Expr; line: number }
  | { k: "aug"; target: Expr; op: string; value: Expr; line: number }
  | { k: "expr"; e: Expr; line: number }
  | {
      k: "if";
      test: Expr;
      body: ReadonlyArray<Stmt>;
      orelse: ReadonlyArray<Stmt>;
      line: number;
    }
  | { k: "for"; target: Expr; iter: Expr; body: ReadonlyArray<Stmt>; line: number }
  | {
      k: "def";
      name: string;
      params: ReadonlyArray<Param>;
      body: ReadonlyArray<Stmt>;
      line: number;
    }
  | { k: "return"; value: Expr | null; line: number }
  | { k: "pass" | "break" | "continue"; line: number };

interface Token {
  readonly t: "name" | "num" | "str" | "op" | "newline" | "indent" | "dedent" | "eof";
  readonly v: string;
  readonly line: number;
}

const KEYWORDS = new Set([
  "and",
  "or",
  "not",
  "in",
  "is",
  "if",
  "elif",
  "else",
  "for",
  "def",
  "return",
  "pass",
  "break",
  "continue",
  "lambda",
  "True",
  "False",
  "None",
]);

/** Python the subset leaves out, with what to write instead. */
const UNSUPPORTED: Readonly<Record<string, string>> = {
  while: "`while` is not supported: loop with `for` over a list or range(n).",
  import: "`import` is not supported: ceil, floor, round, date and days_between are built in.",
  from: "`import` is not supported: ceil, floor, round, date and days_between are built in.",
  class: "`class` is not supported: use dicts and functions.",
  try: "`try` is not supported: test for None instead.",
  with: "`with` is not supported.",
  raise: "`raise` is not supported.",
  assert: "`assert` is not supported.",
  global: "`global` is not supported: return the value from the function.",
  nonlocal: "`nonlocal` is not supported: return the value from the function.",
  del: "`del` is not supported.",
  yield: "`yield` is not supported: build a list.",
  async: "`async` is not supported.",
  await: "`await` is not supported.",
  match: "",
};

const OPERATORS = [
  "**=",
  "//=",
  "**",
  "//",
  "==",
  "!=",
  "<=",
  ">=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "=",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ":",
  ".",
];

const ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  "\\": "\\",
  "'": "'",
  '"': '"',
};

const tokenize = (source: string): ReadonlyArray<Token> => {
  const tokens: Array<Token> = [];
  const indents = [0];
  let depth = 0;
  let line = 1;
  let at = 0;
  let atLineStart = true;
  const fail = (message: string): never => {
    throw new ProgramSyntaxError(message, line);
  };
  while (at < source.length) {
    if (atLineStart && depth === 0) {
      let width = 0;
      while (source[at] === " " || source[at] === "\t") {
        width += source[at] === "\t" ? 8 : 1;
        at += 1;
      }
      const next = source[at];
      if (next === "\n" || next === "\r" || next === "#" || next === undefined) {
        // A blank line or a comment alone says nothing about indentation.
      } else {
        if (width > (indents.at(-1) ?? 0)) {
          indents.push(width);
          tokens.push({ t: "indent", v: "", line });
        }
        while (width < (indents.at(-1) ?? 0)) {
          indents.pop();
          tokens.push({ t: "dedent", v: "", line });
        }
        if (width !== indents.at(-1)) fail("The indentation does not match an earlier line.");
        atLineStart = false;
      }
      if (at >= source.length) break;
    }
    const character = source[at] ?? "";
    if (character === "\n") {
      if (depth === 0 && !atLineStart) tokens.push({ t: "newline", v: "", line });
      line += 1;
      at += 1;
      // Inside brackets a line break is only white space.
      atLineStart = depth === 0;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      at += 1;
      continue;
    }
    if (character === "#") {
      while (at < source.length && source[at] !== "\n") at += 1;
      continue;
    }
    if (character === "\\" && source[at + 1] === "\n") {
      at += 2;
      line += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const triple = source.startsWith(character.repeat(3), at);
      const quote = triple ? character.repeat(3) : character;
      const startLine = line;
      at += quote.length;
      let text = "";
      for (;;) {
        if (at >= source.length) fail("A string is not closed.");
        if (source.startsWith(quote, at)) break;
        const next = source[at] ?? "";
        if (next === "\n") {
          if (!triple) fail("A string is not closed.");
          line += 1;
        }
        if (next === "\\") {
          const escaped = source[at + 1] ?? "";
          text += ESCAPES[escaped] ?? `\\${escaped}`;
          at += 2;
        } else {
          text += next;
          at += 1;
        }
      }
      at += quote.length;
      tokens.push({ t: "str", v: text, line: startLine });
      continue;
    }
    const number = /^(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?/.exec(source.slice(at));
    if (number !== null) {
      tokens.push({ t: "num", v: number[0].replaceAll("_", ""), line });
      at += number[0].length;
      continue;
    }
    const name = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(source.slice(at));
    if (name !== null) {
      const word = name[0];
      const after = source[at + word.length];
      if ((word === "f" || word === "r" || word === "b") && (after === '"' || after === "'")) {
        fail(
          word === "f"
            ? "f-strings are not supported: a result is values, not text. Join words with +."
            : "String prefixes are not supported.",
        );
      }
      tokens.push({ t: "name", v: word, line });
      at += word.length;
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, at));
    if (operator === undefined) return fail(`"${character}" is not supported here.`);
    if (operator === "(" || operator === "[" || operator === "{") depth += 1;
    if (operator === ")" || operator === "]" || operator === "}") depth = Math.max(0, depth - 1);
    tokens.push({ t: "op", v: operator, line });
    at += operator.length;
  }
  if (!atLineStart) tokens.push({ t: "newline", v: "", line });
  while (indents.length > 1) {
    indents.pop();
    tokens.push({ t: "dedent", v: "", line });
  }
  tokens.push({ t: "eof", v: "", line });
  return tokens;
};

const COMPARE = new Set(["<", ">", "<=", ">=", "==", "!="]);
const AUGMENTED = new Set(["+=", "-=", "*=", "/=", "//=", "%=", "**="]);

const parse = (source: string): ReadonlyArray<Stmt> => {
  const tokens = [...tokenize(source)];
  let position = 0;
  const peek = (): Token => tokens[position] ?? { t: "eof", v: "", line: 0 };
  const next = (): Token => {
    const token = peek();
    position += 1;
    return token;
  };
  const fail = (message: string, line = peek().line): never => {
    throw new ProgramSyntaxError(message, line);
  };
  const isOp = (value: string) => peek().t === "op" && peek().v === value;
  const isWord = (value: string) => peek().t === "name" && peek().v === value;
  const take = (value: string): boolean => {
    if (!isOp(value) && !isWord(value)) return false;
    position += 1;
    return true;
  };
  const expect = (value: string): void => {
    if (!take(value)) {
      const found = peek();
      fail(`Expected "${value}" here${found.v === "" ? "" : `, not "${found.v}"`}.`);
    }
  };
  const identifier = (): string => {
    const token = next();
    if (token.t !== "name" || KEYWORDS.has(token.v)) {
      return fail("A name is expected here.", token.line);
    }
    return token.v;
  };

  const params = (closing: string): ReadonlyArray<Param> => {
    const list: Array<Param> = [];
    while (!isOp(closing)) {
      if (isOp("*") || isOp("**")) fail("*args and **kwargs are not supported.");
      const name = identifier();
      list.push({ name, fallback: take("=") ? ternary() : null });
      if (!take(",")) break;
    }
    return list;
  };

  const expression = (): Expr => {
    if (isWord("lambda")) {
      const line = next().line;
      const list = params(":");
      expect(":");
      return { k: "lambda", params: list, body: expression(), line };
    }
    return ternary();
  };
  const ternary = (): Expr => {
    const a = or();
    if (!isWord("if")) return a;
    const line = next().line;
    const test = or();
    expect("else");
    return { k: "tern", test, a, b: expression(), line };
  };
  const or = (): Expr => {
    let left = and();
    while (isWord("or")) {
      const line = next().line;
      left = { k: "bool", op: "or", l: left, r: and(), line };
    }
    return left;
  };
  const and = (): Expr => {
    let left = not();
    while (isWord("and")) {
      const line = next().line;
      left = { k: "bool", op: "and", l: left, r: not(), line };
    }
    return left;
  };
  const not = (): Expr => {
    if (!isWord("not")) return comparison();
    const line = next().line;
    return { k: "unary", op: "not", e: not(), line };
  };
  const comparison = (): Expr => {
    const first = sum();
    const rest: Array<readonly [string, Expr]> = [];
    const line = peek().line;
    for (;;) {
      const token = peek();
      let op: string | null = null;
      if (token.t === "op" && COMPARE.has(token.v)) {
        position += 1;
        op = token.v;
      } else if (isWord("in")) {
        position += 1;
        op = "in";
      } else if (isWord("not") && tokens[position + 1]?.v === "in") {
        position += 2;
        op = "not in";
      } else if (isWord("is")) {
        position += 1;
        op = take("not") ? "is not" : "is";
      }
      if (op === null) break;
      rest.push([op, sum()]);
    }
    return rest.length === 0 ? first : { k: "cmp", first, rest, line };
  };
  const sum = (): Expr => {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const token = next();
      left = { k: "bin", op: token.v, l: left, r: term(), line: token.line };
    }
    return left;
  };
  const term = (): Expr => {
    let left = unary();
    while (isOp("*") || isOp("/") || isOp("//") || isOp("%")) {
      const token = next();
      left = { k: "bin", op: token.v, l: left, r: unary(), line: token.line };
    }
    return left;
  };
  const unary = (): Expr => {
    if (isOp("-") || isOp("+")) {
      const token = next();
      return { k: "unary", op: token.v, e: unary(), line: token.line };
    }
    return power();
  };
  const power = (): Expr => {
    const base = primary();
    if (!isOp("**")) return base;
    const line = next().line;
    return { k: "bin", op: "**", l: base, r: unary(), line };
  };
  const primary = (): Expr => {
    let node = atom();
    for (;;) {
      const line = peek().line;
      if (take("(")) {
        const args: Array<Expr> = [];
        const kwargs: Array<readonly [string, Expr]> = [];
        while (!isOp(")")) {
          if (isOp("*") || isOp("**")) fail("Unpacking arguments with * is not supported.");
          if (peek().t === "name" && tokens[position + 1]?.v === "=") {
            const name = identifier();
            expect("=");
            kwargs.push([name, expression()]);
          } else {
            const value = expression();
            // `sum(x for x in xs)`: a comprehension as the only argument.
            args.push(isWord("for") ? comprehension(null, value, line) : value);
          }
          if (!take(",")) break;
        }
        expect(")");
        node = { k: "call", fn: node, args, kwargs, line };
      } else if (take("[")) {
        const lo = isOp(":") ? null : expression();
        if (take(":")) {
          const hi = isOp("]") ? null : expression();
          if (isOp(":")) fail("A slice with a step is not supported.");
          expect("]");
          node = { k: "slice", obj: node, lo, hi, line };
        } else {
          expect("]");
          node = { k: "sub", obj: node, index: lo ?? fail("An index is expected here."), line };
        }
      } else if (take(".")) {
        node = { k: "attr", obj: node, name: identifier(), line };
      } else return node;
    }
  };
  const comprehension = (key: Expr | null, elt: Expr, line: number): Expr => {
    const clauses: Array<{ target: Expr; iter: Expr; ifs: Array<Expr> }> = [];
    while (take("for")) {
      const target = targetList();
      expect("in");
      const clause = { target, iter: or(), ifs: [] as Array<Expr> };
      while (take("if")) clause.ifs.push(or());
      clauses.push(clause);
    }
    return { k: "comp", key, elt, clauses, line };
  };
  /** `a` or `a, b` or `(a, b)`: what a `for` assigns to. */
  const targetList = (): Expr => {
    const line = peek().line;
    const first = primary();
    if (!isOp(",")) return first;
    const items = [first];
    while (take(",")) {
      if (isWord("in")) break;
      items.push(primary());
    }
    return { k: "list", items, tuple: true, line };
  };
  const atom = (): Expr => {
    const token = next();
    const line = token.line;
    if (token.t === "num") return { k: "num", v: Number(token.v), line };
    if (token.t === "str") {
      let text = token.v;
      while (peek().t === "str") text += next().v;
      return { k: "str", v: text, line };
    }
    if (token.t === "name") {
      if (token.v === "True") return { k: "const", v: true, line };
      if (token.v === "False") return { k: "const", v: false, line };
      if (token.v === "None") return { k: "const", v: null, line };
      const unsupported = UNSUPPORTED[token.v];
      if (unsupported !== undefined && unsupported !== "") fail(unsupported, line);
      if (KEYWORDS.has(token.v)) fail(`"${token.v}" is not expected here.`, line);
      return { k: "name", id: token.v, line };
    }
    if (token.t === "op" && token.v === "(") {
      if (take(")")) return { k: "list", items: [], tuple: true, line };
      const first = expression();
      if (isWord("for")) {
        const made = comprehension(null, first, line);
        expect(")");
        return made;
      }
      if (!isOp(",")) {
        expect(")");
        return first;
      }
      const items = [first];
      while (take(",")) {
        if (isOp(")")) break;
        items.push(expression());
      }
      expect(")");
      return { k: "list", items, tuple: true, line };
    }
    if (token.t === "op" && token.v === "[") {
      if (take("]")) return { k: "list", items: [], tuple: false, line };
      const first = expression();
      if (isWord("for")) {
        const made = comprehension(null, first, line);
        expect("]");
        return made;
      }
      const items = [first];
      while (take(",")) {
        if (isOp("]")) break;
        items.push(expression());
      }
      expect("]");
      return { k: "list", items, tuple: false, line };
    }
    if (token.t === "op" && token.v === "{") {
      if (take("}")) return { k: "dict", pairs: [], line };
      const first = expression();
      if (take(":")) {
        const value = expression();
        if (isWord("for")) {
          const made = comprehension(first, value, line);
          expect("}");
          return made;
        }
        const pairs: Array<readonly [Expr, Expr]> = [[first, value]];
        while (take(",")) {
          if (isOp("}")) break;
          const key = expression();
          expect(":");
          pairs.push([key, expression()]);
        }
        expect("}");
        return { k: "dict", pairs, line };
      }
      // A set is only tested for membership or looped over here: a tuple of distinct values.
      const items = [first];
      while (take(",")) {
        if (isOp("}")) break;
        items.push(expression());
      }
      expect("}");
      return { k: "list", items, tuple: true, distinct: true, line };
    }
    return fail(
      token.t === "eof" || token.t === "newline"
        ? "The line ends where a value is expected."
        : `"${token.v}" is not expected here.`,
      line,
    );
  };

  const block = (): ReadonlyArray<Stmt> => {
    expect(":");
    if (peek().t !== "newline") return [simple()];
    next();
    if (next().t !== "indent") fail("An indented block is expected here.");
    const body: Array<Stmt> = [];
    while (peek().t !== "dedent" && peek().t !== "eof") body.push(statement());
    next();
    return body;
  };
  const endOfLine = (): void => {
    if (peek().t === "eof") return;
    if (next().t !== "newline") fail("One statement to a line.", tokens[position - 1]?.line);
  };
  const exprOrTuple = (): Expr => {
    const line = peek().line;
    const first = expression();
    if (!isOp(",")) return first;
    const items = [first];
    while (take(",")) {
      if (peek().t === "newline" || isOp("=")) break;
      items.push(expression());
    }
    return { k: "list", items, tuple: true, line };
  };
  const simple = (): Stmt => {
    const token = peek();
    const line = token.line;
    for (const word of ["pass", "break", "continue"] as const) {
      if (!take(word)) continue;
      endOfLine();
      return { k: word, line };
    }
    if (take("return")) {
      const value = peek().t === "newline" || peek().t === "eof" ? null : exprOrTuple();
      endOfLine();
      return { k: "return", value, line };
    }
    const first = exprOrTuple();
    const operator = peek();
    if (operator.t === "op" && AUGMENTED.has(operator.v)) {
      next();
      const value = exprOrTuple();
      endOfLine();
      return { k: "aug", target: first, op: operator.v.slice(0, -1), value, line };
    }
    if (isOp("=")) {
      const targets = [first];
      let value = first;
      while (take("=")) {
        value = exprOrTuple();
        if (isOp("=")) targets.push(value);
      }
      endOfLine();
      return { k: "assign", targets, value, line };
    }
    endOfLine();
    return { k: "expr", e: first, line };
  };
  const statement = (): Stmt => {
    const token = peek();
    const line = token.line;
    if (token.t === "indent") fail("This line is indented more than the one before it.");
    if (take("if")) {
      const test = expression();
      const body = block();
      let orelse: ReadonlyArray<Stmt> = [];
      if (isWord("elif")) {
        // Read as `else: if ...`, by leaving `if` where `elif` stood.
        tokens[position] = { t: "name", v: "if", line: peek().line };
        orelse = [statement()];
      } else if (take("else")) orelse = block();
      return { k: "if", test, body, orelse, line };
    }
    if (take("for")) {
      const target = targetList();
      expect("in");
      const iter = exprOrTuple();
      const body = block();
      if (isWord("else")) fail("`else` after a loop is not supported.");
      return { k: "for", target, iter, body, line };
    }
    if (take("def")) {
      const name = identifier();
      expect("(");
      const list = params(")");
      expect(")");
      if (isOp("-")) fail("Type annotations are not supported.");
      return { k: "def", name, params: list, body: block(), line };
    }
    return simple();
  };

  const body: Array<Stmt> = [];
  while (peek().t !== "eof") {
    if (peek().t === "newline") {
      next();
      continue;
    }
    body.push(statement());
  }
  return body;
};

/** What `x.name` may be: a document's handle, a date's parts, and a few methods. */
const ATTRIBUTES = new Set([
  "handle",
  "year",
  "month",
  "day",
  "append",
  "extend",
  "get",
  "items",
  "keys",
  "values",
  "lower",
  "upper",
  "strip",
  "startswith",
  "endswith",
]);

const BUILTINS = [
  "len",
  "sum",
  "min",
  "max",
  "abs",
  "round",
  "ceil",
  "floor",
  "int",
  "float",
  "bool",
  "sorted",
  "reversed",
  "range",
  "enumerate",
  "zip",
  "any",
  "all",
  "list",
  "tuple",
  "print",
  "date",
  "days_between",
  "add_days",
  "add_months",
  "doc",
  "reveal",
] as const;
type Builtin = (typeof BUILTINS)[number];

/** The keyword arguments each function takes. */
const KEYWORDS_OF: Partial<Record<Builtin, ReadonlyArray<string>>> = {
  sorted: ["key", "reverse"],
  min: ["key", "default"],
  max: ["key", "default"],
  sum: ["start"],
  enumerate: ["start"],
  round: ["ndigits"],
};

export interface Program {
  readonly source: string;
  readonly body: ReadonlyArray<Stmt>;
}

/**
 * Reads a program and checks everything that can be checked from its text alone, so that a
 * misspelt name is reported with its line instead of failing later, where nothing may be said.
 * `known` is every field and column name of the call, with its type where it is known.
 */
export const parseProgram = (
  source: string,
  known: ReadonlySet<string> | ReadonlyMap<string, string>,
): Program => {
  if (source.length > MAX_PROGRAM_CHARS) {
    throw new ProgramSyntaxError(`A program may be at most ${MAX_PROGRAM_CHARS} characters.`, 1);
  }
  let body: ReadonlyArray<Stmt>;
  try {
    body = parse(source);
  } catch (cause) {
    if (cause instanceof RangeError) {
      throw new ProgramSyntaxError("The program is nested too deeply.", 1, { cause });
    }
    throw cause;
  }
  const assigned = new Set<string>(["docs", ...BUILTINS]);
  const keys = new Set<string>(known.keys());
  /** Keys the program sets itself, as dict keys compare. */
  const ownKeys = new Set<string>();
  const typeOf = (name: string) => (known instanceof Map ? known.get(name) : undefined);
  const reveals: Array<Extract<Expr, { k: "call" }>> = [];
  // A dict keyed by values has keys the text does not show, so its lookups cannot be checked.
  let keyedByValue = false;
  const name = (id: string, line: number): string => {
    if (id === "reveal") throw new ProgramSyntaxError(REVEAL_CALLED, line);
    return id;
  };
  const bind = (target: Expr): void => {
    if (target.k === "name") assigned.add(name(target.id, target.line));
    else if (target.k === "list") target.items.forEach(bind);
    else if (target.k === "sub") {
      // A loop's target is read too: `for f(x)[0] in ...` calls f.
      visit(target.obj);
      visit(target.index);
      if (target.index.k === "str") {
        keys.add(target.index.v);
        ownKeys.add(canonicalText(target.index.v));
      } else keyedByValue = true;
    } else throw new ProgramSyntaxError("This cannot be assigned to.", target.line);
  };
  const loads: Array<{ id: string; line: number }> = [];
  const reads: Array<{ key: string; line: number }> = [];
  const visit = (node: Expr): void => {
    switch (node.k) {
      case "name":
        if (node.id === "reveal") throw new ProgramSyntaxError(REVEAL_CALLED, node.line);
        loads.push({ id: node.id, line: node.line });
        return;
      case "unary":
        return visit(node.e);
      case "bin":
      case "bool":
        visit(node.l);
        return visit(node.r);
      case "cmp":
        visit(node.first);
        return node.rest.forEach(([, operand]) => visit(operand));
      case "tern":
        visit(node.test);
        visit(node.a);
        return visit(node.b);
      case "call": {
        // reveal() is called by its name and never passed around: its answers are checked here.
        if (node.fn.k === "name" && node.fn.id === "reveal") reveals.push(node);
        else visit(node.fn);
        node.args.forEach(visit);
        node.kwargs.forEach(([, value]) => visit(value));
        const first = node.args[0];
        if (node.fn.k === "attr" && node.fn.name === "get" && first?.k === "str") {
          reads.push({ key: first.v, line: node.line });
        }
        return;
      }
      case "sub":
        visit(node.obj);
        if (node.index.k === "str") reads.push({ key: node.index.v, line: node.line });
        return visit(node.index);
      case "slice":
        visit(node.obj);
        if (node.lo !== null) visit(node.lo);
        if (node.hi !== null) visit(node.hi);
        return;
      case "attr":
        if (node.obj.k === "name" && node.obj.id === "math") {
          throw new ProgramSyntaxError(
            "`math` is not available: ceil, floor, round, abs, min and max are built in.",
            node.line,
          );
        }
        if (!ATTRIBUTES.has(node.name)) {
          throw new ProgramSyntaxError(
            `".${node.name}" is not supported. There are: ${[...ATTRIBUTES].join(", ")}.`,
            node.line,
          );
        }
        return visit(node.obj);
      case "list":
        return node.items.forEach(visit);
      case "dict":
        for (const [key, value] of node.pairs) {
          if (key.k === "str") {
            keys.add(key.v);
            ownKeys.add(canonicalText(key.v));
          } else keyedByValue = true;
          visit(key);
          visit(value);
        }
        return;
      case "comp":
        for (const clause of node.clauses) {
          bind(clause.target);
          visit(clause.iter);
          clause.ifs.forEach(visit);
        }
        if (node.key !== null) {
          keyedByValue = true;
          visit(node.key);
        }
        return visit(node.elt);
      case "lambda":
        for (const parameter of node.params) {
          assigned.add(name(parameter.name, node.line));
          if (parameter.fallback !== null) visit(parameter.fallback);
        }
        return visit(node.body);
      default:
        return;
    }
  };
  const walk = (statements: ReadonlyArray<Stmt>, inLoop: boolean, inFunction: boolean): void => {
    for (const statement of statements) {
      switch (statement.k) {
        case "assign":
          for (const target of statement.targets) {
            bind(target);
            if (target.k !== "name") visit(target);
          }
          visit(statement.value);
          break;
        case "aug":
          bind(statement.target);
          visit(statement.target);
          visit(statement.value);
          break;
        case "expr":
          visit(statement.e);
          break;
        case "if":
          visit(statement.test);
          walk(statement.body, inLoop, inFunction);
          walk(statement.orelse, inLoop, inFunction);
          break;
        case "for":
          bind(statement.target);
          visit(statement.iter);
          walk(statement.body, true, inFunction);
          break;
        case "def":
          assigned.add(name(statement.name, statement.line));
          for (const parameter of statement.params) {
            assigned.add(name(parameter.name, statement.line));
            if (parameter.fallback !== null) visit(parameter.fallback);
          }
          walk(statement.body, false, true);
          break;
        case "return":
          if (!inFunction) {
            throw new ProgramSyntaxError(
              "`return` outside a function: assign `result` instead.",
              statement.line,
            );
          }
          if (statement.value !== null) visit(statement.value);
          break;
        case "break":
        case "continue":
          if (!inLoop) {
            throw new ProgramSyntaxError(`\`${statement.k}\` outside a loop.`, statement.line);
          }
          break;
        default:
          break;
      }
    }
  };
  walk(body, false, false);
  for (const { id, line } of loads) {
    if (assigned.has(id)) continue;
    throw new ProgramSyntaxError(
      id === "math"
        ? "`math` is not available: ceil, floor, round, abs, min and max are built in."
        : `"${id}" is not defined. The functions are: ${BUILTINS.join(", ")}.`,
      line,
    );
  }
  for (const { key, line } of reads) {
    if (keys.has(key) || keyedByValue) continue;
    throw new ProgramSyntaxError(
      `"${key}" is not a field or a column of this call, nor a key the program sets.`,
      line,
    );
  }
  if (!assigned.has("result")) {
    throw new ProgramSyntaxError("The program never assigns `result`.", 1);
  }
  for (const call of reveals) {
    const problem = revealProblem(call, (key) =>
      ownKeys.has(canonicalText(key)) || keyedByValue ? "set" : typeOf(key),
    );
    if (problem !== null) throw new ProgramSyntaxError(problem, call.line);
  }
  return { source, body };
};

/** What these return is never a yes or no. */
const NOT_YES_OR_NO = new Set([
  "len",
  "sum",
  "abs",
  "round",
  "ceil",
  "floor",
  "int",
  "float",
  "sorted",
  "reversed",
  "range",
  "enumerate",
  "zip",
  "list",
  "tuple",
  "date",
  "days_between",
  "add_days",
  "add_months",
  "doc",
]);
const ARITHMETIC = new Set(["+", "-", "*", "/", "//", "%", "**"]);

/**
 * Why a call of reveal() cannot work, judged from the text alone. `fieldType` gives a field's
 * type, "set" for a key the program sets itself, or undefined when not known.
 */
const revealProblem = (
  call: Extract<Expr, { k: "call" }>,
  fieldType: (key: string) => string | undefined,
): string | null => {
  const [value, choices, ...more] = call.args;
  if (value === undefined || more.length > 0 || call.kwargs.length > 0) {
    return "reveal() takes a yes or no, or a value and the list of answers it can be.";
  }
  if (choices !== undefined) {
    const options = (choices.k === "list" ? choices.items : []).map((option) =>
      option.k === "str" && option.v.trim() !== "" && option.v.length <= 60
        ? `s:${canonicalText(option.v)}`
        : option.k === "num" && Number.isFinite(option.v)
          ? `n:${clean(option.v)}`
          : option.k === "unary" &&
              option.op !== "not" &&
              option.e.k === "num" &&
              Number.isFinite(option.e.v)
            ? `n:${clean(option.op === "-" ? -option.e.v : option.e.v)}`
            : null,
    );
    const literal =
      options.every((option) => option?.startsWith("s:")) ||
      options.every((option) => option?.startsWith("n:"));
    const distinct = new Set(options);
    return literal &&
      options.length >= 2 &&
      options.length <= MAX_REVEAL_OPTIONS &&
      distinct.size === options.length
      ? null
      : `The answers reveal() may show must be a list of 2 to ${MAX_REVEAL_OPTIONS} different words, or numbers, written in the program, such as reveal(n, [0, 1, 2, 3]).`;
  }
  const plainlyNot =
    value.k === "num" ||
    value.k === "str" ||
    value.k === "list" ||
    value.k === "dict" ||
    value.k === "comp" ||
    value.k === "lambda" ||
    (value.k === "const" && value.v === null) ||
    (value.k === "unary" && value.op !== "not") ||
    (value.k === "bin" && ARITHMETIC.has(value.op)) ||
    (value.k === "call" && value.fn.k === "name" && NOT_YES_OR_NO.has(value.fn.id)) ||
    (value.k === "sub" &&
      value.index.k === "str" &&
      ![undefined, "set", "boolean"].includes(fieldType(value.index.v)));
  return plainlyNot ? REVEAL_YES_OR_NO : null;
};

/** The document's own spelling of a stated value, kept while the program leaves it untouched. */
interface Stated {
  readonly written: string;
}

/** What `reveal()` chose among, as the program wrote each option; any operation drops it. */
type Revealed = ReadonlyArray<string>;

type Value =
  | { readonly t: "none" }
  | { readonly t: "bool"; readonly v: boolean; readonly revealed?: Revealed }
  | {
      readonly t: "num";
      readonly v: number;
      readonly stated?: Stated;
      readonly revealed?: Revealed;
    }
  | { readonly t: "date"; readonly v: string; readonly stated?: Stated }
  | {
      readonly t: "str";
      readonly v: string;
      /** Written in the program's own text, or a handle: not a word of any document. */
      readonly clear: boolean;
      readonly stated?: Stated;
      readonly revealed?: Revealed;
    }
  | { readonly t: "list"; readonly v: Array<Value>; readonly tuple: boolean }
  | { readonly t: "dict"; readonly v: Map<string, readonly [Value, Value]> }
  | { readonly t: "doc"; readonly handle: string; readonly fields: ReadonlyMap<string, Value> }
  | {
      readonly t: "fn";
      readonly params: ReadonlyArray<Param>;
      readonly body: ReadonlyArray<Stmt> | Expr;
      readonly scope: Scope;
    }
  | { readonly t: "builtin"; readonly name: Builtin }
  | { readonly t: "method"; readonly self: Value; readonly name: string };

const NONE: Value = { t: "none" };
const YES_OR_NO: Revealed = ["true", "false"];
const MAX_REVEAL_OPTIONS = 16;
const REVEAL_CALLED = "reveal is only called, as reveal(...): it cannot be named otherwise.";
const REVEAL_YES_OR_NO =
  "reveal() shows a yes or no, such as reveal(n > 0). To show a count or a choice, list the possible answers in the program: reveal(n, [0, 1, 2, 3]).";
const bool = (v: boolean): Value => ({ t: "bool", v });
const literal = (v: string): Value => ({ t: "str", v, clear: true });

class Scope {
  readonly vars = new Map<string, Value>();
  readonly parent: Scope | null;
  constructor(parent: Scope | null) {
    this.parent = parent;
  }
  get(name: string): Value | undefined {
    return this.vars.get(name) ?? this.parent?.get(name);
  }
}

/** One value of a program's result. `shown`: the program asked for it to be given in clear. */
export interface ProgramLeaf {
  readonly type: "number" | "date" | "text" | "boolean" | "none";
  readonly value: number | string | boolean | null;
  /** The document's own spelling, for a stated value the program passed through unchanged. */
  readonly written?: string;
  readonly shown: boolean;
  /** For a value shown: the answers it was one of, two for a yes or no. */
  readonly options?: ReadonlyArray<string>;
}

export type ProgramOutput =
  | { readonly leaf: ProgramLeaf }
  | { readonly list: ReadonlyArray<ProgramOutput> }
  | { readonly dict: ReadonlyArray<readonly [string, ProgramOutput]> };

export type ProgramRun =
  | {
      readonly ok: true;
      readonly output: ProgramOutput;
      /** Handles of the documents it read a field of, in the order first read. */
      readonly read: ReadonlyArray<string>;
    }
  | {
      readonly ok: false;
      /** For the person's record only: it can depend on a value. */
      readonly detail: string;
      readonly read: ReadonlyArray<string>;
    };

const cellValue = (answer: FieldAnswer): Value => {
  if (answer.status !== "ok" || answer.value === null) return NONE;
  const stated = answer.surface === null ? undefined : { written: answer.surface };
  switch (answer.type) {
    case "boolean":
      return bool(answer.value === true);
    case "number":
      return { t: "num", v: Number(answer.value), ...(stated === undefined ? {} : { stated }) };
    case "date":
      return { t: "date", v: String(answer.value), ...(stated === undefined ? {} : { stated }) };
    case "list":
      return {
        t: "list",
        tuple: false,
        v: (answer.rows ?? []).map((cells): Value => ({
          t: "dict",
          v: new Map(
            cells.map((cell) => [
              dictKey(literal(cell.name)),
              [literal(cell.name), cellValue(cell)],
            ]),
          ),
        })),
      };
    default:
      return {
        t: "str",
        v: String(answer.value),
        clear: false,
        ...(stated === undefined ? {} : { stated }),
      };
  }
};

/**
 * Arithmetic here is Python's, binary noise and all. The noise is taken off only where a number
 * is compared, rounded, used as a key or written, so `0.1 + 0.2 == 0.3` and `1 / 3 * 3 == 1`.
 */
const clean = (value: number): number => withoutNoise(value, 14);

/** A dict is keyed by what a reader would call the same value, as stand-ins are. */
const dictKey = (key: Value): string => {
  switch (key.t) {
    case "str":
      return `s:${canonicalText(key.v)}`;
    case "num":
      return `n:${clean(key.v)}`;
    case "bool":
      return `n:${key.v ? 1 : 0}`;
    case "date":
      return `d:${key.v}`;
    case "none":
      return "none";
    default:
      throw new TypeError("This cannot be a dict key.");
  }
};

const truthy = (value: Value): boolean => {
  switch (value.t) {
    case "none":
      return false;
    case "bool":
      return value.v;
    case "num":
      return value.v !== 0;
    case "str":
      return value.v.length > 0;
    case "list":
      return value.v.length > 0;
    case "dict":
      return value.v.size > 0;
    default:
      return true;
  }
};

/** `spend` is charged for every value looked at, so comparing shared, nested lists still ends. */
const equal = (a: Value, b: Value, spend: () => void): boolean => {
  spend();
  if (a.t === "none" || b.t === "none") return a.t === b.t;
  if ((a.t === "num" || a.t === "bool") && (b.t === "num" || b.t === "bool")) {
    return clean(Number(a.v)) === clean(Number(b.v));
  }
  // Text is one way everywhere, as dict keys are: a reader's notion of the same value.
  if (a.t === "str" && b.t === "str") return canonicalText(a.v) === canonicalText(b.v);
  if (a.t === "date" && b.t === "date") return a.v === b.v;
  if (a.t === "list" && b.t === "list") {
    return (
      a.v.length === b.v.length &&
      a.v.every((item, index) => equal(item, b.v[index] ?? NONE, spend))
    );
  }
  if (a.t === "dict" && b.t === "dict") {
    if (a.v.size !== b.v.size) return false;
    for (const [key, [, value]] of a.v) {
      const other = b.v.get(key);
      if (other === undefined || !equal(value, other[1], spend)) return false;
    }
    return true;
  }
  if (a.t === "doc" && b.t === "doc") return a.handle === b.handle;
  return a === b;
};

const DAY_MS = 86_400_000;
/** A day as `YYYY-MM-DD`, or null outside the years a four-digit date can write. */
const isoDay = (ms: number): string | null => {
  if (!Number.isFinite(ms)) return null;
  const moved = new Date(ms);
  const year = moved.getUTCFullYear();
  return year >= 1000 && year <= 9999 ? moved.toISOString().slice(0, 10) : null;
};
const shiftDays = (iso: string, days: number): string | null =>
  isoDay(Date.parse(`${iso}T00:00:00Z`) + Math.round(days) * DAY_MS);

/** Halves go away from zero on the decimal value, as documents mean, not to even on the binary one. */
const roundHalfAway = (value: number, digits: number): number => {
  const places = Math.max(-15, Math.min(15, Math.trunc(digits)));
  const size = clean(Math.abs(value));
  // Shifting the decimal point in the text avoids 1.005 * 100 being 100.49999999999999.
  const whole = String(Math.round(Number(`${size}e${places}`)));
  const rounded =
    String(size).includes("e") || whole.includes("e")
      ? Math.round(size * 10 ** places) / 10 ** places
      : Number(`${whole}e${-places}`);
  return value < 0 ? -rounded : rounded;
};

/**
 * Runs a parsed program over the checked answers of one call. It never throws: a fault while
 * running comes back as `ok: false`, with the documents read up to then.
 */
export const runProgram = (
  program: Program,
  results: ReadonlyArray<{ readonly handle: string; readonly fields: ReadonlyArray<FieldAnswer> }>,
  fields: ReadonlyArray<FieldSpec>,
  { trial = false }: { readonly trial?: boolean } = {},
): ProgramRun => {
  const read = new Set<string>();
  let steps = 0;
  let items = 0;
  let depth = 0;
  let line = 1;
  const fail = (message: string): never => {
    throw new ProgramRuntimeError(message, line);
  };
  const spend = (count: number): void => {
    steps += count;
    if (steps > MAX_STEPS) fail("The program ran too long.");
  };
  const tick = (): void => spend(1);
  const grow = (count: number): void => {
    items += count;
    if (items > MAX_ITEMS) fail("The program built too much.");
  };
  const number = (value: number): Value => {
    if (!Number.isFinite(value)) return fail("A number is out of range.");
    return { t: "num", v: value };
  };
  const asNumber = (value: Value): number =>
    value.t === "num"
      ? value.v
      : value.t === "bool"
        ? Number(value.v)
        : fail(`A number is needed, not ${describe(value)}.`);
  const describe = (value: Value): string =>
    value.t === "none" ? "None" : value.t === "num" ? "a number" : `a ${value.t}`;
  const list = (values: Array<Value>, tuple = false): Value => {
    grow(values.length);
    return { t: "list", v: values, tuple };
  };
  const text = (value: string, clear: boolean): Value => {
    if (value.length > MAX_TEXT) return fail("A text is too long.");
    return { t: "str", v: value, clear };
  };

  // An empty list stands for a list the document does not state, so a loop over it just ends.
  // A list that failed its check stays None: summed as empty it would be a silent zero.
  const listFields = new Set(fields.filter((field) => field.type === "list").map((f) => f.name));
  const documents: ReadonlyArray<Value> = results.map((result) => ({
    t: "doc",
    handle: result.handle,
    fields: new Map(
      result.fields.map((answer) => {
        const value = cellValue(answer);
        const empty = answer.status === "absent" && listFields.has(answer.name);
        return [answer.name, empty ? list([]) : value];
      }),
    ),
  }));

  /** Charged by length: `any(big)` inside a loop is as much work as a loop over `big`. */
  const iterate = (value: Value): ReadonlyArray<Value> => {
    if (value.t === "list") {
      spend(value.v.length);
      return value.v;
    }
    if (value.t === "dict") {
      spend(value.v.size);
      return [...value.v.values()].map(([key]) => key);
    }
    if (value.t === "str") {
      spend(value.v.length);
      return [...value.v].map((character) => text(character, value.clear));
    }
    return fail(`${describe(value)} cannot be looped over.`);
  };
  const same = (a: Value, b: Value): boolean => equal(a, b, tick);

  const order = (a: Value, b: Value): number => {
    tick();
    if ((a.t === "num" || a.t === "bool") && (b.t === "num" || b.t === "bool")) {
      return clean(Number(a.v)) - clean(Number(b.v));
    }
    if (a.t === "date" && b.t === "date") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    if (a.t === "str" && b.t === "str") {
      const left = canonicalText(a.v);
      const right = canonicalText(b.v);
      return left < right ? -1 : left > right ? 1 : 0;
    }
    if (a.t === "list" && b.t === "list") {
      for (let index = 0; index < Math.min(a.v.length, b.v.length); index += 1) {
        const step = order(a.v[index] ?? NONE, b.v[index] ?? NONE);
        if (step !== 0) return step;
      }
      return a.v.length - b.v.length;
    }
    return fail(`${describe(a)} and ${describe(b)} cannot be put in order.`);
  };

  const contains = (container: Value, item: Value): boolean => {
    if (container.t === "list") return container.v.some((candidate) => same(candidate, item));
    if (container.t === "dict") return container.v.has(keyOf(item));
    if (container.t === "str" && item.t === "str") {
      return canonicalText(container.v).includes(canonicalText(item.v));
    }
    return fail(`"in" needs a list, a dict or a text, not ${describe(container)}.`);
  };
  /** As Python does, a key keeps the spelling it was first set with. */
  const put = (map: Map<string, readonly [Value, Value]>, key: Value, value: Value): void => {
    const at = keyOf(key);
    map.set(at, [map.get(at)?.[0] ?? key, value]);
  };
  const keyOf = (key: Value): string => {
    try {
      return dictKey(key);
    } catch {
      return fail(`${describe(key)} cannot be a dict key.`);
    }
  };

  const binary = (op: string, a: Value, b: Value): Value => {
    if (a.t === "date" || b.t === "date") {
      if (op === "-" && a.t === "date" && b.t === "date") return number(daysBetween(b.v, a.v));
      const date = a.t === "date" ? a : b.t === "date" ? b : null;
      const days = a.t === "date" ? b : a;
      if (date !== null && (op === "+" || (op === "-" && a.t === "date"))) {
        const moved = shiftDays(date.v, asNumber(days) * (op === "+" ? 1 : -1));
        return moved === null ? fail("That date is out of range.") : { t: "date", v: moved };
      }
      return fail(`"${op}" does not work on a date here.`);
    }
    if (op === "+" && a.t === "str" && b.t === "str") return text(a.v + b.v, a.clear && b.clear);
    if (op === "+" && a.t === "list" && b.t === "list") return list([...a.v, ...b.v], a.tuple);
    if (op === "*" && (a.t === "list" || b.t === "list")) {
      const sequence = a.t === "list" ? a : b.t === "list" ? b : null;
      const times = Math.max(0, Math.trunc(asNumber(a.t === "list" ? b : a)));
      if (sequence === null) return fail("A list is needed.");
      if (sequence.v.length === 0 || times === 0) return list([], sequence.tuple);
      if (sequence.v.length * times > MAX_ITEMS) return fail("The program built too much.");
      return list(Array.from({ length: times }, () => sequence.v).flat(), sequence.tuple);
    }
    const x = asNumber(a);
    const y = asNumber(b);
    switch (op) {
      case "+":
        return number(x + y);
      case "-":
        return number(x - y);
      case "*":
        return number(x * y);
      case "/":
        return y === 0 ? fail("Division by zero.") : number(x / y);
      case "//":
        return y === 0 ? fail("Division by zero.") : number(Math.floor(clean(x / y)));
      case "%": {
        if (y === 0) return fail("Division by zero.");
        const rest = x - y * Math.floor(clean(x / y));
        // 0.3 % 0.1 is nothing left over, not a sliver of binary noise.
        return number(Math.abs(rest) <= Math.abs(y) * 1e-12 ? 0 : rest);
      }
      case "**":
        return Math.abs(y) > MAX_EXPONENT ? fail("That power is too large.") : number(x ** y);
      default:
        return fail(`"${op}" is not supported.`);
    }
  };

  const compare = (op: string, a: Value, b: Value): boolean => {
    switch (op) {
      case "==":
        return same(a, b);
      case "!=":
        return !same(a, b);
      case "is":
        return a.t === "none" || b.t === "none" ? a.t === b.t : same(a, b);
      case "is not":
        return a.t === "none" || b.t === "none" ? a.t !== b.t : !same(a, b);
      case "in":
        return contains(b, a);
      case "not in":
        return !contains(b, a);
      case "<":
        return order(a, b) < 0;
      case "<=":
        return order(a, b) <= 0;
      case ">":
        return order(a, b) > 0;
      default:
        return order(a, b) >= 0;
    }
  };

  const assign = (target: Expr, value: Value, scope: Scope): void => {
    if (target.k === "name") {
      scope.vars.set(target.id, value);
    } else if (target.k === "list") {
      const parts = iterate(value);
      if (parts.length !== target.items.length) {
        fail(`${target.items.length} names cannot take ${parts.length} values.`);
      }
      target.items.forEach((item, index) => assign(item, parts[index] ?? NONE, scope));
    } else if (target.k === "sub") {
      const container = evaluate(target.obj, scope);
      const index = evaluate(target.index, scope);
      if (container.t === "dict") {
        if (!container.v.has(keyOf(index))) grow(1);
        put(container.v, index, value);
      } else if (container.t === "list" && !container.tuple) {
        const at = position(container.v.length, index);
        if (at < 0 || at >= container.v.length) fail("A list index is out of range.");
        container.v[at] = value;
      } else fail(`${describe(container)} cannot be assigned into.`);
    } else fail("This cannot be assigned to.");
  };
  const position = (length: number, index: Value): number => {
    const at = Math.trunc(asNumber(index));
    return at < 0 ? length + at : at;
  };

  const call = (
    fn: Value,
    args: ReadonlyArray<Value>,
    kwargs: ReadonlyMap<string, Value>,
  ): Value => {
    if (fn.t === "builtin") return builtin(fn.name, args, kwargs);
    if (fn.t === "method") return method(fn.self, fn.name, args);
    if (fn.t !== "fn") return fail(`${describe(fn)} cannot be called.`);
    if (depth >= MAX_DEPTH) return fail("Functions call each other too deeply.");
    if (args.length > fn.params.length) fail("A function was given too many values.");
    const scope = new Scope(fn.scope);
    fn.params.forEach((parameter, index) => {
      const given = args[index] ?? kwargs.get(parameter.name);
      if (given !== undefined) scope.vars.set(parameter.name, given);
      else if (parameter.fallback !== null) {
        scope.vars.set(parameter.name, evaluate(parameter.fallback, fn.scope));
      } else fail(`A function was not given "${parameter.name}".`);
    });
    for (const name of kwargs.keys()) {
      if (!fn.params.some((parameter) => parameter.name === name)) {
        fail(`A function has no "${name}".`);
      }
    }
    depth += 1;
    try {
      if (!Array.isArray(fn.body)) return evaluate(fn.body as Expr, scope);
      const signal = run(fn.body as ReadonlyArray<Stmt>, scope);
      return signal?.k === "return" ? signal.value : NONE;
    } finally {
      depth -= 1;
    }
  };

  const keyed = (kwargs: ReadonlyMap<string, Value>): ((value: Value) => Value) => {
    const key = kwargs.get("key");
    return key === undefined || key.t === "none"
      ? (value) => value
      : (value) => call(key, [value], new Map());
  };
  /** The values of `f(a, b, c)` or `f([a, b, c])`. */
  const spread = (args: ReadonlyArray<Value>): ReadonlyArray<Value> =>
    args.length === 1 && args[0] !== undefined ? iterate(args[0]) : args;
  const dateOf = (value: Value | undefined): string =>
    value?.t === "date" ? value.v : fail("A date is needed here.");

  const builtin = (
    name: Builtin,
    args: ReadonlyArray<Value>,
    kwargs: ReadonlyMap<string, Value>,
  ): Value => {
    // A keyword Python has and this does not is a fault, not something to pass over.
    for (const keyword of kwargs.keys()) {
      if (!(KEYWORDS_OF[name] ?? []).includes(keyword)) {
        fail(`${name}() takes no "${keyword}".`);
      }
    }
    const first = args[0] ?? NONE;
    switch (name) {
      case "len":
        return first.t === "str"
          ? number(first.v.length)
          : first.t === "dict"
            ? number(first.v.size)
            : first.t === "list"
              ? number(first.v.length)
              : fail(`len() of ${describe(first)}.`);
      case "sum":
        return iterate(first).reduce(
          (total, item) => binary("+", total, item),
          args[1] ?? kwargs.get("start") ?? number(0),
        );
      case "min":
      case "max": {
        const values = spread(args);
        if (values.length === 0) return kwargs.get("default") ?? fail(`${name}() of nothing.`);
        const by = keyed(kwargs);
        let best = values[0] ?? NONE;
        let bestKey = by(best);
        for (const candidate of values.slice(1)) {
          const key = by(candidate);
          if (name === "min" ? order(key, bestKey) < 0 : order(key, bestKey) > 0) {
            best = candidate;
            bestKey = key;
          }
        }
        return best;
      }
      case "abs":
        return number(Math.abs(asNumber(first)));
      case "round":
        return number(
          roundHalfAway(asNumber(first), asNumber(args[1] ?? kwargs.get("ndigits") ?? number(0))),
        );
      case "ceil":
        return number(Math.ceil(clean(asNumber(first))));
      case "floor":
        return number(Math.floor(clean(asNumber(first))));
      case "int":
        return number(Math.trunc(clean(asNumber(first))));
      case "float":
        return number(asNumber(first));
      case "bool":
        return bool(truthy(first));
      case "sorted": {
        const by = keyed(kwargs);
        const rows = iterate(first).map((value) => ({ value, key: by(value) }));
        // Reversed in the comparison and not afterwards, so equal keys keep their order.
        const direction = truthy(kwargs.get("reverse") ?? NONE) ? -1 : 1;
        rows.sort((a, b) => direction * order(a.key, b.key));
        return list(rows.map((row) => row.value));
      }
      case "reversed":
        return list(iterate(first).toReversed());
      case "range": {
        const [start, stop, step] =
          args.length === 1
            ? [0, asNumber(first), 1]
            : [asNumber(first), asNumber(args[1] ?? NONE), asNumber(args[2] ?? number(1))];
        if (step === 0) return fail("range() with a step of zero.");
        const count = Math.max(0, Math.ceil((stop - start) / step));
        if (count > MAX_ITEMS) return fail("The program built too much.");
        return list(Array.from({ length: count }, (_, index) => number(start + index * step)));
      }
      case "enumerate": {
        const start = asNumber(args[1] ?? kwargs.get("start") ?? number(0));
        return list(iterate(first).map((item, index) => list([number(start + index), item], true)));
      }
      case "zip": {
        const columns = args.map(iterate);
        const length = Math.min(...columns.map((column) => column.length));
        return list(
          Array.from({ length: columns.length === 0 ? 0 : length }, (_, index) =>
            list(
              columns.map((column) => column[index] ?? NONE),
              true,
            ),
          ),
        );
      }
      case "any":
        return bool(iterate(first).some(truthy));
      case "all":
        return bool(iterate(first).every(truthy));
      case "list":
        return list(args.length === 0 ? [] : [...iterate(first)]);
      case "tuple":
        return list(args.length === 0 ? [] : [...iterate(first)], true);
      case "print":
        return NONE;
      case "date": {
        if (first.t === "date") return first;
        const parsed =
          args.length === 3
            ? parseDate(
                `${asNumber(first)}-${asNumber(args[1] ?? NONE)}-${asNumber(args[2] ?? NONE)}`,
              )
            : first.t === "str"
              ? parseDate(first.v)
              : null;
        return parsed === null ? fail("That is not a date.") : { t: "date", v: parsed.iso };
      }
      case "days_between":
        return number(daysBetween(dateOf(args[0]), dateOf(args[1])));
      case "add_days": {
        const moved = shiftDays(dateOf(args[0]), asNumber(args[1] ?? NONE));
        return moved === null ? fail("That date is out of range.") : { t: "date", v: moved };
      }
      case "add_months": {
        const [year = 0, month = 1, day = 1] = dateOf(args[0]).split("-").map(Number);
        const months = year * 12 + (month - 1) + Math.trunc(asNumber(args[1] ?? NONE));
        const y = Math.floor(months / 12);
        const m = months - y * 12;
        // The last day of a shorter month stands in for a day it does not have.
        if (y < 1000 || y > 9999) return fail("That date is out of range.");
        const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const moved = isoDay(Date.UTC(y, m, Math.min(day, last)));
        return moved === null ? fail("That date is out of range.") : { t: "date", v: moved };
      }
      case "doc": {
        const wanted = first.t === "str" ? first.v : "";
        return (
          documents.find((document) => document.t === "doc" && document.handle === wanted) ??
          fail("No such document is part of this call.")
        );
      }
      case "reveal": {
        const choices = args[1];
        if (choices === undefined) {
          return first.t === "bool"
            ? { t: "bool", v: first.v, revealed: YES_OR_NO }
            : fail(REVEAL_YES_OR_NO);
        }
        const options = iterate(choices);
        const kind = options[0]?.t === "num" ? "num" : "str";
        // Checked in the text already; checked again so no path round that check shows more.
        const labels = new Set(options.map((option) => keyOf(option)));
        if (
          options.length < 2 ||
          options.length > MAX_REVEAL_OPTIONS ||
          labels.size !== options.length ||
          options.some((option) => option.t !== kind)
        ) {
          return fail("reveal() needs 2 to 16 different words, or numbers, to choose from.");
        }
        if (first.t !== kind) {
          return fail(
            `reveal() was given ${kind === "num" ? "numbers" : "words"} to choose from, and ${describe(first)}.`,
          );
        }
        const revealed = options.map((option) =>
          option.t === "num" ? String(clean(option.v)) : option.t === "str" ? option.v : "",
        );
        // A trial run's values are made up, so which option they match means nothing.
        const chosen = trial ? options[0] : options.find((option) => same(option, first));
        if (chosen?.t === "str") return { ...chosen, revealed };
        if (chosen?.t === "num") return { t: "num", v: chosen.v, revealed };
        return fail("The value is none of the options reveal() was given.");
      }
    }
  };

  const method = (self: Value, name: string, args: ReadonlyArray<Value>): Value => {
    const first = args[0] ?? NONE;
    if (self.t === "list" && !self.tuple) {
      if (name === "append") {
        grow(1);
        self.v.push(first);
        return NONE;
      }
      if (name === "extend") {
        const more = iterate(first);
        grow(more.length);
        self.v.push(...more);
        return NONE;
      }
    }
    if (self.t === "dict") {
      if (name === "get") return self.v.get(keyOf(first))?.[1] ?? args[1] ?? NONE;
      if (name === "keys") return list([...self.v.values()].map(([key]) => key));
      if (name === "values") return list([...self.v.values()].map(([, value]) => value));
      if (name === "items") {
        return list([...self.v.values()].map(([key, value]) => list([key, value], true)));
      }
    }
    if (self.t === "doc" && name === "get") {
      if (first.t !== "str") return fail("A field is named by a text.");
      read.add(self.handle);
      return self.fields.get(first.v) ?? args[1] ?? NONE;
    }
    if (self.t === "str") {
      if (name === "lower") return text(self.v.toLowerCase(), self.clear);
      if (name === "upper") return text(self.v.toUpperCase(), self.clear);
      if (name === "strip") return text(self.v.trim(), self.clear);
      if (first.t === "str" && (name === "startswith" || name === "endswith")) {
        const whole = canonicalText(self.v);
        const part = canonicalText(first.v);
        return bool(name === "startswith" ? whole.startsWith(part) : whole.endsWith(part));
      }
    }
    return fail(`${describe(self)} has no .${name}() like that.`);
  };

  const comprehend = (
    node: Extract<Expr, { k: "comp" }>,
    index: number,
    scope: Scope,
    emit: (scope: Scope) => void,
  ): void => {
    const clause = node.clauses[index];
    if (clause === undefined) return emit(scope);
    for (const item of iterate(evaluate(clause.iter, scope))) {
      tick();
      assign(clause.target, item, scope);
      if (clause.ifs.every((test) => truthy(evaluate(test, scope)))) {
        comprehend(node, index + 1, scope, emit);
      }
    }
  };

  const evaluate = (node: Expr, scope: Scope): Value => {
    tick();
    line = node.line;
    switch (node.k) {
      case "num":
        return { t: "num", v: node.v };
      case "str":
        return literal(node.v);
      case "const":
        return node.v === null ? NONE : bool(node.v);
      case "name":
        return scope.get(node.id) ?? fail(`"${node.id}" has no value yet.`);
      case "unary": {
        const value = evaluate(node.e, scope);
        if (node.op === "not") return bool(!truthy(value));
        return number(node.op === "-" ? -asNumber(value) : asNumber(value));
      }
      case "bin":
        return binary(node.op, evaluate(node.l, scope), evaluate(node.r, scope));
      case "bool": {
        const left = evaluate(node.l, scope);
        return truthy(left) === (node.op === "or") ? left : evaluate(node.r, scope);
      }
      case "cmp": {
        let left = evaluate(node.first, scope);
        for (const [op, operand] of node.rest) {
          const right = evaluate(operand, scope);
          line = node.line;
          if (!compare(op, left, right)) return bool(false);
          left = right;
        }
        return bool(true);
      }
      case "tern":
        return evaluate(truthy(evaluate(node.test, scope)) ? node.a : node.b, scope);
      case "call": {
        const fn = evaluate(node.fn, scope);
        const args = node.args.map((argument) => evaluate(argument, scope));
        const kwargs = new Map(node.kwargs.map(([name, value]) => [name, evaluate(value, scope)]));
        line = node.line;
        return call(fn, args, kwargs);
      }
      case "sub": {
        const container = evaluate(node.obj, scope);
        const index = evaluate(node.index, scope);
        line = node.line;
        if (container.t === "doc") {
          if (index.t !== "str") return fail("A field is named by a text.");
          read.add(container.handle);
          return container.fields.get(index.v) ?? fail(`This call did not ask for "${index.v}".`);
        }
        if (container.t === "dict") {
          return container.v.get(keyOf(index))?.[1] ?? fail("A dict has no such key.");
        }
        if (container.t === "list" || container.t === "str") {
          const at = position(container.v.length, index);
          if (at < 0 || at >= container.v.length) return fail("An index is out of range.");
          return container.t === "list"
            ? (container.v[at] ?? NONE)
            : text(container.v.charAt(at), container.clear);
        }
        return fail(`${describe(container)} cannot be indexed.`);
      }
      case "slice": {
        const container = evaluate(node.obj, scope);
        const bound = (edge: Expr | null, fallback: number): number => {
          const index = edge === null ? NONE : evaluate(edge, scope);
          // An index further back than the start is the start, as in Python.
          return index.t === "none" ? fallback : Math.max(0, position(sizeOf(container), index));
        };
        const lo = bound(node.lo, 0);
        const hi = bound(node.hi, Number.POSITIVE_INFINITY);
        if (container.t === "list") return list(container.v.slice(lo, hi), container.tuple);
        // A piece of the program's own word is still its own; a piece of a document's is not.
        if (container.t === "str") return text(container.v.slice(lo, hi), container.clear);
        return fail(`${describe(container)} cannot be sliced.`);
      }
      case "attr": {
        const object = evaluate(node.obj, scope);
        line = node.line;
        if (object.t === "doc" && node.name === "handle") return literal(object.handle);
        if (
          object.t === "date" &&
          (node.name === "year" || node.name === "month" || node.name === "day")
        ) {
          const parts = object.v.split("-").map(Number);
          return number(parts[node.name === "year" ? 0 : node.name === "month" ? 1 : 2] ?? 0);
        }
        return { t: "method", self: object, name: node.name };
      }
      case "list": {
        const made = node.items.map((item) => evaluate(item, scope));
        if (node.distinct !== true) return list(made, node.tuple);
        const distinct: Array<Value> = [];
        for (const item of made) {
          if (!distinct.some((kept) => same(kept, item))) distinct.push(item);
        }
        return list(distinct, node.tuple);
      }
      case "dict": {
        const made = new Map<string, readonly [Value, Value]>();
        for (const [key, value] of node.pairs) {
          const name = evaluate(key, scope);
          put(made, name, evaluate(value, scope));
        }
        grow(made.size);
        return { t: "dict", v: made };
      }
      case "comp": {
        const inner = new Scope(scope);
        if (node.key !== null) {
          const made = new Map<string, readonly [Value, Value]>();
          const key = node.key;
          comprehend(node, 0, inner, (at) => {
            const name = evaluate(key, at);
            grow(1);
            put(made, name, evaluate(node.elt, at));
          });
          return { t: "dict", v: made };
        }
        const made: Array<Value> = [];
        comprehend(node, 0, inner, (at) => {
          grow(1);
          made.push(evaluate(node.elt, at));
        });
        return { t: "list", v: made, tuple: false };
      }
      case "lambda":
        return { t: "fn", params: node.params, body: node.body, scope };
    }
  };
  const sizeOf = (value: Value): number =>
    value.t === "list" || value.t === "str" ? value.v.length : 0;

  type Signal = { k: "break" } | { k: "continue" } | { k: "return"; value: Value } | undefined;
  const run = (statements: ReadonlyArray<Stmt>, scope: Scope): Signal => {
    for (const statement of statements) {
      tick();
      line = statement.line;
      switch (statement.k) {
        case "assign": {
          const value = evaluate(statement.value, scope);
          for (const target of statement.targets) assign(target, value, scope);
          break;
        }
        case "aug": {
          // Python refuses this too: it would read the outer name and write a new local one.
          if (statement.target.k === "name" && !scope.vars.has(statement.target.id)) {
            fail(`"${statement.target.id}" is not a name of this function: return the value.`);
          }
          const current = evaluate(statement.target, scope);
          const more = evaluate(statement.value, scope);
          line = statement.line;
          assign(statement.target, binary(statement.op, current, more), scope);
          break;
        }
        case "expr":
          evaluate(statement.e, scope);
          break;
        case "if": {
          const branch = truthy(evaluate(statement.test, scope))
            ? statement.body
            : statement.orelse;
          const signal = run(branch, scope);
          if (signal !== undefined) return signal;
          break;
        }
        case "for": {
          // A copy: a body that appends to the list it loops over would never end.
          for (const item of iterate(evaluate(statement.iter, scope)).slice()) {
            tick();
            assign(statement.target, item, scope);
            const signal = run(statement.body, scope);
            if (signal?.k === "break") break;
            if (signal?.k === "return") return signal;
          }
          break;
        }
        case "def":
          scope.vars.set(statement.name, {
            t: "fn",
            params: statement.params,
            body: statement.body,
            scope,
          });
          break;
        case "return":
          return {
            k: "return",
            value: statement.value === null ? NONE : evaluate(statement.value, scope),
          };
        case "break":
        case "continue":
          return { k: statement.k };
        case "pass":
          break;
      }
    }
    return undefined;
  };

  let leaves = 0;
  const output = (value: Value, level: number): ProgramOutput => {
    if (level > MAX_RESULT_DEPTH) return fail("`result` is nested too deeply.");
    // Lists and dicts count too: a list shared a hundred times over is written out each time.
    leaves += 1;
    if (leaves > MAX_LEAVES) return fail("`result` holds too many values.");
    switch (value.t) {
      case "list":
        return { list: value.v.map((item) => output(item, level + 1)) };
      case "dict":
        return {
          dict: [...value.v.values()]
            .map(([key, item]) => {
              // A key is shown as it is, so it may only be a word of the program or a handle.
              if (key.t !== "str" || !key.clear) {
                return fail("A key of `result` must be a word written in the program or a handle.");
              }
              return [key.v, output(item, level + 1)] as const;
            })
            // In order of the keys, not of when they were set: that order can follow a value.
            .toSorted(([a], [b]) => KEY_ORDER.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)),
        };
      case "none":
      case "bool":
      case "num":
      case "date":
      case "str": {
        const revealed =
          value.t === "bool" || value.t === "str" || value.t === "num" ? value.revealed : undefined;
        const written =
          value.t !== "none" && value.t !== "bool" && value.stated !== undefined
            ? { written: value.stated.written }
            : {};
        return {
          leaf: {
            type:
              value.t === "num"
                ? "number"
                : value.t === "str"
                  ? "text"
                  : value.t === "bool"
                    ? "boolean"
                    : value.t,
            // A stated number keeps every digit the document wrote.
            value:
              value.t === "none"
                ? null
                : value.t === "num" && value.stated === undefined
                  ? clean(value.v)
                  : value.v,
            ...written,
            shown: revealed !== undefined,
            ...(revealed === undefined ? {} : { options: revealed }),
          },
        };
      }
      default:
        return fail(`\`result\` cannot hold ${describe(value)}.`);
    }
  };

  const globals = new Scope(null);
  for (const name of BUILTINS) globals.vars.set(name, { t: "builtin", name });
  globals.vars.set("docs", { t: "list", v: [...documents], tuple: false });
  try {
    run(program.body, globals);
    const result = globals.vars.get("result");
    if (result === undefined) fail("`result` was never assigned.");
    return { ok: true, output: output(result ?? NONE, 0), read: [...read] };
  } catch (cause) {
    const detail =
      cause instanceof ProgramRuntimeError
        ? `line ${cause.line}: ${cause.message}`
        : cause instanceof RangeError
          ? "The program nested too deeply."
          : `line ${line}: ${cause instanceof Error ? cause.message : String(cause)}`;
    return { ok: false, detail, read: [...read] };
  }
};

type Answers = ReadonlyArray<{
  readonly handle: string;
  readonly fields: ReadonlyArray<FieldAnswer>;
}>;

const DIGITS = "0123456789";
const CAPITALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CONSONANTS = "bcdfghjklmnprstvwyz";
const VOWELS = "aeiou";
const ARABIC_LETTERS = "ابتثجحخدذرزسشصضطظعغفقكلمنهوي";
/** Weights for how many digits a made-up number has before its point, one to nine. */
const WHOLE_DIGITS = [22, 22, 16, 12, 10, 8, 5, 3, 2];
/** Weights for how many it has after, none to three. */
const DECIMAL_PLACES = [60, 5, 30, 5];
/** The days a made-up date is drawn from: three times in four the first decades of this century. */
const RECENT_DAYS = { from: Date.UTC(2000, 0, 1), to: Date.UTC(2040, 0, 1) };
const WIDE_DAYS = { from: Date.UTC(1950, 0, 1), to: Date.UTC(2080, 0, 1) };

/**
 * The answers for a trial run: what the model was told in clear stays, every other value is drawn
 * in a real value's form, copying only its type, its equals and its stand-in's `ID` or `OTHER`.
 * A trial's faults and shape are shown free, so anything more it copied would be read free.
 */
export const trialAnswers = (
  results: Answers,
  fields: ReadonlyArray<FieldSpec>,
  random: () => number = Math.random,
): Answers => {
  const draw = (count: number) => Math.floor(random() * count);
  const between = (low: number, high: number) => low + draw(high - low + 1);
  const pick = (from: string) => from[draw(from.length)] ?? "";
  const run = (from: string, length: number) => Array.from({ length }, () => pick(from)).join("");
  const weighted = (weights: ReadonlyArray<number>): number => {
    let left = draw(weights.reduce((total, weight) => total + weight, 0));
    for (const [index, weight] of weights.entries()) {
      if (left < weight) return index;
      left -= weight;
    }
    return weights.length - 1;
  };
  const word = (arabic: boolean): string =>
    arabic
      ? run(ARABIC_LETTERS, between(2, 6))
      : Array.from({ length: between(1, 3) }, () => pick(CONSONANTS) + pick(VOWELS)).join("") +
        run(CONSONANTS, draw(2));
  const words = (count: number, arabic: boolean, joiner: () => string): string =>
    Array.from({ length: count }, () => word(arabic)).reduce((all, one) => all + joiner() + one);
  /** At least four digits: a number, a code, a dated reference, digits in groups. */
  const reference = (): string => {
    switch (draw(5)) {
      case 0:
        return run(DIGITS, between(4, 16));
      case 1:
        return `${run(CAPITALS, between(1, 4))}${["-", "/", " ", ""][draw(4)]}${run(DIGITS, between(4, 10))}`;
      case 2:
        return `${run(CAPITALS, between(2, 3))}-${between(1990, 2039)}-${run(DIGITS, between(3, 6))}`;
      case 3: {
        const gap = draw(2) === 0 ? " " : "-";
        const size = between(2, 4);
        const groups = Array.from({ length: between(2, 6) }, () => run(DIGITS, size));
        return `${draw(3) === 0 ? run(CAPITALS, 2) : ""}${groups.join(gap)}`;
      }
      default:
        return `${word(draw(3) === 0)} ${run(DIGITS, between(4, 8))}`;
    }
  };
  /** Fewer than four digits: a name in either script, or a short code. */
  const other = (): string => {
    switch (draw(4)) {
      case 0:
      case 1:
        return words(between(1, 4), draw(2) === 0, () => (draw(5) === 0 ? "-" : " "));
      case 2:
        return `${run(CAPITALS, between(2, 5))}${draw(2) === 0 ? "" : `-${run(DIGITS, between(1, 3))}`}`;
      default:
        return `${word(draw(3) === 0)} ${run(DIGITS, between(1, 3))}`;
    }
  };
  // Never zero or negative, which an ordinary program would fault on.
  const amount = (): number => {
    const whole = 1 + weighted(WHOLE_DIGITS);
    const integer = whole === 1 ? between(1, 9) : between(10 ** (whole - 1), 10 ** whole - 1);
    const places = weighted(DECIMAL_PLACES);
    return places === 0 ? integer : Number(`${integer}.${run(DIGITS, places)}`);
  };
  const day = (): string => {
    const span = draw(4) === 0 ? WIDE_DAYS : RECENT_DAYS;
    const days = draw((span.to - span.from) / DAY_MS);
    return new Date(span.from + days * DAY_MS).toISOString().slice(0, 10);
  };
  // Prose has its figures taken out (`textWithoutNumbers`), so a `#` stands where one was.
  const prose = (): string => {
    const arabic = draw(2) === 0;
    return `${words(between(3, 30), arabic, () => (draw(12) === 0 ? " # " : " "))}.`.slice(0, 240);
  };

  const drawn = new Map<string, string | number>();
  const used = new Set<string>();
  // A repeat after many tries is allowed: it only makes a trial refuse, and a loop must end.
  const fresh = (make: () => string | number): string | number => {
    const keyOf = (value: string | number) =>
      typeof value === "number" ? `n:${value}` : canonicalText(value);
    let value = make();
    for (let tries = 0; used.has(keyOf(value)) && tries < 64; tries += 1) value = make();
    used.add(keyOf(value));
    return value;
  };
  /** `asReference`: what the stand-in's kind says; unknown for a value the model never saw. */
  const makeUp = (type: FieldAnswer["type"], asReference?: boolean): string | number => {
    if (type === "number") return fresh(amount);
    if (type === "date") return fresh(day);
    if (type === "text") return fresh(prose);
    return fresh((asReference ?? draw(2) === 0) ? reference : other);
  };
  const madeUp = (
    answer: FieldAnswer,
    kept: boolean,
    options?: ReadonlyArray<string>,
  ): FieldAnswer => {
    const base = { ...answer, surface: null, evidence: null, status: "ok" as const };
    switch (answer.type) {
      case "boolean":
        return kept ? { ...base, value: draw(2) === 0 } : answer;
      case "enum":
        return kept ? { ...base, value: options?.[draw(options.length)] ?? "" } : answer;
      case "list":
        return answer;
      default: {
        if (answer.status !== "ok" && !kept) return answer;
        // Prose is shown with some values masked, so equal prose is not known to be equal.
        if (kept || answer.type === "text") return { ...base, value: makeUp(answer.type) };
        if (answer.value === null) return answer;
        const asReference =
          answer.type === "identifier"
            ? isReferenceLike(answer.surface ?? String(answer.value))
            : undefined;
        // Filed as stand-ins are (seal.ts `sealedToken`), so no equality is kept they do not show.
        const key = `${answer.type}${answer.percent === true ? "%" : ""}:${
          answer.type === "number"
            ? String(answer.value)
            : answer.type === "date"
              ? String(answer.value)
              : canonicalText(String(answer.value))
        }`;
        const value = drawn.get(key) ?? makeUp(answer.type, asReference);
        drawn.set(key, value);
        return { ...base, value };
      }
    }
  };
  const blank = (column: ColumnSpec): FieldAnswer => ({
    name: column.name,
    type: column.type,
    status: "ok",
    value: null,
    surface: null,
    evidence: null,
    problems: [],
  });
  return results.map((result) => ({
    handle: result.handle,
    fields: result.fields.map((answer): FieldAnswer => {
      const spec = fields.find((field) => field.name === answer.name);
      // A kept answer that could not be checked is shown as such, so it stays as it is.
      const kept = spec?.sealed === true && answer.status !== "unverified";
      const columns = spec?.columns ?? [];
      if (answer.type !== "list") return madeUp(answer, kept, spec?.options);
      if (kept) {
        // How many rows it has is not known to the model either. Never none: see `amount`.
        const count = draw(5) === 0 ? between(9, MAX_ROWS) : between(1, 8);
        return {
          ...answer,
          status: "ok",
          value: count,
          rows: Array.from({ length: count }, () =>
            columns.map((column) => madeUp(blank(column), true, column.options)),
          ),
        };
      }
      if (answer.rows === undefined) return answer;
      return {
        ...answer,
        rows: answer.rows.map((cells) =>
          cells.map((one) =>
            madeUp(one, false, columns.find((column) => column.name === one.name)?.options),
          ),
        ),
      };
    }),
  }));
};

/** Everything about a result the model sees in clear besides what it reveals. */
export const shapeOf = (output: ProgramOutput): string =>
  "leaf" in output
    ? output.leaf.shown
      ? `?${output.leaf.type}${JSON.stringify(output.leaf.options ?? [])}`
      : "_"
    : "list" in output
      ? `[${output.list.map(shapeOf).join(",")}]`
      : `{${output.dict.map(([key, item]) => `${JSON.stringify(key)}:${shapeOf(item)}`).join(",")}}`;

/** What a result shows, in clear answers: one for whether the run worked, and enough yes-or-no answers for each value it reveals to tell its options apart. */
export const costOf = (output: ProgramOutput): number => {
  const reveals = (part: ProgramOutput): number =>
    "leaf" in part
      ? part.leaf.shown
        ? Math.ceil(Math.log2(Math.max(2, part.leaf.options?.length ?? 2)))
        : 0
      : ("list" in part ? part.list : part.dict.map(([, item]) => item)).reduce(
          (total, item) => total + reveals(item),
          0,
        );
  return 1 + reveals(output);
};

/** A program's two runs: over made-up values first, then over the documents' own. */
export const sealedRuns = (
  program: Program,
  results: Answers,
  fields: ReadonlyArray<FieldSpec>,
  random?: () => number,
) => ({
  source: program.source,
  trial: () => runProgram(program, trialAnswers(results, fields, random), fields, { trial: true }),
  run: () => runProgram(program, results, fields),
});
