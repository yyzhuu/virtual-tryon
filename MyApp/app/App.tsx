import { Ionicons } from "@expo/vector-icons";
import axios from "axios";
import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import React, { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  ImageBackground,
  Modal,
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
  setShowBodyTypeModal: (value: boolean) => void;
};
const SCREEN_WIDTH = Dimensions.get("window").width;
const ITEM_PER_PAGE = 3;
const ITEM_HEIGHT = 200;
const ITEM_MARGIN = 10;
const ITEM_WIDTH = SCREEN_WIDTH / ITEM_PER_PAGE - ITEM_MARGIN;

export default function App() {
  const [human, setHuman] = useState<string | null>(null); //either string or null
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [bodyType, setBodyType] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [showBodyTypeModal, setShowBodyTypeModal] = useState(false);
  const [estimatedSize, setEstimatedSize] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const insets = useSafeAreaInsets();
  const handleBodyTypeSelect = (type: string) => {
    setBodyType(type);
    setShowBodyTypeModal(false);
  };
  const [clothes, setClothes] = useState<Cloth[]>([
    { id: "1", uri: require("./example/cloth/04469_00.jpg") },
    { id: "2", uri: require("./example/cloth/04743_00.jpg") },
    { id: "3", uri: require("./example/cloth/09133_00.jpg") },
    { id: "4", uri: require("./example/cloth/09166_00.jpg") },
    { id: "5", uri: require("./example/cloth/14627_00.jpg") },
  ]);

  const bodyTypes = [
    "Hourglass",
    "Rectangle",
    "Inverted Triangle",
    "Pear",
    "Apple",
  ];

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

  // IOS simulator:
  const BACKEND_HOST = "http://0.0.0.0:7860";
  // Phone
  //const BACKEND_HOST = "http://10.91.236.135:7860";

  // pick image for human
  const pickImage = async (type: "human") => {
    try {
      let result;
      if (type === "human") {
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"], // only images
          quality: 1,
        });

        // User canceled the picker
        if (result.canceled || !result.assets || result.assets.length === 0)
          return;

        const uri = result.assets[0].uri;

        // Set state
        setHuman(uri);
      }
    } catch (err) {
      console.error("Error picking image:", err);
      alert("Failed to pick image. Please try again.");
    }
  };

  // submit to backend
  const submit = async () => {
    if (!human) {
      alert("Please select human images");
      return;
    }

    setLoading(true);

    const form = new FormData();
    const baseDir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;

    const humanLocalUri = baseDir + "human.jpg";
    await FileSystem.copyAsync({ from: human, to: humanLocalUri });
    console.log("Human image copied:", humanLocalUri);
    form.append("human", {
      uri: humanLocalUri,
      type: "image/jpeg",
      name: "human.jpg",
    } as any);

    const garmentAsset = Asset.fromModule(clothes[selectedIndex].uri);
    await garmentAsset.downloadAsync();
    console.log(garmentAsset.localUri);
    const garmentLocalUri = garmentAsset.localUri;
    form.append("garment", {
      uri: garmentLocalUri,
      type: "image/jpeg",
      name: "garment.jpg",
    } as any);
    form.append("body_type", bodyType ?? "");

    try {
      //console.log("Sending images to backend:", humanLocalUri, garmentLocalUri);
      const res = await axios.post(`${BACKEND_HOST}/tryon`, form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120000,
      });
      console.log("Sent images and body type to backend.");

      // Extract images from response
      const data = res.data;
      const output = `data:image/png;base64,${data.masked}`;
      setHuman(output);

      // Get size recommendation
      setEstimatedSize(data.size);
      setConfidence(data.size_confidence);
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
      source={human ? { uri: human } : undefined}
      style={styles.humanBackground}
      imageStyle={{ resizeMode: "contain" }}
    >
      {estimatedSize && confidence !== null && (
        <View style={[styles.sizeBadge, { top: insets.top + 10 }]}>
          <Text style={styles.sizeText}>Recommended Size: {estimatedSize}</Text>
        </View>
      )}
      <View style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ padding: 40, alignItems: "center" }}
        >
          <Text style={[styles.title, { flexWrap: "wrap" }]}>
            Virtual Try On
          </Text>
        </ScrollView>

        {loading && ( //loading overlay
          <View
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: "rgba(0,0,0,0.5)", // semi-transparent
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <ActivityIndicator size="large" color="#fff" />
            <Text style={{ color: "white", marginTop: 10 }}>
              Processing images...
            </Text>

            <TouchableOpacity
              onPress={() => setLoading(false)}
              style={{
                marginTop: 20,
                padding: 10,
                backgroundColor: "red",
                borderRadius: 5,
              }}
            >
              <Text style={{ color: "white" }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.clothSelectorContainer}>
          {/* Cloth selector */}
          <ClothSelector
            clothes={clothes}
            selectedIndex={selectedIndex}
            setSelectedIndex={setSelectedIndex}
            setShowBodyTypeModal={setShowBodyTypeModal}
          />
        </View>

        <Modal visible={showBodyTypeModal} transparent animationType="slide">
          <View style={styles.modalContainer}>
            <View style={styles.modalCard}>
              <Text style={styles.title}>Select Body Type</Text>

              {bodyTypes.map((type) => (
                <TouchableOpacity
                  key={type}
                  style={styles.optionButton}
                  onPress={() => handleBodyTypeSelect(type)}
                >
                  <Text>{type}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </Modal>
        <View style={styles.bottomButtonContainer}>
          <TouchableOpacity
            onPress={pickFromCamera}
            style={styles.cameraButton}
          >
            <Ionicons name="camera" size={28} color="white" />
          </TouchableOpacity>
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

          <TouchableOpacity
            onPress={submit}
            style={styles.sideButton}
            disabled={loading}
          >
            <Text style={styles.buttonText}>Try On</Text>
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
  setShowBodyTypeModal,
}: ClothSelectorProps) {
  return (
    <View style={styles.container}>
      <FlatList
        data={clothes}
        horizontal
        snapToInterval={ITEM_WIDTH + ITEM_MARGIN * 2}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: 10 }}
        keyExtractor={(item) => item.id}
        onMomentumScrollEnd={(event) => {
          const index = Math.round(
            event.nativeEvent.contentOffset.x / (ITEM_WIDTH + ITEM_MARGIN * 2),
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
            onPress={() => {
              setSelectedIndex(index);
              setShowBodyTypeModal(true);
            }}
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
  modalContainer: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalCard: {
    width: "80%",
    backgroundColor: "white",
    borderRadius: 10,
    padding: 20,
    alignItems: "center",
  },
  optionButton: {
    width: "100%",
    padding: 15,
    backgroundColor: "#eee",
    borderRadius: 8,
    marginTop: 10,
    alignItems: "center",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 20,
  },
  sizeBadge: {
    position: "absolute",
    backgroundColor: "rgba(120,120,120,0.9)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  sizeText: {
    color: "white",
    fontWeight: "bold",
    fontSize: 14,
  },
  confidenceText: {
    color: "white",
    fontSize: 12,
  },
  bottomButtonContainer: {
    flexDirection: "row",
    padding: 10,
    gap: 10,
    alignContent: "center",
    justifyContent: "center",
  },

  clothSelectorContainer: {
    justifyContent: "center",
    marginBottom: -100,
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

  cameraButton: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#007AFF",
    justifyContent: "center",
    alignItems: "center",
  },
});
