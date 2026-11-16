import { describe, expect, it } from "vitest";
import { toDesignMd } from "../../src/output/design-md.js";
import { namedLinks } from "../../src/output/screen-links.js";
import { scanRepo } from "../../src/scan/index.js";
import { scanNotes } from "../../src/scan/notes.js";
import { speedIt } from "../helpers/speed.js";
import { tempDir } from "../helpers/temp.js";

const IMPORTS = "import androidx.compose.runtime.Composable\n";

async function app(files: Record<string, string>) {
  const scan = await scanRepo(
    await tempDir(Object.fromEntries(Object.entries(files).map(([f, t]) => [f, IMPORTS + t]))),
  );
  const compose = scan.frameworks.find((f) => f.framework === "compose");
  if (!compose) throw new Error("no Compose found");
  const kindOf = (name: string) => compose.screens.find((s) => s.name === name)?.kind;
  const links = namedLinks([compose]).map((l) => `${l.fromName} -> ${l.toName} (${l.opening})`);
  return { scan, compose, kindOf, links };
}

/** A view with nothing page-like about it, so only how the app opens it can make it a screen. */
const plain = (name: string) => `@Composable fun ${name}(onOpen: () -> Unit = {}) { Text("x") }\n`;

describe("Compose screens from Navigation Compose", () => {
  it("makes each destination's view a screen, and links what its block opens, dialogs included", async () => {
    const { kindOf, links } = await app({
      "app/Views.kt": plain("Inbox") + plain("Thread") + plain("Compose") + plain("Avatar"),
      "app/Nav.kt": [
        "@Composable fun AppNav() {",
        "  NavHost(navController, startDestination = InboxRoute) {",
        "    composable<InboxRoute> { Inbox(onOpen = { navController.navigate(ThreadRoute(id)) }) }",
        "    composable<ThreadRoute> { Thread(onOpen = { navController.navigate(ComposeRoute) { popUpTo(InboxRoute) } }) }",
        "    dialog<ComposeRoute> { Compose() }",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(["Inbox", "Thread", "Compose"].map(kindOf)).toEqual(["screen", "screen", "screen"]);
    expect(kindOf("Avatar")).toBe("component");
    expect(links).toEqual(["Inbox -> Thread (push)", "Thread -> Compose (dialog)"]);
  });

  it("reads string routes, constants in templates, an app's own wrapper, and navigate helpers", async () => {
    const { links, kindOf } = await app({
      "app/Views.kt": plain("Home") + plain("Detail"),
      "app/Nav.kt": [
        'object Routes { const val HOME = "home"; const val DETAIL = "detail" }',
        "fun NavGraphBuilder.composableWithFade(route: String, content: @Composable () -> Unit) { composable(route) { content() } }",
        "class AppNavigator(val nav: NavController) {",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a Kotlin string template, not a JavaScript one.
        '  fun openDetail(id: Long) { nav.navigate("${Routes.DETAIL}/$id") }',
        "}",
        "@Composable fun AppNav(navigator: AppNavigator) {",
        "  NavHost(nav, startDestination = Routes.HOME) {",
        "    composableWithFade(route = Routes.HOME) { Home(onOpen = navigator::openDetail) }",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a Kotlin string template, not a JavaScript one.
        '    composableWithFade("${Routes.DETAIL}/{id}") { Detail() }',
        '    composable("settings") { }',
        "  }",
        "}",
      ].join("\n"),
    });
    expect([kindOf("Home"), kindOf("Detail")]).toEqual(["screen", "screen"]);
    expect(links).toEqual(["Home -> Detail (push)"]);
  });
});

describe("Compose links, read carefully", () => {
  it("reads helpers called on a receiver, and routes named by a type inside an object", async () => {
    const { links } = await app({
      "app/Views.kt": plain("List") + plain("Podcast"),
      "app/Nav.kt": [
        'sealed class Screen(val route: String) { object List : Screen("list"); object Podcast : Screen("podcast/{id}") }',
        "fun NavController.navigateToPodcast(id: String) { navigate(Screen.Podcast.createRoute(id)) }",
        "@Composable fun Nav() {",
        "  NavHost(navController, Screen.List.route) {",
        "    composable(Screen.List.route) { List(onOpen = { navController.navigateToPodcast(it) }) }",
        "    composable(Screen.Podcast.route) { Podcast() }",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(links).toEqual(["List -> Podcast (push)"]);
  });

  it("keeps a nested host's links to its own destinations, and each app's links within its module", async () => {
    const { links } = await app({
      "phone/src/main/Views.kt": plain("Main") + plain("Feed") + plain("Player"),
      "phone/src/main/Nav.kt": [
        "@Composable fun Nav() {",
        "  NavHost(nav, MainRoute) {",
        "    composable<MainRoute> {",
        "      Main()",
        "      NavHost(inner, FeedRoute) { composable<FeedRoute> { Feed(onOpen = { nav.navigate(PlayerRoute) }) } }",
        "    }",
        "    composable<PlayerRoute> { Player() }",
        "  }",
        "}",
      ].join("\n"),
      "watch/src/main/Views.kt": plain("Player") + plain("Queue"),
      "watch/src/main/Nav.kt": [
        "@Composable fun WatchNav() {",
        "  NavHost(nav, QueueRoute) {",
        "    composable<QueueRoute> { Queue(onOpen = { nav.navigate(PlayerRoute) }) }",
        "    composable<PlayerRoute> { Player() }",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(links).toEqual(["Feed -> Player (push)", "Queue -> Player (push)"]);
  });
});

describe("what isn't a link", () => {
  it("doesn't count going back, asking about the back stack, icons, or a helper merely mentioned", async () => {
    const { links } = await app({
      "app/Views.kt": plain("Home") + plain("Detail"),
      "app/Nav.kt": [
        "class Ui { fun open() { nav.navigate(Home) } }",
        "class Other { fun open() { nav.navigate(Detail) } }",
        "@Composable fun Nav() {",
        "  NavHost(nav, Home) {",
        "    composable<Home> { Home(onOpen = { open }) }",
        "    composable<Detail> {",
        "      val parent = nav.getBackStackEntry<Home>()",
        "      Detail(onOpen = { nav.popBackStack(Home, false) }, icon = Icons.Default.Home)",
        "      x.open()",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(links).toEqual([]);
  });

  it("tells nested string routes apart, and keeps the same pair of routes in two apps", async () => {
    const { links } = await app({
      "phone/src/main/Views.kt":
        plain("Settings") + plain("Notifications") + plain("Queue") + plain("Player"),
      "phone/src/main/Nav.kt": [
        "@Composable fun Nav() {",
        '  NavHost(nav, "settings") {',
        '    composable("settings") { Settings(onOpen = { nav.navigate("settings/notifications") }) }',
        '    composable("settings/notifications") { Notifications() }',
        "    composable<QueueRoute> { Queue(onOpen = { nav.navigate(PlayerRoute) }) }",
        "    composable<PlayerRoute> { Player() }",
        "  }",
        "}",
      ].join("\n"),
      "watch/src/main/Views.kt": plain("Queue") + plain("Player"),
      "watch/src/main/Nav.kt":
        "@Composable fun Nav() { NavHost(nav, QueueRoute) { composable<QueueRoute> { Queue(onOpen = { nav.navigate(PlayerRoute) }) }; composable<PlayerRoute> { Player() } } }",
    });
    expect(links).toEqual([
      "Queue -> Player (push)",
      "Settings -> Notifications (push)",
      "Queue -> Player (push)",
    ]);
  });
});

describe("Compose screens from Navigation 3", () => {
  it("reads entries, back stack additions, and callbacks passed to the function declaring an entry", async () => {
    const { links } = await app({
      "app/Views.kt": plain("Feed") + plain("Topic") + plain("Post"),
      "app/Entries.kt": [
        "fun EntryProviderScope<NavKey>.feedEntry(openPost: (String) -> Unit) {",
        "  entry<FeedKey> { Feed(onOpen = { backStack.add(TopicKey(1)) }) }",
        "}",
        "fun EntryProviderScope<NavKey>.topicEntry() { entry<TopicKey> { Topic() } }",
        "fun EntryProviderScope<NavKey>.postEntry() { entry<PostKey> { Post() } }",
      ].join("\n"),
      "app/Display.kt": [
        "@Composable fun AppDisplay() {",
        "  NavDisplay(backStack, entryProvider = entryProvider {",
        "    feedEntry(openPost = { navigator.navigate(PostKey(it), popUpTo = PopUpTo(FeedKey)) })",
        "    topicEntry()",
        "    postEntry()",
        "  })",
        "}",
      ].join("\n"),
    });
    expect(links).toEqual(["Feed -> Post (push)", "Feed -> Topic (push)"]);
  });
});

describe("Compose screens from Circuit", () => {
  it("finds screens through the app's base class, their views in UI factories, and links from presenters", async () => {
    const { kindOf, links } = await app({
      "app/Screens.kt": [
        "import com.slack.circuit.runtime.screen.Screen",
        "abstract class AppScreen : Screen",
        "object HomeScreen : AppScreen()",
        "data class DetailScreen(val id: Long) : AppScreen()",
      ].join("\n"),
      "app/Home.kt": `${plain("Home")}${plain("Detail")}`,
      "app/UiFactory.kt": [
        "fun uiFor(screen: Screen) = when (screen) {",
        "  is HomeScreen -> ui<HomeState> { state, modifier -> Home() }",
        "  is DetailScreen -> ui<DetailState> { state, modifier -> Detail() }",
        "  else -> null",
        "}",
      ].join("\n"),
      "app/HomePresenter.kt": [
        "fun presenterFor(screen: Screen, navigator: Navigator) = when (screen) { is HomeScreen -> HomePresenter(navigator) }",
        "class HomePresenter(val navigator: Navigator) { fun open(id: Long) = navigator.goTo(DetailScreen(id)) }",
      ].join("\n"),
    });
    expect([kindOf("Home"), kindOf("Detail")]).toEqual(["screen", "screen"]);
    expect(links).toEqual(["Home -> Detail (push)"]);
  });
});

describe("Navigation 3 entries written as a when", () => {
  it("reads `is Key -> NavEntry(key) { … }`", async () => {
    const { links } = await app({
      "app/Views.kt": plain("Home") + plain("Post"),
      "app/Nav.kt": [
        "@Composable fun Nav() {",
        "  NavDisplay(backStack, entryProvider = { key ->",
        "    when (key) {",
        "      is HomeKey -> NavEntry(key) { Home(onOpen = { backStack.add(PostKey) }) }",
        "      is PostKey -> NavEntry(key) { Post() }",
        "    }",
        "  })",
        "}",
      ].join("\n"),
    });
    expect(links).toEqual(["Home -> Post (push)"]);
  });
});

describe("how screens open, where the app starts, and what couldn't be tied", () => {
  it("reads panes, replacing navigation, the start screen, and navigation to a library's screen", async () => {
    const { scan, compose, links } = await app({
      "app/Views.kt": plain("Login") + plain("Topics") + plain("Topic"),
      "app/Nav.kt": [
        "@Composable fun Nav() {",
        "  val backStack = rememberNavBackStack(LoginKey)",
        "  NavDisplay(backStack, entryProvider = entryProvider {",
        "    entry<LoginKey> { Login(onOpen = { backStack.replaceAll(listOf(TopicsKey)) }) }",
        "    entry<TopicsKey>(metadata = ListDetailSceneStrategy.listPane()) { Topics(onOpen = { backStack.add(TopicKey); backStack.add(PlayerKey) }) }",
        "    entry<TopicKey>(metadata = ListDetailSceneStrategy.detailPane()) { Topic() }",
        "  })",
        "}",
      ].join("\n"),
    });
    expect(links).toEqual(["Login -> Topics (replace)", "Topics -> Topic (pane)"]);
    expect(compose.starts).toEqual(["compose:app/Views.kt#Login"]);
    expect(compose.unresolvedLinks).toBe(1);
    expect(toDesignMd(scan)).toContain(
      "How screens open each other: Login → Topics (replaces); Topics → Topic (pane beside). The app starts on Login. 1 navigation call couldn't be tied to two screens",
    );
  });

  it("starts on a host's startDestination or a Circuit back stack's first screen, and lists links in the same order every run", async () => {
    const files = {
      "app/Views.kt": plain("Home") + plain("Detail") + plain("Zebra"),
      "app/Nav.kt": [
        "@Composable fun Nav() {",
        "  NavHost(nav, startDestination = HomeRoute) {",
        "    composable<ZebraRoute> { Zebra(onOpen = { nav.navigate(HomeRoute) }) }",
        "    composable<HomeRoute> { Home(onOpen = { nav.navigate(DetailRoute); nav.navigate(ZebraRoute) }) }",
        "    composable<DetailRoute> { Detail() }",
        "  }",
        "}",
      ].join("\n"),
    };
    const first = await app(files);
    expect(first.compose.starts).toEqual(["compose:app/Views.kt#Home"]);
    expect(first.links).toEqual(["Home -> Detail (push)", "Home -> Zebra (push)", "Zebra -> Home (push)"]);
    expect((await app(files)).links).toEqual(first.links);
    const circuit = await app({
      "app/Screens.kt": "import com.slack.circuit.runtime.screen.Screen\nobject HomeScreen : Screen",
      "app/Home.kt": plain("Home"),
      "app/Ui.kt": "fun ui(s: Screen) = when (s) { is HomeScreen -> ui { Home() } }",
      "app/Main.kt": "fun main() { val backStack = rememberSaveableBackStack(listOf(HomeScreen)) }",
    });
    expect(circuit.compose.starts).toEqual(["compose:app/Home.kt#Home"]);
  });
});

describe("starts and calls that aren't navigation", () => {
  it("starts on the main graph's first screen, not every nested graph's", async () => {
    const { compose } = await app({
      "app/Views.kt": plain("Login") + plain("Home"),
      "app/Nav.kt": [
        "@Composable fun Nav() {",
        "  NavHost(nav, startDestination = MainGraph) {",
        "    navigation<AuthGraph>(startDestination = LoginRoute) { composable<LoginRoute> { Login() } }",
        "    navigation<MainGraph>(startDestination = HomeRoute) { composable<HomeRoute> { Home() } }",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(compose.starts).toEqual(["compose:app/Views.kt#Home"]);
  });

  it("doesn't take adding to a list or replacing text for navigation", async () => {
    const { compose, links } = await app({
      "app/Views.kt": [
        "@Composable fun Home(onOpen: () -> Unit = {}) { focus.add(FocusRequester()); colors.add(Color.Red) }",
        '@Composable fun Detail(route: String) { Text(route.replace("home", "Home")) }',
      ].join("\n"),
      "app/Nav.kt":
        '@Composable fun Nav() { NavHost(nav, "home") { composable("home") { Home() }; composable("detail") { Detail("x") } } }',
    });
    expect(links).toEqual([]);
    expect(compose.unresolvedLinks).toBeUndefined();
  });
});

describe("navigation written through an app's own state class", () => {
  it("follows routes held in a variable, helpers calling helpers, and a screen opening itself", async () => {
    const { links, compose } = await app({
      "app/Views.kt": plain("Discover") + plain("Podcast") + plain("Player"),
      "app/AppState.kt": [
        "class AppState(val nav: NavHostController) {",
        "  private fun navigate(screen: Screen) { nav.navigate(screen.route) }",
        "  fun navigateToDiscover() { navigate(Screen.Discover) }",
        "  fun showPodcast(uri: String) { val screen = Screen.Podcast(uri); navigate(screen) }",
        "  fun playEpisode() { navigate(Screen.Player) }",
        "  fun backToHome() { nav.popBackStack(); navigateToDiscover() }",
        "}",
      ].join("\n"),
      "app/Nav.kt": [
        "@Composable fun Nav(state: AppState) {",
        "  NavHost(state.nav, Screen.Discover.route, ) {",
        "    composable(Screen.Discover.route) { Discover(onOpen = { state.showPodcast(it) }) }",
        "    composable(Screen.Podcast.route) { Podcast(onOpen = { state.playEpisode(); state.showPodcast(other) }) }",
        "    composable(Screen.Player.route) { Player(onOpen = { state.backToHome() }) }",
        "  }",
        "}",
      ].join("\n"),
      "app/Main.kt":
        "@Composable fun App() { val navigationState = rememberNavigationState(startKey = Screen.Discover) }",
    });
    expect(links).toEqual([
      "Discover -> Podcast (push)",
      "Player -> Discover (push)",
      "Podcast -> Player (push)",
      "Podcast -> Podcast (push)",
    ]);
    expect(compose.starts).toEqual(["compose:app/Views.kt#Discover"]);
  });

  it("reads Circuit screens shown as a dialog or a bottom sheet", async () => {
    const { links } = await app({
      "app/Screens.kt":
        "import com.slack.circuit.runtime.screen.Screen\nobject HomeScreen : Screen\nobject AccountScreen : Screen\nobject TrackScreen : Screen",
      "app/Views.kt": plain("Home") + plain("Account") + plain("Track"),
      "app/Ui.kt":
        "fun ui(s: Screen) = when (s) { is AccountScreen -> ui { Account() }; is TrackScreen -> ui { Track() }; else -> null }",
      "app/HomeUi.kt": [
        "fun homeUi(s: Screen) = when (s) { is HomeScreen -> ui { Home() } }",
        "suspend fun open() { overlayHost.showInDialog(AccountScreen, navigator::goTo); overlayHost.showInBottomSheet(TrackScreen) }",
      ].join("\n"),
      "app/HomePresenter.kt":
        "fun presenter(s: Screen) = when (s) { is HomeScreen -> HomePresenter() }\nclass HomePresenter { fun open() = navigator.goTo(AccountScreen) }",
    });
    expect(links).toEqual(["Home -> Account (dialog)", "Home -> Track (sheet)"]);
  });
});

describe("navigation laid out the way Google recommends for feature modules", () => {
  const host = (calls: string) =>
    `@Composable fun AppNavHost(navController: NavHostController) {\n  NavHost(navController, startDestination = ForYouRoute) {\n${calls}\n  }\n}`;

  it("credits a feature's screen to its graph function, past a one-line helper declared before it", async () => {
    const { links } = await app({
      "feature/Views.kt": plain("ForYouScreen") + plain("TopicScreen"),
      "feature/Navigation.kt": [
        "fun NavController.navigateToForYou(navOptions: NavOptions) = navigate(route = ForYouRoute, navOptions)",
        "fun NavGraphBuilder.forYouSection(onTopicClick: (String) -> Unit) {",
        "  composable<ForYouRoute> { ForYouScreen(onTopicClick) }",
        "}",
        "fun NavController.navigateToTopic(id: String) { navigate(route = TopicRoute(id)) }",
        "fun NavGraphBuilder.topicScreen() { composable<TopicRoute> { TopicScreen() } }",
      ].join("\n"),
      "app/NavHost.kt": host(
        "    forYouSection(onTopicClick = navController::navigateToTopic)\n    topicScreen()",
      ),
    });
    expect(links).toEqual(["ForYouScreen -> TopicScreen (push)"]);
  });

  it("reads a helper whose body starts on the line after `=`", async () => {
    const { links } = await app({
      "feature/Views.kt": plain("ForYouScreen") + plain("SearchScreen"),
      "feature/Navigation.kt": [
        "fun NavController.navigateToSearch(navOptions: NavOptions? = null) =",
        "    navigate(SearchRoute, navOptions)",
        "fun NavGraphBuilder.forYouSection(onSearchClick: () -> Unit) {",
        "  composable<ForYouRoute> { ForYouScreen(onOpen = onSearchClick) }",
        "}",
        "fun NavGraphBuilder.searchScreen() { composable<SearchRoute> { SearchScreen() } }",
      ].join("\n"),
      "app/NavHost.kt": host(
        "    forYouSection(onSearchClick = navController::navigateToSearch)\n    searchScreen()",
      ),
    });
    expect(links).toEqual(["ForYouScreen -> SearchScreen (push)"]);
  });

  it("doesn't read the next line as the body of a one-line function returning a string", async () => {
    const { links } = await app({
      "feature/Views.kt": plain("ForYouScreen") + plain("SettingsScreen"),
      "feature/Navigation.kt": [
        'fun title() = "Hello"',
        "val opened = navController.navigate(SettingsRoute)",
        "fun NavGraphBuilder.forYouSection() { composable<ForYouRoute> { ForYouScreen(onOpen = { title() }) } }",
        "fun NavGraphBuilder.settingsScreen() { composable<SettingsRoute> { SettingsScreen() } }",
      ].join("\n"),
      "app/NavHost.kt": host("    forYouSection()\n    settingsScreen()"),
    });
    expect(links).toEqual([]);
  });
});

describe("a destination drawing one screen or another", () => {
  const views =
    plain("SimpleTuner") +
    plain("ScientificTuner") +
    plain("Settings") +
    plain("Instruments") +
    plain("Header");
  const nav = (tuner: string) =>
    [
      "@Composable fun AppNav() {",
      "  NavHost(navController, startDestination = TunerRoute) {",
      `    composable<TunerRoute> {\n${tuner}\n    }`,
      "    composable<SettingsRoute> { Settings(onOpen = { navController.navigate(TunerRoute) }) }",
      "    composable<InstrumentsRoute> { Instruments() }",
      "  }",
      "}",
    ].join("\n");

  it("credits a link to the screen whose call makes it, and opens each screen it may draw", async () => {
    const { links } = await app({
      "app/Views.kt": views,
      "app/Nav.kt": nav(
        [
          "      if (scientific) ScientificTuner(header = { Header() }, onOpen = { navController.navigate(SettingsRoute) })",
          "      else SimpleTuner(onOpen = { navController.navigate(SettingsRoute) }) { Header(onOpen = { navController.navigate(InstrumentsRoute) }) }",
        ].join("\n"),
      ),
    });
    expect(links).toEqual([
      "ScientificTuner -> Settings (push)",
      "Settings -> ScientificTuner (push)",
      "Settings -> SimpleTuner (push)",
      "SimpleTuner -> Instruments (push)",
      "SimpleTuner -> Settings (push)",
    ]);
  });

  it("starts on each screen a destination may draw, and counts each as a screen", async () => {
    const { compose, kindOf } = await app({
      "app/Views.kt": views,
      "app/Nav.kt": nav("      if (scientific) ScientificTuner(header = { Header() }) else SimpleTuner()"),
    });
    expect(compose.starts?.sort()).toEqual([
      "compose:app/Views.kt#ScientificTuner",
      "compose:app/Views.kt#SimpleTuner",
    ]);
    expect([kindOf("ScientificTuner"), kindOf("SimpleTuner"), kindOf("Header")]).toEqual([
      "screen",
      "screen",
      "component",
    ]);
  });

  it("credits navigation the screens share to each, and a callback passed in to the screen using it", async () => {
    const { links } = await app({
      "app/Views.kt": views,
      "app/Section.kt": [
        "fun NavGraphBuilder.tunerSection(onSettings: () -> Unit, onInstruments: () -> Unit) {",
        "  composable<TunerRoute> {",
        "    val back = { navController.navigate(SettingsRoute) }",
        "    if (scientific) ScientificTuner(onOpen = onSettings, onBack = back) else SimpleTuner(onOpen = onInstruments, onBack = back)",
        "  }",
        "}",
      ].join("\n"),
      "app/Nav.kt": [
        "@Composable fun AppNav() {",
        "  NavHost(navController, startDestination = TunerRoute) {",
        "    tunerSection(onSettings = { navController.navigate(SettingsRoute) }, onInstruments = { navController.navigate(InstrumentsRoute) })",
        "    composable<SettingsRoute> { Settings() }",
        "    composable<InstrumentsRoute> { Instruments() }",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(links).toEqual([
      "ScientificTuner -> Settings (push)",
      "SimpleTuner -> Instruments (push)",
      "SimpleTuner -> Settings (push)",
    ]);
  });

  it("doesn't take views drawn after a lambda's arrow or an if expression's else for another screen", async () => {
    const { compose } = await app({
      "app/Views.kt": views,
      "app/Nav.kt": nav(
        "      SimpleTuner()\n      items.forEach { item -> Header(item) }\n      val c = if (x) 1 else 2\n      Instruments()",
      ),
    });
    expect(compose.starts).toEqual(["compose:app/Views.kt#SimpleTuner"]);
  });

  it("reads `when` cases and `else if` as screens drawn one instead of another", async () => {
    const { compose } = await app({
      "app/Views.kt": views,
      "app/Nav.kt": nav(
        "      when (mode) {\n        Mode.Simple -> SimpleTuner()\n        is Mode.Pro -> { ScientificTuner() }\n      }",
      ),
    });
    expect(compose.starts?.sort()).toEqual([
      "compose:app/Views.kt#ScientificTuner",
      "compose:app/Views.kt#SimpleTuner",
    ]);
  });

  it("reads `else if` as another branch", async () => {
    const { compose } = await app({
      "app/Views.kt": views,
      "app/Nav.kt": nav("      if (a) SimpleTuner() else if (b) ScientificTuner()"),
    });
    expect(compose.starts?.sort()).toEqual([
      "compose:app/Views.kt#ScientificTuner",
      "compose:app/Views.kt#SimpleTuner",
    ]);
  });

  it("follows a callback by the value a screen's call hands on, not an argument's name", async () => {
    const { links } = await app({
      "app/Views.kt": views,
      "app/Section.kt": [
        "fun NavGraphBuilder.tunerSection(onSettings: () -> Unit, onInstruments: () -> Unit) {",
        "  composable<TunerRoute> { if (x) ScientificTuner(onSettings = onInstruments) else SimpleTuner(onOpen = onSettings) }",
        "}",
      ].join("\n"),
      "app/Nav.kt": [
        "@Composable fun AppNav() {",
        "  NavHost(navController, startDestination = TunerRoute) {",
        "    tunerSection(onSettings = { navController.navigate(SettingsRoute) }, onInstruments = { navController.navigate(InstrumentsRoute) })",
        "    composable<SettingsRoute> { Settings() }",
        "    composable<InstrumentsRoute> { Instruments() }",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(links).toEqual(["ScientificTuner -> Instruments (push)", "SimpleTuner -> Settings (push)"]);
  });

  it("doesn't take a view drawn beside the screen, or the same view drawn twice, for another screen", async () => {
    const { compose, links } = await app({
      "app/Views.kt": views,
      "app/Nav.kt": nav(
        "      SimpleTuner()\n      if (showSheet) Instruments(onOpen = { navController.navigate(SettingsRoute) })\n      if (x) Header() else Header()",
      ),
    });
    expect(compose.starts).toEqual(["compose:app/Views.kt#SimpleTuner"]);
    // Drawn beside the screen, it isn't what opening the route shows, but the links in its own call are its own.
    expect(links).toEqual(["Instruments -> Settings (push)", "Settings -> SimpleTuner (push)"]);
  });
});

describe("parts of a screen that navigate by themselves", () => {
  const routes = [
    "@Composable fun AppNav() {",
    '  NavHost(navController, startDestination = "home") {',
    '    composable("home") { Home() }',
    '    composable("search") { Search() }',
    '    composable("artist/{id}") { Artist() }',
    "  }",
    "}",
  ].join("\n");

  it("credits a menu's own navigation to every screen holding it", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Artist") +
        "@Composable fun Home() { LazyColumn { item { SongMenu() } } }\n" +
        "@Composable fun Search() { LazyColumn { item { SongRow() } } }\n" +
        "@Composable fun SongRow() { SongMenu() }\n" +
        '@Composable fun SongMenu() { val nav = LocalNavController.current\n Button(onClick = { nav.navigate("artist/$id") }) }\n',
      "app/Nav.kt": routes,
    });
    expect(links).toEqual(expect.arrayContaining(["Home -> Artist (push)", "Search -> Artist (push)"]));
  });

  it("leaves out the app's frame: the view holding the navigation, what places it, and parts only it places", async () => {
    const { links } = await app({
      "app/Views.kt": plain("Home") + plain("Search") + plain("Artist"),
      "app/App.kt": [
        '@Composable fun MusicApp() { Scaffold(topBar = { TopBar(onSearch = { navController.navigate("search") }) }) { Shell() } }',
        "@Composable fun Shell() { Box { AppNav() } }",
        '@Composable fun Rail(content: @Composable () -> Unit) { NavigationRail { item(onClick = { navController.navigate("artist/$id") }) }; content() }',
      ].join("\n"),
      "app/Nav.kt": routes.replace(
        'composable("search") { Search() }',
        'composable("search") { Rail { Search() } }',
      ),
    });
    expect(links).toEqual([]);
  });

  it("doesn't take a part's own callback for the navigation helper of the same name", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Artist") +
        plain("Search") +
        "@Composable fun Home() { LazyColumn { item { SongRow(navigateToArtist = {}) } } }\n" +
        "@Composable fun SongRow(navigateToArtist: (String) -> Unit) { Button(onClick = { navigateToArtist(id) }) }\n",
      "app/Helpers.kt": 'fun NavController.navigateToArtist(id: String) = navigate("artist/$id")\n',
      "app/Nav.kt": routes,
    });
    expect(links).toEqual([]);
  });

  it("still reads a helper called on a navigator", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Artist") +
        plain("Search") +
        "@Composable fun Home() { LazyColumn { item { SongRow() } } }\n" +
        "@Composable fun SongRow() { Button(onClick = { LocalNavController.current.navigateToArtist(id) }) }\n",
      "app/Helpers.kt": 'fun NavController.navigateToArtist(id: String) = navigate("artist/$id")\n',
      "app/Nav.kt": routes,
    });
    expect(links).toEqual(["Home -> Artist (push)"]);
  });

  it("reads a nested navigation graph's links with its own destinations, not the view holding it", async () => {
    const { links } = await app({
      "app/Views.kt": plain("Welcome") + plain("Server") + plain("Validate"),
      "app/Setup.kt": [
        "@Composable fun SetupHost() {",
        '  NavHost(setupNav, startDestination = "server") {',
        '    composable("server") { Server(onOpen = { setupNav.navigate("validate") }) }',
        '    composable("validate") { Validate() }',
        "  }",
        "}",
      ].join("\n"),
      "app/Nav.kt": [
        "@Composable fun AppNav() {",
        '  NavHost(navController, startDestination = "welcome") {',
        '    composable("welcome") { Welcome(onOpen = { navController.navigate("setup") }) }',
        '    composable("setup") { SetupHost() }',
        "  }",
        "}",
      ].join("\n"),
    });
    expect(links).toContain("Server -> Validate (push)");
    expect(links.filter((l) => l.startsWith("SetupHost"))).toEqual([]);
  });

  it("treats overloads in one file as one view when finding the frame", async () => {
    const { links } = await app({
      "app/Views.kt": plain("Home") + plain("Search") + plain("Artist"),
      "app/App.kt":
        '@Composable fun MusicApp() { Scaffold(topBar = { TopBar(onSearch = { navController.navigate("search") }) }) { AppNav() } }\n' +
        "@Composable fun Rail(x: Int) { Text(x) }\n" +
        '@Composable fun Rail(content: @Composable () -> Unit) { NavigationRail { item(onClick = { navController.navigate("artist/$id") }) }; content() }\n',
      "app/Nav.kt": `@Composable fun AppNav() { AppNav(rememberNavController()) }\n${routes
        .replace("fun AppNav()", "fun AppNav(navController: NavHostController)")
        .replace('composable("search") { Search() }', 'composable("search") { Rail { Search() } }')}`,
    });
    expect(links).toEqual([]);
  });

  it("credits parts to a screen holding a nested graph, such as its own tabs", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Search") +
        plain("Artist") +
        plain("Tab") +
        '@Composable fun Home() { Scaffold(bottomBar = { MiniPlayer() }) { NavHost(inner, "tab") { composable("tab") { Tab() } } } }\n' +
        '@Composable fun MiniPlayer() { Button(onClick = { navController.navigate("search") }) }\n',
      "app/Nav.kt": routes,
    });
    expect(links).toContain("Home -> Search (push)");
  });

  it("reads a helper called through a safe call", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Artist") +
        plain("Search") +
        "@Composable fun Home() { LazyColumn { item { SongRow() } } }\n" +
        "@Composable fun SongRow() { Button(onClick = { nav?.navigateToArtist(id) }) }\n",
      "app/Helpers.kt": 'fun NavController.navigateToArtist(id: String) = navigate("artist/$id")\n',
      "app/Nav.kt": routes,
    });
    expect(links).toEqual(["Home -> Artist (push)"]);
  });

  speedIt("reads one part placed in tens of thousands of views quickly", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 80 }, (_, f) => [
        `app/V${f}.kt`,
        Array.from({ length: 500 }, (_, i) => `@Composable fun V${f}x${i}() { Common() }\n`).join(""),
      ]),
    );
    const started = performance.now();
    await app({
      ...files,
      "app/Views.kt": `${plain("Artist") + plain("Search")}@Composable fun Home() { V0x0() }\n@Composable fun Common() { nav.navigate("artist/$id") }\n`,
      "app/Nav.kt": routes,
    });
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("reads a part's bare call to a navigation helper it doesn't take as a callback", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Artist") +
        plain("Search") +
        "@Composable fun Home() { LazyColumn { item { SongRow() } } }\n" +
        "@Composable fun SongRow() { Button(onClick = { openArtist(id) }) }\n",
      "app/Helpers.kt": 'fun openArtist(id: String) { navController.navigate("artist/$id") }\n',
      "app/Nav.kt": routes,
    });
    expect(links).toEqual(["Home -> Artist (push)"]);
  });

  it("keeps an effect drawn beside a screen as the destination's navigation", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Home") +
        plain("Search") +
        plain("Artist") +
        '@Composable fun AuthEffect() { LaunchedEffect(Unit) { navController.navigate("artist/$id") } }\n',
      "app/Nav.kt": routes.replace(
        'composable("home") { Home() }',
        'composable("home") { Home(); AuthEffect() }',
      ),
    });
    expect(links).toEqual(["Home -> Artist (push)"]);
  });

  it("leaves out a part only the frame places, but not one a screen also places", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Search") +
        plain("Artist") +
        "@Composable fun Home() { SearchButton() }\n" +
        '@Composable fun SearchButton() { IconButton(onClick = { navController.navigate("search") }) }\n',
      "app/App.kt":
        "@Composable fun MusicApp() { Column { TopBar(); SearchButton(); AppNav() } }\n" +
        '@Composable fun TopBar() { IconButton(onClick = { navController.navigate("artist/$id") }) }\n',
      "app/Nav.kt": routes,
    });
    expect(links).toEqual(["Home -> Search (push)"]);
  });

  it("keeps a part's push and replace to the same screen apart", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Search") +
        plain("Artist") +
        "@Composable fun Home() { Menu() }\n" +
        '@Composable fun Menu() { Item(onClick = { nav.navigate("search") }); Item(onClick = { nav.resetRoot("search") }) }\n',
      "app/Nav.kt": routes,
    });
    expect(links).toEqual(["Home -> Search (push)", "Home -> Search (replace)"]);
  });

  it("opens a detail pane from a part of the list pane beside it, and counts a part's calls to undeclared routes", async () => {
    const { compose, links } = await app({
      "app/Views.kt":
        plain("Topic") +
        "@Composable fun Login() { LoginHelp() }\n" +
        "@Composable fun Topics() { TopicRow() }\n" +
        "@Composable fun TopicRow() { Row(onClick = { backStack.add(TopicKey); backStack.add(PlayerKey) }) }\n" +
        "@Composable fun LoginHelp() { Text(onClick = { backStack.add(TopicKey) }) }\n",
      "app/Nav.kt": [
        "@Composable fun Nav() {",
        "  val backStack = rememberNavBackStack(LoginKey)",
        "  NavDisplay(backStack, entryProvider = entryProvider {",
        "    entry<LoginKey> { Login() }",
        "    entry<TopicsKey>(metadata = ListDetailSceneStrategy.listPane()) { Topics() }",
        "    entry<TopicKey>(metadata = ListDetailSceneStrategy.detailPane()) { Topic() }",
        "  })",
        "}",
      ].join("\n"),
    });
    expect(links).toEqual(["Login -> Topic (push)", "Topics -> Topic (pane)"]);
    expect(compose.unresolvedLinks).toBe(1);
  });

  it("credits an effect inside a screen's body once", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Search") +
        plain("Artist") +
        "@Composable fun Home() { Column { AuthEffect() } }\n" +
        '@Composable fun AuthEffect() { LaunchedEffect(Unit) { navController.navigate("artist/$id") } }\n',
      "app/Nav.kt": routes,
    });
    expect(links).toEqual(["Home -> Artist (push)"]);
  });

  it("reads a lowercase composable, which isn't a view, as a helper", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Home") +
        plain("Search") +
        plain("Artist") +
        '@Composable fun openOnStart() { LaunchedEffect(Unit) { navController.navigate("artist/$id") } }\n',
      "app/Nav.kt": routes.replace(
        'composable("home") { Home() }',
        'composable("home") { Home(); openOnStart() }',
      ),
    });
    expect(links).toEqual(["Home -> Artist (push)"]);
  });

  it("credits an overloaded part placed through an overloaded row to the screen", async () => {
    const { links } = await app({
      "app/Views.kt": `${plain("Search") + plain("Artist")}@Composable fun Home() { SongRow(song) }\n`,
      "app/Rows.kt":
        "@Composable fun SongRow(id: Int) { Text(id) }\n" +
        "@Composable fun SongRow(song: Song) { ArtistText(song.artists) }\n",
      "app/Parts.kt":
        "@Composable fun ArtistText(name: String) { Text(name) }\n" +
        '@Composable fun ArtistText(artists: List<Artist>) { Text(onClick = { nav.navigate("artist/$id") }) }\n',
      "app/Nav.kt": routes,
    });
    expect(links).toEqual(["Home -> Artist (push)"]);
  });

  it("opens a detail pane from a shared part as a pane only when every screen holding it is a list pane", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Topic") +
        "@Composable fun Login() { TopicRow() }\n" +
        "@Composable fun Topics() { TopicRow() }\n" +
        "@Composable fun TopicRow() { Row(onClick = { backStack.add(TopicKey) }) }\n",
      "app/Nav.kt": [
        "@Composable fun Nav() {",
        "  val backStack = rememberNavBackStack(LoginKey)",
        "  NavDisplay(backStack, entryProvider = entryProvider {",
        "    entry<LoginKey> { Login() }",
        "    entry<TopicsKey>(metadata = ListDetailSceneStrategy.listPane()) { Topics() }",
        "    entry<TopicKey>(metadata = ListDetailSceneStrategy.detailPane()) { Topic() }",
        "  })",
        "}",
      ].join("\n"),
    });
    expect(links).toEqual(["Login -> Topic (push)", "Topics -> Topic (push)"]);
  });

  it("credits parts to a screen holding a nested graph through a view inside it", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Search") +
        plain("Artist") +
        plain("Tab") +
        "@Composable fun Home() { HomeContent() }\n" +
        '@Composable fun HomeContent() { Scaffold(topBar = { IconButton(onClick = { navController.navigate("artist/$id") }) }, bottomBar = { MiniPlayer() }) { NavHost(inner, "tab") { composable("tab") { Tab() } } } }\n' +
        '@Composable fun MiniPlayer() { Button(onClick = { navController.navigate("search") }) }\n',
      "app/Nav.kt": routes,
    });
    expect(links).toEqual(expect.arrayContaining(["Home -> Artist (push)", "Home -> Search (push)"]));
  });

  it("finds a part's own callback past a long header, and not inside another parameter's function type", async () => {
    const extra = Array.from(
      { length: 20 },
      (_, i) => `modifierNumber${i}: Modifier = Modifier.padding(4.dp),`,
    ).join(" ");
    const { links } = await app({
      "app/Views.kt":
        plain("Search") +
        plain("Artist") +
        "@Composable fun Home() { LazyColumn { item { LongRow(); TypedRow() } } }\n" +
        `@Composable fun LongRow(${extra} navigateToArtist: (String) -> Unit = {}) { Button(onClick = { navigateToArtist(id) }) }\n` +
        "@Composable fun TypedRow(onEvent: (navigateToArtist: String) -> Unit = {}) { Button(onClick = { navigateToArtist(id) }) }\n",
      "app/Helpers.kt": 'fun navigateToArtist(id: String) { navController.navigate("artist/$id") }\n',
      "app/Nav.kt": routes,
    });
    expect(links).toEqual(["Home -> Artist (push)"]);
  });

  it("reads navigation in another overload of a drawn screen", async () => {
    const { links } = await app({
      "app/Views.kt":
        plain("Search") +
        plain("Artist") +
        "@Composable fun Home(navController: NavController) { Home(state = 1, navController) }\n" +
        '@Composable fun Home(state: Int, navController: NavController) { Button(onClick = { navController.navigate("artist/$id") }) }\n',
      "app/Nav.kt": routes.replace("{ Home() }", "{ Home(navController) }"),
    });
    expect(links).toEqual(["Home -> Artist (push)"]);
  });

  speedIt("reads thousands of parts placed in thousands of views quickly", async () => {
    const parts = Array.from(
      { length: 3000 },
      (_, i) => `@Composable fun P${i}() { P${i + 1}(); nav.navigate("artist/$id") }\n`,
    ).join("");
    const started = performance.now();
    await app({
      "app/Views.kt": `${plain("Artist") + plain("Search")}@Composable fun Home() { P0() }\n${parts}`,
      "app/Nav.kt": routes,
    });
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("Compose views", () => {
  it("makes what an Activity draws first a screen, leaves previews out, and keeps containers components", async () => {
    const { compose, kindOf } = await app({
      "app/MainActivity.kt":
        "class MainActivity { fun onCreate() { setContent { IntentEffect(); AppTheme { Root() } } } }\n@Composable fun IntentEffect() { }\n@Composable fun AppTheme(content: @Composable () -> Unit) { content() }",
      "app/Views.kt": [
        plain("Root"),
        "@Preview @Composable fun RootPreview() { Root() }",
        "@Composable fun Section(title: String, content: @Composable () -> Unit) { Scaffold { LazyColumn { } } }",
      ].join(""),
    });
    expect(kindOf("Root")).toBe("screen");
    expect(compose.screens.some((s) => s.name === "RootPreview")).toBe(false);
    expect(kindOf("Section")).toBe("component");
  });

  it("leaves out every kind of preview, reads an expression body's trailing block, and keeps setContent to its block", async () => {
    const { compose, kindOf } = await app({
      "app/Views.kt": [
        "@PreviewLightDark @Composable fun APreview() { Card() }",
        "@DevicePreviews @Composable fun BPreview() { Card() }",
        plain("Card"),
        "@Composable fun Feed() = Column(Modifier) { Scaffold { TopAppBar(title = {}); LazyColumn { } } }",
      ].join(""),
      "app/MainActivity.kt": [
        "class MainActivity { fun onCreate() { setContent { val x = 1 } } }",
        "@Composable fun Later() { Card() }",
      ].join("\n"),
    });
    expect(compose.screens.map((s) => s.name).sort()).toEqual(["Card", "Feed", "Later"]);
    expect(kindOf("Feed")).toBe("screen");
    expect(kindOf("Later")).toBe("component");
  });

  it("says which navigation libraries it doesn't read yet", async () => {
    const { scan } = await app({
      "app/Root.kt": `import com.bumble.appyx.navigation.node.Node\n${plain("Root")}`,
    });
    expect(scanNotes(scan)).toContain(
      "This app moves between screens with Appyx, which Designlane doesn't read yet: its screens are found by what they contain, and the links between them aren't listed.",
    );
  });

  it("lists how screens open each other in DESIGN.md", async () => {
    const { scan } = await app({
      "app/Views.kt": plain("Inbox") + plain("Thread"),
      "app/Nav.kt":
        "@Composable fun Nav() { NavHost(nav, Inbox) { composable<InboxRoute> { Inbox(onOpen = { nav.navigate(ThreadRoute) }) }; bottomSheet<ThreadRoute> { Thread() } } }",
    });
    expect(toDesignMd(scan)).toContain("How screens open each other: Inbox → Thread (sheet).");
  });
});

describe("hostile Compose navigation", () => {
  speedIt(
    "reads a destination drawing thousands of views beside thousands of navigation calls quickly",
    async () => {
      const block = Array.from({ length: 10_000 }, () => "Alpha()\nnav.navigate(DetailRoute)").join("\n");
      const started = performance.now();
      await app({
        "app/Views.kt": plain("Alpha") + plain("Detail"),
        "app/Nav.kt": `@Composable fun AppNav() { NavHost(nav, startDestination = HomeRoute) { composable<HomeRoute> {\n${block}\n}\n composable<DetailRoute> { Detail() } } }`,
      });
      expect(performance.now() - started).toBeLessThan(3_000);
    },
  );

  speedIt("reads a destination drawing tens of thousands of views quickly", async () => {
    const calls = Array.from({ length: 40_000 }, () => "Alpha()").join("\n");
    const started = performance.now();
    await app({
      "app/Views.kt": plain("Alpha"),
      "app/Nav.kt": `@Composable fun AppNav() { NavHost(nav, startDestination = HomeRoute) { composable<HomeRoute> {\n${calls}\n} } }`,
    });
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  speedIt.each([
    [
      "thousands of destinations and links",
      Array.from(
        { length: 3000 },
        (_, i) => `composable<R${i}> { V(onOpen = { nav.navigate(R${i + 1}) }) }\n`,
      ).join(""),
    ],
    [
      "thousands of navigate helpers",
      Array.from({ length: 3000 }, (_, i) => `fun go${i}() { nav.navigate(R${i}) }\n`).join(""),
    ],
    ["destinations nested thousands deep", `${"composable<R> { ".repeat(2000)}${"} ".repeat(2000)}`],
    ["functions nested thousands deep", `${"fun a() { nav.navigate(R) ".repeat(2000)}${"} ".repeat(2000)}`],
    ["thousands of setContent blocks", "setContent { x }\n".repeat(5000)],
    [
      "thousands of Circuit screens",
      `import com.slack.circuit.runtime.screen.Screen\n${Array.from({ length: 3000 }, (_, i) => `object S${i} : Screen\nis S${i} -> ui { V() }\n`).join("")}`,
    ],
  ])("reads %s quickly", async (_, text) => {
    const started = performance.now();
    await app({ "app/Hostile.kt": `${plain("V")}${text}` });
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
