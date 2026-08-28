import type { CreateCatalog, CreateModel } from "../../api";

/** What the Create page can be asked to make. */
export type CreateKind = "image" | "video";

/** The models to show on one tab, narrowed by the name filter.
 *
 * A model that makes BOTH stills and clips appears on both tabs rather than
 * being forced into one — the catalog is allowed to say a model does two
 * things, and hiding half of that would make the shelf disagree with the
 * ledger's own counts. */
export function visibleModels(
  models: CreateModel[],
  kind: CreateKind,
  query: string,
): CreateModel[] {
  const needle = query.trim().toLowerCase();
  return models.filter((m) => {
    if (kind === "image" ? !m.image : !m.video) return false;
    if (!needle) return true;
    return `${m.label} ${m.slug}`.toLowerCase().includes(needle);
  });
}

/** The model the bench is composing for.
 *
 * Falls back to the first model of the current tab, so switching tabs can
 * never leave the bench pointing at something the gallery is no longer
 * showing — which read as the page ignoring the click. */
export function selectedModel(
  visible: CreateModel[],
  picked: string | null,
): CreateModel | null {
  return visible.find((m) => m.model === picked) ?? visible[0] ?? null;
}

/** The ledger's three figures.
 *
 * `cannot` is summed from the exclusion rows rather than derived as
 * `scanned - models.length`: the rows are what the disclosure lists, so a
 * subtraction that disagreed with them would put two different numbers for
 * the same fact on one screen. */
export function tallies(catalog: CreateCatalog | null): {
  image: number;
  video: number;
  cannot: number;
  can: number;
  scanned: number;
} {
  if (!catalog) return { image: 0, video: 0, cannot: 0, can: 0, scanned: 0 };
  return {
    image: catalog.models.filter((m) => m.image).length,
    video: catalog.models.filter((m) => m.video).length,
    cannot: catalog.excluded.reduce((sum, row) => sum + row.count, 0),
    can: catalog.models.length,
    scanned: catalog.scanned,
  };
}

/** Why THIS tab is empty, in the reader's terms.
 *
 * The distinction matters and was got wrong first time round: with a filter
 * typed, an empty video shelf is a filter miss, not evidence that no model
 * makes video. Saying the latter while a search box holds text is a claim
 * about the catalogue that the catalogue never made.
 *
 * The video wording used to assert that no provider serves a video model at
 * all. That was FALSE, and confidently so — it was written from the default
 * `/models` listing, which omits every media model. The filtered catalogue
 * returns 21. An empty video tab now means the catalogue did not load, which
 * is a different and much more useful thing to say. */
export function emptyShelfLine(kind: CreateKind, query: string): string {
  const needle = query.trim();
  if (needle) return `Nothing matches “${needle}”.`;
  return kind === "video"
    ? "No video models came back from the connected provider. Reconnect it in Settings so its catalogue reloads."
    : "No image models came back from the connected provider. Reconnect it in Settings so its catalogue reloads.";
}

/** The clip lengths one model actually accepts.
 *
 * Empty means the provider published no list, which is NOT "any length" — it
 * is "we were not told", and the caller's job is then to send no duration at
 * all and let the model's own default stand. Offering a made-up set of numbers
 * would produce a refusal on most of the shelf: Veo takes 4, 6 and 8 seconds
 * and nothing else, while Kling takes every whole number from 3 to 15. */
export function legalSeconds(model: CreateModel | null): number[] {
  return model?.limits?.durations ?? [];
}

/** The values every one of these models will accept — their intersection.
 *
 * Needed because a shot list's frame shape has to satisfy TWO models at once:
 * the picture model that draws the still, and the clip model that animates it.
 * The still becomes the clip's literal first frame, so offering a shape only
 * one of them takes would mean drawing a 1:1 picture and pinning it to the
 * front of a 16:9 clip — a mismatch nothing downstream can repair.
 *
 * A model that publishes NO list is skipped rather than treated as empty:
 * "we were not told" must not intersect everything down to nothing, which
 * would leave the control offering no values at all on a shelf where most
 * models publish sizes and one does not. */
export function sharedValues(
  models: (CreateModel | null | undefined)[],
  pick: (limits: NonNullable<CreateModel["limits"]>) => string[],
): string[] {
  const published = models
    .map((m) => (m?.limits ? pick(m.limits) : []))
    .filter((list) => list.length > 0);
  if (published.length === 0) return [];
  return published.reduce((keep, list) => keep.filter((v) => list.includes(v)));
}

/** Can a picture be pinned to the front of this model's clip?
 *
 * Two of the video models in the live catalogue (Runway Aleph 2, Sora 2 Pro)
 * publish no frame slots at all. Offering them a starting picture would be
 * offering something that is silently ignored — the user pays, and gets a clip
 * with no relation to the picture they chose. */
export function takesFirstFrame(model: CreateModel | null): boolean {
  // NO ENTRY at all is the unknown case — the limits table did not load, or
  // this model is not in it — and stays permissive, because refusing a legal
  // feature on the strength of a table we never received is the worse error.
  if (!model?.limits) return true;
  // An EMPTY list is a published answer, not a missing one. Every video model
  // that accepts a frame lists its slots; the two that do not (Runway Aleph 2,
  // Sora 2 Pro) send `supported_frame_images: null`. So empty means no.
  return model.limits.frameImages.includes("first_frame");
}

/** Which empty state the page owes the reader.
 *
 * Three different sentences, because they call for three different actions:
 * a failed catalog fetch is a retry, no provider is a setup step, and a
 * provider whose models simply cannot draw is a settled fact. Collapsing
 * them into one "nothing here" would tell two thirds of readers the wrong
 * thing. */
export function emptyReason(
  catalog: CreateCatalog | null,
): "loading" | "error" | "no-provider" | "none-can-draw" | null {
  if (!catalog) return "loading";
  if (catalog.error) return "error";
  if (catalog.models.length > 0) return null;
  return catalog.anyProvider ? "none-can-draw" : "no-provider";
}
