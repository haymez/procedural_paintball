// Isola entry: menus, rooms, and (later) the game behind startMatch().
import "./ui/styles.css";
import { App } from "./app/app";
import { runDemo } from "./app/demo";

const root = document.getElementById("app")!;
const demo = new URLSearchParams(location.search).get("demo");
if (demo) runDemo(root, demo);
else {
  const app = new App(root);
  // Debug handle for scripts/e2e: __isola.app.room.conn.simulateDrop()
  (window as unknown as { __isola: unknown }).__isola = { app };
  app.start();
}
