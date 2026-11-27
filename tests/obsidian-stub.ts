/**
 * A minimal but honest stand-in for the parts of the Obsidian API this plugin
 * touches. Used only by the headless smoke test, which runs the real onload().
 *
 * It records every registration so the test can assert on them, and keeps an
 * in-memory vault so note round trips can be exercised for real.
 */

export interface Registered {
  commands: any[];
  views: Map<string, Function>;
  extensions: Map<string, string>;
  codeBlocks: Map<string, Function>;
  postProcessors: Function[];
  settingsTabs: any[];
  ribbon: any[];
  statusBar: any[];
  events: Array<{ name: string; fn: Function }>;
  domEvents: Array<{ type: string; fn: Function }>;
  viewSwitches: any[];
  activeLeafSwitches: any[];
  cleanups: Function[];
  editorExtensions: any[];
}

export interface Harness {
  registered: Registered;
  files: Map<string, string>;
  folders: Set<string>;
  notices: string[];
  /**
   * Paths whose `remove` fails with EBUSY, modelling a file a sync client or a
   * virus scanner still holds open. Windows keeps such a name delete-pending,
   * so the name stays taken until the handle closes - the exact condition that
   * used to make every later save fail with "Destination file already exists!".
   */
  stuckPaths: Set<string>;
  app: any;
}

/**
 * The exported classes must record into the harness created for the current
 * test, not the one that happened to exist at module load time. A module level
 * pointer set by buildHarness() keeps the classes stateless.
 */
let activeHarness: Harness | null = null;

export function active(): Harness {
  if (!activeHarness) throw new Error("No harness built yet");
  return activeHarness;
}

/**
 * T-classes MUST live at module scope so every harness and the production
 * `instanceof TFile` check share one class identity. If they were rebuilt
 * inside buildHarness(), each call creates a different class and instanceof
 * silently returns false, disabling every file-type guard.
 */
export class TAbstractFile {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  constructor(path: string) {
    super(path);
    this.basename = path.split("/").pop()!.replace(/\.[^.]+$/, "");
    this.extension = path.split(".").pop()!;
  }
}

export class TFolder extends TAbstractFile {}

export function createEl(): any {
  const el: any = {
    tag: "div",
    children: [] as any[],
    classes: new Set<string>(),
    text: "",
    attrs: {} as Record<string, string>,
    value: "",
    checked: false,
    style: {},
    empty() {
      this.children = [];
      this.text = "";
    },
    createEl(tag: string, opts: any = {}) {
      const child = createEl();
      child.tag = tag;
      if (opts.text) child.text = opts.text;
      if (opts.cls) String(opts.cls).split(" ").forEach((c: string) => child.classes.add(c));
      if (opts.type) child.type = opts.type;
      this.children.push(child);
      return child;
    },
    createDiv(opts: any = {}) {
      return this.createEl("div", opts);
    },
    createSpan(opts: any = {}) {
      return this.createEl("span", opts);
    },
    appendChild(c: any) {
      this.children.push(c);
      return c;
    },
    addClass(c: string) {
      this.classes.add(c);
    },
    removeClass(c: string) {
      this.classes.delete(c);
    },
    toggleClass() {},
    setText(t: string) {
      this.text = t;
    },
    getText() {
      return this.text;
    },
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    appendText(t: string) {
      this.text += t;
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    click() {},
  };
  return el;
}

export function buildHarness(): { obsidian: any; harness: Harness } {
  const registered: Registered = {
    commands: [],
    views: new Map(),
    extensions: new Map(),
    codeBlocks: new Map(),
    postProcessors: [],
    settingsTabs: [],
    ribbon: [],
    statusBar: [],
    events: [],
    domEvents: [],
    viewSwitches: [],
    activeLeafSwitches: [],
    cleanups: [],
    editorExtensions: [],
  };

  const files = new Map<string, string>();
  const folders = new Set<string>();
  const notices: string[] = [];

  const adapter = {
    exists: async (p: string) => files.has(p) || folders.has(p),
    read: async (p: string) => {
      if (!files.has(p)) throw new Error("ENOENT: " + p);
      return files.get(p)!;
    },
    write: async (p: string, data: string) => {
      files.set(p, data);
    },
    rename: async (from: string, to: string) => {
      const v = files.get(from);
      if (v === undefined) throw new Error("ENOENT: " + from);
      // Obsidian's DataAdapter refuses to clobber an existing destination (it
      // checks first and throws this exact message). The stub used to allow it,
      // which is why a write path that renamed onto an existing file passed
      // 109 tests while failing on every real save.
      if (from !== to && (files.has(to) || folders.has(to))) {
        throw new Error("Destination file already exists!");
      }
      files.delete(from);
      files.set(to, v);
    },
    mkdir: async (p: string) => {
      folders.add(p);
    },
    list: async (dir: string) => ({
      files: [...files.keys()].filter((f) => f.startsWith(dir + "/")),
      folders: [],
    }),
    remove: async (p: string) => {
      if (active().stuckPaths.has(p)) throw new Error(`EBUSY: resource busy or locked, unlink '${p}'`);
      files.delete(p);
    },
  };

  const harness: Harness = { registered, files, folders, notices, stuckPaths: new Set(), app: null as any };

  const app: any = {
    vault: {
      on: (name: string, fn: Function) => {
        active().registered.events.push({ name: `vault:${name}`, fn });
        return { name, fn };
      },
      getName: () => "TestVault",
      adapter,
      getAbstractFileByPath: (p: string) =>
        files.has(p) ? new TFile(p) : folders.has(p) ? new TFolder(p) : null,
      create: async (p: string, data: string) => {
        // Same contract as the real Vault: creating over an existing path throws.
        if (files.has(p) || folders.has(p)) throw new Error("Destination file already exists!");
        files.set(p, data);
        return new TFile(p);
      },
      rename: async (f: any, to: string) => {
        const from = typeof f === "string" ? f : f.path;
        const v = files.get(from);
        if (v === undefined) throw new Error("ENOENT: " + from);
        if (from !== to && files.has(to)) throw new Error("Destination file already exists!");
        files.delete(from);
        files.set(to, v);
      },
      createFolder: async (p: string) => {
        folders.add(p);
      },
      read: async (f: any) => files.get(f.path) ?? "",
      cachedRead: async (f: any) => files.get(f.path) ?? "",
      modify: async (f: any, data: string) => {
        if (!files.has(f.path)) throw new Error("ENOENT: " + f.path);
        files.set(f.path, data);
      },
      getFiles: () => [...files.keys()].map((p) => new TFile(p)),
      getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith(".md")).map((p) => new TFile(p)),
    },
    workspace: {
      activePath: null as string | null,
      getActiveFile: function () {
        const p = this.activePath;
        return p ? { path: p, basename: p.split("/").pop()!.replace(/\.[^.]+$/, ""), extension: p.split(".").pop() } : null;
      },
      // Tests call this explicitly to simulate the user switching notes.
      setActiveFile: function (p: string | null) {
        this.activePath = p;
      },
      triggerActiveLeafChange: function () {
        for (const e of active().registered.events) {
          if (e.name === "active-leaf-change") e.fn();
        }
      },
      // Closing or opening a tab fires layout-change in the real app; tests
      // fire it after mutating markdownLeaves to simulate a tab close.
      triggerLayoutChange: function () {
        for (const e of active().registered.events) {
          if (e.name === "layout-change") e.fn();
        }
      },
      triggerFileOpen: function (p: string | null) {
        const file = p === null ? null : { path: p, basename: p.split("/").pop()!.replace(/\.[^.]+$/, "") };
        for (const e of active().registered.events) {
          if (e.name === "file-open") e.fn(file);
        }
      },
      leafOpens: [] as any[],
      activeLeafIsSide: false as boolean,
      rootSplit: { kind: "root" },
      leftSplit: { kind: "left" },
      rightSplit: { kind: "right" },
      getLeaf: (mode?: any) => {
        active().app.workspace.leafOpens.push({ kind: "getLeaf", mode });
        return {
          openFile: async (f: any) => {
            active().registered.viewSwitches.push({ type: "markdown", state: { file: f?.path ?? f } });
          },
          parent: active().app.workspace.rootSplit,
          getRoot: () => active().app.workspace.rootSplit,
          setViewState: async (state: any) => {
            active().registered.viewSwitches.push(state);
          },
        };
      },
      activeLeaf: {
        view: { getViewType: () => "markdown" },
        get parent() {
          const ws = active().app.workspace;
          return ws.activeLeafIsSide ? ws.leftSplit : ws.rootSplit;
        },
        getRoot: function () {
          const ws = active().app.workspace;
          return ws.activeLeafIsSide ? ws.leftSplit : ws.rootSplit;
        },
        setViewState: async (state: any) => {
          active().registered.viewSwitches.push(state);
          active().registered.activeLeafSwitches.push(state);
        },
      },
      getActiveViewOfType: (type: any) => {
        // Only a Markdown view can be faked (tests need a caret target); the
        // padlock view has no stub instance, so it still answers null. Matched
        // by name, and loosely: the plugin and the test are separate bundles,
        // so esbuild renames the class (MarkdownView2) and class identity is
        // useless across the boundary.
        const md = active().app.workspace.mdView;
        if (!md) return null;
        return String(type?.name ?? "").includes("MarkdownView") ? md : null;
      },
      /** Set by a test that wants to assert where the caret landed. */
      mdView: null as any,
      markdownLeaves: [] as any[],
      sealedLeaves: [] as any[],
      getLeavesOfType: function (type: string) {
        if (type === "markdown") return active().app.workspace.markdownLeaves;
        if (type === "sealed-note-view") return active().app.workspace.sealedLeaves;
        return [];
      },
      // The real API walks every leaf in the workspace; the sweep for closed
      // tabs (the "close" lock policy) is built on it, so the stub must be
      // able to answer "is this leaf still alive?" and "which leaf shows this
      // file?". Tests mutate markdownLeaves/sealedLeaves to open or close
      // tabs, and this walks the same arrays.
      iterateAllLeaves: function (cb: Function) {
        for (const leaf of [...this.markdownLeaves, ...this.sealedLeaves]) cb(leaf);
      },
      on: (name: string, fn: Function) => {
        active().registered.events.push({ name, fn });
        return { name, fn };
      },
    },
  };

  class Plugin {
    manifest = { id: "sealed-note", version: "1.0.0", dir: ".obsidian/plugins/sealed-note" };
    app: any;
    private data: unknown = null;
    constructor() {
      this.app = app;
    }
    async loadData() {
      return this.data;
    }
    async saveData(d: unknown) {
      this.data = JSON.parse(JSON.stringify(d));
    }
    addCommand(cmd: any) {
      active().registered.commands.push(cmd);
      return cmd;
    }
    registerView(type: string, factory: Function) {
      active().registered.views.set(type, factory);
    }
    registerExtensions(exts: string[], type: string) {
      for (const e of exts) active().registered.extensions.set(e, type);
    }
    registerMarkdownCodeBlockProcessor(lang: string, handler: Function) {
      active().registered.codeBlocks.set(lang, handler);
    }
    registerMarkdownPostProcessor(fn: Function) {
      active().registered.postProcessors.push(fn);
    }
    registerEvent(ref: any) {
      return ref;
    }
    register(fn: Function) {
      active().registered.cleanups.push(fn);
    }
    registerEditorExtension(exts: any) {
      active().registered.editorExtensions.push(exts);
    }
    registerDomEvent(_target: any, type: string, fn: Function) {
      active().registered.domEvents.push({ type, fn });
    }
    registerInterval(id: number) {
      return id;
    }
    addSettingTab(tab: any) {
      active().registered.settingsTabs.push(tab);
    }
    addRibbonIcon(_icon: string, title: string, cb: Function) {
      const el = createEl();
      active().registered.ribbon.push({ title, cb, el });
      return el;
    }
    addStatusBarItem() {
      const el = createEl();
      active().registered.statusBar.push(el);
      return el;
    }
  }

  class Modal {
    app: any;
    contentEl = createEl();
    constructor(app: any) {
      this.app = app;
    }
    open() {}
    close() {}
  }

  class Setting {
    settingEl = createEl();
    constructor(containerEl: any) {
      containerEl?.children?.push(this.settingEl);
    }
    setName() {
      return this;
    }
    setDesc() {
      return this;
    }
    setHeading() {
      return this;
    }
    setClass() {
      return this;
    }
    addText(cb: Function) {
      const comp: any = {
        inputEl: createEl(),
        setPlaceholder: () => comp,
        setValue: () => comp,
        getValue: () => "",
        onChange: () => comp,
        setDisabled: () => comp,
      };
      cb(comp);
      return this;
    }
    addToggle(cb: Function) {
      const comp: any = { setValue: () => comp, onChange: () => comp, setDisabled: () => comp };
      cb(comp);
      return this;
    }
    addDropdown(cb: Function) {
      const comp: any = {
        addOptions: () => comp,
        addOption: () => comp,
        setValue: () => comp,
        onChange: () => comp,
        setDisabled: () => comp,
      };
      cb(comp);
      return this;
    }
    addButton(cb: Function) {
      const comp: any = {
        setButtonText: () => comp,
        setWarning: () => comp,
        setCta: () => comp,
        setIcon: () => comp,
        setTooltip: () => comp,
        setDisabled: () => comp,
        onClick: () => comp,
      };
      cb(comp);
      return this;
    }
    addExtraButton(cb: Function) {
      const comp: any = { setIcon: () => comp, setTooltip: () => comp, onClick: () => comp };
      cb(comp);
      return this;
    }
  }

  class PluginSettingTab {
    app: any;
    plugin: any;
    containerEl = createEl();
    constructor(app: any, plugin: any) {
      this.app = app;
      this.plugin = plugin;
    }
  }

  class FileView {
    app: any;
    leaf: any;
    contentEl = createEl();
    file: any = null;
    constructor(leaf: any, lib?: any) {
      this.leaf = leaf;
      this.app = lib ?? app;
    }
    addAction() {}
    async onLoadFile() {}
    async onUnloadFile() {}
  }

  class ItemView extends FileView {}
  class MarkdownView extends FileView {}

  // TAbstractFile/TFile/TFolder now live at true module scope above (shared
  // class identity with production `instanceof` checks).

  class Notice {
    constructor(message: string) {
      active().notices.push(String(message));
    }
  }

  class Menu {
    items: any[] = [];
    addItem(cb: Function) {
      const item: any = {
        title: "",
        setTitle: (value: string) => {
          item.title = value;
          return item;
        },
        setIcon: () => item,
        setSection: () => item,
        setChecked: () => item,
        onClick: () => item,
      };
      cb(item);
      return this;
    }
    addSeparator() {
      return this;
    }
    showAtMouseEvent() {}
    showAtPosition() {}
  }

  const obsidian = {
    Plugin,
    Modal,
    Setting,
    PluginSettingTab,
    FileView,
    ItemView,
    MarkdownView,
    TAbstractFile,
    TFile,
    TFolder,
    Notice,
    Menu,
    normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
    setIcon: () => undefined,
    parseYaml: () => ({}),
  };

  harness.app = app;
  activeHarness = harness;
  return { obsidian, harness };
}

/* ------------------------------------------------------------------ */
/* named exports                                                       */
/*                                                                     */
/* The plugin imports these by name, so the stub must expose them as    */
/* real exports (not just properties of a namespace object).           */
/* ------------------------------------------------------------------ */

const _shared = buildHarness();
export const Plugin = (_shared.obsidian as any).Plugin;
export const Modal = (_shared.obsidian as any).Modal;
export const Setting = (_shared.obsidian as any).Setting;
export const PluginSettingTab = (_shared.obsidian as any).PluginSettingTab;
export const FileView = (_shared.obsidian as any).FileView;
export const ItemView = (_shared.obsidian as any).ItemView;
export const MarkdownView = (_shared.obsidian as any).MarkdownView;
// TAbstractFile/TFile/TFolder are exported as real module-scope classes
// above; do NOT re-derive them from a harness build (that would create a
// second class identity and break production instanceof checks).
export const Notice = (_shared.obsidian as any).Notice;
export const Menu = (_shared.obsidian as any).Menu;
export const normalizePath = (_shared.obsidian as any).normalizePath;
export const getLanguage = (): string => "en";
export const setIcon = (_shared.obsidian as any).setIcon;
export const parseYaml = (_shared.obsidian as any).parseYaml;
