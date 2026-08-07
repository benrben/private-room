export const MAX_EDGES = 400; // cap rendered/simulated edges — keep it snappy
export const MAX_NODES = 800;
/** Mirrors GRAPH_MAX_FILES in src-tauri/src/commands/moonshot/graph.rs: the
 * backend maps only the newest N files, so a room with more than that gets a
 * partial map. Kept here so the header can SAY so instead of presenting the
 * count as the whole room. */
export const GRAPH_MAX_FILES = 60;
export const AREA_PER_NODE = 8000; // ideal-distance k = sqrt(AREA_PER_NODE) ≈ 89px
export const COOL = 0.94; // temperature decay per tick
export const GRAVITY = 0.015; // gentle pull to centre so the graph stays framed
export const EMPTY_TEXT = "Add a few files and I'll map how they connect.";

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 12;
export const FIT_PAD = 52; // px of breathing room around the graph when fitting

/* ----- label de-clutter tuning -----
 *
 * LABEL_FONT is 12 because 12 is the smallest size the notebook allows anywhere
 * (--fs-micro in tokens.css). It used to be 11, which is under that floor and
 * is exactly the size at which a room full of similar file names stops being
 * readable at a glance — the thing labels exist for.
 *
 * LABEL_CHAR_W is a deliberate OVERestimate of Manrope's average advance at
 * that size (~6.6px): the number only feeds the collision test, and guessing a
 * label slightly too wide costs a little empty paper, while guessing it too
 * narrow lets two names print on top of each other. */
export const LABEL_MIN_R_PX = 6.4; // a star must render at least this big to auto-label
export const LABEL_FONT = 12;
export const LABEL_CHAR_W = 6.8;
export const LABEL_PAD = 6; // paper between the card's edge and the first glyph
export const LABEL_H = 19; // card height — LABEL_FONT plus a line of air
/** Extra width a memory label needs for the small ring mark in front of its
 *  name. The mark repeats the memory node's own SHAPE, so "this is a memory"
 *  survives being read by someone who cannot separate the two by colour. */
export const LABEL_MARK_W = 12;
export const LABEL_MAX = 48; // hard cap on labels drawn at once
export const NAME_MAX = 30; // truncate long names in labels

/* There are deliberately NO colour constants in this file any more.
 *
 * The map used to carry VIOLET / VIOLET_SOFT / MEMORY here and hand them to SVG
 * PRESENTATION ATTRIBUTES. That is a trap worth remembering: var() in an
 * attribute is proven in this tree (see SparkIcon), but a color-mix() there is
 * not, and this project has already lost a whole feature to a WebKit
 * color-mix() parsing gap that Chrome accepted silently (the dotted grid, see
 * tokens.css). An unsupported attribute value falls back to SVG's INITIAL fill,
 * which is black — so the failure mode was every file node wearing a black halo.
 *
 * Every mark on the map is now painted by a class in roomMap.css instead, where
 * colour is a normal CSS declaration, flips with the theme for free, and cannot
 * be silently dropped. Do not reintroduce a colour literal here. */
