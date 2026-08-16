import { dump, load } from 'js-yaml';

export function stripConventionSidecars(specYaml: string): string {
  const parsed = load(specYaml);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return specYaml;
  }
  const stripped = { ...(parsed as Record<string, unknown>) };
  delete stripped.view;
  delete stripped.render;
  delete stripped.policies;
  delete stripped.capabilities;
  delete stripped.composite;
  delete stripped.notebook;
  return dump(stripped, { lineWidth: -1, noRefs: true, sortKeys: false });
}
