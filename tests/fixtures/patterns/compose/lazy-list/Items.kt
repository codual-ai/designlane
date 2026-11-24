import androidx.compose.runtime.Composable

@Composable
fun Items(items: List<String>) {
  LazyColumn {
    items(items) { item ->
      Text(item)
    }
  }
}
