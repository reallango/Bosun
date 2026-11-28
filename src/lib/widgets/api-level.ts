/**
 * The widget API level of this Bosun, and the manifest field that names the level a package needs.
 *
 * Bosun has no semantic version number (an image is identified by its git commit), but a widget package may use
 * spec keys that an older Bosun does not know. Left alone, an older Bosun would install it and silently ignore
 * those keys. A package therefore says which level it needs in its manifest:
 *
 *   "requires": { "api": 3 }
 *
 * A package without `requires` needs level 1. See `widgets/README.md` for what each level added.
 */

/** The widget API level of this Bosun. Raise it when a widget package gains a spec key that older Bosun versions cannot honour. */
export const WIDGET_API_LEVEL = 11;

/** The optional `requires` object of a package manifest. */
export interface WidgetApiRequires { api: number }

/** The level a package needs; a package that names none needs level 1. */
export function requiredApiLevel(requires: WidgetApiRequires | null | undefined): number {
  return requires && Number.isFinite(requires.api) && requires.api > 0 ? requires.api : 1;
}

/**
 * Why this Bosun cannot honour a package's `requires`, or null when it can (or the package names none).
 * The message is what the admin sees, on every path that refuses the package.
 */
export function apiLevelProblem(requires: WidgetApiRequires | null | undefined): string | null {
  if (!requires || requires.api <= WIDGET_API_LEVEL) return null;
  return `This widget needs a newer Bosun (widget API level ${requires.api}; this Bosun has ${WIDGET_API_LEVEL}). Update Bosun first.`;
}

/**
 * Why an installed package cannot be used on this node, or null when it can. This is the mixed-cluster case: the
 * database already holds a package version another (newer) node installed, and this node's API level is below what
 * the package needs. Unlike `apiLevelProblem` (an install is refused), this is shown in place of the widget.
 */
export function nodeApiLevelProblem(requires: WidgetApiRequires | null | undefined): string | null {
  if (!requires || requires.api <= WIDGET_API_LEVEL) return null;
  return `This widget needs a newer Bosun on this node (API level ${requires.api}; this node has ${WIDGET_API_LEVEL}). Finish updating the cluster.`;
}
