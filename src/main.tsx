import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "virtual:app-theme.css";
import "./index.css";
import { Root } from "./root";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
