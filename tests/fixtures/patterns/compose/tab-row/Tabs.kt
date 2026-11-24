import androidx.compose.runtime.Composable

@Composable
fun Tabs() {
  TabRow(selectedTabIndex = 0) {
    Tab(selected = true, onClick = {}, text = { Text("Recent") })
    Tab(selected = false, onClick = {}, text = { Text("Saved") })
  }
}
