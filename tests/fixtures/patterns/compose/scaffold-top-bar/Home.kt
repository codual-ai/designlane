import androidx.compose.runtime.Composable

@Composable
fun Home() {
  Scaffold(
    topBar = { TopAppBar(title = { Text("Home") }) },
  ) { padding ->
    Text("Welcome")
  }
}
