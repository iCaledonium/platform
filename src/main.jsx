import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./index.css";

// Session 153 — the desktop shell runs frameless (titleBarStyle hiddenInset),
// so there is no title bar to drag the window by and the OS traffic lights
// float over whatever the page draws in its top-left corner. Mark the document
// and index.css turns each page's own header into the window's grip.
if (/Anima\/\d/.test(navigator.userAgent)) {
  document.documentElement.classList.add("anima-desktop-shell");
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
