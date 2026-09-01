/** Stable creative-job surface; implementation is split by execution domain. */
export { creativeAttachment, storeCreativeOutput } from "./creativeJobSurfaceCreate.js";
export { installCreativeJobStarters, registerCreativeJobSurfaceIpc } from "./creativeJobSurfaceRegistry.js";
export { startDeepSummaryJob } from "./creativeJobSurfaceSummary.js";
