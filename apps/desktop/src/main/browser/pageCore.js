/* BROWSE-1: the agent's page script — the Electron port of
 * src-tauri/src/browser/page.js.
 *
 * THE BODY BELOW IS THE RUST FILE, UNCHANGED. Every line of it is ordinary
 * DOM/window work — the mark vocabulary, the visibility rules, the staleness
 * invariant, password fencing, the settle detector, honest overflow reporting —
 * and none of it ever touched a Tauri API, so none of it needed translating.
 * Keep it that way: syncing a fix from the Rust file should stay a plain copy
 * of everything between the IIFE's first line and the export footer.
 *
 * It is a deliberate port of `src/agent/driver.ts` (ADD-25), which drives
 * Arcelle's OWN interface. Same mark vocabulary, same visibility rules, same
 * staleness invariant, same honest-overflow reporting — so a model's browsing
 * skill and its app-driving skill are one skill. Differences are only the ones
 * a hostile document forces: password fencing, cross-origin frame opacity, and
 * a settle detector (an app's DOM is ours; a page's is not).
 *
 * HOW IT IS INJECTED, AND WHAT WAS VERIFIED
 * -----------------------------------------
 * Tauri used `initialization_script_for_all_frames` (a `WKUserScript` at
 * document start, every frame). This file IS the Electron preload, registered
 * per page session with `registerPreloadScript({ type: "frame" })` and
 * `nodeIntegrationInSubFrames: true` — see webviewManager.ts. All four
 * properties that arrangement has to have were confirmed against a REAL
 * Electron process (browserLive.test.ts, which reproduces the probe):
 *
 *   * the bridge is present in the main world before the page's OWN first
 *     inline `<script>` runs;
 *   * every sub-frame gets its own instance, with its own `DOC_ID`;
 *   * `nodeIntegrationInSubFrames` is load-bearing — without it a sub-frame
 *     gets nothing;
 *   * `window.__arcelleSuperseded`, set by the host through
 *     `executeJavaScript`, is visible to the readiness probe.
 *
 * THE ONE ADAPTATION is the export footer at the bottom of this file. A preload
 * runs in an ISOLATED world while `contextIsolation` is on — which this port
 * keeps on, along with `sandbox`, because a browser pointed at the open web is
 * the last place to weaken Electron's defaults — so a bare
 * `window.__arcelleBrowse = api` would set a property the host's main-world
 * `executeJavaScript` could never see. `contextBridge.exposeInMainWorld` is the
 * sanctioned door across exactly that boundary. Running the script's internals
 * in the isolated world is also strictly better than the Tauri arrangement: the
 * ticket map, the element registry and the generation counter are out of reach
 * of the page being driven.
 *
 * NOT PORTED: `NO_POPUPS_JS`, the second script Tauri injected beside this one.
 * It existed because wry answers `nil` to WebKit's "give me a new web view"
 * request unless a handler is installed, so every `target="_blank"` link did
 * nothing at all — and its own comment concedes the cases it could not catch.
 * Electron has the first-class hook wry lacked; see popup.ts.
 *
 * CONTRACT WITH THE HOST SIDE (evalBridge.ts)
 * -------------------------------------------
 * Kept TOTAL — every entry point returns a value and never throws, and async
 * work never crosses the boundary as a promise: `begin(op,args)` hands back a
 * ticket and `take(ticket)` polls it. On the Tauri side that was forced
 * (`evaluateJavaScript` cannot tell `undefined` from `throw`). Here it is a
 * choice, and evalBridge.ts's header says why it is still the right one.
 *
 */
(function () {
  "use strict";
  if (window.__arcelleBrowse || window.__arcellePageScope) return;
  var scope = {};
  window.__arcellePageScope = scope;


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

  var generationState = { value: 0 };


  // ----------------------------------------------------- keyboard escape

  /* THE WAY BACK OUT (item #18).
   *
   * The page is a SIBLING native view of the app's own webview, with its own
   * first responder. Once the keyboard is inside it, no key the app listens
   * for is ever delivered to the app — Tab cycles the page forever and there
   * is no DOM route home. That is a focus trap, and for a keyboard-only or
   * screen-reader user it is the whole feature broken.
   *
   * There is no push channel from here to Rust (this script plus
   * `evaluateJavaScript` IS the transport), so the request is LATCHED and
   * reported on the next `info` poll — the browser chrome already polls every
   * 1200 ms, which is what makes this cost no new plumbing. It is read once
   * and cleared, so a request can never fire twice.
   *
   * Escape TWICE is the chord because it is the one key VoiceOver passes
   * straight through (⌃⌥ is its own modifier, and ⌘-anything belongs to the
   * page or the system), and because a first Escape that a page consumed to
   * close its own dialog leaves the second one free.
   *
   * Sub-frames run their own copy of this script and are never polled, so a
   * double Escape typed inside an iframe is not seen. The main frame is where
   * the chrome's own focus lands, so that is the case that matters.
   */
  var LEAVE_CHORD_MS = 700;

  var lastEscapeAt = 0;

  var leaveRequested = false;


  function takeLeaveRequest() {
    var asked = leaveRequested;
    leaveRequested = false;
    return asked;
  }


  try {
    window.addEventListener(
      "keydown",
      function (e) {
        if (!e || e.key !== "Escape") {
          lastEscapeAt = 0;
          return;
        }
        var now = Date.now();
        if (lastEscapeAt && now - lastEscapeAt <= LEAVE_CHORD_MS) {
          leaveRequested = true;
          lastEscapeAt = 0;
        } else {
          lastEscapeAt = now;
        }
      },
      true,
    );
  } catch (e) {
    /* a document that refuses listeners still gets every other op */
  }


  // ------------------------------------------------------------------ utils

  function truncate(s, max) {
    s = String(s == null ? "" : s);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }


  function clean(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }


  /** @param el element
   *  @param forReading true when the caller wants the page's TEXT rather than
   *  the things a click can reach — see the band note below. */
  function elementRect(el) {
    try {
      return el.getBoundingClientRect();
    } catch (e) {
      return null;
    }
  }


  function hasVisibleRect(r, forReading) {
    if (!hasVisibleDimensions(r)) return false;
    // Off-screen in the scroll direction is still "on the page" for a browser
    // (unlike the app, where panes clip); only reject what is fully outside
    // the document flow's visible band by a wide margin.
    //
    // THE READING RULE IS NOT THE CLICKING RULE. The "far below / far to the
    // right" half of this band is right for a SNAPSHOT — MARK_CAP only has 80
    // marks and they belong near the user, and nothing is clicked five screens
    // away. For TEXT it silently deletes the document: the extractor never
    // scrolls, so a page whose body runs 30 000px down (which is what any long
    // article becomes once the stage is narrow — and the reading view shrinks
    // it to 320px on purpose) loses everything past its fifth screen while
    // `read` still answers `truncated: false` and a `total` measured on the
    // fragment. That is a slice presented as the whole page, in the one
    // channel a screen-reader user has. Reading keeps every CSS check and both
    // NEGATIVE-side rejections (that is where `left: -9999px` menus and
    // scrolled-past-and-recycled rows live); it drops only the far side,
    // because further down the document is what reading a document means.
    if (isBeforeVisibleBand(r)) return false;
    if (!forReading && isPastClickBand(r)) return false;
    return true;
  }


  function hasVisibleDimensions(rect) {
    return rect.width > 0 && rect.height > 0;
  }


  function isBeforeVisibleBand(rect) {
    return rect.bottom < -2000 || rect.right < -2000;
  }


  function isPastClickBand(rect) {
    return rect.top > window.innerHeight + 4000 || rect.left > window.innerWidth + 4000;
  }


  function checkedVisibility(el) {
    if (typeof el.checkVisibility === "function") {
      try {
        return { used: true, value: el.checkVisibility({ checkVisibilityCSS: true }) };
      } catch (e) {
        /* fall through to the computed-style probe */
      }
    }
    return { used: false };
  }


  function computedVisibility(el) {
    var cs;
    try {
      cs = getComputedStyle(el);
    } catch (e) {
      return true;
    }
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  }


  function isVisible(el, forReading) {
    var r = elementRect(el);
    if (!r || !hasVisibleRect(r, forReading)) return false;
    var checked = checkedVisibility(el);
    return checked.used ? checked.value : computedVisibility(el);
  }


  function isDisabled(el) {
    return el.disabled === true || el.getAttribute("aria-disabled") === "true";
  }


  /** What a field is CALLED, for the two credential judgements below: its
   *  autocomplete token, its form name and its id, lowercased. */
  function fieldHint(el) {
    return (
      (el.getAttribute("autocomplete") || "") +
      " " +
      (el.getAttribute("name") || "") +
      " " +
      (el.id || "")
    ).toLowerCase();
  }


  /** A credential by its NAME, whatever `type` currently says.
   *
   * Matched as a SUBSTRING rather than as a whole token: the site's own "show
   * password" toggle sets `type="text"`, and from that moment the only signal
   * left is the name — which real sign-in forms spell `password`, `passwd`,
   * `login-password`, `user_password`, none of which the old tokenised pattern
   * (`current-password`/`new-password` only) matched. The field then got a ref
   * and its plaintext value went into the snapshot.
   */
  var SECRET_NAME = /passwo?rd|passwd|one-time-code|\botp\b/;


  /** The input types a credential can be TYPED into (no `type` means text).
   *
   * The name test above is a substring one, so the reveal toggle that motivated
   * it — `<input type="checkbox" id="showPassword">` — carries the word as
   * plainly as the field it reveals. Fencing the checkbox counted it in the
   * "N password field(s) present — fenced, the user must type those" line,
   * which is a count of fields to fill that included one nobody fills.
   */
  var TYPED_INPUT = /^(text|password|email|tel|number|search|url)?$/;


  /** PRIVACY: a password input is never actionable by the agent. It is fenced
   *  at the walker — it never receives a ref, so there is no number the model
   *  could pass to `act`. The snapshot still SAYS one exists (silently hiding
   *  it would read as a broken page), it just cannot be filled. */
  function isSecret(el) {
    if (el.tagName !== "INPUT") return false;
    var t = (el.getAttribute("type") || "").toLowerCase();
    if (t === "password") return true;
    return TYPED_INPUT.test(t) && SECRET_NAME.test(fieldHint(el));
  }


  /** Values that are the user's to type and nobody's to repeat: credentials,
   *  card numbers, national ids.
   *
   *  Independent of [`isSecret`], and deliberately wider. `isSecret` decides
   *  what the agent may ACT on; this decides what may be WRITTEN DOWN in a
   *  snapshot the model reads. A card number in a plainly-named field is not a
   *  password — the agent can legitimately be asked to fill one — but echoing
   *  the digits back into the transcript is a copy of them nobody asked for.
   */
  var PRIVATE_VALUE =
    /passwo?rd|passwd|one-time-code|\botp\b|\bcc-|card-?number|\bcvv\b|\bcvc\b|security-code|\bssn\b|social-security|national-id/;


  function valueIsPrivate(el) {
    return PRIVATE_VALUE.test(fieldHint(el));
  }


  var NATIVE_ROLES = {
    a: "link", button: "button", summary: "button", select: "select",
    textarea: "textbox", label: "label",
  };


  function inputRole(el) {
    var type = (el.getAttribute("type") || "text").toLowerCase();
    if (["checkbox", "radio", "submit", "button"].indexOf(type) >= 0) return type;
    return type === "password" ? "password" : "textbox";
  }


  function roleFor(el) {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (NATIVE_ROLES[tag]) return NATIVE_ROLES[tag];
    if (tag === "input") return inputRole(el);
    return el.isContentEditable ? "textbox" : "control";
  }


  function labelText(value) {
    var text = clean(value);
    return text ? truncate(text, LABEL_MAX) : null;
  }


  function ariaLabelFor(el) {
    var aria = clean(el.getAttribute("aria-label"));
    if (aria) return truncate(aria, LABEL_MAX);
    var labelledby = el.getAttribute("aria-labelledby");
    if (!labelledby) return null;
    var parts = [];
    labelledby.split(/\s+/).forEach(function (id) {
      var target = document.getElementById(id);
      if (target) parts.push(clean(target.textContent));
    });
    return labelText(parts.join(" "));
  }


  function associatedLabelFor(el) {
    if (!el.id) return null;
    var label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    return label ? labelText(label.textContent) : null;
  }


  function attributeLabelFor(el) {
    var placeholder = labelText(el.getAttribute("placeholder"));
    if (placeholder) return placeholder;
    return labelText(el.getAttribute("title"));
  }


  function imageOrNameLabelFor(el) {
    var image = el.querySelector ? el.querySelector("img[alt]") : null;
    var alt = image ? labelText(image.getAttribute("alt")) : null;
    return alt || labelText(el.getAttribute("name"));
  }


  function valueLabelFor(el) {
    if (!el.value || valueIsPrivate(el)) return null;
    return truncate(clean(el.value), LABEL_MAX);
  }


  function basicLabelFor(el) {
    var label = ariaLabelFor(el);
    if (label) return label;
    label = labelText(el.textContent);
    if (label) return label;
    label = associatedLabelFor(el);
    if (label) return label;
    return attributeLabelFor(el);
  }


  function labelFor(el) {
    var label = basicLabelFor(el);
    if (label) return label;
    label = imageOrNameLabelFor(el);
    if (label) return label;
    label = valueLabelFor(el);
    if (label !== null) return label;
    return "(unlabeled)";
  }


  var LANDMARKS = [
    ["nav", "nav", ["navigation"]],
    ["header", "header", ["banner"]],
    ["footer", "footer", ["contentinfo"]],
    ["aside", "aside", ["complementary"]],
    ["form", "form", ["form", "search"]],
    ["dialog", "dialog", ["dialog", "alertdialog"]],
    ["main", "main", ["main"]],
  ];


  function landmarkFor(node) {
    var tag = node.tagName ? node.tagName.toLowerCase() : "";
    var role = node.getAttribute ? node.getAttribute("role") : null;
    for (var index = 0; index < LANDMARKS.length; index++) {
      var landmark = LANDMARKS[index];
      if (tag === landmark[1] || landmark[2].indexOf(role) >= 0) return landmark[0];
    }
    return null;
  }


  /** A coarse page region, so the model can tell a nav link from a body link
   *  without being handed the DOM path. */
  function regionFor(el) {
    var node = el;
    for (var index = 0; node && index < 12; index++) {
      var landmark = landmarkFor(node);
      if (landmark) return landmark;
      node = node.parentElement;
    }
    return "body";
  }


  function ariaStateFor(el, bits) {
    if (el.getAttribute("aria-expanded") === "true") bits.push("expanded");
    if (el.getAttribute("aria-selected") === "true") bits.push("selected");
    if (el.checked === true) bits.push("checked");
  }


  function inputStateFor(el, bits) {
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return;
    var value = clean(el.value);
    if (!value) {
      bits.push("empty");
      return;
    }
    bits.push(valueIsPrivate(el) ? "filled" : 'has "' + truncate(value, 40) + '"');
  }


  function selectStateFor(el, bits) {
    if (el.tagName !== "SELECT" || !el.selectedOptions || !el.selectedOptions[0]) return;
    bits.push('"' + truncate(clean(el.selectedOptions[0].textContent), 40) + '"');
  }


  function stateFor(el) {
    var bits = [];
    ariaStateFor(el, bits);
    inputStateFor(el, bits);
    selectStateFor(el, bits);
    if (document.activeElement === el) bits.push("focused");
    return bits.length ? bits.join(", ") : undefined;
  }
  Object.assign(scope, { DOC_ID: DOC_ID, MARK_CAP: MARK_CAP, LABEL_MAX: LABEL_MAX, READ_MAX: READ_MAX, INTERACTIVE: INTERACTIVE, registry: registry, generationState: generationState, LEAVE_CHORD_MS: LEAVE_CHORD_MS, lastEscapeAt: lastEscapeAt, leaveRequested: leaveRequested, takeLeaveRequest: takeLeaveRequest, truncate: truncate, clean: clean, elementRect: elementRect, hasVisibleRect: hasVisibleRect, hasVisibleDimensions: hasVisibleDimensions, isBeforeVisibleBand: isBeforeVisibleBand, isPastClickBand: isPastClickBand, checkedVisibility: checkedVisibility, computedVisibility: computedVisibility, isVisible: isVisible, isDisabled: isDisabled, fieldHint: fieldHint, SECRET_NAME: SECRET_NAME, TYPED_INPUT: TYPED_INPUT, isSecret: isSecret, PRIVATE_VALUE: PRIVATE_VALUE, valueIsPrivate: valueIsPrivate, NATIVE_ROLES: NATIVE_ROLES, inputRole: inputRole, roleFor: roleFor, labelText: labelText, ariaLabelFor: ariaLabelFor, associatedLabelFor: associatedLabelFor, attributeLabelFor: attributeLabelFor, imageOrNameLabelFor: imageOrNameLabelFor, valueLabelFor: valueLabelFor, basicLabelFor: basicLabelFor, labelFor: labelFor, LANDMARKS: LANDMARKS, landmarkFor: landmarkFor, regionFor: regionFor, ariaStateFor: ariaStateFor, inputStateFor: inputStateFor, selectStateFor: selectStateFor, stateFor: stateFor });
})();
