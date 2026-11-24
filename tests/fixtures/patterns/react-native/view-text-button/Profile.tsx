import { Pressable, Text, View } from "react-native";

export function Profile() {
  return (
    <View>
      <Text>Your profile</Text>
      <Pressable onPress={() => {}}>
        <Text>Save</Text>
      </Pressable>
    </View>
  );
}
