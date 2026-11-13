import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./precise.css";
import "./precise-legacy.css";
import "./ui/precise-ui.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
