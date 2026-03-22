import axios from "axios";
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import React, { useState } from "react";

import {
  Alert,
  Dimensions,
  FlatList,
  Image,
  ImageBackground,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

type Cloth = {
  id: string;
  uri: any;
};

type ClothSelectorProps = {
  clothes: Cloth[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
};
const SCREEN_WIDTH = Dimensions.get("window").width;
const ITEM_PER_PAGE = 3;
const ITEM_HEIGHT = 200;
const ITEM_MARGIN = 10;
const ITEM_WIDTH = SCREEN_WIDTH / ITEM_PER_PAGE - ITEM_MARGIN;

export default function App() {
  const [human, setHuman] = useState<string | null>(null); //either string or null
  const [garment, setGarment] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [clothes, setClothes] = useState<Cloth[]>([
    { id: "1", uri: require("./example/cloth/04469_00.jpg") },
    { id: "2", uri: require("./example/cloth/04743_00.jpg") },
    { id: "3", uri: require("./example/cloth/09133_00.jpg") },
    { id: "4", uri: require("./example/cloth/09166_00.jpg") },
    { id: "5", uri: require("./example/cloth/14627_00.jpg") },
  ]);

  const pickFromCamera = async () => {
    const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
    if (!permissionResult.granted) {
      Alert.alert(
        "Permissin Denied",
        "Camera access is required to take a photo.",
      );
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      quality: 1,
    });
    if (result.canceled || !result.assets || result.assets.length === 0) return;
    const photoUri = result.assets[0].uri;
    console.log("Photo URI:", photoUri);

    // Save to state
    setHuman(photoUri); // if using your human state
  };

  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  const BACKEND_HOST =
    Platform.OS === "web"
      ? "http://localhost:7860"
      : "http://10.91.236.135:7860";

  // pick image for human or garment
  const pickImage = async (type: "human" | "garment") => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"], // only images
        quality: 1,
      });

      // User canceled the picker
      if (result.canceled || !result.assets || result.assets.length === 0)
        return;

      const uri = result.assets[0].uri;

      // Set state
      if (type === "human") setHuman(uri);
      else setGarment(uri);
    } catch (err) {
      console.error("Error picking image:", err);
      alert("Failed to pick image. Please try again.");
    }
  };

  // submit to backend
  const submit = async () => {
    if (!human || !garment) {
      alert("Please select both human and garment images");
      return;
    }

    setLoading(true);

    const form = new FormData();

    if (Platform.OS !== "web") {
      const baseDir =
        (FileSystem as any).cacheDirectory ??
        (FileSystem as any).documentDirectory ??
        "";
      const humanLocalUri = baseDir + "human.jpg";
      const garmentLocalUri = baseDir + "garment.jpg";

      await FileSystem.copyAsync({ from: human, to: humanLocalUri });
      await FileSystem.copyAsync({ from: garment, to: garmentLocalUri });

      form.append("human", {
        uri: humanLocalUri,
        type: "image/jpeg",
        name: "human.jpg",
      } as any);
      form.append("garment", {
        uri: garmentLocalUri,
        type: "image/jpeg",
        name: "garment.jpg",
      } as any);
    } else {
      const humanBlob = await (await fetch(human)).blob();
      const garmentBlob = await (await fetch(garment)).blob();

      form.append("human", humanBlob, "human.jpg");
      form.append("garment", garmentBlob, "garment.jpg");
    }

    try {
      const res = await axios.post(`${BACKEND_HOST}/tryon`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    } catch (err: any) {
      console.log("Detailed error:", err.response?.data || err.message || err);
      alert(
        "Error: " +
          (err.response?.data?.message || err.message || "Unknown error"),
      );
    }

    setLoading(false);
  };

  return (
    <ImageBackground
      source={human ? { uri: human } : undefined} // Human image as full background
      style={styles.humanBackground} // fill the whole screen
      imageStyle={{ resizeMode: "contain" }}
    >
      <View style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ padding: 40, alignItems: "center" }}
        >
          <Text style={[styles.title, { flexWrap: "wrap" }]}>
            Virtual Try On
          </Text>
        </ScrollView>
        <View style={styles.clothSelectorContainer}>
          {/* Cloth selector */}
          <ClothSelector
            clothes={clothes}
            selectedIndex={selectedIndex}
            setSelectedIndex={setSelectedIndex}
          />
        </View>
        {/*Bottom button */}
        <View style={styles.bottomButtonContainer}>
          {/* Human Panel button */}
          <TouchableOpacity
            style={styles.sideButton}
            onPress={() => pickImage("human")}
          >
            <Text style={styles.buttonText}>Pick Human</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={pickFromCamera} style={styles.sideButton}>
            <Text style={styles.buttonText}>Camera</Text>
          </TouchableOpacity>
        </View>
      </View>
    </ImageBackground>
  );
}

function ClothSelector({
  clothes,
  selectedIndex,
  setSelectedIndex,
}: ClothSelectorProps) {
  const ITEM_MARGIN = 10;

  return (
    <View style={styles.container}>
      <FlatList
        data={clothes}
        horizontal
        snapToInterval={ITEM_WIDTH + ITEM_MARGIN}
        decelerationRate="fast"
        keyExtractor={(item) => item.id}
        onMomentumScrollEnd={(event) => {
          const index = Math.round(
            event.nativeEvent.contentOffset.x / (ITEM_WIDTH + ITEM_MARGIN),
          );
          setSelectedIndex(index);
        }}
        renderItem={({ item, index }) => (
          <TouchableOpacity
            style={{
              width: ITEM_WIDTH,
              height: ITEM_HEIGHT,
              marginHorizontal: 10,
              borderRadius: 15,
              borderWidth: selectedIndex === index ? 4 : 0,
              borderColor: "black",
              justifyContent: "center",
              padding: 10,
              alignContent: "center",
            }}
            onPress={() => setSelectedIndex(index)}
          >
            <Image
              source={item.uri}
              resizeMode="contain"
              style={{ width: "100%", height: "100%" }}
            />
          </TouchableOpacity>
        )}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  bottomButtonContainer: {
    flexDirection: "row",
    padding: 10,
    gap: 10,
    backgroundColor: "rgba(255,255,255,0.7)", // semi-transparent overlay
  },

  clothSelectorContainer: {
    justifyContent: "center",
    marginBottom: 10,
  },

  sideButton: {
    flex: 1,
    padding: 12,
    backgroundColor: "#007AFF",
    borderRadius: 8,
    alignItems: "center",
  },

  buttonText: {
    color: "white",
    fontWeight: "bold",
    fontSize: 16,
  },

  humanBackground: {
    flex: 1,
    justifyContent: "flex-end",
    borderRadius: 10,
    overflow: "hidden",
  },
  panelTitle: {
    fontWeight: "bold",
    marginBottom: 5,
  },
  container: {
    padding: 10,
    height: 300,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 10,
    textAlign: "center",
  },
  input: {
    borderWidth: 1,
    borderColor: "#aaa",
    borderRadius: 8,
    padding: 8,
    marginTop: 5,
  },

  selectedText: {
    marginTop: 10,
    fontSize: 16,
  },
});
