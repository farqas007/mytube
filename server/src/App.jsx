import { useState } from "react";

export default function App() {

  const [videos] = useState([
    { id: 1, title: "🔥 Gaming Video 1" },
    { id: 2, title: "🎬 Movie Trailer" },
    { id: 3, title: "🚀 Tech Review" },
    { id: 4, title: "😂 Funny Shorts" }
  ]);

  return (
    <div style={{
      background: "#0f0f0f",
      color: "white",
      minHeight: "100vh",
      fontFamily: "Arial"
    }}>

      {/* HEADER */}
      <header style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "15px",
        background: "#202020"
      }}>
        <h2 style={{ color: "red" }}>YouTube Clone</h2>
        <input placeholder="Search..." style={{ padding: "8px", width: "40%" }} />
      </header>

      {/* VIDEOS */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
        gap: "15px",
        padding: "20px"
      }}>

        {videos.map(v => (
          <div key={v.id} style={{
            background: "#222",
            padding: "10px",
            borderRadius: "10px",
            cursor: "pointer"
          }}>
            <div style={{
              height: "140px",
              background: "#444",
              borderRadius: "10px"
            }}></div>

            <h4>{v.title}</h4>
          </div>
        ))}

      </div>

    </div>
  );
}