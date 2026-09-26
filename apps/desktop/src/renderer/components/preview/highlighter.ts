import {
  createHighlighterCore,
  type HighlighterCore,
  type ThemeRegistrationAny,
  type ThemedToken,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export type { ThemedToken };

export interface HighlightResult {
  lang: string;
  /** 每行若干 token;调用方负责按行渲染与行号 */
  lines: ThemedToken[][];
}

/**
 * token 颜色是 CSS 变量,由 styles.css 里的各个应用主题给出具体值,
 * 切换主题时无需重新分词。
 */
const velaTheme: ThemeRegistrationAny = {
  name: "vela",
  type: "light",
  colors: { "editor.foreground": "var(--syntax-fg)", "editor.background": "var(--bg-code)" },
  tokenColors: [
    { settings: { foreground: "var(--syntax-fg)" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--syntax-comment)", fontStyle: "italic" } },
    { scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"], settings: { foreground: "var(--syntax-string)" } },
    { scope: ["constant.numeric", "constant.language", "constant.character.escape"], settings: { foreground: "var(--syntax-number)" } },
    { scope: ["keyword", "keyword.operator", "storage", "variable.language", "punctuation.definition.tag"], settings: { foreground: "var(--syntax-keyword)" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call", "variable.function"], settings: { foreground: "var(--syntax-function)" } },
    { scope: ["entity.name.type", "support.type", "support.class", "entity.name.class", "entity.name.namespace", "entity.name.tag"], settings: { foreground: "var(--syntax-type)" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "var(--syntax-attr)" } },
    { scope: ["variable", "meta.property-name"], settings: { foreground: "var(--syntax-fg)" } },
  ],
};

type LangImport = () => Promise<{ default: unknown }>;

/** 显式列出语言的动态导入,Vite 才能做静态分析与分包。 */
const langImports: Record<string, LangImport> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  objc: () => import("shiki/langs/objc.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  vim: () => import("shiki/langs/vim.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  cmake: () => import("shiki/langs/cmake.mjs"),
  bat: () => import("shiki/langs/bat.mjs"),
};

const extensionToLang: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx", tsx: "tsx",
  json: "json", jsonc: "jsonc", json5: "jsonc",
  css: "css", scss: "scss", sass: "scss", less: "less",
  html: "html", htm: "html", vue: "vue", svelte: "svelte",
  md: "markdown", markdown: "markdown", mdx: "mdx",
  yml: "yaml", yaml: "yaml", toml: "toml",
  xml: "xml", svg: "xml", xsl: "xml", plist: "xml",
  py: "python", pyi: "python",
  go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", ino: "cpp",
  cs: "csharp", m: "objc", mm: "objc",
  php: "php", rb: "ruby", rake: "ruby",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  sql: "sql", graphql: "graphql", gql: "graphql",
  lua: "lua", pl: "perl", pm: "perl", zig: "zig", dart: "dart",
  ex: "elixir", exs: "elixir", hs: "haskell", scala: "scala", r: "r",
  vim: "vim", bat: "bat", cmd: "bat",
  ini: "ini", cfg: "ini", conf: "ini", env: "ini", properties: "ini",
  mk: "make", cmake: "cmake",
  diff: "diff", patch: "diff",
};

/** 扩展名 → shiki 语言;不支持时返回 null,调用方按纯文本渲染。 */
export function languageForPath(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  if (name.toLowerCase() === "dockerfile") return "dockerfile";
  if (name.toLowerCase() === "makefile") return "make";
  if (name.toLowerCase() === "cmakelists.txt") return "cmake";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return extensionToLang[ext] ?? null;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
const pendingLangs = new Map<string, Promise<boolean>>();

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [velaTheme],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    highlighterPromise.catch(() => {
      highlighterPromise = null;
    });
  }
  return highlighterPromise;
}

async function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<boolean> {
  if (highlighter.getLoadedLanguages().includes(lang)) return true;
  let pending = pendingLangs.get(lang);
  if (!pending) {
    const load = langImports[lang];
    if (!load) return false;
    pending = load()
      .then((module) => highlighter.loadLanguage(module as never))
      .then(() => true)
      .catch((error) => {
        console.error("[vela-highlight] 语言加载失败", lang, error);
        return false;
      });
    pendingLangs.set(lang, pending);
  }
  return pending;
}

const plainFenceLangs = new Set(["text", "txt", "plaintext", "plain", "none"]);

/** 围栏信息里的简写,补上扩展名表没有的叫法。 */
const fenceAliases: Record<string, string> = {
  shell: "shellscript",
  console: "shellscript",
  "c++": "cpp",
  "c#": "csharp",
  "objective-c": "objc",
  objectivec: "objc",
  golang: "go",
  docker: "dockerfile",
};

/** 代码块语言标记 → shiki 语言;纯文本或不认识时返回 null。 */
export function languageForFence(info: string): string | null {
  const token = info.trim().toLowerCase().split(/[\s,{]+/)[0] ?? "";
  if (!token || plainFenceLangs.has(token)) return null;
  if (langImports[token]) return token;
  const alias = fenceAliases[token] ?? extensionToLang[token];
  if (alias && langImports[alias]) return alias;
  return null;
}

async function highlightWithLanguage(lang: string, content: string): Promise<ThemedToken[][] | null> {
  if (!langImports[lang]) return null;
  let highlighter: HighlighterCore;
  try {
    highlighter = await getHighlighter();
  } catch (error) {
    console.error("[vela-highlight] highlighter 创建失败", error);
    return null;
  }
  if (!(await ensureLanguage(highlighter, lang))) return null;
  try {
    const result = highlighter.codeToTokens(content, { lang, theme: velaTheme });
    return result.tokens;
  } catch (error) {
    console.error("[vela-highlight] codeToTokens 失败", lang, error);
    return null;
  }
}

/** 按文件路径高亮;语言不支持或加载失败时返回 null(纯文本)。 */
export async function highlightDocument(path: string, content: string): Promise<HighlightResult | null> {
  const lang = languageForPath(path);
  if (!lang) return null;
  const lines = await highlightWithLanguage(lang, content);
  if (!lines) return null;
  return { lang, lines };
}

/** 按围栏语言高亮一段代码;语言不支持或加载失败时返回 null。 */
export async function highlightSnippet(lang: string, content: string): Promise<ThemedToken[][] | null> {
  return highlightWithLanguage(lang, content);
}
