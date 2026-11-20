/** One small app per framework, each with a screen placing a child view, a state holder and named tokens, for the
 * library API's tests. */

import path from "node:path";
import { kotlin, RN_MANIFEST, swift, tsx } from "./catalog.js";
import { tempDir } from "./temp.js";

/** The SwiftUI Shop fixture: `PaywallView` places `PlanRow`, whose code uses `Color.accentColor`. */
export const SHOP = path.join(process.cwd(), "tests/fixtures/swiftui-app");

export const SWIFT_APP = {
  "App/Theme.swift": swift(
    "extension Color { static let brand = Color(red: 0.2, green: 0.4, blue: 0.9) }",
    'extension Font { static let brandTitle = Font.custom("Inter-Bold", size: 28) }',
  ),
  "App/CartModel.swift": swift("@Observable final class CartModel { var items: [String] = [] }"),
  "App/CartScreen.swift": swift(
    "struct CartScreen: View {",
    "    @State private var model = CartModel()",
    "    var body: some View { NavigationStack { List { CartRow(title: t) }.navigationTitle(t) } }",
    "}",
  ),
  "App/CartRow.swift": swift(
    "struct CartRow: View {",
    "    let title: String",
    "    var body: some View { Text(title).font(.brandTitle).foregroundStyle(Color.brand) }",
    "}",
  ),
};

export const COMPOSE_APP = {
  "app/src/main/java/a/ui/theme/Color.kt": kotlin(
    "import androidx.compose.ui.graphics.Color",
    "val Brand = Color(0xFF3366CC)",
  ),
  "app/src/main/java/a/ui/theme/Type.kt": kotlin(
    "import androidx.compose.ui.text.TextStyle",
    "val Inter = FontFamily(Font(R.font.inter_bold, FontWeight.Bold))",
    "val Title = TextStyle(fontFamily = Inter, fontSize = 28.sp, fontWeight = FontWeight.Bold)",
  ),
  "app/src/main/java/a/cart/CartViewModel.kt": kotlin("class CartViewModel : ViewModel() { val items = 1 }"),
  "app/src/main/java/a/cart/CartScreen.kt": kotlin(
    "@Composable fun CartScreen(viewModel: CartViewModel = viewModel()) {",
    "    Scaffold { LazyColumn { item { CartRow(title = t) } } }",
    "}",
  ),
  "app/src/main/java/a/cart/CartRow.kt": kotlin(
    "@Composable fun CartRow(title: String) { Text(title, color = Brand, style = Title) }",
  ),
};

export const RN_APP = {
  ...RN_MANIFEST,
  "src/theme.ts": 'export const colors = { primary: "#3366ff", muted: "#999999" };',
  "src/useCart.ts": "export function useCart() { return { items: [] }; }",
  "src/CartRow.tsx": tsx(
    'import { colors } from "./theme";',
    "export function CartRow({ title }: { title: string }) {",
    '  return <Text style={{ color: colors.primary, fontFamily: "Inter-Bold" }}>{title}</Text>;',
    "}",
  ),
  "src/CartScreen.tsx": tsx(
    'import { CartRow } from "./CartRow";',
    'import { useCart } from "./useCart";',
    'import { useNavigation } from "@react-navigation/native";',
    "export function CartScreen() { const cart = useCart(); return <View><CartRow title={a} /></View>; }",
  ),
};

/** An app whose users pick a theme, each with a light and a dark set of the same colors. */
const set = (name: string, scheme: string, tint: string) =>
  [
    `public struct ${name}: ColorSet {`,
    `  public var scheme: ColorScheme = .${scheme}`,
    `  public var tintColor: Color = ${tint}`,
    "  public init() {}",
    "}",
  ].join("\n");
export const THEMES = swift(
  "public protocol ColorSet {",
  "  var scheme: ColorScheme { get }",
  "  var tintColor: Color { get set }",
  "}",
  set("OceanDark", "dark", ".init(hex: 0x101523)"),
  set("OceanLight", "light", ".init(hex: 0x3366CC)"),
  set("DesertDark", "dark", ".init(hex: 0x433744)"),
  set("DesertLight", "light", ".init(hex: 0xDF915E)"),
);

/** `files` written to a temporary folder. */
export const appIn = (files: Record<string, string>) => tempDir(files);
