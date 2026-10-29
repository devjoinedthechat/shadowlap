// ESLint's complexity, max-lines-per-function and max-depth, held per function: every function to the
// cap, and each function over it today to a ceiling of its own, by the name it has in its file
// (lint-caps.json, which scripts/lint-caps.mjs keeps exact). A file's worst function once let every
// other function in that file grow to it; now only the function itself is held there.
//
// Each rule runs ESLint's own with no limit and takes its findings over: a function's complexity, its
// length, and the deepest its blocks nest. A function is named by what it is called where it is
// (`functionKey`): `parse`, `Store.open`, `TimelineView > useMemo(…)`; where two in a file share a name,
// the later ones in it are `#2`, `#3`.
import { builtinRules } from 'eslint/use-at-your-own-risk';

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
/** What each rule measures, from the finding ESLint's own rule makes, and on what node. */
const MEASURES = {
  complexity: { value: (d) => d.data.complexity, words: 'has a complexity of {{value}}' },
  'max-lines-per-function': { value: (d) => d.data.lineCount, words: 'has too many lines ({{value}})' },
  'max-depth': { value: (d) => d.data.depth, words: 'nests blocks too deeply ({{value}})' },
};

const short = (text, n = 40) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** A key's name as the code writes it: an identifier, a string or number, a private name, or what a computed key holds. */
function keyName(property, sourceCode) {
  const key = property.key;
  if (property.computed) return `[${short(sourceCode.getText(key))}]`;
  if (key.type === 'PrivateIdentifier') return `#${key.name}`;
  return key.type === 'Identifier' ? key.name : String(key.value);
}

/** A class by its name, or the name of what it is assigned to. */
function className(cls, sourceCode) {
  if (cls.id?.name) return cls.id.name;
  const p = cls.parent;
  if (p?.type === 'VariableDeclarator' && p.id.type === 'Identifier') return p.id.name;
  if (p?.type === 'AssignmentExpression') return short(sourceCode.getText(p.left));
  return '(class)';
}

/** What a call names: `useMemo`, `store.getRun`, `it.each`; in a chain of calls, the last one's name (`….action`). */
function calleeName(callee, sourceCode) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed) {
    const { object } = callee;
    const on = object.type === 'Identifier' ? `${object.name}.` : object.type === 'ThisExpression' ? 'this.' : '';
    return `${on}${callee.property.name}`;
  }
  if (callee.type === 'CallExpression') return calleeName(callee.callee, sourceCode);
  return short(sourceCode.getText(callee), 20);
}

/** A call's first argument, when it is a string the code writes as it is, and not the function itself. */
function stringArgument(call, fn) {
  const a = call.arguments[0];
  if (!a || a === fn) return undefined;
  if (a.type === 'Literal' && typeof a.value === 'string') return a.value;
  if (a.type === 'TemplateLiteral' && a.expressions.length === 0) return a.quasis[0].value.cooked;
  return undefined;
}

/** The first string a chain of calls is given, nearest its start: `program.command('changes')…` gives `changes`. */
function chainString(callee) {
  const calls = [];
  for (let c = callee; c; ) {
    if (c.type === 'CallExpression') {
      calls.unshift(c);
      c = c.callee;
    } else if (c.type === 'MemberExpression') c = c.object;
    else break;
  }
  for (const call of calls) {
    const s = stringArgument(call, null);
    if (s !== undefined) return s;
  }
  return undefined;
}

/** What a function is called where it is: its own name, its method's or property's, the variable it is assigned to, or the call it is a callback of. */
function ownName(fn, sourceCode) {
  if (fn.id?.name) return fn.id.name;
  const p = fn.parent;
  switch (p?.type) {
    case 'MethodDefinition':
    case 'PropertyDefinition':
    case 'Property': {
      const kind = p.kind === 'get' || p.kind === 'set' ? `${p.kind} ` : '';
      const owner = p.type === 'Property' ? '' : `${className(p.parent.parent, sourceCode)}.`;
      return `${kind}${owner}${keyName(p, sourceCode)}`;
    }
    case 'VariableDeclarator':
      return p.id.type === 'Identifier' ? p.id.name : short(sourceCode.getText(p.id));
    case 'AssignmentExpression':
    case 'AssignmentPattern':
      return short(sourceCode.getText(p.left));
    case 'CallExpression':
    case 'NewExpression': {
      // A callback by the call it is given to, and the words that tell it from the file's others: the
      // call's own first string (`it('…')`, `on('data')`), or the chain's (`command('changes')`).
      const words = stringArgument(p, fn) ?? chainString(p.callee);
      return `${calleeName(p.callee, sourceCode)}(${words === undefined ? '…' : JSON.stringify(short(words))})`;
    }
    case 'ExportDefaultDeclaration':
      return 'default';
    default:
      return '(function)';
  }
}

/**
 * A function's name in its file: its own (ownName), after those of the functions it is inside, each
 * with ` > `. A class's field initializer or static block, which ESLint's complexity measures as a
 * function of its own, is named for its class.
 */
export function functionKey(node, sourceCode) {
  let own;
  if (FUNCTIONS.has(node.type)) own = ownName(node, sourceCode);
  else if (node.type === 'StaticBlock') own = `${className(node.parent.parent, sourceCode)} static block`;
  else if (node.parent?.type === 'PropertyDefinition') own = `${className(node.parent.parent.parent, sourceCode)}.${keyName(node.parent, sourceCode)} initializer`;
  else own = '(top level)';
  const outer = [];
  for (let a = node.parent; a; a = a.parent) if (FUNCTIONS.has(a.type)) outer.unshift(ownName(a, sourceCode));
  return [...outer, own].join(' > ');
}

/** The function a node is in, for max-depth, whose findings are the blocks that nest too deep; null at the top level. */
function functionOf(node) {
  for (let a = node.parent; a; a = a.parent) if (FUNCTIONS.has(a.type) || a.type === 'StaticBlock') return a;
  return null;
}

/**
 * ESLint's rule `name`, held per function. Options: `max`, the cap; `ceilings`, each function over it
 * today by its name, at what it is today; with `measure`, every function over the cap is reported with
 * its name and what it measures, as JSON, for scripts/lint-caps.mjs. The rest of the options are the
 * rule's own (max-lines-per-function's skipBlankLines, skipComments and IIFEs).
 *
 * @param {keyof typeof MEASURES} name
 * @returns {import('eslint').Rule.RuleModule}
 */
function heldPerFunction(name) {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- ESLint gives its own rules nowhere else, and these hold three of them per function: an ESLint without it fails this import at once
  const core = builtinRules.get(name);
  const measure = MEASURES[name];
  return {
    meta: {
      type: 'suggestion',
      docs: { description: `${core.meta.docs?.description ?? name}, each function held to the cap or to a ceiling of its own` },
      schema: [
        {
          type: 'object',
          properties: {
            max: { type: 'integer', minimum: 0 },
            ceilings: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
            measure: { type: 'boolean' },
            skipBlankLines: { type: 'boolean' },
            skipComments: { type: 'boolean' },
            IIFEs: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      ],
      messages: {
        over: `{{key}} ${measure.words}. Maximum allowed is {{allowed}}{{held}}.`,
        measured: '{{json}}',
      },
    },
    create(context) {
      const { max = 0, ceilings = {}, measure: measuring = false, ...own } = context.options[0] ?? {};
      /** Each function's worst finding: the node it was made on, and what it measured. */
      const found = new Map();
      const inner = Object.create(context, {
        options: { value: [{ ...own, max: 0 }] },
        report: {
          value: (d) => {
            const fn = name === 'max-depth' ? functionOf(d.node) : d.node;
            const value = measure.value(d);
            const was = found.get(fn);
            if (!was || value > was.value) found.set(fn, { node: d.node, value });
          },
        },
      });
      const listeners = { ...core.create(inner) };
      const exit = listeners['Program:exit'];
      listeners['Program:exit'] = (program) => {
        exit?.(program);
        const { sourceCode } = context;
        const seen = new Map();
        const ordered = [...found].sort(([a], [b]) => (a ?? program).range[0] - (b ?? program).range[0]);
        for (const [fn, { node, value }] of ordered) {
          const base = fn ? functionKey(fn, sourceCode) : '(top level)';
          const n = (seen.get(base) ?? 0) + 1;
          seen.set(base, n);
          const key = n === 1 ? base : `${base} #${n}`;
          if (measuring) {
            if (value > max) context.report({ node, messageId: 'measured', data: { json: JSON.stringify({ key, value }) } });
            continue;
          }
          const ceiling = ceilings[key];
          const allowed = ceiling ?? max;
          if (value > allowed) context.report({ node: fn ?? node, messageId: 'over', data: { key, value: String(value), allowed: String(allowed), held: ceiling === undefined ? '' : ' (its ceiling in lint-caps.json)' } });
        }
      };
      return listeners;
    },
  };
}

/**
 * The plugin, as eslint.config.mjs names it: `caps/complexity`, `caps/max-lines-per-function`, `caps/max-depth`.
 *
 * @type {import('eslint').ESLint.Plugin}
 */
const plugin = {
  meta: { name: 'shadowlap-caps' },
  rules: Object.fromEntries(Object.keys(MEASURES).map((name) => [name, heldPerFunction(name)])),
};
export default plugin;

/** The rules held per function, by ESLint's own names. */
export const PER_FUNCTION = Object.keys(MEASURES);
