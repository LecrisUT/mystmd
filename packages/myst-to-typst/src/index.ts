import type { Root, Parent, Code } from 'myst-spec';
import type { Plugin } from 'unified';
import type { VFile } from 'vfile';
import type { GenericNode } from 'myst-common';
import { fileError, toText } from 'myst-common';
import { captionHandler, containerHandler } from './container.js';
// import { renderNodeToLatex } from './tables.js';
import type { Handler, ITypstSerializer, TypstResult, Options, StateData } from './types.js';
import {
  getLatexImageWidth,
  hrefToLatexText,
  nodeOnlyHasTextChildren,
  stringToTypstMath,
  stringToTypstText,
} from './utils.js';
import MATH_HANDLERS, { withRecursiveCommands } from './math.js';
import { select, selectAll } from 'unist-util-select';
import type { Admonition, FootnoteDefinition } from 'myst-spec-ext';
import { tableCellHandler, tableHandler, tableRowHandler } from './table.js';

export type { TypstResult } from './types.js';

const admonition = `#let admonition(body, heading: none, color: blue) = {
  let stroke = (left: 2pt + color.darken(20%))
  let fill = color.lighten(80%)
  let title
  if heading != none {
    title = block(width: 100%, inset: (x: 8pt, y: 4pt), fill: fill, below: 0pt, radius: (top-right: 2pt))[#text(11pt, weight: "bold")[#heading]]
  }
  block(width: 100%, stroke: stroke, [
    #title
  #block(fill: luma(240), width: 100%, inset: 8pt, radius: (bottom-right: 2pt))[#body]
])
}`;
const admonitionMacros = {
  attention:
    '#let attentionBlock(body, heading: [Attention]) = admonition(body, heading: heading, color: yellow)',
  caution:
    '#let cautionBlock(body, heading: [Caution]) = admonition(body, heading: heading, color: yellow)',
  danger:
    '#let dangerBlock(body, heading: [Danger]) = admonition(body, heading: heading, color: red)',
  error: '#let errorBlock(body, heading: [Error]) = admonition(body, heading: heading, color: red)',
  hint: '#let hintBlock(body, heading: [Hint]) = admonition(body, heading: heading, color: green)',
  important:
    '#let importantBlock(body, heading: [Important]) = admonition(body, heading: heading, color: blue)',
  note: '#let noteBlock(body, heading: [Note]) = admonition(body, heading: heading, color: blue)',
  seealso:
    '#let seealsoBlock(body, heading: [See Also]) = admonition(body, heading: heading, color: green)',
  tip: '#let tipBlock(body, heading: [Tip]) = admonition(body, heading: heading, color: green)',
  warning:
    '#let warningBlock(body, heading: [Warning]) = admonition(body, heading: heading, color: yellow)',
};

const blockquote = `#let blockquote(node, color: gray) = {
  let stroke = (left: 2pt + color.darken(20%))
  set text(fill: black.lighten(40%), style: "oblique")
  block(width: 100%, inset: 8pt, stroke: stroke)[#node]
}`;

const INDENT = '  ';

const linkHandler = (node: any, state: ITypstSerializer) => {
  const href = node.url;
  state.write('#link("');
  state.write(hrefToLatexText(href));
  state.write('")');
  if (node.children.length && node.children[0].value !== href) {
    state.write('[');
    state.renderChildren(node);
    state.write(']');
  }
};

function nextCharacterIsText(parent: GenericNode, node: GenericNode): boolean {
  const ind = parent?.children?.findIndex((n: GenericNode) => n === node);
  if (!ind) return false;
  const next = parent?.children?.[ind + 1];
  if (!next?.value) return false;
  return (next?.type === 'text' && !!next.value.match(/^[a-zA-Z0-9\-_]/)) || false;
}

const handlers: Record<string, Handler> = {
  text(node, state) {
    state.text(node.value);
  },
  paragraph(node, state) {
    state.renderChildren(node, 2);
  },
  heading(node, state) {
    const { depth, identifier, enumerated } = node;
    state.write(`${Array(depth).fill('=').join('')} `);
    state.renderChildren(node);
    if (enumerated !== false && identifier) {
      state.write(` <${identifier}>`);
    }
    state.write('\n\n');
  },
  block(node, state) {
    if (node.visibility === 'remove') return;
    state.renderChildren(node, 2);
  },
  blockquote(node, state) {
    state.useMacro(blockquote);
    state.renderEnvironment(node, 'blockquote');
  },
  definitionList(node, state) {
    let dedent = false;
    if (!state.data.definitionIndent) {
      state.data.definitionIndent = 2;
    } else {
      state.write(`#set terms(indent: ${state.data.definitionIndent}em)`);
      state.data.definitionIndent += 2;
      dedent = true;
    }
    state.renderChildren(node, 1);
    state.data.definitionIndent -= 2;
    if (dedent) state.write(`#set terms(indent: ${state.data.definitionIndent - 2}em)\n`);
  },
  definitionTerm(node, state) {
    state.ensureNewLine();
    state.write('/ ');
    state.renderChildren(node);
    state.write(': ');
  },
  definitionDescription(node, state) {
    state.renderChildren(node);
  },
  code(node: Code, state) {
    let ticks = '```';
    while (node.value.includes(ticks)) {
      ticks += '`';
    }
    const start = `${ticks}${node.lang ?? ''}\n`;
    const end = `\n${ticks}`;
    state.write(start);
    state.write(node.value);
    state.write(end);
    state.ensureNewLine(true);
    state.addNewLine();
  },
  list(node, state) {
    state.data.list ??= { env: [] };
    state.data.list.env.push(node.ordered ? '+' : '-');
    state.renderChildren(node, 2);
    state.data.list.env.pop();
  },
  listItem(node, state) {
    const listEnv = state.data.list?.env ?? [];
    const tabs = Array(Math.max(listEnv.length - 1, 0))
      .fill(INDENT)
      .join('');
    const env = listEnv.slice(-1)[0] ?? '-';
    state.ensureNewLine();
    state.write(`${tabs}${env} `);
    state.renderChildren(node, 1);
  },
  thematicBreak(node, state) {
    state.write('#line(length: 100%, stroke: gray)\n\n');
  },
  ...MATH_HANDLERS,
  mystRole(node, state) {
    state.renderChildren(node);
  },
  mystDirective(node, state) {
    state.renderChildren(node, 2);
  },
  comment(node, state) {
    state.ensureNewLine();
    if (node.value?.includes('\n')) {
      state.write(`/*\n${node.value}\n*/\n\n`);
    } else {
      state.write(`// ${node.value ?? ''}\n\n`);
    }
  },
  strong(node, state, parent) {
    const next = nextCharacterIsText(parent, node);
    if (nodeOnlyHasTextChildren(node) && !next) {
      state.write('*');
      state.renderChildren(node);
      state.write('*');
    } else {
      state.renderInlineEnvironment(node, 'strong');
    }
  },
  emphasis(node, state, parent) {
    const next = nextCharacterIsText(parent, node);
    if (nodeOnlyHasTextChildren(node) && !next) {
      state.write('_');
      state.renderChildren(node);
      state.write('_');
    } else {
      state.renderInlineEnvironment(node, 'emph');
    }
  },
  underline(node, state) {
    state.renderInlineEnvironment(node, 'underline');
  },
  smallcaps(node, state) {
    state.renderInlineEnvironment(node, 'smallcaps');
  },
  inlineCode(node, state) {
    let ticks = '`';
    // inlineCode can sometimes have children (e.g. from latex)
    const value = toText(node);
    // Double ticks create empty inline code; we never want that for start/end
    while (ticks === '``' || value.includes(ticks)) {
      ticks += '`';
    }
    state.write(ticks);
    if (value.startsWith('`')) state.write(' ');
    state.write(value);
    if (value.endsWith('`')) state.write(' ');
    state.write(ticks);
  },
  subscript(node, state) {
    state.renderInlineEnvironment(node, 'sub');
  },
  superscript(node, state) {
    state.renderInlineEnvironment(node, 'super');
  },
  delete(node, state) {
    state.renderInlineEnvironment(node, 'strike');
  },
  break(node, state) {
    state.write(' \\');
    state.ensureNewLine();
  },
  abbreviation(node, state) {
    state.renderChildren(node);
  },
  link: linkHandler,
  admonition(node: Admonition, state) {
    state.useMacro(admonition);
    state.ensureNewLine();
    const title = select('admonitionTitle', node);
    if (!node.kind) {
      fileError(state.file, `Unknown admonition kind`, {
        node,
        source: 'myst-to-typst',
      });
      return;
    }
    state.useMacro(admonitionMacros[node.kind]);
    state.write(`#${node.kind}Block`);
    if (title && toText(title).toLowerCase().replace(' ', '') !== node.kind) {
      state.write('(heading: [');
      state.renderChildren(title);
      state.write('])');
    }
    state.write('[\n');
    state.renderChildren(node);
    state.write('\n]\n\n');
  },
  admonitionTitle() {
    return;
  },
  table: tableHandler,
  tableRow: tableRowHandler,
  tableCell: tableCellHandler,
  image(node, state) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { width: nodeWidth, url: nodeSrc, align } = node;
    const src = nodeSrc;
    const width = getLatexImageWidth(nodeWidth);
    const command = state.data.isInTable || !state.data.isInFigure ? '#image' : 'image';
    state.write(`${command}("${src}"`);
    if (!state.data.isInTable) {
      state.write(`, width: ${width}`);
    }
    state.write(')\n\n');
  },
  container: containerHandler,
  caption: captionHandler,
  legend: captionHandler,
  captionNumber: () => undefined,
  crossReference(node, state, parent) {
    // Look up reference and add the text
    // const usedTemplate = node.template?.includes('%s') ? node.template : undefined;
    // const text = (usedTemplate ?? toText(node))?.replace(/\s/g, '~') || '%s';
    const id = node.identifier;
    // state.write(text.replace(/%s/g, `@${id}`));
    const next = nextCharacterIsText(parent, node);
    state.write(next ? `#[@${id}]` : `@${id}`);
  },
  citeGroup(node, state) {
    state.renderChildren(node, 0, ' ');
  },
  cite(node, state) {
    state.write(`#cite(<${node.label}>`);
    if (node.kind === 'narrative') state.write(`, form: "prose"`);
    // node.prefix not supported by typst: see https://github.com/typst/typst/issues/1139
    if (node.suffix) state.write(`, supplement: [${node.suffix}]`);
    state.write(`)`);
  },
  embed(node, state) {
    state.renderChildren(node);
  },
  include(node, state) {
    state.renderChildren(node);
  },
  footnoteReference(node, state) {
    if (!node.identifier) return;
    const footnote = state.footnotes[node.identifier];
    if (!footnote) {
      fileError(state.file, `Unknown footnote identifier "${node.identifier}"`, {
        node,
        source: 'myst-to-typst',
      });
      return;
    }
    state.write('#footnote[');
    state.renderChildren(footnote);
    state.write(']');
  },
  footnoteDefinition() {
    // Nothing!
  },
  // si(node, state) {
  //   // state.useMacro('siunitx');
  //   if (node.number == null) {
  //     state.write(`\\unit{${node.units?.map((u: string) => `\\${u}`).join('') ?? ''}}`);
  //   } else {
  //     state.write(
  //       `\\qty{${node.number}}{${node.units?.map((u: string) => `\\${u}`).join('') ?? ''}}`,
  //     );
  //   }
  // },
};

class TypstSerializer implements ITypstSerializer {
  file: VFile;
  data: StateData;
  options: Options;
  handlers: Record<string, Handler>;
  footnotes: Record<string, FootnoteDefinition>;

  constructor(file: VFile, tree: Root, opts?: Options) {
    file.result = '';
    this.file = file;
    this.options = opts ?? {};
    this.data = { mathPlugins: {}, macros: new Set() };
    this.handlers = opts?.handlers ?? handlers;
    this.footnotes = Object.fromEntries(
      selectAll('footnoteDefinition', tree).map((node) => {
        const fn = node as FootnoteDefinition;
        return [fn.identifier, fn];
      }),
    );
    this.renderChildren(tree);
  }

  get out(): string {
    return this.file.result as string;
  }

  useMacro(macro: string) {
    this.data.macros.add(macro);
  }

  write(value: string) {
    this.file.result += value;
  }

  text(value: string, mathMode = false) {
    const escaped = mathMode ? stringToTypstMath(value) : stringToTypstText(value);
    this.write(escaped);
  }

  trimEnd() {
    this.file.result = this.out.trimEnd();
  }

  addNewLine() {
    this.write('\n');
  }

  ensureNewLine(trim = false) {
    if (trim) this.trimEnd();
    if (this.out.endsWith('\n')) return;
    this.addNewLine();
  }

  renderChildren(node: Partial<Parent>, trailingNewLines = 0, delim = '') {
    const numChildren = node.children?.length ?? 0;
    node.children?.forEach((child, index) => {
      if (!child) return;
      const handler = this.handlers[child?.type];
      if (handler) {
        handler(child, this, node);
      } else {
        fileError(this.file, `Unhandled Typst conversion for node of "${child?.type}"`, {
          node: child,
          source: 'myst-to-typst',
        });
      }
      if (delim && index + 1 < numChildren) this.write(delim);
    });
    this.trimEnd();
    for (let i = trailingNewLines; i--; ) this.addNewLine();
  }

  renderEnvironment(node: any, env: string) {
    this.file.result += `#${env}[\n`;
    this.renderChildren(node, 1);
    this.file.result += `]\n\n`;
  }

  renderInlineEnvironment(node: any, env: string) {
    this.file.result += `#${env}[`;
    this.renderChildren(node);
    this.file.result += ']';
  }
}

const plugin: Plugin<[Options?], Root, VFile> = function (opts) {
  this.Compiler = (node, file) => {
    const state = new TypstSerializer(file, node, opts ?? { handlers });
    const tex = (file.result as string).trim();
    const result: TypstResult = {
      macros: [...state.data.macros],
      commands: withRecursiveCommands(state),
      value: tex,
    };
    file.result = result;
    return file;
  };

  return (node: Root) => {
    // Preprocess
    return node;
  };
};

export default plugin;
