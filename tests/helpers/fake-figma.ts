/** A small stand-in for the Figma plugin API: only what Designlane's plugin touches, with the limits and failures a
 * real file can have (a Figma plan's mode limit, a font that won't load). */

function sharedData() {
  const data = new Map<string, string>();
  return {
    getSharedPluginData: (namespace: string, key: string) => data.get(`${namespace}/${key}`) ?? "",
    setSharedPluginData: (namespace: string, key: string, value: string) =>
      void data.set(`${namespace}/${key}`, value),
  };
}

/** A page, frame, shape or text in the fake file: what the plugin sets on it is kept to read back. */
export class FakeNode {
  name = "";
  characters = "";
  fills: unknown;
  cornerRadius = 0;
  fontName: unknown;
  fontSize = 12;
  layoutMode = "NONE";
  layoutWrap = "NO_WRAP";
  itemSpacing = 0;
  counterAxisSpacing = 0;
  primaryAxisSizingMode = "AUTO";
  counterAxisSizingMode = "AUTO";
  counterAxisAlignItems = "MIN";
  layoutPositioning = "AUTO";
  clipsContent = true;
  paddingTop = 0;
  paddingRight = 0;
  paddingBottom = 0;
  paddingLeft = 0;
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  children: FakeNode[] = [];
  parent: FakeNode | undefined;
  /** The mode each collection is shown in here, by the collection's id. */
  explicitModes: Record<string, string> = {};
  textStyleId = "";
  private readonly data = new Map<string, string>();

  constructor(readonly type: string) {}

  getSharedPluginData(namespace: string, key: string) {
    return this.data.get(`${namespace}/${key}`) ?? "";
  }
  setSharedPluginData(namespace: string, key: string, value: string) {
    this.data.set(`${namespace}/${key}`, value);
  }
  /** The plugin's own data, which other plugins can't read: kept apart from every namespace's. */
  getPluginData(key: string) {
    return this.data.get(`\0own/${key}`) ?? "";
  }
  setPluginData(key: string, value: string) {
    this.data.set(`\0own/${key}`, value);
  }
  appendChild(child: FakeNode) {
    this.insertChild(this.children.length, child);
  }
  insertChild(index: number, child: FakeNode) {
    child.remove();
    child.parent = this;
    this.children.splice(index, 0, child);
  }
  findAllWithCriteria({ sharedPluginData }: { sharedPluginData: { namespace: string; keys: string[] } }) {
    return this.descendants().filter((node) =>
      sharedPluginData.keys.some((key) => node.getSharedPluginData(sharedPluginData.namespace, key) !== ""),
    );
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = undefined;
  }
  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  setExplicitVariableModeForCollection(collection: { id: string }, modeId: string) {
    this.explicitModes[collection.id] = modeId;
  }
  async setTextStyleIdAsync(styleId: string) {
    this.textStyleId = styleId;
  }
  async loadAsync() {}
  /** Every node under this one, depth first. */
  descendants(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

export interface FakeOptions {
  /** How many modes a collection may have, as on Figma's plans. */
  maxModes?: number;
  /** Font families installed in the file. */
  fonts?: Record<string, string[]>;
  /** Families whose fonts fail to load. */
  unloadable?: string[];
}

function fakeFigma({
  maxModes = 4,
  fonts = { Inter: ["Regular"], "SF Pro": ["Regular", "Medium", "Semibold", "Bold"] },
  unloadable = [],
}: FakeOptions = {}) {
  const installed = { ...fonts };
  /** What the plugin keeps on this computer, as `figma.clientStorage`. */
  const stored = new Map<string, unknown>();
  let next = 1;
  const id = (prefix: string) => `${prefix}:${next++}`;
  const variables = new Map<string, ReturnType<typeof variable>>();
  const collections = new Map<string, ReturnType<typeof collection>>();
  const styles = new Map<string, ReturnType<typeof textStyle>>();

  function collection(name: string) {
    const defaultModeId = id("mode");
    const self = {
      id: id("collection"),
      name,
      defaultModeId,
      modes: [{ modeId: defaultModeId, name: "Mode 1" }],
      variableIds: [] as string[],
      ...sharedData(),
      renameMode(modeId: string, newName: string) {
        const mode = self.modes.find((mode) => mode.modeId === modeId);
        if (mode) mode.name = newName;
      },
      removeMode(modeId: string) {
        self.modes = self.modes.filter((mode) => mode.modeId !== modeId);
        if (self.defaultModeId === modeId) self.defaultModeId = self.modes[0]?.modeId ?? "";
      },
      addMode(newName: string) {
        if (self.modes.length >= maxModes) throw new Error(`Limited to ${maxModes} modes only`);
        const modeId = id("mode");
        self.modes.push({ modeId, name: newName });
        // Figma starts a new mode with each variable's value in the default mode.
        for (const variableId of self.variableIds) {
          const values = variables.get(variableId)?.valuesByMode;
          if (values) values[modeId] = values[self.defaultModeId];
        }
        return modeId;
      },
    };
    collections.set(self.id, self);
    return self;
  }

  function variable(name: string, owner: ReturnType<typeof collection>, resolvedType: "COLOR" | "FLOAT") {
    const self = {
      id: id("VariableID"),
      name,
      resolvedType,
      variableCollectionId: owner.id,
      valuesByMode: {} as Record<string, unknown>,
      scopes: [] as string[],
      description: "",
      hiddenFromPublishing: false,
      codeSyntax: {} as Record<string, string>,
      ...sharedData(),
      setValueForMode(modeId: string, value: unknown) {
        if (!owner.modes.some((mode) => mode.modeId === modeId)) throw new Error(`Invalid mode ${modeId}`);
        self.valuesByMode[modeId] = value;
      },
      removeVariableCodeSyntax(platform: string) {
        delete self.codeSyntax[platform];
      },
      setVariableCodeSyntax(platform: string, value: string) {
        self.codeSyntax[platform] = value;
      },
    };
    variables.set(self.id, self);
    owner.variableIds.push(self.id);
    return self;
  }

  /** Figma changes a style's font only with the new one loaded, and its size only with its font loaded. */
  const loaded = new Set<string>();
  const fontKey = ({ family, style }: { family: string; style: string }) => `${family}/${style}`;

  function textStyle() {
    let fontName = { family: "Inter", style: "Regular" };
    let fontSize = 12;
    const self = {
      id: id("S"),
      type: "TEXT" as const,
      name: "",
      description: "",
      /** How often the font was set, which in Figma resets a variable font's own axis settings. */
      fontSets: 0,
      get fontName() {
        return fontName;
      },
      set fontName(value) {
        if (!loaded.has(fontKey(value))) throw new Error(`${fontKey(value)} isn't loaded`);
        fontName = value;
        self.fontSets++;
      },
      get fontSize() {
        return fontSize;
      },
      set fontSize(value) {
        if (!loaded.has(fontKey(fontName))) throw new Error(`${fontKey(fontName)} isn't loaded`);
        fontSize = value;
      },
      ...sharedData(),
    };
    styles.set(self.id, self);
    return self;
  }

  const root = new FakeNode("DOCUMENT");
  const api = {
    root,
    createPage: () => {
      const page = new FakeNode("PAGE");
      root.appendChild(page);
      return page;
    },
    createFrame: () => new FakeNode("FRAME"),
    createRectangle: () => new FakeNode("RECTANGLE"),
    createText: () => new FakeNode("TEXT"),
    variables: {
      getLocalVariableCollectionsAsync: async () => [...collections.values()],
      getVariableByIdAsync: async (key: string) => variables.get(key) ?? null,
      getVariableCollectionByIdAsync: async (key: string) => collections.get(key) ?? null,
      createVariableCollection: collection,
      createVariable: variable,
      setBoundVariableForPaint: (paint: object, field: string, bound: { id: string }) => ({
        ...paint,
        boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: bound.id } },
      }),
    },
    getLocalTextStylesAsync: async () => [...styles.values()],
    getStyleByIdAsync: async (key: string) => styles.get(key) ?? null,
    createTextStyle: textStyle,
    listAvailableFontsAsync: async () =>
      Object.entries(installed).flatMap(([family, names]) =>
        names.map((style) => ({ fontName: { family, style } })),
      ),
    closePlugin: () => {},
    clientStorage: {
      getAsync: async (key: string) => stored.get(key),
      setAsync: async (key: string, value: unknown) => void stored.set(key, value),
      deleteAsync: async (key: string) => void stored.delete(key),
    },
    loadFontAsync: async (font: { family: string; style: string }) => {
      if (unloadable.includes(font.family)) throw new Error(`could not load ${font.family}`);
      loaded.add(fontKey(font));
    },
  };
  /** Uninstalls a font family, as when a file opens on a machine without it. */
  const removeFamily = (family: string) => {
    delete installed[family];
  };
  return { api, variables, collections, styles, stored, root, removeFamily };
}

/** Installs a fake as the `figma` global for the code under test, returning it to inspect. */
export function useFakeFigma(options?: FakeOptions) {
  const fake = fakeFigma(options);
  Object.assign(globalThis, { figma: fake.api });
  return fake;
}
