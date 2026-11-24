import { FlatList, Text } from "react-native";

export function Items({ items }: { items: string[] }) {
  return <FlatList data={items} renderItem={({ item }) => <Text>{item}</Text>} />;
}
