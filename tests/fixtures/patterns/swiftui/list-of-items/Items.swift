import SwiftUI

struct Items: View {
  let items: [String]

  var body: some View {
    List {
      ForEach(items, id: \.self) { item in
        Text(item)
      }
    }
  }
}
