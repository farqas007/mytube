import express from "express";
import mongoose from "mongoose";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect("mongodb://127.0.0.1:27017/youtubeClone");

app.listen(5000, () => {
  console.log("Server running on port 5000");
});

import mongoose from "mongoose";

const VideoSchema = new mongoose.Schema({
  title: String,
  url: String,
  likes: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("Video", VideoSchema);


import express from "express";
import Video from "../models/Video.js";

const router = express.Router();

router.post("/upload", async (req, res) => {
  const { title, url } = req.body;

  const video = await Video.create({
    title,
    url
  });

  res.json(video);
});

router.get("/videos", async (req, res) => {
  const videos = await Video.find().sort({ createdAt: -1 });
  res.json(videos);
});

export default router;



import { useEffect, useState } from "react";
import axios from "axios";

export default function Home() {

  const [videos, setVideos] = useState([]);

  useEffect(() => {
    axios.get("http://localhost:5000/videos")
      .then(res => setVideos(res.data));
  }, []);

  return (
    <div>
      <h1>🔥 YouTube Clone</h1>

      {videos.map(v => (
        <div key={v._id}>
          <h3>{v.title}</h3>
          <video src={v.url} controls width="300" />
        </div>
      ))}

    </div>
  );
}


import { useState } from "react";
import axios from "axios";

export default function Upload() {

  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");

  const upload = async () => {
    await axios.post("http://localhost:5000/upload", {
      title,
      url
    });

    alert("Uploaded!");
  };

  return (
    <div>
      <h2>Upload Video</h2>

      <input onChange={e => setTitle(e.target.value)} placeholder="title" />
      <input onChange={e => setUrl(e.target.value)} placeholder="video url" />

      <button onClick={upload}>Upload</button>
    </div>
  );
}



