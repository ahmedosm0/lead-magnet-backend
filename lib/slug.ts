/**
 * Turns a free-typed client name ("Crestline Roofing Co.") into the id used as
 * a directory name (uploads/<slug>, output/<slug>) and in report URLs.
 *
 * Keep this strict — the slug is interpolated straight into filesystem paths,
 * so anything outside [a-z0-9-] must be gone before it reaches disk. Validation
 * is separate from generation because API routes receive slugs directly (where
 * there is nothing to slugify, only to reject).
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const VALID_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidClientSlug(slug: string): boolean {
  return VALID_SLUG.test(slug) && slug.length <= 100;
}
