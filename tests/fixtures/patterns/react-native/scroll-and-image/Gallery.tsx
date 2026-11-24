import { Image, ScrollView, Text } from "react-native";

export function Gallery() {
  return (
    <ScrollView>
      <Text>Gallery</Text>
      <Image source={{ uri: "https://example.com/a.png" }} />
    </ScrollView>
  );
}
