import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// index.html carries <div id="root">, so the mount point exists by
// construction. Saying so here is what keeps this file free of a runtime branch
// for a build that could not load at all.
const root = document.getElementById("root") as HTMLElement;

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
