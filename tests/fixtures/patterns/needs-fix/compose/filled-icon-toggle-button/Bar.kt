import androidx.compose.runtime.Composable

@Composable
fun Bar() {
  Row {
    FilledIconToggleButton(checked = true, onCheckedChange = {}) { Icon(icon, null) }
    Text("Like")
  }
}
