import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import ErrorBoundary from "./components/ErrorBoundary.js";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// PWA：仅生产环境注册 service worker（dev 下会干扰热更新）
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
