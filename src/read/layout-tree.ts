/**
 * A screen's layout from the elements its code writes, the same way for every framework: each element becomes a node
 * by its kind, a wrapper that only styles gives way to what it holds, and each node gets an id from its path.
 */

import type { FrameworkId } from "../scan/types.js";
import type { ReadingNotes } from "./reading-notes.js";
import type { LayoutKind, LayoutNode } from "./schema.js";

/** An element as a framework's code writes it, from where its name starts to where it ends. */
export interface Element {
  /** The name it's built by (`VStack`, `Column`, `Animated.View`), or empty for one a reader knows the kind of. */
  name: string;
  start: number;
  end: number;
  /** The kind a reader knows it is (an `if`, a loop, a toolbar), else read from its name. */
  kind?: LayoutKind | "group";
  /** Its kind when a wrapper holds more than one element: a row or a column. */
  holding?: LayoutKind;
  children: Element[];
  /** A conditional's branches, or a repeat's item, each the elements it writes. */
  branches?: Element[][];
}

/** What an element is, by its name: a kind; `group`, which adds nothing, so its children take its place; `wrapper`,
 * which only styles one child, or lays out several; `backdrop`, an image other elements may be laid over; or `drop`,
 * written in the layout but not shown in it. */
type Entry = LayoutKind | "group" | "wrapper" | "drop" | "backdrop";

/** Kinds that hold no nodes: what's inside one is part of it. */
const LEAVES = new Set<LayoutKind>(["text", "button", "image", "input", "spacer", "other"]);

const entries = (kind: Entry, names: string) => names.split(" ").map((name) => [name, kind] as const);

const SWIFTUI = new Map<string, Entry>([
  ...entries("stack-v", "VStack"),
  ...entries("stack-h", "HStack GridRow LabeledContent"),
  ...entries("stack-z", "ZStack"),
  ...entries("grid", "Grid"),
  ...entries("list", "List"),
  ...entries("lazy-list", "LazyVStack LazyHStack"),
  ...entries("lazy-grid", "LazyVGrid LazyHGrid"),
  ...entries("scroll", "ScrollView"),
  ...entries("tabs", "TabView"),
  ...entries("nav", "NavigationStack NavigationView NavigationSplitView"),
  ...entries("form", "Form"),
  ...entries("section", "Section DisclosureGroup"),
  ...entries("text", "Text Label"),
  ...entries("button", "Button NavigationLink Link Menu ShareLink EditButton PasteButton RenameButton"),
  ...entries("image", "Image AsyncImage"),
  ...entries("input", "TextField SecureField TextEditor Toggle Slider Picker Stepper DatePicker ColorPicker"),
  ...entries("spacer", "Spacer"),
  ...entries(
    "group",
    "Group AnyView GeometryReader ViewThatFits ScrollViewReader ToolbarItem ToolbarItemGroup TimelineView Tab TabSection",
  ),
  // Code run, not shown: `Task { await load() }` in a block.
  ...entries("drop", "EmptyView Task"),
]);

const COMPOSE = new Map<string, Entry>([
  ...entries("stack-v", "Column"),
  ...entries("stack-h", "Row ListItem"),
  ...entries("wrapper", "Box BoxWithConstraints"),
  ...entries("grid", "FlowRow FlowColumn"),
  ...entries("lazy-list", "LazyColumn LazyRow HorizontalPager VerticalPager"),
  ...entries(
    "lazy-grid",
    "LazyVerticalGrid LazyHorizontalGrid LazyVerticalStaggeredGrid LazyHorizontalStaggeredGrid",
  ),
  ...entries("tabs", "TabRow ScrollableTabRow PrimaryTabRow SecondaryTabRow"),
  ...entries("nav", "Scaffold NavHost"),
  ...entries(
    "toolbar",
    "TopAppBar CenterAlignedTopAppBar MediumTopAppBar LargeTopAppBar BottomAppBar NavigationBar NavigationRail",
  ),
  ...entries("text", "Text"),
  ...entries(
    "button",
    "Button TextButton OutlinedButton ElevatedButton FilledTonalButton IconButton FilledIconButton OutlinedIconButton IconToggleButton FloatingActionButton SmallFloatingActionButton LargeFloatingActionButton ExtendedFloatingActionButton Tab LeadingIconTab NavigationBarItem NavigationRailItem FilterChip AssistChip InputChip SuggestionChip",
  ),
  ...entries("image", "Image Icon AsyncImage SubcomposeAsyncImage GlideImage"),
  ...entries(
    "input",
    "TextField OutlinedTextField BasicTextField SearchBar DockedSearchBar Checkbox TriStateCheckbox Switch Slider RangeSlider RadioButton ExposedDropdownMenuBox",
  ),
  ...entries("spacer", "Spacer"),
  ...entries(
    "group",
    "Surface Card ElevatedCard OutlinedCard MaterialTheme CompositionLocalProvider AnimatedVisibility AnimatedContent Crossfade ProvideTextStyle SelectionContainer TooltipBox",
  ),
  // Effects run code when the view appears and show nothing; dialogs and menus open over the screen, not in it.
  ...entries(
    "drop",
    "LaunchedEffect DisposableEffect SideEffect LifecycleEventEffect LifecycleStartEffect LifecycleResumeEffect BackHandler AlertDialog BasicAlertDialog Dialog DropdownMenu ModalBottomSheet",
  ),
]);

/** React Native's elements, and a web build's (`div`, `span`) in an app built for the web as well. */
const REACT_NATIVE = new Map<string, Entry>([
  ...entries(
    "wrapper",
    "View SafeAreaView KeyboardAvoidingView Animated.View LinearGradient BlurView MaskedView div",
  ),
  ...entries("scroll", "ScrollView KeyboardAwareScrollView Animated.ScrollView"),
  ...entries("lazy-list", "FlatList SectionList FlashList VirtualizedList Animated.FlatList"),
  ...entries("text", "Text Animated.Text span p h1 h2 h3 label"),
  ...entries(
    "button",
    "Button Pressable TouchableOpacity TouchableHighlight TouchableWithoutFeedback TouchableNativeFeedback Link button a",
  ),
  ...entries("image", "Image FastImage Animated.Image Svg img"),
  ...entries("backdrop", "ImageBackground"),
  ...entries("input", "TextInput Switch Slider input textarea select"),
  ...entries("group", "Fragment React.Fragment GestureDetector"),
  ...entries("drop", "Modal StatusBar"),
]);

const TABLES: Record<FrameworkId, ReadonlyMap<string, Entry>> = {
  swiftui: SWIFTUI,
  compose: COMPOSE,
  "react-native": REACT_NATIVE,
};

/** What a JSX tag of a navigator is: `Tab.Navigator` lays out tabs, `Stack.Screen` only configures one. */
function navigatorEntry(name: string): Entry | undefined {
  if (name.endsWith(".Navigator")) return /tab/i.test(name) ? "tabs" : "nav";
  if (name.endsWith(".Screen") || name.endsWith(".Group")) return "drop";
  return undefined;
}

/** How a layout is read: the framework's names, where each element is written, and the app's view a name places. */
export interface Building {
  framework: FrameworkId;
  span: (start: number, end: number) => LayoutNode["span"];
  /** The id of the app's view `name` places here, written from `at.start` to `at.end`, or undefined when it's not one
   * of the app's. */
  viewNamed: (name: string, at: { start: number; end: number }) => string | undefined;
  /** The framework's own name a local one stands for: `Text` for `Label` in `import { Text as Label }`. */
  builtIn?: (name: string) => string | undefined;
  /** Where what may be wrong in the layout is noted: an element no table names. */
  notes?: ReadingNotes;
}

type Node = Omit<LayoutNode, "id" | "children"> & { children: Node[] };

/** The nodes `elements` make, in order: a group's or a styling wrapper's children in its place. */
function nodesOf(building: Building, elements: Element[]): Node[] {
  return elements.flatMap((element) => nodesOfOne(building, element));
}

function nodesOfOne(building: Building, element: Element): Node[] {
  const span = building.span(element.start, element.end);
  const node = (kind: LayoutKind, children: Node[], ref?: string): Node[] => [
    { kind, span, ...(ref !== undefined && { ref }), children: LEAVES.has(kind) ? [] : children },
  ];
  // What a leaf holds is part of it, so it isn't read, nor noted: a button's label, an unknown element's content.
  const childrenFor = (kind: LayoutKind) => {
    if (!LEAVES.has(kind)) return nodesOf(building, element.children);
    for (const child of element.children) building.notes?.drop(child.start, child.end);
    return [];
  };
  if (element.kind === "conditional" || element.kind === "repeat")
    return node(
      element.kind,
      (element.branches ?? []).flatMap((branch) => {
        const one = oneNode(building, branch);
        return one ? [one] : [];
      }),
    );
  if (element.kind === "group") return nodesOf(building, element.children);
  // The app's own view of a name is that view, whatever its name would make it (an app's `FlatList`).
  const ref = element.name ? building.viewNamed(element.name, element) : undefined;
  if (ref !== undefined) return node("view-ref", nodesOf(building, element.children), ref);
  if (element.kind) return node(element.kind, childrenFor(element.kind));
  const name = building.builtIn?.(element.name) ?? element.name;
  const known =
    TABLES[building.framework].get(name) ??
    (building.framework === "react-native" ? navigatorEntry(name) : undefined);
  if (known === undefined && name)
    building.notes?.issue({ kind: "unknown-element", start: element.start, end: element.end, detail: name });
  const entry = known ?? "other";
  if (entry === "drop") return [];
  if (entry !== "group" && entry !== "backdrop" && entry !== "wrapper")
    return node(entry, childrenFor(entry));
  const children = nodesOf(building, element.children);
  if (entry === "group") return children;
  // An image holding content (`ImageBackground`) lays it over the image.
  if (entry === "backdrop")
    return children.length === 0
      ? node("image", [])
      : node("stack-z", [{ kind: "image", span, children: [] }, ...children]);
  // A wrapper around one element only styles it; around none, it's an element of its own.
  if (children.length === 1) return children;
  return node(children.length === 0 ? "other" : (element.holding ?? "stack-z"), children);
}

/** A branch's or an item's one node: its element's, or, for several, an `other` holding them. */
function oneNode(building: Building, elements: Element[]): Node | undefined {
  const nodes = nodesOf(building, elements);
  if (nodes.length <= 1) return nodes[0];
  // A view property read in place may be written before the code placing it, so its span is the nodes' widest.
  const start = nodes.reduce((least, n) => Math.min(least, n.span.start), Number.POSITIVE_INFINITY);
  const end = nodes.reduce((most, n) => Math.max(most, n.span.end), 0);
  return { kind: "other", span: building.span(start, end), children: nodes };
}

/** Each node with its id: its parent's path, then its kind, numbered after the first of its kind among its siblings. */
function withIds(node: Node, id: string): LayoutNode {
  const seen = new Map<LayoutKind, number>();
  const children = node.children.map((child) => {
    const count = seen.get(child.kind) ?? 0;
    seen.set(child.kind, count + 1);
    const own = count === 0 ? child.kind : `${child.kind}.${count}`;
    return withIds(child, id ? `${id}/${own}` : own);
  });
  return { id, kind: node.kind, span: node.span, ...(node.ref !== undefined && { ref: node.ref }), children };
}

/** The layout of the screen `ref`, declared from `start` to `end`, whose code writes `elements`: the screen itself,
 * with the id "", holding the nodes they make. */
export function layoutTree(
  building: Building,
  screen: { ref: string; start: number; end: number },
  elements: Element[],
): LayoutNode {
  // A function written as an expression ends where its last element does, past what its declaration covers.
  const end = elements.reduce((most, e) => Math.max(most, e.end), screen.end);
  return withIds(
    {
      kind: "view-ref",
      span: building.span(screen.start, end),
      ref: screen.ref,
      children: nodesOf(building, elements),
    },
    "",
  );
}
