import { attributeTypeOf, compareValues, deepEqual, sizeOf, type Item } from './values.js';

/**
 * A small recursive-descent parser for DynamoDB condition, key-condition and
 * filter expressions.
 *
 * Scope is deliberate: it covers what unit tests write — comparisons, BETWEEN,
 * IN, the attribute_/begins_with/contains/size functions, boolean operators and
 * parentheses, over nested and indexed document paths. It is not a DynamoDB
 * emulator, and it is honest about that: anything it cannot parse throws
 * `ExpressionSyntaxError` rather than quietly evaluating to true, so a test can
 * never pass because the fake ignored the condition it was asserting on.
 */

export class ExpressionSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionSyntaxError';
  }
}

export type ExpressionContext = {
  item: Item | undefined;
  names: Record<string, string>;
  values: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export type Token =
  | { kind: 'name'; text: string }
  | { kind: 'placeholder'; text: string }
  | { kind: 'valueRef'; text: string }
  | { kind: 'operator'; text: string }
  | { kind: 'punct'; text: '(' | ')' | ',' | '.' | '[' | ']' }
  | { kind: 'number'; value: number };

const OPERATORS = ['<>', '<=', '>=', '=', '<', '>', '+', '-'];

export function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index] as string;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '#') {
      const match = /^#[A-Za-z0-9_]+/.exec(expression.slice(index));
      if (!match) throw new ExpressionSyntaxError(`Invalid name placeholder at ${index}.`);
      tokens.push({ kind: 'placeholder', text: match[0] });
      index += match[0].length;
      continue;
    }

    if (char === ':') {
      const match = /^:[A-Za-z0-9_]+/.exec(expression.slice(index));
      if (!match) throw new ExpressionSyntaxError(`Invalid value placeholder at ${index}.`);
      tokens.push({ kind: 'valueRef', text: match[0] });
      index += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression.slice(index));
      const text = match?.[0] ?? char;
      tokens.push({ kind: 'name', text });
      index += text.length;
      continue;
    }

    if (/[0-9]/.test(char)) {
      const match = /^[0-9]+/.exec(expression.slice(index));
      const text = match?.[0] ?? char;
      tokens.push({ kind: 'number', value: Number(text) });
      index += text.length;
      continue;
    }

    if (
      char === '(' ||
      char === ')' ||
      char === ',' ||
      char === '.' ||
      char === '[' ||
      char === ']'
    ) {
      tokens.push({ kind: 'punct', text: char });
      index += 1;
      continue;
    }

    const operator = OPERATORS.find((candidate) => expression.startsWith(candidate, index));
    if (operator) {
      tokens.push({ kind: 'operator', text: operator });
      index += operator.length;
      continue;
    }

    throw new ExpressionSyntaxError(`Unexpected character "${char}" at ${index}.`);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type PathSegment = { kind: 'attribute'; name: string } | { kind: 'index'; index: number };

export type Operand =
  | { kind: 'path'; segments: PathSegment[] }
  | { kind: 'value'; ref: string }
  | { kind: 'size'; argument: Operand };

export type Condition =
  | { kind: 'and'; left: Condition; right: Condition }
  | { kind: 'or'; left: Condition; right: Condition }
  | { kind: 'not'; condition: Condition }
  | { kind: 'compare'; operator: string; left: Operand; right: Operand }
  | { kind: 'between'; operand: Operand; low: Operand; high: Operand }
  | { kind: 'in'; operand: Operand; candidates: Operand[] }
  | { kind: 'function'; name: string; args: Operand[] };

const CONDITION_FUNCTIONS = new Set([
  'attribute_exists',
  'attribute_not_exists',
  'attribute_type',
  'begins_with',
  'contains',
]);

const KEYWORDS = new Set(['and', 'or', 'not', 'between', 'in']);

export class Parser {
  #tokens: Token[];
  #position = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  get done(): boolean {
    return this.#position >= this.#tokens.length;
  }

  peek(offset = 0): Token | undefined {
    return this.#tokens[this.#position + offset];
  }

  next(): Token {
    const token = this.#tokens[this.#position];
    if (!token) throw new ExpressionSyntaxError('Unexpected end of expression.');
    this.#position += 1;
    return token;
  }

  expectPunct(text: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.text !== text) {
      throw new ExpressionSyntaxError(`Expected "${text}".`);
    }
  }

  matchKeyword(keyword: string): boolean {
    const token = this.peek();
    if (token?.kind === 'name' && token.text.toLowerCase() === keyword) {
      this.#position += 1;
      return true;
    }
    return false;
  }

  peekKeyword(keyword: string): boolean {
    const token = this.peek();
    return token?.kind === 'name' && token.text.toLowerCase() === keyword;
  }

  parseCondition(): Condition {
    return this.#parseOr();
  }

  #parseOr(): Condition {
    let left = this.#parseAnd();
    while (this.matchKeyword('or')) {
      left = { kind: 'or', left, right: this.#parseAnd() };
    }
    return left;
  }

  #parseAnd(): Condition {
    let left = this.#parseNot();
    while (this.peekKeyword('and')) {
      this.matchKeyword('and');
      left = { kind: 'and', left, right: this.#parseNot() };
    }
    return left;
  }

  #parseNot(): Condition {
    if (this.matchKeyword('not')) {
      return { kind: 'not', condition: this.#parseNot() };
    }
    return this.#parsePrimary();
  }

  #parsePrimary(): Condition {
    const token = this.peek();
    if (!token) throw new ExpressionSyntaxError('Unexpected end of expression.');

    if (token.kind === 'punct' && token.text === '(') {
      this.next();
      const condition = this.parseCondition();
      this.expectPunct(')');
      return condition;
    }

    if (
      token.kind === 'name' &&
      CONDITION_FUNCTIONS.has(token.text.toLowerCase()) &&
      this.peek(1)?.kind === 'punct' &&
      (this.peek(1) as { text: string }).text === '('
    ) {
      // Read the name off the already-narrowed token; this.next() returns the
      // full Token union, whose number variant carries no `text`.
      const name = token.text;
      this.next();
      this.expectPunct('(');
      const args: Operand[] = [this.parseOperand()];
      while (this.peek()?.kind === 'punct' && (this.peek() as { text: string }).text === ',') {
        this.next();
        args.push(this.parseOperand());
      }
      this.expectPunct(')');
      return { kind: 'function', name: name.toLowerCase(), args };
    }

    const operand = this.parseOperand();

    if (this.matchKeyword('between')) {
      const low = this.parseOperand();
      if (!this.matchKeyword('and')) {
        throw new ExpressionSyntaxError('BETWEEN requires AND.');
      }
      const high = this.parseOperand();
      return { kind: 'between', operand, low, high };
    }

    if (this.matchKeyword('in')) {
      this.expectPunct('(');
      const candidates: Operand[] = [this.parseOperand()];
      while (this.peek()?.kind === 'punct' && (this.peek() as { text: string }).text === ',') {
        this.next();
        candidates.push(this.parseOperand());
      }
      this.expectPunct(')');
      return { kind: 'in', operand, candidates };
    }

    const operatorToken = this.peek();
    if (operatorToken?.kind !== 'operator') {
      throw new ExpressionSyntaxError('Expected a comparison operator.');
    }
    this.next();
    const right = this.parseOperand();
    return { kind: 'compare', operator: operatorToken.text, left: operand, right };
  }

  parseOperand(): Operand {
    const token = this.next();

    if (token.kind === 'valueRef') return { kind: 'value', ref: token.text };

    if (token.kind === 'name' && token.text.toLowerCase() === 'size') {
      const following = this.peek();
      if (following?.kind === 'punct' && following.text === '(') {
        this.next();
        const argument = this.parseOperand();
        this.expectPunct(')');
        return { kind: 'size', argument };
      }
    }

    if (token.kind !== 'name' && token.kind !== 'placeholder') {
      throw new ExpressionSyntaxError('Expected an attribute path or value placeholder.');
    }
    if (token.kind === 'name' && KEYWORDS.has(token.text.toLowerCase())) {
      throw new ExpressionSyntaxError(`Unexpected keyword "${token.text}".`);
    }

    const segments: PathSegment[] = [{ kind: 'attribute', name: token.text }];
    for (;;) {
      const following = this.peek();
      if (following?.kind === 'punct' && following.text === '.') {
        this.next();
        const attribute = this.next();
        if (attribute.kind !== 'name' && attribute.kind !== 'placeholder') {
          throw new ExpressionSyntaxError('Expected an attribute name after ".".');
        }
        segments.push({ kind: 'attribute', name: attribute.text });
        continue;
      }
      if (following?.kind === 'punct' && following.text === '[') {
        this.next();
        const indexToken = this.next();
        if (indexToken.kind !== 'number') {
          throw new ExpressionSyntaxError('Expected a list index.');
        }
        this.expectPunct(']');
        segments.push({ kind: 'index', index: indexToken.value });
        continue;
      }
      break;
    }

    return { kind: 'path', segments };
  }
}

export function parseCondition(expression: string): Condition {
  const parser = new Parser(tokenize(expression));
  const condition = parser.parseCondition();
  if (!parser.done) {
    throw new ExpressionSyntaxError(`Unparsed trailing input in "${expression}".`);
  }
  return condition;
}

export function parseOperandExpression(expression: string): Operand {
  const parser = new Parser(tokenize(expression));
  const operand = parser.parseOperand();
  if (!parser.done) {
    throw new ExpressionSyntaxError(`Unparsed trailing input in "${expression}".`);
  }
  return operand;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function resolveSegmentName(name: string, names: Record<string, string>): string {
  if (!name.startsWith('#')) return name;
  const resolved = names[name];
  if (resolved === undefined) {
    throw new ExpressionSyntaxError(`No ExpressionAttributeNames entry for "${name}".`);
  }
  return resolved;
}

export function resolvePathSegments(
  segments: PathSegment[],
  names: Record<string, string>,
): Array<string | number> {
  return segments.map((segment) =>
    segment.kind === 'index' ? segment.index : resolveSegmentName(segment.name, names),
  );
}

export function readPath(item: Item | undefined, path: Array<string | number>): unknown {
  let cursor: unknown = item;
  for (const key of path) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof key === 'number') {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[key];
      continue;
    }
    if (typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Item)[key];
  }
  return cursor;
}

export function writePath(item: Item, path: Array<string | number>, value: unknown): void {
  if (path.length === 0) return;
  let cursor: Item | unknown[] = item;

  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index] as string | number;
    const nextKey = path[index + 1] as string | number;
    const container = Array.isArray(cursor) ? cursor : (cursor as Item);
    const existing = Array.isArray(container) ? container[key as number] : container[key as string];

    if (existing === null || typeof existing !== 'object') {
      const created: Item | unknown[] = typeof nextKey === 'number' ? [] : {};
      if (Array.isArray(container)) container[key as number] = created;
      else container[key as string] = created;
      cursor = created;
      continue;
    }
    cursor = existing as Item | unknown[];
  }

  const last = path[path.length - 1] as string | number;
  if (Array.isArray(cursor)) cursor[last as number] = value;
  else (cursor as Item)[last as string] = value;
}

export function deletePath(item: Item, path: Array<string | number>): void {
  if (path.length === 0) return;
  const parentPath = path.slice(0, -1);
  const parent = parentPath.length === 0 ? item : readPath(item, parentPath);
  if (parent === null || typeof parent !== 'object') return;

  const last = path[path.length - 1] as string | number;
  if (Array.isArray(parent)) {
    if (typeof last === 'number') parent.splice(last, 1);
    return;
  }
  delete (parent as Item)[last as string];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function resolveOperand(operand: Operand, context: ExpressionContext): unknown {
  switch (operand.kind) {
    case 'value': {
      if (!(operand.ref in context.values)) {
        throw new ExpressionSyntaxError(`No ExpressionAttributeValues entry for "${operand.ref}".`);
      }
      return context.values[operand.ref];
    }
    case 'path':
      return readPath(context.item, resolvePathSegments(operand.segments, context.names));
    case 'size':
      return sizeOf(resolveOperand(operand.argument, context));
    default:
      throw new ExpressionSyntaxError('Unsupported operand.');
  }
}

function evaluateFunction(
  condition: Condition & { kind: 'function' },
  context: ExpressionContext,
): boolean {
  const [first, second] = condition.args;
  if (!first) throw new ExpressionSyntaxError(`${condition.name} requires an argument.`);

  switch (condition.name) {
    case 'attribute_exists':
      return resolveOperand(first, context) !== undefined;
    case 'attribute_not_exists':
      return resolveOperand(first, context) === undefined;
    case 'attribute_type': {
      if (!second) throw new ExpressionSyntaxError('attribute_type requires two arguments.');
      const value = resolveOperand(first, context);
      if (value === undefined) return false;
      return attributeTypeOf(value) === resolveOperand(second, context);
    }
    case 'begins_with': {
      if (!second) throw new ExpressionSyntaxError('begins_with requires two arguments.');
      const value = resolveOperand(first, context);
      const prefix = resolveOperand(second, context);
      return typeof value === 'string' && typeof prefix === 'string' && value.startsWith(prefix);
    }
    case 'contains': {
      if (!second) throw new ExpressionSyntaxError('contains requires two arguments.');
      const container = resolveOperand(first, context);
      const needle = resolveOperand(second, context);
      if (typeof container === 'string') {
        return typeof needle === 'string' && container.includes(needle);
      }
      if (Array.isArray(container)) return container.some((entry) => deepEqual(entry, needle));
      if (container instanceof Set) return [...container].some((entry) => deepEqual(entry, needle));
      return false;
    }
    default:
      throw new ExpressionSyntaxError(`Unsupported function "${condition.name}".`);
  }
}

export function evaluateCondition(condition: Condition, context: ExpressionContext): boolean {
  switch (condition.kind) {
    case 'and':
      return (
        evaluateCondition(condition.left, context) && evaluateCondition(condition.right, context)
      );
    case 'or':
      return (
        evaluateCondition(condition.left, context) || evaluateCondition(condition.right, context)
      );
    case 'not':
      return !evaluateCondition(condition.condition, context);
    case 'function':
      return evaluateFunction(condition, context);
    case 'between': {
      const value = resolveOperand(condition.operand, context);
      if (value === undefined) return false;
      const low = compareValues(value, resolveOperand(condition.low, context));
      const high = compareValues(value, resolveOperand(condition.high, context));
      return low !== null && high !== null && low >= 0 && high <= 0;
    }
    case 'in': {
      const value = resolveOperand(condition.operand, context);
      if (value === undefined) return false;
      return condition.candidates.some((candidate) =>
        deepEqual(value, resolveOperand(candidate, context)),
      );
    }
    case 'compare': {
      const left = resolveOperand(condition.left, context);
      const right = resolveOperand(condition.right, context);

      if (condition.operator === '=') return left !== undefined && deepEqual(left, right);
      // `<>` is true when the attribute is missing: it genuinely does not equal.
      if (condition.operator === '<>') return !deepEqual(left, right);

      if (left === undefined || right === undefined) return false;
      const comparison = compareValues(left, right);
      if (comparison === null) return false;

      switch (condition.operator) {
        case '<':
          return comparison < 0;
        case '<=':
          return comparison <= 0;
        case '>':
          return comparison > 0;
        case '>=':
          return comparison >= 0;
        default:
          throw new ExpressionSyntaxError(`Unsupported operator "${condition.operator}".`);
      }
    }
    default:
      throw new ExpressionSyntaxError('Unsupported condition.');
  }
}

/** Parses and evaluates in one call. Undefined expressions evaluate to true. */
export function evaluateExpression(
  expression: string | undefined,
  context: ExpressionContext,
): boolean {
  if (!expression) return true;
  return evaluateCondition(parseCondition(expression), context);
}
