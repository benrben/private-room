(function () {
  "use strict";
  if (window.__arcelleBrowse) return;
  var scope = window.__arcellePageScope;
  if (!scope) return;
  var clean = scope.clean;
  var generationState = scope.generationState;
  var isDisabled = scope.isDisabled;
  var isSecret = scope.isSecret;
  var isVisible = scope.isVisible;
  var labelFor = scope.labelFor;
  var markedEntry = scope.markedEntry;
  var registry = scope.registry;
  var roleFor = scope.roleFor;
  var snapshot = scope.snapshot;
  var truncate = scope.truncate;


  // ------------------------------------------------------------------- find

  /** The elements the CURRENT numbering refers to, rebuilt from the registry
   *  without touching it. Anything that has gone away or been re-laid-out is
   *  dropped by the same staleness rule `resolve` uses, and anything a fresh
   *  snapshot would no longer offer is dropped by the same visibility rule
   *  `snapshot` uses — so a dead number can never be reported as live. */
  function markedNumbers() {
    var ns = [];
    registry.forEach(function (_weak, n) {
      ns.push(n);
    });
    ns.sort(function (a, b) {
      return a - b;
    });
    return ns;
  }


  function currentMarkedElement(n) {
    var weak = registry.get(n);
    var el = weak ? weak.deref() : null;
    if (!el || !el.isConnected || el.getAttribute("data-arcelle-mark") !== String(n)) return null;
    return el;
  }


  function currentEntry(n) {
    var el = currentMarkedElement(n);
    if (!el || isDisabled(el) || !isVisible(el)) return null;
    return markedEntry(el, n);
  }


  function currentElements() {
    var ns = markedNumbers();
    var out = [];
    for (var i = 0; i < ns.length; i++) {
      var entry = currentEntry(ns[i]);
      // Staleness alone is not the whole door a snapshot puts an element
      // through. A control that was visible when the marks were laid down and
      // has since been hidden (a menu that closed, a tab panel that switched)
      // or disabled by client-side validation is still marked and still
      // connected — and offering it here handed the model a ref that `act`
      // resolves and clicks, answering "clicked e7" for a control nobody can
      // see. `snapshot` rejects both; so must the numbering it left behind.
      if (entry) out.push(entry);
    }
    return out;
  }


  /** Is ANY number this page handed out still attached to the element it was
   *  handed out for? Refs the model holds are live exactly while this is true. */
  function anyMarkAlive() {
    var alive = false;
    registry.forEach(function (weak, n) {
      if (alive) return;
      var el = weak ? weak.deref() : null;
      if (el && el.isConnected && el.getAttribute("data-arcelle-mark") === String(n)) alive = true;
    });
    return alive;
  }


  function findNeedle(args) {
    return clean((args && args.text) || "").toLowerCase();
  }


  function findScope() {
    // Search the numbering that is ALREADY out there. `find` used to take a
    // fresh snapshot, and a snapshot clears every mark and bumps the
    // generation — so the cheap "which control is called X" tool silently
    // cancelled every ref the model had been handed a moment earlier, and the
    // next click came back "e7 is gone" on a page nothing had changed on.
    var elements = currentElements();
    var gen = generationState.value;
    if (!anyMarkAlive()) {
      // Nothing numbered yet, or every number has come off the page with the
      // document it was written on: a snapshot is the only way to answer, and
      // there are no live refs left to invalidate.
      //
      // Gated on the marks being ATTACHED, not on the filtered list.
      // `currentElements` also drops marks that have merely scrolled out of
      // its visibility band, so a user scrolling to the bottom of a long page
      // with the trackpad emptied it while every mark was still out there —
      // and the re-snapshot then silently renumbered the page while returning
      // only the matches, so the model's earlier refs pointed at different
      // controls and the next click acted on the wrong one and reported
      // success. With marks in place we answer with no matches instead, which
      // the Rust side already words as "take a fresh browse_snapshot".
      var snap = snapshot({ badges: false });
      elements = snap.elements;
      gen = snap.generation;
    }
    return { elements: elements, generation: gen };
  }


  function matchingEntries(elements, needle) {
    var hits = [];
    for (var i = 0; i < elements.length; i++) {
      var e = elements[i];
      if ((e.label || "").toLowerCase().indexOf(needle) >= 0) hits.push(e);
    }
    return hits;
  }


  function textOccurrences(needle) {
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
    return textHits;
  }


  function find(args) {
    var needle = findNeedle(args);
    if (!needle) return { ok: false, error: "find needs text to look for." };
    var scope = findScope();
    return {
      ok: true,
      url: location.href,
      generation: scope.generation,
      matches: matchingEntries(scope.elements, needle),
      textOccurrences: textOccurrences(needle),
    };
  }


  // ------------------------------------------------------------------ act

  function refNumber(ref) {
    return typeof ref === "number" ? ref : Number(String(ref).replace(/^e/i, ""));
  }


  function staleRefError(n) {
    return { error: "e" + n + " is gone — act on the fresh snapshot below." };
  }


  function resolve(ref) {
    var n = refNumber(ref);
    if (!isFinite(n) || n <= 0) return { error: 'Bad ref "' + ref + '" — refs look like "e4".' };
    var el = currentMarkedElement(n);
    // The staleness invariant, inherited from driver.ts: an old number must
    // never silently act on a re-laid-out element.
    if (!el) return staleRefError(n);
    if (isSecret(el)) {
      return { error: "e" + n + " is a password field — fenced; the user must fill it." };
    }
    return { el: el };
  }


  /** The half of the disabled trap that `resolve` cannot close by itself.
   *
   * `snapshot` and `currentElements` both refuse to hand out a disabled or
   * hidden control, so a ref taken from either is fine at the moment it is
   * issued. It can still go dead between being issued and being used — a form
   * that disables its Submit while validating is the ordinary case — and the
   * click path then reported `clicked e7 — button "Submit"` for a click the
   * browser itself discarded, which is a fabricated result.
   *
   * Deliberately NATIVE `disabled` only, not `aria-disabled` and not
   * `isVisible`: the browser genuinely swallows a click on the former, so
   * refusing can never be wrong, while `aria-disabled` is only the page's own
   * claim and `isVisible` carries a "far below the fold" band that is right for
   * choosing what to SHOW and would wrongly refuse a legitimate click five
   * screens down. Scrolling to such an element stays allowed — that is how you
   * look at it.
   */
  function refuseIfDead(ref, el) {
    if (el.disabled === true) {
      return (
        "e" +
        String(ref).replace(/^e/i, "") +
        " is disabled right now — " +
        describe(el) +
        ". Nothing was clicked or typed; act on the fresh snapshot below."
      );
    }
    return null;
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


  function scrollToRef(ref) {
    var resolved = resolve(ref);
    if (resolved.error) return { ok: false, error: resolved.error };
    try {
      resolved.el.scrollIntoView({ block: "center" });
    } catch (e) {}
    return { ok: true, did: "scrolled to " + ref };
  }


  function scrollTarget(direction) {
    return typeof direction === "object" && direction.to ? direction.to : null;
  }


  function scrollDirectionName(direction) {
    return String(typeof direction === "object" ? direction.dir : direction).toLowerCase();
  }


  function scrollPage(name) {
    var amount = window.innerHeight * 0.85;
    if (name === "top") {
      window.scrollTo(0, 0);
      return;
    }
    if (name === "bottom") {
      window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
      return;
    }
    window.scrollBy(0, name === "up" ? -amount : amount);
  }


  function doScroll(a) {
    var direction = a.scroll;
    var target = scrollTarget(direction);
    if (target) return scrollToRef(target);
    var name = scrollDirectionName(direction);
    scrollPage(name);
    return { ok: true, did: "scrolled " + name };
  }


  function doClickAt(a) {
    var x = Number(a.click_at.x);
    var y = Number(a.click_at.y);
    if (!isFinite(x) || !isFinite(y)) {
      return { ok: false, error: "click_at needs numeric x and y in CSS pixels." };
    }
    var target = document.elementFromPoint(x, y);
    if (!target) return { ok: false, error: "Nothing is at (" + x + ", " + y + ")." };
    if (isSecret(target)) return { ok: false, error: "That point is a password field — fenced." };
    var init = { clientX: x, clientY: y, button: 0, view: window };
    fire(target, "mousedown", init);
    fire(target, "mouseup", init);
    fire(target, "click", init);
    return {
      ok: true,
      did: 'clicked (' + Math.round(x) + ", " + Math.round(y) + ") — " + describe(target),
    };
  }


  function focusElement(el) {
    try {
      if (typeof el.focus === "function") el.focus();
    } catch (e) {}
  }


  function clickElement(el) {
    try {
      el.click();
    } catch (e) {
      fire(el, "click");
    }
  }


  function doClick(a) {
    var resolved = resolve(a.click);
    if (resolved.error) return { ok: false, error: resolved.error };
    var dead = refuseIfDead(a.click, resolved.el);
    if (dead) return { ok: false, error: dead };
    try {
      resolved.el.scrollIntoView({ block: "center" });
    } catch (e) {}
    focusElement(resolved.el);
    clickElement(resolved.el);
    return { ok: true, did: "clicked " + a.click + " — " + describe(resolved.el) };
  }


  function typeIntoContentEditable(input, spec, text) {
    if (spec.clear) input.textContent = "";
    input.textContent = (input.textContent || "") + text;
    fire(input, "input");
  }


  function typeIntoElement(input, spec, text) {
    if (input.isContentEditable) return typeIntoContentEditable(input, spec, text);
    var base = spec.clear ? "" : input.value || "";
    setNativeValue(input, base + text);
  }


  function submitField(input) {
    fire(input, "keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13 });
    fire(input, "keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13 });
    var form = input.form;
    if (!form) return;
    try {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    } catch (e) {}
  }


  function doType(a) {
    var spec = a.type;
    var resolved = resolve(spec.ref);
    if (resolved.error) return { ok: false, error: resolved.error };
    var dead = refuseIfDead(spec.ref, resolved.el);
    if (dead) return { ok: false, error: dead };
    focusElement(resolved.el);
    typeIntoElement(resolved.el, spec, String(spec.text == null ? "" : spec.text));
    var did = "typed into " + spec.ref + " — " + describe(resolved.el);
    if (spec.submit) {
      submitField(resolved.el);
      did += " and submitted";
    }
    return { ok: true, did: did };
  }


  function optionMatches(option, want) {
    var text = clean(option.textContent).toLowerCase();
    return String(option.value).toLowerCase() === want || text === want || text.indexOf(want) >= 0;
  }


  function matchingOption(options, want) {
    for (var index = 0; index < options.length; index++) {
      if (optionMatches(options[index], want)) return index;
    }
    return -1;
  }


  function availableOptions(options) {
    var available = [];
    for (var index = 0; index < options.length && index < 20; index++) {
      available.push(clean(options[index].textContent));
    }
    return available;
  }


  function missingOptionResult(spec, options) {
    return {
      ok: false,
      error: 'No option matching "' + spec.value + '". Available: ' + availableOptions(options).join(", "),
    };
  }


  function selectMatch(spec, element) {
    var want = String(spec.value == null ? "" : spec.value).toLowerCase();
    var options = element.options || [];
    return { options: options, index: matchingOption(options, want) };
  }


  function doSelect(a) {
    var spec = a.select;
    var resolved = resolve(spec.ref);
    if (resolved.error) return { ok: false, error: resolved.error };
    var dead = refuseIfDead(spec.ref, resolved.el);
    if (dead) return { ok: false, error: dead };
    var match = selectMatch(spec, resolved.el);
    if (match.index === -1) return missingOptionResult(spec, match.options);
    var option = match.options[match.index];
    resolved.el.selectedIndex = match.index;
    fire(resolved.el, "input");
    fire(resolved.el, "change");
    return { ok: true, did: 'selected "' + clean(option.textContent) + '" in ' + spec.ref };
  }


  function doKey(a) {
    var target = document.activeElement || document.body;
    var key = String(a.key);
    fire(target, "keydown", { key: key, code: key });
    fire(target, "keyup", { key: key, code: key });
    return { ok: true, did: "pressed " + key };
  }


  function doBack() {
    history.back();
    return { ok: true, did: "went back" };
  }


  function doForward() {
    history.forward();
    return { ok: true, did: "went forward" };
  }


  var ACTION_HANDLERS = [
    ["scroll", doScroll],
    ["click_at", doClickAt],
    ["click", doClick],
    ["type", doType],
    ["select", doSelect],
    ["key", doKey],
    ["back", doBack],
    ["forward", doForward],
  ];


  function actionHandler(a) {
    for (var index = 0; index < ACTION_HANDLERS.length; index++) {
      var entry = ACTION_HANDLERS[index];
      if (a[entry[0]]) return entry[1];
    }
    return null;
  }


  function doOne(a) {
    if (!a || typeof a !== "object") return { ok: false, error: "Each action must be an object." };
    var handler = actionHandler(a);
    if (handler) return handler(a);
    return { ok: false, error: "Unknown action: " + truncate(JSON.stringify(a), 120) };
  }


  function describe(el) {
    if (!el || !el.tagName) return "element";
    return roleFor(el) + ' "' + labelFor(el) + '"';
  }
  Object.assign(scope, { markedNumbers: markedNumbers, currentMarkedElement: currentMarkedElement, currentEntry: currentEntry, currentElements: currentElements, anyMarkAlive: anyMarkAlive, findNeedle: findNeedle, findScope: findScope, matchingEntries: matchingEntries, textOccurrences: textOccurrences, find: find, refNumber: refNumber, staleRefError: staleRefError, resolve: resolve, refuseIfDead: refuseIfDead, fire: fire, setNativeValue: setNativeValue, scrollToRef: scrollToRef, scrollTarget: scrollTarget, scrollDirectionName: scrollDirectionName, scrollPage: scrollPage, doScroll: doScroll, doClickAt: doClickAt, focusElement: focusElement, clickElement: clickElement, doClick: doClick, typeIntoContentEditable: typeIntoContentEditable, typeIntoElement: typeIntoElement, submitField: submitField, doType: doType, optionMatches: optionMatches, matchingOption: matchingOption, availableOptions: availableOptions, missingOptionResult: missingOptionResult, selectMatch: selectMatch, doSelect: doSelect, doKey: doKey, doBack: doBack, doForward: doForward, ACTION_HANDLERS: ACTION_HANDLERS, actionHandler: actionHandler, doOne: doOne, describe: describe });
})();
