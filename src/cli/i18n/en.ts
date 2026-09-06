/**
 * The English message catalog: the source of truth every other locale is
 * typed against (`type Catalog = typeof en`). Values are plain strings;
 * `{name}` tokens are filled by `t()`, plural variants by `choose()`.
 * Adding a string means adding a key here and the translation in `ru.ts`
 * in the same change — the compiler rejects a partial catalog, so locales
 * cannot drift silently.
 */
export const en = {} as const;

/** The shape every locale's catalog must satisfy exactly. */
export type Catalog = typeof en;
