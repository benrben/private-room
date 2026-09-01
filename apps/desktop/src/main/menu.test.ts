import { describe, expect, it, vi } from "vitest";
import {
  alwaysEnabled,
  APP_ID,
  buildTemplate,
  CLOSE_ID,
  dispatch,
  type DispatchDeps,
  EDIT_ID,
  FILE_ID,
  gatedRows,
  ids,
  type MainWindowLike,
  MENU_EVENT,
  MENU_SPEC,
  menuSync,
  NEW_ID,
  QUIT_ID,
  quit,
  type QuitDoorLike,
  type Row,
  sidebarLabel,
  VIEW_ASSISTANT_ID,
  VIEW_FOCUS_ID,
  VIEW_ID,
  VIEW_LIBRARY_ID,
  VIEW_PRESET_FOCUS_ID,
  VIEW_PRESET_RESEARCH_ID,
  VIEW_PRESET_REVIEW_ID,
  VIEW_RAIL_LABELS_ID,
  VIEW_RESET_ID,
  type ViewMenuState,
  viewMenuChecks,
  WINDOW_ID,
} from "./menu.js";
import { QUIT_REQUESTED } from "./quitDoor.js";
import type { Menu as ElectronMenu, MenuItemConstructorOptions } from "electron";

// ------------------------------------------------------------- test helpers

function rowsOf(id: string): Row[] {
  const section = MENU_SPEC.find((s) => s.id === id);
  if (!section) {
    throw new Error(`no ${id} section`);
  }
  return section.rows;
}

function platformRoles(rows: Row[]): Array<MenuItemConstructorOptions["role"]> {
  return rows
    .filter((r): r is Extract<Row, { kind: "platform" }> => r.kind === "platform")
    .map((r) => r.role);
}

function aState(): ViewMenuState {
  return {
    enabled: true,
    library: true,
    assistant: false,
    focus: false,
    railLabels: true,
    railLabelsSettable: true,
    sidebar: "Sketches",
  };
}

// The Rust source's `CLIPBOARD` const is itself `#[cfg(test)]`-gated — a
// list named once so the test protecting it and the reader looking for it
// read the same thing. Its TS equivalent belongs here for the same reason:
// it is test-only.
const CLIPBOARD: Array<MenuItemConstructorOptions["role"]> = ["cut", "copy", "paste", "selectAll"];

// ------------------------------------------------------------------ MENU_SPEC

describe("MENU_SPEC", () => {
  /**
   * THE test this module exists for. Electron's `Menu.setApplicationMenu`
   * replaces the stock menu, so an Edit submenu that loses a row takes that
   * row's key equivalent with it — app-wide, including the password gate's
   * passphrase field.
   */
  it("spec_declares_the_clipboard_keys", () => {
    const edit = platformRoles(rowsOf(EDIT_ID));
    for (const role of CLIPBOARD) {
      expect(
        edit.includes(role),
        `${role} is missing from the Edit submenu — its key equivalent would stop working in every text field in the app`,
      ).toBe(true);
    }
    expect(edit.includes("undo") && edit.includes("redo")).toBe(true);
  });

  /** The application menu is the other half of the same trap: without
   * these there is no About, no Services, no Hide — and no ⌘Q. */
  it("spec_declares_the_application_menu", () => {
    const app = platformRoles(rowsOf(APP_ID));
    for (const role of ["about", "services", "hide", "hideOthers"] as const) {
      expect(app.includes(role), `${role} is missing from the app menu`).toBe(true);
    }
  });

  /**
   * ⌘Q IS OURS, and it has to be — see the doc comment on `QUIT_ID`. The
   * predefined Quit role gives no hook that can hold the exit and ask about
   * an unsaved buffer, so this row raises `MENU_EVENT` like any other and
   * `dispatch` answers it directly rather than passing it on.
   */
  it("quit_is_a_row_of_ours_because_the_platform_row_cannot_be_asked_a_question", () => {
    const quitRow = rowsOf(APP_ID).find(
      (r): r is Extract<Row, { kind: "command" }> => r.kind === "command" && r.id === QUIT_ID,
    );
    expect(quitRow, "the Quit row is not ours — unsaved edits go out with the process").toBeDefined();
    expect(quitRow?.accelerator).toBe("CmdOrCtrl+Q");
    // Born enabled, like Close: the start screen and the password gate are
    // windows too, and a ⌘Q that does nothing there would be worse than the
    // bug this row fixes.
    expect(alwaysEnabled(QUIT_ID)).toBe(true);
    // ...and it is NOT a gated row, so `menuSync` never greys it and the
    // frontend is never asked to handle it — `dispatch` answers it, because
    // the answer is "hold the exit", which no window can decide.
    expect(ids().includes(QUIT_ID)).toBe(false);
  });

  /** The label is a literal, so a rename would leave the Apple menu saying
   * Quit <the old product>. The app has been renamed once already (Private
   * Room → Arcelle). */
  it("the_quit_row_is_named_after_the_app_it_quits", () => {
    const quitRow = rowsOf(APP_ID).find(
      (r): r is Extract<Row, { kind: "command" }> => r.kind === "command" && r.id === QUIT_ID,
    );
    expect(quitRow?.label).toBe("Quit Arcelle");
  });

  it("ids_are_unique_and_namespaced", () => {
    const seen = new Set<string>();
    for (const [section, id] of gatedRows()) {
      expect(seen.has(id), `duplicate menu id ${id}`).toBe(false);
      seen.add(id);
      // An id names the menu it lives in, so a stray row cannot be synced
      // (or handled) as though it belonged to the other one.
      expect(id.startsWith(`${section}.`), `${id} is not in the ${section} namespace`).toBe(true);
    }
    expect(gatedRows().length, "a row was added or removed — check the frontend maps too").toBe(10);
  });

  /**
   * ⌘W is macOS's "close this window", and the start screen and the
   * password gate are windows. This menu REPLACES the predefined Close
   * Window row that would otherwise own the key unconditionally, so gating
   * our Close row with the room would leave ⌘W doing nothing whatever with
   * no room open. It is the one row that survives the gate, in
   * `buildTemplate` and in `menuSync` alike, and `dispatch` gives it its
   * meaning there because the frontend's handler mounts with the room.
   */
  it("close_is_the_one_row_the_room_gate_leaves_alone", () => {
    expect(alwaysEnabled(CLOSE_ID)).toBe(true);
    for (const id of ids()) {
      expect(alwaysEnabled(id), `${id} disagrees with the gate about whether it needs a room`).toBe(id === CLOSE_ID);
    }
    const closeRow = rowsOf(FILE_ID).find(
      (r): r is Extract<Row, { kind: "command" }> => r.kind === "command" && r.id === CLOSE_ID,
    );
    expect(closeRow, "the Close row is gone — ⌘W has no owner at all now").toBeDefined();
    expect(closeRow?.accelerator).toBe("CmdOrCtrl+W");
  });

  /** ⌘1 and ⌘2 have exactly one owner, and it is this file — a capture-
   * phase keydown listener would give the same key two owners, and a pane
   * toggled twice never moves. */
  it("the_pane_keys_are_declared_once_each", () => {
    function accelPairs(rows: Row[]): Array<[string, string]> {
      const out: Array<[string, string]> = [];
      for (const row of rows) {
        if ((row.kind === "command" || row.kind === "check") && row.accelerator) {
          out.push([row.id, row.accelerator]);
        }
      }
      return out;
    }
    expect(accelPairs(rowsOf(VIEW_ID))).toEqual([
      [VIEW_LIBRARY_ID, "CmdOrCtrl+1"],
      [VIEW_ASSISTANT_ID, "CmdOrCtrl+2"],
    ]);
  });

  /** ⌘Q/⌘T/⌘W/⌘1/⌘2 accelerators are exactly where the Rust spec puts them
   * — App for Quit, File for New/Close, View for library/assistant — and
   * none of them leak into Edit or Window as a second, competing owner. */
  it("the_named_accelerators_live_only_in_the_sections_the_rust_spec_puts_them_in", () => {
    const named = ["CmdOrCtrl+Q", "CmdOrCtrl+T", "CmdOrCtrl+W", "CmdOrCtrl+1", "CmdOrCtrl+2"];
    const commandsOf = (id: string) =>
      rowsOf(id).filter(
        (r): r is Extract<Row, { kind: "command" | "check" }> => r.kind === "command" || r.kind === "check",
      );
    expect(commandsOf(APP_ID).find((r) => r.id === QUIT_ID)?.accelerator).toBe("CmdOrCtrl+Q");
    expect(commandsOf(FILE_ID).find((r) => r.id === NEW_ID)?.accelerator).toBe("CmdOrCtrl+T");
    expect(commandsOf(FILE_ID).find((r) => r.id === CLOSE_ID)?.accelerator).toBe("CmdOrCtrl+W");
    expect(commandsOf(VIEW_ID).find((r) => r.id === VIEW_LIBRARY_ID)?.accelerator).toBe("CmdOrCtrl+1");
    expect(commandsOf(VIEW_ID).find((r) => r.id === VIEW_ASSISTANT_ID)?.accelerator).toBe("CmdOrCtrl+2");
    for (const section of MENU_SPEC) {
      if (section.id === APP_ID || section.id === FILE_ID || section.id === VIEW_ID) continue;
      const stray = commandsOf(section.id).find((r) => named.includes(r.accelerator ?? ""));
      expect(stray, `a named accelerator leaked into ${section.id}`).toBeUndefined();
    }
  });

  /** The ⌘1 row is named after the column it toggles, and that column is a
   * different thing in each destination — it must never read like one
   * destination's word for it. */
  it("the_sidebar_row_never_borrows_one_destinations_name", () => {
    const libraryRow = rowsOf(VIEW_ID).find(
      (r): r is Extract<Row, { kind: "check" }> => r.kind === "check" && r.id === VIEW_LIBRARY_ID,
    );
    expect(libraryRow?.label).not.toBe("Library");
  });

  /** Add a tick row to the spec and forget its field in the payload and the
   * row goes stale silently — it keeps whatever it was last set to while the
   * window says otherwise. This is the test that makes that impossible. */
  it("every_check_row_has_a_payload_field", () => {
    const mapped = new Set(viewMenuChecks(aState()).map(([id]) => id));
    const declared = new Set<string>();
    function walk(rows: Row[]): void {
      for (const row of rows) {
        if (row.kind === "check") declared.add(row.id);
        if (row.kind === "nested") walk(row.rows);
      }
    }
    walk(rowsOf(VIEW_ID));
    expect(declared).toEqual(mapped);
  });

  /**
   * View is the one section holding rows with two different lifetimes, and
   * that is the whole reason `menuSync` gates it row by row rather than as
   * a unit — what is provable here is the shape underneath: the rows
   * `menuSync` reaches are exactly the room's, and no window command
   * (platform role) is among them.
   */
  it("the_view_section_mixes_window_commands_with_room_ones", () => {
    const view = MENU_SPEC.find((s) => s.id === VIEW_ID);
    expect(view, "the View section is gone").toBeDefined();
    let windowCommands = 0;
    let roomRows = 0;
    for (const row of view!.rows) {
      if (row.kind === "platform") windowCommands += 1;
      else if (row.kind === "command" || row.kind === "check" || row.kind === "nested") roomRows += 1;
    }
    expect(
      windowCommands >= 1 && roomRows >= 1,
      "if View ever holds only one kind of row this test has stopped saying anything, and gating the section becomes safe again",
    ).toBe(true);

    // Nothing `gatedRows` touches is a window command: every id it walks is
    // declared by a Command or a Check (independently re-derived here,
    // rather than by calling `gatedRows` again, so a bug inside `gatedRows`
    // itself cannot hide from this test).
    function declaredIds(rows: Row[], out: string[]): void {
      for (const row of rows) {
        if (row.kind === "command" || row.kind === "check") out.push(row.id);
        if (row.kind === "nested") declaredIds(row.rows, out);
      }
    }
    const declared: string[] = [];
    declaredIds(view!.rows, declared);
    const file = MENU_SPEC.find((s) => s.id === FILE_ID);
    expect(file, "a File section").toBeDefined();
    declaredIds(file!.rows, declared);

    const governed = [...ids()].sort();
    declared.sort();
    expect(governed).toEqual(declared);
  });

  /** Every other id used above lands in exactly one section, in menu
   * order, so `gatedRows` walking into the Layout submenu is the same
   * traversal a reader following the nesting by eye would do. */
  it("gated_rows_only_touches_view_and_file_and_walks_into_layout", () => {
    const sections = new Set(gatedRows().map(([section]) => section));
    expect(sections).toEqual(new Set([FILE_ID, VIEW_ID]));
    const flatIds = ids();
    for (const nestedId of [
      VIEW_PRESET_FOCUS_ID,
      VIEW_PRESET_RESEARCH_ID,
      VIEW_PRESET_REVIEW_ID,
      VIEW_RESET_ID,
    ]) {
      expect(flatIds.includes(nestedId), `${nestedId} (nested under Layout) missing from gatedRows`).toBe(true);
    }
    // File comes before View in menu order, and gatedRows is expected to
    // preserve that.
    expect(flatIds.indexOf(NEW_ID)).toBeLessThan(flatIds.indexOf(VIEW_LIBRARY_ID));
  });
});

// ---------------------------------------------------------------- alwaysEnabled

describe("alwaysEnabled", () => {
  it("is exactly the two-id set: Close and Quit", () => {
    expect(alwaysEnabled(CLOSE_ID)).toBe(true);
    expect(alwaysEnabled(QUIT_ID)).toBe(true);
    for (const id of ids()) {
      if (id !== CLOSE_ID) {
        expect(alwaysEnabled(id)).toBe(false);
      }
    }
    expect(alwaysEnabled("view.assistant")).toBe(false);
    expect(alwaysEnabled("file.new-item")).toBe(false);
    expect(alwaysEnabled("something-unrelated")).toBe(false);
  });
});

// ----------------------------------------------------------------- buildTemplate

describe("buildTemplate", () => {
  function flatten(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    const out: MenuItemConstructorOptions[] = [];
    for (const item of template) {
      out.push(item);
      if (Array.isArray(item.submenu)) {
        out.push(...flatten(item.submenu));
      }
    }
    return out;
  }

  it("is pure data — calling it twice never invokes onCommand", () => {
    const onCommand = vi.fn();
    buildTemplate(onCommand);
    buildTemplate(onCommand);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("labels the application menu (null section label) with the app's own name", () => {
    const template = buildTemplate(() => {});
    expect(template[0]?.label).toBe("Arcelle");
    expect(template.find((s) => s.label === "File")).toBeDefined();
    expect(template.find((s) => s.label === "Edit")).toBeDefined();
    expect(template.find((s) => s.label === "View")).toBeDefined();
    expect(template.find((s) => s.label === "Window")).toBeDefined();
  });

  it("gives platform rows only a role, separators only a type, and nests Layout", () => {
    const template = buildTemplate(() => {});
    const flat = flatten(template);
    const clipboardRoles = flat.filter((i) => i.role && CLIPBOARD.includes(i.role)).map((i) => i.role);
    expect(new Set(clipboardRoles)).toEqual(new Set(CLIPBOARD));
    const separators = flat.filter((i) => i.type === "separator");
    expect(separators.length).toBeGreaterThan(0);
    const layout = flat.find((i) => i.label === "Layout");
    expect(layout).toBeDefined();
    expect(Array.isArray(layout?.submenu)).toBe(true);
    const layoutSubmenu = layout!.submenu as MenuItemConstructorOptions[];
    expect(layoutSubmenu.map((i) => i.id)).toEqual([
      VIEW_PRESET_FOCUS_ID,
      VIEW_PRESET_RESEARCH_ID,
      VIEW_PRESET_REVIEW_ID,
      undefined, // the separator between Review and Reset Layout
      VIEW_RESET_ID,
    ]);
  });

  it("every command/check row is born disabled except Close and Quit", () => {
    const flat = flatten(buildTemplate(() => {}));
    for (const item of flat) {
      if (item.id) {
        expect(item.enabled, `${item.id} born-enabled state`).toBe(alwaysEnabled(item.id));
      }
    }
  });

  it("check rows are type checkbox and start unchecked", () => {
    const flat = flatten(buildTemplate(() => {}));
    for (const id of [VIEW_LIBRARY_ID, VIEW_ASSISTANT_ID, VIEW_FOCUS_ID, VIEW_RAIL_LABELS_ID]) {
      const item = flat.find((i) => i.id === id);
      expect(item?.type, `${id} should be a checkbox`).toBe("checkbox");
      expect(item?.checked, `${id} should start unchecked`).toBe(false);
    }
  });

  it("clicking a produced row calls onCommand with its own id, not another's", () => {
    const calls: string[] = [];
    const template = buildTemplate((id) => calls.push(id));
    const flat = flatten(template);
    const newItem = flat.find((i) => i.id === NEW_ID);
    const closeItem = flat.find((i) => i.id === CLOSE_ID);
    expect(typeof newItem?.click).toBe("function");
    expect(typeof closeItem?.click).toBe("function");
    // @ts-expect-error -- test invocation with the documented dummy args
    newItem!.click!();
    expect(calls).toEqual([NEW_ID]);
    // @ts-expect-error -- test invocation with the documented dummy args
    closeItem!.click!();
    expect(calls).toEqual([NEW_ID, CLOSE_ID]);
  });
});

// ------------------------------------------------------------------ sidebarLabel

describe("sidebarLabel", () => {
  it("falls back to the generic word only when there is nothing to say", () => {
    expect(sidebarLabel("Sketches")).toBe("Sketches");
    expect(sidebarLabel("")).toBe("Sidebar");
    expect(sidebarLabel("   ")).toBe("Sidebar");
    expect(sidebarLabel("  Private pages ")).toBe("Private pages");
  });
});

// ---------------------------------------------------------------- viewMenuChecks

describe("viewMenuChecks", () => {
  it("the rail-labels row needs BOTH enabled and rail-labels-settable", () => {
    const stuck: ViewMenuState = { ...aState(), railLabelsSettable: false };
    const enabledOf = (state: ViewMenuState, id: string) =>
      viewMenuChecks(state).find(([rowId]) => rowId === id)?.[2];

    expect(enabledOf(aState(), VIEW_RAIL_LABELS_ID)).toBe(true);
    expect(enabledOf(stuck, VIEW_RAIL_LABELS_ID)).toBe(false);

    // ...and a closed room greys out every row, that one included.
    const noRoom: ViewMenuState = { ...aState(), enabled: false };
    for (const [, , enabled] of viewMenuChecks(noRoom)) {
      expect(enabled).toBe(false);
    }
  });

  /** Neither flag alone is sufficient — both must hold, in every
   * combination, not just the two extremes above. */
  it("railLabels needs both enabled and settable in every combination", () => {
    const enabledOnly: ViewMenuState = { ...aState(), enabled: true, railLabelsSettable: false };
    const settableOnly: ViewMenuState = { ...aState(), enabled: false, railLabelsSettable: true };
    const both: ViewMenuState = { ...aState(), enabled: true, railLabelsSettable: true };
    const railEnabled = (s: ViewMenuState) => viewMenuChecks(s).find(([id]) => id === VIEW_RAIL_LABELS_ID)?.[2];
    expect(railEnabled(enabledOnly)).toBe(false);
    expect(railEnabled(settableOnly)).toBe(false);
    expect(railEnabled(both)).toBe(true);
  });

  it("checked mirrors the payload's own flags", () => {
    const state = aState();
    expect(viewMenuChecks(state)).toEqual([
      [VIEW_LIBRARY_ID, true, true],
      [VIEW_ASSISTANT_ID, false, true],
      [VIEW_FOCUS_ID, false, true],
      [VIEW_RAIL_LABELS_ID, true, true],
    ]);
  });
});

// ------------------------------------------------------------------------ quit

describe("quit", () => {
  it("holds_and_has_a_window_sends_quit_requested_and_does_not_exit", () => {
    const sent: Array<[string, unknown[]]> = [];
    const window: MainWindowLike = {
      webContents: { send: (channel, ...args) => sent.push([channel, args]) },
      close: () => {
        throw new Error("close should never be called by quit()");
      },
    };
    const appExit = vi.fn();
    const quitDoor: QuitDoorLike = { holdForUnsaved: () => true };

    quit(quitDoor, () => window, appExit);

    expect(sent).toEqual([[QUIT_REQUESTED, []]]);
    expect(appExit).not.toHaveBeenCalled();
  });

  it("hold_returns_false_exits_immediately_without_even_looking_for_a_window", () => {
    const appExit = vi.fn();
    const quitDoor: QuitDoorLike = { holdForUnsaved: () => false };
    const getMainWindow = vi.fn((): MainWindowLike | null => {
      throw new Error("must not be consulted when nothing is held");
    });

    quit(quitDoor, getMainWindow, appExit);

    expect(appExit).toHaveBeenCalledTimes(1);
    expect(getMainWindow).not.toHaveBeenCalled();
  });

  /** Ports the Rust source's `if let Some(window) = ... else` fallthrough:
   * held is true, but there is no window left to ask, so the exit proceeds
   * anyway rather than being silently swallowed. */
  it("holds_true_but_no_window_left_falls_through_to_exit", () => {
    const appExit = vi.fn();
    const quitDoor: QuitDoorLike = { holdForUnsaved: () => true };

    quit(quitDoor, () => null, appExit);

    expect(appExit).toHaveBeenCalledTimes(1);
  });

  it("also falls through to exit when getMainWindow returns undefined", () => {
    const appExit = vi.fn();
    const quitDoor: QuitDoorLike = { holdForUnsaved: () => true };

    quit(quitDoor, () => undefined, appExit);

    expect(appExit).toHaveBeenCalledTimes(1);
  });
});

// --------------------------------------------------------------------- dispatch

function windowRecorder(): { window: MainWindowLike; sent: Array<[string, unknown[]]>; closed: boolean } {
  const sent: Array<[string, unknown[]]> = [];
  let closed = false;
  const window: MainWindowLike = {
    webContents: { send: (channel, ...args) => sent.push([channel, args]) },
    close: () => {
      closed = true;
    },
  };
  return {
    window,
    sent,
    get closed() {
      return closed;
    },
  } as { window: MainWindowLike; sent: Array<[string, unknown[]]>; closed: boolean };
}

describe("dispatch", () => {
  it("QUIT_ID is handled before any window or room lookup at all", () => {
    const appExit = vi.fn();
    const getMainWindow = vi.fn((): MainWindowLike | null => {
      throw new Error("must not be consulted for a held=false quit");
    });
    const isRoomOpen = vi.fn((): boolean => {
      throw new Error("QUIT_ID must never consult room state");
    });
    const deps: DispatchDeps = {
      quitDoor: { holdForUnsaved: () => false },
      getMainWindow,
      isRoomOpen,
      appExit,
    };

    dispatch(QUIT_ID, deps);

    expect(appExit).toHaveBeenCalledTimes(1);
    expect(isRoomOpen).not.toHaveBeenCalled();
  });

  it("QUIT_ID works with a window present but no room open — the start screen", () => {
    const rec = windowRecorder();
    const appExit = vi.fn();
    const isRoomOpen = vi.fn((): boolean => {
      throw new Error("quit does not consult room state");
    });
    const deps: DispatchDeps = {
      quitDoor: { holdForUnsaved: () => true },
      getMainWindow: () => rec.window,
      isRoomOpen,
      appExit,
    };

    dispatch(QUIT_ID, deps);

    expect(rec.sent).toEqual([[QUIT_REQUESTED, []]]);
    expect(appExit).not.toHaveBeenCalled();
    expect(isRoomOpen).not.toHaveBeenCalled();
  });

  it("CLOSE_ID with no room open closes the window itself, and does not emit", () => {
    const rec = windowRecorder();
    const deps: DispatchDeps = {
      quitDoor: { holdForUnsaved: () => false },
      getMainWindow: () => rec.window,
      isRoomOpen: () => false,
      appExit: () => {
        throw new Error("should not exit for CLOSE_ID");
      },
    };

    dispatch(CLOSE_ID, deps);

    expect(rec.closed).toBe(true);
    expect(rec.sent).toEqual([]);
  });

  it("CLOSE_ID with a room open is forwarded to the frontend instead of closing", () => {
    const rec = windowRecorder();
    const deps: DispatchDeps = {
      quitDoor: { holdForUnsaved: () => false },
      getMainWindow: () => rec.window,
      isRoomOpen: () => true,
      appExit: () => {
        throw new Error("should not exit for CLOSE_ID");
      },
    };

    dispatch(CLOSE_ID, deps);

    expect(rec.closed).toBe(false);
    expect(rec.sent).toEqual([[MENU_EVENT, [CLOSE_ID]]]);
  });

  it("an ordinary row with no window at all is a silent no-op", () => {
    const deps: DispatchDeps = {
      quitDoor: { holdForUnsaved: () => false },
      getMainWindow: () => null,
      isRoomOpen: (): boolean => {
        throw new Error("never reached with no window to close or emit to");
      },
      appExit: () => {
        throw new Error("never reached for a non-quit id");
      },
    };

    expect(() => dispatch(VIEW_PRESET_FOCUS_ID, deps)).not.toThrow();
  });

  it("an ordinary row with a window emits MENU_EVENT carrying its own id", () => {
    const rec = windowRecorder();
    const deps: DispatchDeps = {
      quitDoor: { holdForUnsaved: () => false },
      getMainWindow: () => rec.window,
      isRoomOpen: () => true,
      appExit: () => {
        throw new Error("should not exit");
      },
    };

    dispatch(VIEW_PRESET_FOCUS_ID, deps);

    expect(rec.sent).toEqual([[MENU_EVENT, [VIEW_PRESET_FOCUS_ID]]]);
    expect(rec.closed).toBe(false);
  });
});

// --------------------------------------------------------------------- menuSync

/** A minimal fake `Electron.Menu`: enough surface for `menuSync` to drive
 * (`getMenuItemById`), backed by the SAME object each call so mutations to
 * `.checked`/`.enabled`/`.label` are observable afterwards — a real
 * `Electron.MenuItem` behaves the same way (it is a live handle, not a
 * snapshot). Cast to `Electron.Menu` at the call site; menuSync only ever
 * calls the one method this fake actually implements. */
class FakeMenu {
  private readonly items = new Map<string, { id: string; type: string; checked?: boolean; enabled: boolean; label?: string }>();

  set(id: string, item: { type: string; checked?: boolean; enabled: boolean; label?: string }): void {
    this.items.set(id, { id, ...item });
  }

  getMenuItemById(id: string) {
    return this.items.get(id) ?? null;
  }
}

function buildFakeMenu(): FakeMenu {
  const menu = new FakeMenu();
  const checkIds = new Set(viewMenuChecks(aState()).map(([id]) => id));
  for (const [, id] of gatedRows()) {
    if (checkIds.has(id)) {
      menu.set(id, { type: "checkbox", checked: false, enabled: false, label: "" });
    } else {
      menu.set(id, { type: "normal", enabled: false });
    }
  }
  return menu;
}

describe("menuSync", () => {
  it("pushes checked/enabled onto every gated row, and the label onto view.library only", () => {
    const menu = buildFakeMenu();
    menuSync(menu as unknown as ElectronMenu, aState());

    const library = menu.getMenuItemById(VIEW_LIBRARY_ID)!;
    expect(library.checked).toBe(true);
    expect(library.enabled).toBe(true);
    expect(library.label).toBe("Sketches");

    const assistant = menu.getMenuItemById(VIEW_ASSISTANT_ID)!;
    expect(assistant.checked).toBe(false);
    expect(assistant.label).toBe(""); // untouched — only view.library gets retitled

    const newItem = menu.getMenuItemById(NEW_ID)!;
    expect(newItem.enabled).toBe(true); // follows view.enabled

    const close = menu.getMenuItemById(CLOSE_ID)!;
    expect(close.enabled).toBe(true); // always enabled regardless of view.enabled
  });

  it("greys out room rows when no room is open, but leaves Close alone", () => {
    const menu = buildFakeMenu();
    menuSync(menu as unknown as ElectronMenu, { ...aState(), enabled: false });

    expect(menu.getMenuItemById(NEW_ID)!.enabled).toBe(false);
    expect(menu.getMenuItemById(VIEW_LIBRARY_ID)!.enabled).toBe(false);
    expect(menu.getMenuItemById(CLOSE_ID)!.enabled).toBe(true);
  });

  it("retitles view.library to the trimmed sidebar name from the payload", () => {
    const menu = buildFakeMenu();
    menuSync(menu as unknown as ElectronMenu, { ...aState(), sidebar: "  Private pages  " });
    expect(menu.getMenuItemById(VIEW_LIBRARY_ID)!.label).toBe("Private pages");
  });

  it("falls back to Sidebar when the payload has nothing to say", () => {
    const menu = buildFakeMenu();
    menuSync(menu as unknown as ElectronMenu, { ...aState(), sidebar: "" });
    expect(menu.getMenuItemById(VIEW_LIBRARY_ID)!.label).toBe("Sidebar");
  });

  it("a missing menu item is a silent no-op, not a throw", () => {
    const menu = new FakeMenu(); // nothing registered at all
    expect(() => menuSync(menu as unknown as ElectronMenu, aState())).not.toThrow();
  });

  it("a menu with no matching ids at all does not throw either", () => {
    const menu = new FakeMenu();
    menu.set("totally-unrelated-id", { type: "normal", enabled: false });
    expect(() => menuSync(menu as unknown as ElectronMenu, aState())).not.toThrow();
  });

  it("ignores an item whose type is neither checkbox nor normal, rather than misinterpreting it", () => {
    const menu = new FakeMenu();
    // Simulates a row somehow backed by a submenu/separator item at one of
    // our own gated ids — should never happen given ids_are_unique, but the
    // Rust source's exhaustive match falls through with `_ => {}` for this
    // case, and this pins the TS port to the same silent no-op.
    menu.set(NEW_ID, { type: "submenu", enabled: false });
    menuSync(menu as unknown as ElectronMenu, aState());
    expect(menu.getMenuItemById(NEW_ID)!.enabled).toBe(false);
  });

  it("leaves an unexpected checkbox row unchanged when no checked payload exists for it", () => {
    const menu = new FakeMenu();
    menu.set(NEW_ID, { type: "checkbox", checked: true, enabled: false });

    menuSync(menu as unknown as ElectronMenu, aState());

    expect(menu.getMenuItemById(NEW_ID)).toMatchObject({ checked: true, enabled: false });
  });
});

// Section-id constants are exercised implicitly by every `rowsOf(...)` call
// above; this pins their literal values directly, matching the Rust
// source's own string literals ("app", "file", "edit", "view", "window").
describe("section id constants", () => {
  it("match the Rust source's literal section ids", () => {
    expect(APP_ID).toBe("app");
    expect(FILE_ID).toBe("file");
    expect(EDIT_ID).toBe("edit");
    expect(VIEW_ID).toBe("view");
    expect(WINDOW_ID).toBe("window");
  });
});
