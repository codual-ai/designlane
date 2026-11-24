import SwiftUI

struct Settings: View {
  var body: some View {
    NavigationStack {
      Form {
        Toggle("Notifications", isOn: .constant(true))
      }
      .navigationTitle("Settings")
      .toolbar {
        Button("Done") {}
      }
    }
  }
}
