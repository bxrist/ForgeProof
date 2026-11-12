// Node 22's built-in transform handles TS; resolve the repo's extensionless imports.
// Use: node --experimental-transform-types --loader ./tests/support/typescript-resolver.mjs --test ...
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || /\.[a-z]+$/i.test(specifier)) throw error;
    return nextResolve(specifier + '.ts', context);
  }
}
