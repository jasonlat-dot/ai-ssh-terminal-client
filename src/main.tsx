import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TerminalActionsProvider } from './components/TerminalActionsContext';
import { WindowResizeHandles } from './components/WindowResizeHandles';

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TerminalActionsProvider><App /></TerminalActionsProvider>
    <WindowResizeHandles />
  </React.StrictMode>,
);
