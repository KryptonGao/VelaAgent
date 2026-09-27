import { createContext, useContext, type ReactNode } from "react";
import astro from "devicon/icons/astro/astro-original.svg";
import bash from "devicon/icons/bash/bash-original.svg";
import c from "devicon/icons/c/c-original.svg";
import cplusplus from "devicon/icons/cplusplus/cplusplus-original.svg";
import csharp from "devicon/icons/csharp/csharp-original.svg";
import css3 from "devicon/icons/css3/css3-original.svg";
import dart from "devicon/icons/dart/dart-original.svg";
import docker from "devicon/icons/docker/docker-original.svg";
import elixir from "devicon/icons/elixir/elixir-original.svg";
import go from "devicon/icons/go/go-original.svg";
import graphql from "devicon/icons/graphql/graphql-plain.svg";
import html5 from "devicon/icons/html5/html5-original.svg";
import java from "devicon/icons/java/java-original.svg";
import javascript from "devicon/icons/javascript/javascript-original.svg";
import json from "devicon/icons/json/json-original.svg";
import kotlin from "devicon/icons/kotlin/kotlin-original.svg";
import lua from "devicon/icons/lua/lua-original.svg";
import markdown from "devicon/icons/markdown/markdown-original.svg";
import php from "devicon/icons/php/php-original.svg";
import powershell from "devicon/icons/powershell/powershell-original.svg";
import python from "devicon/icons/python/python-original.svg";
import ruby from "devicon/icons/ruby/ruby-original.svg";
import rust from "devicon/icons/rust/rust-original.svg";
import sass from "devicon/icons/sass/sass-original.svg";
import scala from "devicon/icons/scala/scala-original.svg";
import svelte from "devicon/icons/svelte/svelte-original.svg";
import swift from "devicon/icons/swift/swift-original.svg";
import typescript from "devicon/icons/typescript/typescript-original.svg";
import vue from "devicon/icons/vuejs/vuejs-original.svg";
import xml from "devicon/icons/xml/xml-original.svg";
import yaml from "devicon/icons/yaml/yaml-original.svg";
import zsh from "devicon/icons/zsh/zsh-original.svg";
import materialAstro from "material-icon-theme/icons/astro.svg";
import materialC from "material-icon-theme/icons/c.svg";
import materialConsole from "material-icon-theme/icons/console.svg";
import materialCpp from "material-icon-theme/icons/cpp.svg";
import materialCsharp from "material-icon-theme/icons/csharp.svg";
import materialCss from "material-icon-theme/icons/css.svg";
import materialDart from "material-icon-theme/icons/dart.svg";
import materialDocker from "material-icon-theme/icons/docker.svg";
import materialElixir from "material-icon-theme/icons/elixir.svg";
import materialFile from "material-icon-theme/icons/file.svg";
import materialGo from "material-icon-theme/icons/go.svg";
import materialGraphql from "material-icon-theme/icons/graphql.svg";
import materialH from "material-icon-theme/icons/h.svg";
import materialHpp from "material-icon-theme/icons/hpp.svg";
import materialHtml from "material-icon-theme/icons/html.svg";
import materialJava from "material-icon-theme/icons/java.svg";
import materialJavascript from "material-icon-theme/icons/javascript.svg";
import materialJson from "material-icon-theme/icons/json.svg";
import materialKotlin from "material-icon-theme/icons/kotlin.svg";
import materialLua from "material-icon-theme/icons/lua.svg";
import materialMarkdown from "material-icon-theme/icons/markdown.svg";
import materialMdx from "material-icon-theme/icons/mdx.svg";
import materialPhp from "material-icon-theme/icons/php.svg";
import materialPowershell from "material-icon-theme/icons/powershell.svg";
import materialPython from "material-icon-theme/icons/python.svg";
import materialReact from "material-icon-theme/icons/react.svg";
import materialReactTs from "material-icon-theme/icons/react_ts.svg";
import materialRuby from "material-icon-theme/icons/ruby.svg";
import materialRust from "material-icon-theme/icons/rust.svg";
import materialSass from "material-icon-theme/icons/sass.svg";
import materialScala from "material-icon-theme/icons/scala.svg";
import materialSvelte from "material-icon-theme/icons/svelte.svg";
import materialSwift from "material-icon-theme/icons/swift.svg";
import materialTypescript from "material-icon-theme/icons/typescript.svg";
import materialVue from "material-icon-theme/icons/vue.svg";
import materialXml from "material-icon-theme/icons/xml.svg";
import materialYaml from "material-icon-theme/icons/yaml.svg";
import type { FileIconTheme } from "../hooks/usePreferences";

const FileIconThemeContext = createContext<FileIconTheme>("devicon");

export function FileIconThemeProvider({ value, children }: { value: FileIconTheme; children: ReactNode }) {
  return <FileIconThemeContext.Provider value={value}>{children}</FileIconThemeContext.Provider>;
}

const fileIconsByExtension: Record<string, string> = {
  ts: typescript,
  tsx: typescript,
  js: javascript,
  mjs: javascript,
  cjs: javascript,
  jsx: javascript,
  py: python,
  rs: rust,
  go,
  java,
  php,
  rb: ruby,
  swift,
  kt: kotlin,
  kts: kotlin,
  c,
  h: c,
  cc: cplusplus,
  cpp: cplusplus,
  cxx: cplusplus,
  hpp: cplusplus,
  cs: csharp,
  dart,
  ex: elixir,
  exs: elixir,
  scala,
  lua,
  sh: bash,
  bash,
  zsh,
  ps1: powershell,
  html: html5,
  htm: html5,
  css: css3,
  scss: sass,
  sass,
  json,
  yaml,
  yml: yaml,
  md: markdown,
  mdx: markdown,
  xml,
  graphql,
  gql: graphql,
  vue,
  svelte,
  astro,
  dockerfile: docker,
};

const fileIconsByName: Record<string, string> = {
  dockerfile: docker,
  ".dockerignore": docker,
};

const materialIconsByExtension: Record<string, string> = {
  ts: materialTypescript,
  tsx: materialReactTs,
  js: materialJavascript,
  mjs: materialJavascript,
  cjs: materialJavascript,
  jsx: materialReact,
  py: materialPython,
  rs: materialRust,
  go: materialGo,
  java: materialJava,
  php: materialPhp,
  rb: materialRuby,
  swift: materialSwift,
  kt: materialKotlin,
  kts: materialKotlin,
  c: materialC,
  h: materialH,
  cc: materialCpp,
  cpp: materialCpp,
  cxx: materialCpp,
  hpp: materialHpp,
  cs: materialCsharp,
  dart: materialDart,
  ex: materialElixir,
  exs: materialElixir,
  scala: materialScala,
  lua: materialLua,
  sh: materialConsole,
  bash: materialConsole,
  zsh: materialConsole,
  ps1: materialPowershell,
  html: materialHtml,
  htm: materialHtml,
  css: materialCss,
  scss: materialSass,
  sass: materialSass,
  json: materialJson,
  yaml: materialYaml,
  yml: materialYaml,
  md: materialMarkdown,
  mdx: materialMdx,
  xml: materialXml,
  graphql: materialGraphql,
  gql: materialGraphql,
  vue: materialVue,
  svelte: materialSvelte,
  astro: materialAstro,
  dockerfile: materialDocker,
};

const materialIconsByName: Record<string, string> = {
  dockerfile: materialDocker,
  ".dockerignore": materialDocker,
};

export function FileTypeIcon({ path }: { path: string }) {
  const theme = useContext(FileIconThemeContext);
  const fileName = path.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? "";
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1) : fileName;
  const icon =
    theme === "material"
      ? materialIconsByName[fileName] ?? materialIconsByExtension[extension] ?? materialFile
      : fileIconsByName[fileName] ?? fileIconsByExtension[extension];
  if (!icon) return null;

  return <img className="file-type-icon" src={icon} alt="" aria-hidden="true" />;
}
