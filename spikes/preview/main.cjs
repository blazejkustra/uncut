// Spike A harness: opens a page in Electron. UNCUT_CDP=<port> exposes DevTools
// so tests can drive it with puppeteer; UNCUT_PAGE picks the page to load.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

if (process.env.UNCUT_CDP) app.commandLine.appendSwitch("remote-debugging-port", process.env.UNCUT_CDP);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: { backgroundThrottling: false },
  });
  const page = process.env.UNCUT_PAGE ?? "measure.html";
  win.loadFile(path.join(__dirname, page), { query: { src: process.env.UNCUT_SRC ?? "" } });
});
app.on("window-all-closed", () => app.quit());
