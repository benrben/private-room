export const MAX_EDGES = 400; // cap rendered/simulated edges — keep it snappy
export const MAX_NODES = 800;
export const AREA_PER_NODE = 8000; // ideal-distance k = sqrt(AREA_PER_NODE) ≈ 89px
export const COOL = 0.94; // temperature decay per tick
export const GRAVITY = 0.015; // gentle pull to centre so the graph stays framed
export const EMPTY_TEXT = "Add a few files and I'll map how they connect.";

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 12;
export const FIT_PAD = 52; // px of breathing room around the graph when fitting

// Label de-clutter tuning.
export const LABEL_MIN_R_PX = 6.4; // a star must render at least this big to auto-label
export const LABEL_FONT = 11;
export const LABEL_CHAR_W = 6.25; // rough advance width at LABEL_FONT for de-clutter
export const LABEL_MAX = 48; // hard cap on labels drawn at once
export const NAME_MAX = 30; // truncate long names in labels

export const VIOLET = "#8b7cf6";
export const VIOLET_SOFT = "rgba(139, 124, 246, 0.16)";
export const MEMORY = "#4cc38a";
