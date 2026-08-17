import { Platform } from 'youtubei.js';

let installed = false;

/**
 * youtubei.js ≥ 16 n’embarque plus d’interpréteur : sans ça,
 * decipher() lève « To decipher URLs, you must provide your own JavaScript evaluator »
 * et les formats TV n’ont souvent plus d’URL en clair.
 */
export function installYoutubeJsEvaluator() {
  if (installed) return;
  const shim = Platform.shim;
  Platform.load({
    ...shim,
    eval: (data, env) => {
      const properties: string[] = [];
      if (env.n) {
        properties.push(`n: exportedVars.nFunction(${JSON.stringify(String(env.n))})`);
      }
      if (env.sig) {
        properties.push(`sig: exportedVars.sigFunction(${JSON.stringify(String(env.sig))})`);
      }
      const code = `${data.output}\nreturn { ${properties.join(', ')} }`;
      return new Function(code)();
    },
  });
  installed = true;
}
