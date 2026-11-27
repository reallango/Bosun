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
export const WIDGET_API_LEVEL = 6;

/** The optional `requires` object of a package manifest. */
export interface WidgetApiRequires { api: number }

/**
 * Why this Bosun cannot honour a package's `requires`, or null when it can (or the package names none).
 * The message is what the admin sees, on every path that refuses the package.
 */
export function apiLevelProblem(requires: WidgetApiRequires | null | undefined): string | null {
  if (!requires || requires.api <= WIDGET_API_LEVEL) return null;
  return `This widget needs a newer Bosun (widget API level ${requires.api}; this Bosun has ${WIDGET_API_LEVEL}). Update Bosun first.`;
}
