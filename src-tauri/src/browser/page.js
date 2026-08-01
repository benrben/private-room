/* BROWSE-1: the agent's page script.
 *
 * Injected into EVERY frame of the private browser at document start (a
 * WKUserScript on the child webview's configuration), so it is in place before
 * any page code runs and needs no allowlist — Tauri's own IPC cannot reach an
 * arbitrary remote origin, so this script plus `evaluateJavaScript` IS the
 * whole agent transport.
 *
 * It is a deliberate port of `src/agent/driver.ts` (ADD-25), which drives
 * Arcelle's OWN interface. Same mark vocabulary, same visibility rules, same
 * staleness invariant, same honest-overflow reporting — so a model's browsing
 * skill and its app-driving skill are one skill. Differences are only the ones
 * a hostile document forces: password fencing, cross-origin frame opacity, and
 * a settle detector (an app's DOM is ours; a page's is not).
 *
 * CONTRACT WITH THE RUST SIDE (browser/eval.rs)
 * --------------------------------------------
 * `WKWebView.evaluateJavaScript` does NOT await promises and SWALLOWS
 * exceptions — wry's completion handler cannot tell `undefined` from `throw`,
 * both arrive as an empty string. So:
 *   * every entry point is total: it returns a value and never throws;
 *   * async work never crosses the boundary as a promise. `begin(op,args)`
 *     hands back a ticket and `take(ticket)` polls it.
 */
(function () {
  "use strict";
  if (window.__arcelleBrowse) return;

  /** Identity of THIS document, for the async-ticket contract.
   *
   * The script is injected at document start, so a navigation gives every new
   * document a fresh copy of this closure — and therefore a fresh, empty
   * `tickets` map. The Rust poller cannot otherwise tell "your ticket is gone
   * because the page you were acting on has been replaced" (normal, and usually
   * caused by the very action it started) from "unknown ticket" (a real bug).
   * With this, `info` reports which document is answering and `call_async` can
   * be truthful about a navigation instead of failing a click that worked.
   */
  var DOC_ID = String(Date.now()) + "." + String(Math.random()).slice(2, 10);

  // Marks are capped for the same reason driver.ts caps them: a model that is
  // handed 400 controls picks worse than one handed the 80 nearest its work.
  var MARK_CAP = 80;
  var LABEL_MAX = 80;
  var READ_MAX = 40000;

  var INTERACTIVE =
    'a[href], button, input, select, textarea, summary, label[for], ' +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
    '[role="tab"], [role="menuitem"], [role="menuitemcheckbox"], ' +
    '[role="switch"], [role="combobox"], [role="textbox"], [role="option"], ' +
    '[role="searchbox"], [contenteditable=""], [contenteditable="true"], ' +
    '[tabindex]:not([tabindex="-1"])';

  /** ref (number) -> WeakRef<Element>, rebuilt on every snapshot. WeakRefs so a
   *  torn-down view's rows don't outlive their DOM; a dead ref tells the model
   *  to re-snapshot rather than silently acting on nothing. */
  var registry = new Map();
  var generation = 0;
  var tickets = new Map();
  var ticketSeq = 0;

  // ------------------------------------------------------------------ utils

  function truncate(s, max) {
    s = String(s == null ? "" : s);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function clean(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    var r;
    try {
      r = el.getBoundingClientRect();
    } catch (e) {
      return false;
    }
    if (r.width <= 0 || r.height <= 0) return false;
    // Off-screen in the scroll direction is still "on the page" for a browser
    // (unlike the app, where panes clip); only reject what is fully outside
    // the document flow's visible band by a wide margin.
    if (r.bottom < -2000 || r.top > window.innerHeight + 4000) return false;
    if (r.right < -2000 || r.left > window.innerWidth + 4000) return false;
    if (typeof el.checkVisibility === "function") {
      try {
        return el.checkVisibility({ checkVisibilityCSS: true });
      } catch (e) {
        /* fall through to the computed-style probe */
      }
    }
    var cs;
    try {
      cs = getComputedStyle(el);
    } catch (e) {
      return true;
    }
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  }

  function isDisabled(el) {
    return el.disabled === true || el.getAttribute("aria-disabled") === "true";
  }

  /** PRIVACY: a password input is never actionable by the agent. It is fenced
   *  at the walker — it never receives a ref, so there is no number the model
   *  could pass to `act`. The snapshot still SAYS one exists (silently hiding
   *  it would read as a broken page), it just cannot be filled. */
  function isSecret(el) {
    if (el.tagName !== "INPUT") return false;
    var t = (el.getAttribute("type") || "").toLowerCase();
    if (t === "password") return true;
    var hint = (
      (el.getAttribute("autocomplete") || "") +
      " " +
      (el.getAttribute("name") || "") +
      " " +
      (el.id || "")
    ).toLowerCase();
    return /(^|\W)(current-password|new-password|otp|one-time-code)(\W|$)/.test(hint);
  }

  function roleFor(el) {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textbox";
    if (tag === "label") return "label";
    if (tag === "input") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox" || t === "radio" || t === "submit" || t === "button") return t;
      if (t === "password") return "password";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "control";
  }

  function labelFor(el) {
    var aria = clean(el.getAttribute("aria-label"));
    if (aria) return truncate(aria, LABEL_MAX);
    var labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      var parts = [];
      labelledby.split(/\s+/).forEach(function (id) {
        var t = document.getElementById(id);
        if (t) parts.push(clean(t.textContent));
      });
      var joined = clean(parts.join(" "));
      if (joined) return truncate(joined, LABEL_MAX);
    }
    var text = clean(el.textContent);
    if (text) return truncate(text, LABEL_MAX);
    // A form control's own <label>, then the usual attribute fallbacks.
    if (el.id) {
      var lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) {
        var lt = clean(lbl.textContent);
        if (lt) return truncate(lt, LABEL_MAX);
      }
    }
    var ph = clean(el.getAttribute("placeholder"));
    if (ph) return truncate(ph, LABEL_MAX);
    var title = clean(el.getAttribute("title"));
    if (title) return truncate(title, LABEL_MAX);
    var alt = el.querySelector ? el.querySelector("img[alt]") : null;
    if (alt) {
      var at = clean(alt.getAttribute("alt"));
      if (at) return truncate(at, LABEL_MAX);
    }
    var name = clean(el.getAttribute("name"));
    if (name) return truncate(name, LABEL_MAX);
    if (el.value) return truncate(clean(el.value), LABEL_MAX);
    return "(unlabeled)";
  }

  /** A coarse page region, so the model can tell a nav link from a body link
   *  without being handed the DOM path. */
  function regionFor(el) {
    var node = el;
    for (var i = 0; node && i < 12; i++) {
      var tag = node.tagName ? node.tagName.toLowerCase() : "";
      var role = node.getAttribute ? node.getAttribute("role") : null;
      if (tag === "nav" || role === "navigation") return "nav";
      if (tag === "header" || role === "banner") return "header";
      if (tag === "footer" || role === "contentinfo") return "footer";
      if (tag === "aside" || role === "complementary") return "aside";
      if (tag === "form" || role === "form" || role === "search") return "form";
      if (tag === "dialog" || role === "dialog" || role === "alertdialog") return "dialog";
      if (tag === "main" || role === "main") return "main";
      node = node.parentElement;
    }
    return "body";
  }

  function stateFor(el) {
    var bits = [];
    if (el.getAttribute("aria-expanded") === "true") bits.push("expanded");
    if (el.getAttribute("aria-selected") === "true") bits.push("selected");
    if (el.checked === true) bits.push("checked");
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      var v = clean(el.value);
      if (v) bits.push('has "' + truncate(v, 40) + '"');
      else bits.push("empty");
    }
    if (el.tagName === "SELECT" && el.selectedOptions && el.selectedOptions[0]) {
      bits.push('"' + truncate(clean(el.selectedOptions[0].textContent), 40) + '"');
    }
    if (document.activeElement === el) bits.push("focused");
    return bits.length ? bits.join(", ") : undefined;
  }

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
  function collectInteractive() {
    var out = [];
    var roots = [document];
    var guard = 0;
    while (roots.length && guard++ < 400) {
      var root = roots.shift();
      try {
        var hits = root.querySelectorAll(INTERACTIVE);
        for (var i = 0; i < hits.length; i++) out.push(hits[i]);
      } catch (e) {}
      // Only hosts can carry a shadow root, so this is the cheapest way to find
      // the next level without walking every text node.
      try {
        var all = root.querySelectorAll("*");
        for (var j = 0; j < all.length && j < 6000; j++) {
          var sr = all[j].shadowRoot;
          if (sr) roots.push(sr);
        }
      } catch (e) {}
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

  function snapshot(opts) {
    opts = opts || {};
    clearMarks();
    generation++;

    var candidates = [];
    var secrets = 0;
    var nodes = collectInteractive();
    var modals = modalRoots();
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (isSecret(el)) {
        // Fenced at the walker, exactly like driver.ts's consent surfaces.
        if (isVisible(el)) secrets++;
        continue;
      }
      if (isDisabled(el) || !isVisible(el)) continue;
      var top = 0;
      try {
        top = el.getBoundingClientRect().top;
      } catch (e) {}
      candidates.push({
        el: el,
        top: top,
        order: candidates.length,
        modal: modals.length > 0 && inAnyModal(el, modals),
      });
    }

    var overflow = Math.max(0, candidates.length - MARK_CAP);
    var chosen = candidates;
    if (overflow > 0) {
      // An OPEN MODAL outranks everything (see modalRoots): while a dialog is
      // up it is the only thing the user can act on, so spending the cap on the
      // nav bar behind it would hide the very field they asked about. Then
      // nearest the viewport top (that is where the work is), then document
      // order is restored so the numbers read naturally.
      chosen = candidates
        .slice()
        .sort(function (a, b) {
          if (a.modal !== b.modal) return a.modal ? -1 : 1;
          return Math.max(a.top, 0) - Math.max(b.top, 0);
        })
        .slice(0, MARK_CAP)
        .sort(function (a, b) {
          return a.order - b.order;
        });
    }

    var elements = [];
    for (var j = 0; j < chosen.length; j++) {
      var e = chosen[j].el;
      var n = j + 1;
      try {
        e.setAttribute("data-arcelle-mark", String(n));
      } catch (err) {
        continue;
      }
      registry.set(n, new WeakRef(e));
      var entry = {
        ref: "e" + n,
        role: roleFor(e),
        label: labelFor(e),
        region: regionFor(e),
      };
      var st = stateFor(e);
      if (st !== undefined) entry.state = st;
      elements.push(entry);
    }

    var frames = crossOriginFrames();
    var summary =
      elements.length + " interactive elements on " + truncate(document.title || location.host, 70);
    if (overflow > 0) summary += "; …and " + overflow + " more (scroll to reveal)";
    if (secrets > 0) {
      summary +=
        "; " +
        secrets +
        " password field(s) present — fenced, the user must type those";
    }
    if (frames > 0) {
      summary +=
        "; " + frames + " cross-origin frame(s) whose contents cannot be read from here";
    }

    if (opts.badges) drawBadges();
    else removeBadges();

    return {
      ok: true,
      url: location.href,
      title: document.title || "",
      generation: generation,
      summary: summary,
      count: elements.length,
      overflow: overflow,
      secrets: secrets,
      crossOriginFrames: frames,
      lowSignal: lowSignal(elements),
      elements: elements,
    };
  }

  /** Honest signal about whether the text channel is worth trusting on this
   *  page. The Rust side turns a true here into an explicit "consider
   *  browse_look" line, so the model escalates without having to guess. */
  function lowSignal(elements) {
    var unlabeled = 0;
    for (var i = 0; i < elements.length; i++) {
      if (elements[i].label === "(unlabeled)") unlabeled++;
    }
    var canvasHeavy = false;
    try {
      var cs = document.querySelectorAll("canvas");
      var vw = window.innerWidth * window.innerHeight;
      for (var j = 0; j < cs.length; j++) {
        var r = cs[j].getBoundingClientRect();
        if (vw > 0 && (r.width * r.height) / vw > 0.6) canvasHeavy = true;
      }
    } catch (e) {}
    if (canvasHeavy) return "canvas covers most of the viewport";
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
    registry.forEach(function (ref, n) {
      var el = ref.deref();
      if (!el) return;
      var r;
      try {
        r = el.getBoundingClientRect();
      } catch (e) {
        return;
      }
      if (r.width <= 0 || r.height <= 0) return;
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      var box = document.createElement("div");
      box.style.cssText =
        "position:absolute;left:" +
        Math.max(0, r.left) +
        "px;top:" +
        Math.max(0, r.top) +
        "px;width:" +
        r.width +
        "px;height:" +
        r.height +
        "px;outline:2px solid rgba(255,64,129,.9);outline-offset:-1px;box-sizing:border-box";
      var tag = document.createElement("div");
      tag.textContent = String(n);
      tag.style.cssText =
        "position:absolute;left:" +
        Math.max(0, r.left) +
        "px;top:" +
        Math.max(0, r.top - 16) +
        "px;background:rgba(255,64,129,.95);color:#fff;font:700 11px/14px ui-sans-serif,system-ui,sans-serif;" +
        "padding:1px 4px;border-radius:3px;white-space:nowrap";
      layer.appendChild(box);
      layer.appendChild(tag);
    });
    document.body.appendChild(layer);
  }

  // ------------------------------------------------------------------- read

  var DROP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, IFRAME: 1, CANVAS: 1,
    TEMPLATE: 1, HEAD: 1, LINK: 1, META: 1,
  };
  var CHROME_TAGS = { NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1, FORM: 1 };

  /** The main-content root, best effort: an explicit <main>/role=main, else
   *  <article>, else the block with the most text. Never throws. */
  function readRoot(mode) {
    if (mode === "full") return document.body;
    var main = document.querySelector("main, [role='main'], article");
    if (main && clean(main.textContent).length > 200) return main;
    var best = document.body;
    var bestLen = 0;
    try {
      var blocks = document.querySelectorAll("div, section, article");
      for (var i = 0; i < blocks.length && i < 400; i++) {
        var b = blocks[i];
        var ps = b.querySelectorAll("p");
        if (ps.length < 3) continue;
        var len = clean(b.textContent).length;
        if (len > bestLen) {
          bestLen = len;
          best = b;
        }
      }
    } catch (e) {}
    return best || document.body;
  }

  function readMarkdown(mode) {
    var root = readRoot(mode);
    if (!root) return "";
    var out = [];
    var full = mode === "full";

    function walk(node, depth) {
      if (!node || depth > 40) return;
      if (node.nodeType === 3) {
        var t = clean(node.nodeValue);
        if (t) out.push(t);
        return;
      }
      if (node.nodeType !== 1) return;
      var tag = node.tagName;
      if (DROP_TAGS[tag]) return;
      if (node.getAttribute && node.getAttribute("data-arcelle-ui")) return;
      if (!full && CHROME_TAGS[tag] && node !== root) return;
      if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return;
      if (!isVisible(node) && tag !== "BODY") return;

      if (/^H[1-6]$/.test(tag)) {
        var h = clean(node.textContent);
        if (h) out.push("\n" + "#".repeat(Number(tag[1])) + " " + h + "\n");
        return;
      }
      if (tag === "P" || tag === "BLOCKQUOTE") {
        var p = clean(node.textContent);
        if (p) out.push("\n" + (tag === "BLOCKQUOTE" ? "> " : "") + p + "\n");
        return;
      }
      if (tag === "LI") {
        var li = clean(node.textContent);
        if (li) out.push("- " + li);
        return;
      }
      if (tag === "PRE") {
        var code = node.textContent || "";
        if (clean(code)) out.push("\n```\n" + code.replace(/\s+$/, "") + "\n```\n");
        return;
      }
      if (tag === "A") {
        var at = clean(node.textContent);
        var href = node.getAttribute("href") || "";
        if (at) {
          // Resolve relative hrefs so the model can hand one straight back to
          // browse_open without having to reason about the base URL.
          var abs = href;
          try {
            abs = href ? new URL(href, location.href).href : "";
          } catch (e) {}
          out.push(abs && abs.indexOf("javascript:") !== 0 ? "[" + at + "](" + abs + ")" : at);
        }
        return;
      }
      if (tag === "BR") {
        out.push("\n");
        return;
      }
      if (tag === "TR") {
        var cells = [];
        var kids = node.children || [];
        for (var c = 0; c < kids.length; c++) cells.push(clean(kids[c].textContent));
        if (cells.length) out.push("| " + cells.join(" | ") + " |");
        return;
      }
      if (tag === "IMG") {
        var alt = clean(node.getAttribute("alt"));
        if (alt) out.push("![" + alt + "]");
        return;
      }
      var children = node.childNodes;
      for (var i = 0; i < children.length; i++) walk(children[i], depth + 1);
      if (tag === "DIV" || tag === "SECTION" || tag === "UL" || tag === "OL") out.push("\n");
    }

    try {
      walk(root, 0);
    } catch (e) {
      return clean(root.textContent || "");
    }
    var text = out.join(" ").replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n");
    return text.trim();
  }

  function read(args) {
    args = args || {};
    var mode = args.mode === "full" ? "full" : "main";
    var body = readMarkdown(mode);
    var offset = Math.max(0, Number(args.offset) || 0);
    var slice = body.slice(offset, offset + READ_MAX);
    return {
      ok: true,
      url: location.href,
      title: document.title || "",
      mode: mode,
      offset: offset,
      total: body.length,
      truncated: offset + slice.length < body.length,
      text: slice,
    };
  }

  // ---------------------------------------------------------------- capture

  // Caps for saving a page into the room (BROWSE-2). Far larger than READ_MAX:
  // this feeds a room FILE, not a model turn — but still bounded, because a
  // runaway SPA DOM can be arbitrarily huge.
  var CAPTURE_TEXT_MAX = 800000;
  var CAPTURE_HTML_MAX = 4000000;

  /** The page — or the user's current selection — as save-ready content:
   *  readable markdown plus the raw HTML of the LIVE DOM. Unlike a re-fetch,
   *  this is what is actually on screen: scripts run, logins honoured. */
  function capture(args) {
    var what = args && args.what === "selection" ? "selection" : "page";
    if (what === "selection") {
      var sel = "";
      try {
        sel = String(window.getSelection() || "");
      } catch (e) {}
      sel = sel.trim();
      if (!sel) return { ok: false, error: "Nothing is selected on the page." };
      return {
        ok: true,
        what: what,
        url: location.href,
        title: document.title || "",
        text: sel.slice(0, CAPTURE_TEXT_MAX),
        html: "",
        truncated: sel.length > CAPTURE_TEXT_MAX,
      };
    }
    var text = readMarkdown("main");
    var html = "";
    try {
      html = document.documentElement
        ? "<!doctype html>\n" + document.documentElement.outerHTML
        : "";
    } catch (e) {}
    return {
      ok: true,
      what: what,
      url: location.href,
      title: document.title || "",
      text: text.slice(0, CAPTURE_TEXT_MAX),
      html: html.slice(0, CAPTURE_HTML_MAX),
      truncated: text.length > CAPTURE_TEXT_MAX || html.length > CAPTURE_HTML_MAX,
    };
  }

  // ------------------------------------------------------------------- find

  function find(args) {
    var needle = clean((args && args.text) || "").toLowerCase();
    if (!needle) return { ok: false, error: "find needs text to look for." };
    var snap = snapshot({ badges: false });
    var hits = [];
    for (var i = 0; i < snap.elements.length; i++) {
      var e = snap.elements[i];
      if ((e.label || "").toLowerCase().indexOf(needle) >= 0) hits.push(e);
    }
    // Nothing among the interactive marks? Report visible page text hits so
    // "is it even on this page" is answerable without a full read.
    var textHits = 0;
    try {
      var bodyText = (document.body ? document.body.innerText || "" : "").toLowerCase();
      var idx = bodyText.indexOf(needle);
      while (idx >= 0 && textHits < 50) {
        textHits++;
        idx = bodyText.indexOf(needle, idx + needle.length);
      }
    } catch (e) {}
    return {
      ok: true,
      url: location.href,
      generation: snap.generation,
      matches: hits,
      textOccurrences: textHits,
    };
  }

  // ------------------------------------------------------------------ act

  function resolve(ref) {
    var n = typeof ref === "number" ? ref : Number(String(ref).replace(/^e/i, ""));
    if (!isFinite(n) || n <= 0) return { error: 'Bad ref "' + ref + '" — refs look like "e4".' };
    var weak = registry.get(n);
    var el = weak ? weak.deref() : null;
    // The staleness invariant, inherited from driver.ts: an old number must
    // never silently act on a re-laid-out element.
    if (!el || !el.isConnected || el.getAttribute("data-arcelle-mark") !== String(n)) {
      return { error: "e" + n + " is gone — act on the fresh snapshot below." };
    }
    if (isSecret(el)) {
      return { error: "e" + n + " is a password field — fenced; the user must fill it." };
    }
    return { el: el };
  }

  function fire(el, type, init) {
    try {
      el.dispatchEvent(
        new (type.indexOf("mouse") === 0 || type === "click"
          ? MouseEvent
          : type.indexOf("key") === 0
            ? KeyboardEvent
            : Event)(type, Object.assign({ bubbles: true, cancelable: true }, init || {})),
      );
    } catch (e) {}
  }

  function setNativeValue(el, value) {
    // React and friends install a value setter on the instance; writing
    // `el.value` directly leaves their state stale and the field snaps back.
    // Go through the prototype's setter, then fire the events they listen for.
    try {
      var proto = Object.getPrototypeOf(el);
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch (e) {
      try {
        el.value = value;
      } catch (e2) {}
    }
    fire(el, "input");
    fire(el, "change");
  }

  function doOne(a) {
    if (!a || typeof a !== "object") return { ok: false, error: "Each action must be an object." };

    if (a.scroll) {
      var dir = a.scroll;
      if (typeof dir === "object" && dir.to) {
        var rt = resolve(dir.to);
        if (rt.error) return { ok: false, error: rt.error };
        try {
          rt.el.scrollIntoView({ block: "center" });
        } catch (e) {}
        return { ok: true, did: "scrolled to " + dir.to };
      }
      var amount = window.innerHeight * 0.85;
      var d = String(typeof dir === "object" ? dir.dir : dir).toLowerCase();
      if (d === "top") window.scrollTo(0, 0);
      else if (d === "bottom") window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
      else window.scrollBy(0, d === "up" ? -amount : amount);
      return { ok: true, did: "scrolled " + d };
    }

    if (a.click_at) {
      var x = Number(a.click_at.x);
      var y = Number(a.click_at.y);
      if (!isFinite(x) || !isFinite(y)) {
        return { ok: false, error: "click_at needs numeric x and y in CSS pixels." };
      }
      var target = document.elementFromPoint(x, y);
      if (!target) return { ok: false, error: "Nothing is at (" + x + ", " + y + ")." };
      if (isSecret(target)) {
        return { ok: false, error: "That point is a password field — fenced." };
      }
      var init = { clientX: x, clientY: y, button: 0, view: window };
      fire(target, "mousedown", init);
      fire(target, "mouseup", init);
      fire(target, "click", init);
      return {
        ok: true,
        did: 'clicked (' + Math.round(x) + ", " + Math.round(y) + ") — " + describe(target),
      };
    }

    if (a.click) {
      var rc = resolve(a.click);
      if (rc.error) return { ok: false, error: rc.error };
      var el = rc.el;
      try {
        el.scrollIntoView({ block: "center" });
      } catch (e) {}
      try {
        if (typeof el.focus === "function") el.focus();
      } catch (e) {}
      // A real click first (it carries the browser's own default action, e.g.
      // following a link); synthetic events only as the fallback path.
      try {
        el.click();
      } catch (e) {
        fire(el, "click");
      }
      return { ok: true, did: "clicked " + a.click + " — " + describe(el) };
    }

    if (a.type) {
      var t = a.type;
      var rr = resolve(t.ref);
      if (rr.error) return { ok: false, error: rr.error };
      var input = rr.el;
      var text = String(t.text == null ? "" : t.text);
      try {
        if (typeof input.focus === "function") input.focus();
      } catch (e) {}
      if (input.isContentEditable) {
        if (t.clear) input.textContent = "";
        input.textContent = (input.textContent || "") + text;
        fire(input, "input");
      } else {
        var base = t.clear ? "" : input.value || "";
        setNativeValue(input, base + text);
      }
      var did = 'typed into ' + t.ref + " — " + describe(input);
      if (t.submit) {
        fire(input, "keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13 });
        fire(input, "keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13 });
        var form = input.form;
        if (form) {
          try {
            if (typeof form.requestSubmit === "function") form.requestSubmit();
            else form.submit();
          } catch (e) {}
        }
        did += " and submitted";
      }
      return { ok: true, did: did };
    }

    if (a.select) {
      var rs = resolve(a.select.ref);
      if (rs.error) return { ok: false, error: rs.error };
      var sel = rs.el;
      var want = String(a.select.value == null ? "" : a.select.value).toLowerCase();
      var opts = sel.options || [];
      for (var i = 0; i < opts.length; i++) {
        var o = opts[i];
        if (
          String(o.value).toLowerCase() === want ||
          clean(o.textContent).toLowerCase() === want ||
          clean(o.textContent).toLowerCase().indexOf(want) >= 0
        ) {
          sel.selectedIndex = i;
          fire(sel, "input");
          fire(sel, "change");
          return { ok: true, did: 'selected "' + clean(o.textContent) + '" in ' + a.select.ref };
        }
      }
      var available = [];
      for (var k = 0; k < opts.length && k < 20; k++) available.push(clean(opts[k].textContent));
      return {
        ok: false,
        error:
          'No option matching "' + a.select.value + '". Available: ' + available.join(", "),
      };
    }

    if (a.key) {
      var target2 = document.activeElement || document.body;
      var key = String(a.key);
      fire(target2, "keydown", { key: key, code: key });
      fire(target2, "keyup", { key: key, code: key });
      return { ok: true, did: "pressed " + key };
    }

    if (a.back) {
      history.back();
      return { ok: true, did: "went back" };
    }
    if (a.forward) {
      history.forward();
      return { ok: true, did: "went forward" };
    }

    return { ok: false, error: "Unknown action: " + truncate(JSON.stringify(a), 120) };
  }

  function describe(el) {
    if (!el || !el.tagName) return "element";
    return roleFor(el) + ' "' + labelFor(el) + '"';
  }

  // ---------------------------------------------------------------- settle

  /** Resolve once the page has stopped moving: navigation complete, no new
   *  network resources for `netQuiet`, no DOM mutations for `domQuiet`. This
   *  exists so "waiting" is deterministic code and never a model turn — a 4B
   *  asked to decide when a page is ready will burn turns guessing. */
  function settle(budgetMs) {
    var budget = budgetMs || 5000;
    var netQuiet = 500;
    var domQuiet = 350;
    return new Promise(function (resolve) {
      var lastNet = Date.now();
      var lastDom = Date.now();
      var done = false;
      var po = null;
      var mo = null;

      try {
        po = new PerformanceObserver(function () {
          lastNet = Date.now();
        });
        po.observe({ entryTypes: ["resource"] });
      } catch (e) {}
      try {
        mo = new MutationObserver(function () {
          lastDom = Date.now();
        });
        mo.observe(document.documentElement || document, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      } catch (e) {}

      var started = Date.now();
      var timer = setInterval(function () {
        if (done) return;
        var now = Date.now();
        var ready = document.readyState === "complete" || document.readyState === "interactive";
        var quiet = now - lastNet > netQuiet && now - lastDom > domQuiet;
        var expired = now - started > budget;
        if ((ready && quiet) || expired) {
          done = true;
          clearInterval(timer);
          if (po) try { po.disconnect(); } catch (e) {}
          if (mo) try { mo.disconnect(); } catch (e) {}
          resolve({ settled: !expired, waitedMs: now - started });
        }
      }, 60);
    });
  }

  function waitFor(spec, budgetMs) {
    var budget = budgetMs || 8000;
    var started = Date.now();
    return new Promise(function (resolve) {
      var timer = setInterval(function () {
        var hit = false;
        try {
          if (spec.text) {
            hit =
              (document.body ? document.body.innerText || "" : "")
                .toLowerCase()
                .indexOf(String(spec.text).toLowerCase()) >= 0;
          } else if (spec.gone) {
            var r = resolve_(spec.gone);
            hit = !r;
          }
        } catch (e) {}
        if (hit || Date.now() - started > budget) {
          clearInterval(timer);
          resolve({ found: hit, waitedMs: Date.now() - started });
        }
      }, 100);
    });
    function resolve_(ref) {
      var n = Number(String(ref).replace(/^e/i, ""));
      var w = registry.get(n);
      var el = w ? w.deref() : null;
      return el && el.isConnected ? el : null;
    }
  }

  async function act(args) {
    var actions = (args && args.actions) || [];
    if (!Array.isArray(actions) || actions.length === 0) {
      return { ok: false, error: "act needs a non-empty actions array." };
    }
    var beforeUrl = location.href;
    var results = [];
    var stopped = null;
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      var r;
      if (a && a.wait_for) {
        r = { ok: true, did: "waited" };
        var w = await waitFor(a.wait_for, a.wait_for.timeout_ms);
        r.did = w.found ? "waited until it appeared" : "waited, but it never appeared";
        r.ok = w.found;
      } else {
        try {
          r = doOne(a);
        } catch (e) {
          r = { ok: false, error: "That action failed: " + (e && e.message ? e.message : e) };
        }
      }
      results.push(r);
      if (!r.ok) {
        // Stop on the first failure: the model's later actions were planned
        // against a page state that never happened.
        stopped = i;
        break;
      }
      await settle(a && a.settle_ms ? a.settle_ms : 2500);
      // A same-document navigation invalidates every remaining ref; the rest
      // of the batch was planned against the old page, so stop and re-report.
      if (location.href !== beforeUrl && i < actions.length - 1) {
        stopped = i;
        results.push({ ok: true, did: "page changed — remaining actions skipped" });
        break;
      }
    }
    await settle(3000);
    var snap = snapshot({ badges: false });
    return {
      ok: stopped === null,
      results: results,
      stoppedAt: stopped,
      urlChanged: location.href !== beforeUrl,
      snapshot: snap,
    };
  }

  // ------------------------------------------------------- ticket plumbing

  function begin(op, args) {
    var id = "t" + ++ticketSeq;
    var rec = { done: false, value: null };
    tickets.set(id, rec);
    var p;
    try {
      if (op === "act") p = act(args);
      else if (op === "settle") p = settle(args && args.budget_ms).then(function (s) {
        return Object.assign({ ok: true }, s, { snapshot: snapshot({ badges: false }) });
      });
      else if (op === "annotate") p = annotate(args);
      else p = Promise.resolve({ ok: false, error: "Unknown async op: " + op });
    } catch (e) {
      p = Promise.resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    p.then(
      function (v) {
        rec.value = v;
        rec.done = true;
      },
      function (e) {
        rec.value = { ok: false, error: String(e && e.message ? e.message : e) };
        rec.done = true;
      },
    );
    return { ok: true, ticket: id };
  }

  function take(id) {
    var rec = tickets.get(id);
    if (!rec) return { ok: false, error: "Unknown ticket " + id };
    if (!rec.done) return { ok: true, done: false };
    tickets.delete(id);
    return { ok: true, done: true, value: rec.value };
  }

  /** Paint (or clear) the mark badges and wait two frames, so a screenshot
   *  taken right after this call is guaranteed to contain them. */
  function annotate(args) {
    var on = !args || args.on !== false;
    return new Promise(function (resolve) {
      try {
        if (on) {
          if (registry.size === 0) snapshot({ badges: true });
          else drawBadges();
        } else {
          removeBadges();
        }
      } catch (e) {}
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          resolve({ ok: true, badges: on, marks: registry.size });
        });
      });
    });
  }

  // ------------------------------------------------------------------ entry

  /** The single synchronous entry point. Total by construction: any throw
   *  becomes `{ok:false,error}` rather than the empty string an uncaught
   *  exception would hand the Rust side. */
  function call(op, args) {
    try {
      switch (op) {
        case "ping":
          return { ok: true, url: location.href, title: document.title || "", ready: document.readyState, doc: DOC_ID };
        case "snapshot":
          return snapshot(args || {});
        case "read":
          return read(args);
        case "capture":
          return capture(args);
        case "find":
          return find(args);
        case "begin":
          return begin((args && args.op) || "", (args && args.args) || {});
        case "take":
          return take((args && args.ticket) || "");
        case "info":
          return {
            ok: true,
            url: location.href,
            title: document.title || "",
            ready: document.readyState,
            canGoBack: history.length > 1,
            doc: DOC_ID,
          };
        default:
          return { ok: false, error: "Unknown op: " + op };
      }
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  window.__arcelleBrowse = {
    call: call,
    // Exposed for the Node test harness; not part of the Rust contract.
    _internals: {
      snapshot: snapshot,
      read: read,
      capture: capture,
      find: find,
      doOne: doOne,
      resolve: resolve,
      isSecret: isSecret,
      labelFor: labelFor,
      roleFor: roleFor,
      regionFor: regionFor,
      lowSignal: lowSignal,
      readMarkdown: readMarkdown,
      registry: registry,
      MARK_CAP: MARK_CAP,
    },
  };
})();
