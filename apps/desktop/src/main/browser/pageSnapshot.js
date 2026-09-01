(function () {
  "use strict";
  if (window.__arcelleBrowse) return;
  var scope = window.__arcellePageScope;
  if (!scope) return;
  var INTERACTIVE = scope.INTERACTIVE;
  var MARK_CAP = scope.MARK_CAP;
  var elementRect = scope.elementRect;
  var generationState = scope.generationState;
  var hasVisibleDimensions = scope.hasVisibleDimensions;
  var isDisabled = scope.isDisabled;
  var isSecret = scope.isSecret;
  var isVisible = scope.isVisible;
  var labelFor = scope.labelFor;
  var regionFor = scope.regionFor;
  var registry = scope.registry;
  var roleFor = scope.roleFor;
  var stateFor = scope.stateFor;
  var truncate = scope.truncate;


  // --------------------------------------------------------------- snapshot

  function clearMarks() {
    var old = document.querySelectorAll("[data-arcelle-mark]");
    for (var i = 0; i < old.length; i++) old[i].removeAttribute("data-arcelle-mark");
    registry.clear();
  }


  /** Every INTERACTIVE element, PIERCING open shadow roots.
   *
   * THE BUG THIS EXISTS FOR (owner report 2026-07-30): a plain
   * `document.querySelectorAll` stops at the shadow boundary, so a popup built
   * as a web component — which is most modern cookie banners, sign-in widgets
   * and design-system dialogs — showed up as a clickable wrapper with NO fields
   * inside it. The agent could click the dialog and then had nothing to type
   * into, which reads as "the browser can't fill this form".
   *
   * Bounded: shadow trees nest a few levels in practice, and both caps below
   * keep a pathological page from turning one snapshot into a hang.
   */
  function interactiveIn(root) {
    var out = [];
    try {
      var hits = root.querySelectorAll(INTERACTIVE);
      for (var index = 0; index < hits.length; index++) out.push(hits[index]);
    } catch (e) {}
    return out;
  }


  function shadowRootsIn(root) {
    var roots = [];
    try {
      var all = root.querySelectorAll("*");
      for (var index = 0; index < all.length && index < 6000; index++) {
        if (all[index].shadowRoot) roots.push(all[index].shadowRoot);
      }
    } catch (e) {}
    return roots;
  }


  function collectInteractive() {
    var out = [];
    var roots = [document];
    var guard = 0;
    while (roots.length) {
      if (guard++ >= 400) break;
      var root = roots.shift();
      out = out.concat(interactiveIn(root));
      roots = roots.concat(shadowRootsIn(root));
    }
    return out;
  }


  /** Elements inside an OPEN modal, which must outrank the rest of the page when
   *  the mark cap bites: while a dialog is up, it IS the work. Without this a
   *  page carrying 100+ nav/ad controls could spend the whole cap outside the
   *  very popup the user is asking about. */
  function modalRoots() {
    var out = [];
    try {
      var nodes = document.querySelectorAll(
        'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]'
      );
      for (var i = 0; i < nodes.length; i++) {
        if (isVisible(nodes[i])) out.push(nodes[i]);
      }
    } catch (e) {}
    return out;
  }


  function inAnyModal(el, modals) {
    for (var i = 0; i < modals.length; i++) {
      try {
        if (modals[i] === el || modals[i].contains(el)) return true;
      } catch (e) {}
    }
    return false;
  }


  function candidateTop(el) {
    var rect = elementRect(el);
    return rect ? rect.top : 0;
  }


  function snapshotCandidate(el, modals, order) {
    if (isSecret(el)) return isVisible(el) ? { secret: true } : null;
    if (isDisabled(el) || !isVisible(el)) return null;
    return {
      el: el,
      top: candidateTop(el),
      order: order,
      modal: modals.length > 0 && inAnyModal(el, modals),
    };
  }


  function snapshotCandidates(nodes, modals) {
    var candidates = [];
    var secrets = 0;
    for (var index = 0; index < nodes.length; index++) {
      var candidate = snapshotCandidate(nodes[index], modals, candidates.length);
      if (!candidate) continue;
      if (candidate.secret) {
        secrets++;
        continue;
      }
      candidates.push(candidate);
    }
    return { candidates: candidates, secrets: secrets };
  }


  function modalCandidateOrder(a, b) {
    if (a.modal !== b.modal) return a.modal ? -1 : 1;
    return Math.max(a.top, 0) - Math.max(b.top, 0);
  }


  function documentCandidateOrder(a, b) {
    return a.order - b.order;
  }


  function chosenCandidates(candidates) {
    if (candidates.length <= MARK_CAP) return candidates;
    return candidates
      .slice()
      .sort(modalCandidateOrder)
      .slice(0, MARK_CAP)
      .sort(documentCandidateOrder);
  }


  function markedEntry(el, number) {
    var entry = { ref: "e" + number, role: roleFor(el), label: labelFor(el), region: regionFor(el) };
    var state = stateFor(el);
    if (state !== undefined) entry.state = state;
    return entry;
  }


  function markCandidates(candidates) {
    var elements = [];
    for (var index = 0; index < candidates.length; index++) {
      var element = candidates[index].el;
      var number = index + 1;
      try {
        element.setAttribute("data-arcelle-mark", String(number));
      } catch (e) {
        continue;
      }
      registry.set(number, new WeakRef(element));
      elements.push(markedEntry(element, number));
    }
    return elements;
  }


  function snapshotSummary(elements, overflow, secrets, frames) {
    var summary = elements.length + " interactive elements on " + truncate(document.title || location.host, 70);
    if (overflow > 0) summary += "; …and " + overflow + " more (scroll to reveal)";
    if (secrets > 0) summary += "; " + secrets + " password field(s) present — fenced, the user must type those";
    if (frames > 0) summary += "; " + frames + " cross-origin frame(s) whose contents cannot be read from here";
    return summary;
  }


  function showSnapshotBadges(opts) {
    if (opts.badges) drawBadges();
    else removeBadges();
  }


  function snapshot(opts) {
    opts = opts || {};
    clearMarks();
    generationState.value++;
    var collected = snapshotCandidates(collectInteractive(), modalRoots());
    var overflow = Math.max(0, collected.candidates.length - MARK_CAP);
    var elements = markCandidates(chosenCandidates(collected.candidates));
    var frames = crossOriginFrames();
    showSnapshotBadges(opts);
    return {
      ok: true,
      url: location.href,
      title: document.title || "",
      generation: generationState.value,
      summary: snapshotSummary(elements, overflow, collected.secrets, frames),
      count: elements.length,
      overflow: overflow,
      secrets: collected.secrets,
      crossOriginFrames: frames,
      lowSignal: lowSignal(elements),
      elements: elements,
    };
  }


  /** Honest signal about whether the text channel is worth trusting on this
   *  page. The Rust side turns a true here into an explicit "consider
   *  browse_look" line, so the model escalates without having to guess. */
  function unlabeledCount(elements) {
    var unlabeled = 0;
    for (var i = 0; i < elements.length; i++) {
      if (elements[i].label === "(unlabeled)") unlabeled++;
    }
    return unlabeled;
  }


  function canvasHeavy() {
    var heavy = false;
    var canvases;
    try {
      canvases = document.querySelectorAll("canvas");
      var vw = window.innerWidth * window.innerHeight;
      for (var index = 0; index < canvases.length; index++) {
        var rect = canvases[index].getBoundingClientRect();
        if (vw > 0 && (rect.width * rect.height) / vw > 0.6) heavy = true;
        if (index === canvases.length - 1) return heavy; }
    } catch (e) {}
    return heavy;
  }


  function lowSignal(elements) {
    var unlabeled = unlabeledCount(elements);
    if (canvasHeavy()) return "canvas covers most of the viewport";
    if (elements.length === 0) return "no interactive elements were found";
    if (unlabeled / elements.length > 0.6) return "most elements have no usable label";
    return null;
  }


  function crossOriginFrames() {
    var n = 0;
    var frames;
    try {
      frames = document.querySelectorAll("iframe");
    } catch (e) {
      return 0;
    }
    for (var i = 0; i < frames.length; i++) {
      try {
        // Touching contentDocument on a cross-origin frame throws; that throw
        // IS the test. Same-origin frames are walked by the page script's own
        // copy in that frame, so they are not counted as opaque here.
        if (!frames[i].contentDocument) n++;
      } catch (e) {
        n++;
      }
    }
    return n;
  }


  // ----------------------------------------------------------------- badges

  var BADGE_LAYER_ID = "__arcelle_som_layer";


  function removeBadges() {
    var old = document.getElementById(BADGE_LAYER_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }


  function visibleBadgeRect(element) {
    var rect = elementRect(element);
    if (!rect || !hasVisibleDimensions(rect)) return null;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return null;
    return rect;
  }


  function badgeBox(rect) {
    var box = document.createElement("div");
    box.style.cssText =
      "position:absolute;left:" +
      Math.max(0, rect.left) +
      "px;top:" +
      Math.max(0, rect.top) +
      "px;width:" +
      rect.width +
      "px;height:" +
      rect.height +
      "px;outline:2px solid rgba(255,64,129,.9);outline-offset:-1px;box-sizing:border-box";
    return box;
  }


  function badgeTag(rect, number) {
    var tag = document.createElement("div");
    tag.textContent = String(number);
    tag.style.cssText =
      "position:absolute;left:" +
      Math.max(0, rect.left) +
      "px;top:" +
      Math.max(0, rect.top - 16) +
      "px;background:rgba(255,64,129,.95);color:#fff;font:700 11px/14px ui-sans-serif,system-ui,sans-serif;" +
      "padding:1px 4px;border-radius:3px;white-space:nowrap";
    return tag;
  }


  function appendBadge(layer, ref, number) {
    var element = ref.deref();
    if (!element) return;
    var rect = visibleBadgeRect(element);
    if (!rect) return;
    layer.appendChild(badgeBox(rect));
    layer.appendChild(badgeTag(rect, number));
  }


  /** The Set-of-Marks layer: the same numbers the text snapshot uses, painted
   *  onto the page so a screenshot and the ref list are ONE coordinate system.
   *  This is what makes vision first-class rather than a second, disconnected
   *  view — the model can read `e7` in the list and see `7` in the pixels. */
  function drawBadges() {
    removeBadges();
    if (!document.body) return;
    var layer = document.createElement("div");
    layer.id = BADGE_LAYER_ID;
    layer.setAttribute("data-arcelle-ui", "1");
    layer.style.cssText =
      "position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483647";
    registry.forEach(function (ref, number) {
      appendBadge(layer, ref, number);
    });
    document.body.appendChild(layer);
  }
  Object.assign(scope, { clearMarks: clearMarks, interactiveIn: interactiveIn, shadowRootsIn: shadowRootsIn, collectInteractive: collectInteractive, modalRoots: modalRoots, inAnyModal: inAnyModal, candidateTop: candidateTop, snapshotCandidate: snapshotCandidate, snapshotCandidates: snapshotCandidates, modalCandidateOrder: modalCandidateOrder, documentCandidateOrder: documentCandidateOrder, chosenCandidates: chosenCandidates, markedEntry: markedEntry, markCandidates: markCandidates, snapshotSummary: snapshotSummary, showSnapshotBadges: showSnapshotBadges, snapshot: snapshot, unlabeledCount: unlabeledCount, canvasHeavy: canvasHeavy, lowSignal: lowSignal, crossOriginFrames: crossOriginFrames, BADGE_LAYER_ID: BADGE_LAYER_ID, removeBadges: removeBadges, visibleBadgeRect: visibleBadgeRect, badgeBox: badgeBox, badgeTag: badgeTag, appendBadge: appendBadge, drawBadges: drawBadges });
})();
