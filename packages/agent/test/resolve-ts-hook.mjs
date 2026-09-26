const extensions = [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".json", ".node"];

function hasExtension(specifier) {
  return extensions.some((extension) => specifier.endsWith(extension));
}

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !hasExtension(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}
