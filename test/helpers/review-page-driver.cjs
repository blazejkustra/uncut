// Run by Electron: opens a review page from disk in a hidden window, adds comments through its own
// controls, and prints what happened: every URL it asked for, what the page shows, what it exports.
const { app, BrowserWindow, session } = require("electron");

const [page, script] = process.argv.slice(-2);

async function main() {
  await app.whenReady();
  const requests = [];
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    requests.push(details.url);
    done({});
  });
  const problems = [];
  const win = new BrowserWindow({ show: false, width: 1200, height: 800 });
  win.webContents.on("console-message", (details) => {
    if (details.level === "error" || details.level === 3) problems.push(details.message);
  });
  await win.loadFile(page);
  const result = await win.webContents.executeJavaScript(require("node:fs").readFileSync(script, "utf8"));
  await win.loadFile(page);
  const afterReload = await win.webContents.executeJavaScript('document.querySelectorAll("#comments li").length');
  console.log(`RESULT ${JSON.stringify({ requests, problems, result, afterReload })}`);
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
