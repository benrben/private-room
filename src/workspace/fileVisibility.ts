import type { FileMeta } from "../api";

/** WHERE AN OBJECT SHOWS UP — the section-only model, in one place.
 *
 * Every object here is a full room file: encrypted, versioned, searchable,
 * attachable, undeletable-by-accident. The only question this module answers is
 * which LISTS show it, and it is deliberately a question about visibility
 * rather than about storage, because there is exactly one copy of everything.
 *
 * Adding to the Library is a link, not a duplicate. One id, one version
 * history, one title, one set of bytes — rename it from Sketches and Home shows
 * the new name, because Home is looking at the same row. Removing from the
 * Library takes the Home reference away and leaves the object where it lives;
 * deleting is a different verb entirely, with the trash behind it.
 *
 * Pure and dependency-free so the rules can be tested without a room.
 */

/** Does Home's Library list this file?
 *
 * `linked` is the default in the database (see `schema.rs`), so everything a
 * room already held before this existed answers true — which is what those
 * rooms mean. Nothing was hidden by the upgrade. */
export function isLibraryVisible(f: FileMeta): boolean {
  return f.libraryVisibility !== "sectionOnly";
}

/** The files Home shows. Everything Home renders — Browse, AI sources, the
 * document strip, the counts beside them — goes through this, so the four can
 * never disagree about what "in the Library" means. */
export function libraryFiles(files: FileMeta[]): FileMeta[] {
  return files.filter(isLibraryVisible);
}

/** The reader-facing name of where a section-only object lives. Used in the
 * status chip and in the promotion dialog's sentence, so both name the same
 * place in the same words the rail does. */
export function sectionLabel(origin: string): string {
  switch (origin) {
    case "sketch":
      return "Sketches";
    case "create":
      return "Creations";
    case "recordings":
      return "Recordings";
    default:
      return "the Library";
  }
}

/** The compact state a promotable object's toolbar shows.
 *
 * `null` for an object that has no promotion to offer — an ordinary Library
 * file that never belonged to a section. Those get NO chip: a badge reading
 * "In Library" on every one of a hundred rows is decoration, and the point of
 * the chip is that it marks the exception. */
export function libraryStatus(
  f: FileMeta,
): { linked: boolean; label: string; where: string } | null {
  const promotable = f.originDestination !== "library";
  if (!promotable) return null;
  const linked = isLibraryVisible(f);
  return {
    linked,
    label: linked ? "In Library" : "Section only",
    where: sectionLabel(f.originDestination),
  };
}
