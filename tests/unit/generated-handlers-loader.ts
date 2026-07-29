import { createContext, Script } from 'node:vm';
import { reconstructArray, type ReactionHandler } from '@simodelne/pgas-server/plugin.js';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

export function loadGeneratedReactionHandlers(source: string): Map<string, ReactionHandler> {
  const transpiled = transpileModule(source, {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2022,
      strict: true,
    },
  });
  const exportsObject: Record<string, unknown> = {};
  const moduleObject = { exports: exportsObject };
  const context = createContext({
    exports: exportsObject,
    module: moduleObject,
    require: (specifier: string): Record<string, unknown> => {
      if (specifier === '@simodelne/pgas-server/plugin.js') {
        return { reconstructArray };
      }
      if (specifier === './handlers/_resolver.js') {
        return { resolveDomainValue };
      }
      throw new Error(`unexpected generated handlers import: ${specifier}`);
    },
  });
  new Script(transpiled.outputText, { filename: 'generated-handlers.cjs' }).runInContext(context, {
    timeout: 1_000,
  });

  const exported = moduleObject.exports as Record<string, unknown>;
  if (!exported.reactionHandlers || typeof (exported.reactionHandlers as Map<string, ReactionHandler>).get !== 'function') {
    throw new Error('generated handlers did not expose reactionHandlers');
  }
  return exported.reactionHandlers as Map<string, ReactionHandler>;
}

function resolveDomainValue<T>(
  payload: { domain?: Record<string, unknown> } | undefined,
  path: string,
  fallback: T,
): T {
  const value = payload?.domain?.[path];
  return value === undefined ? fallback : value as T;
}
