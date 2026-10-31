(() => {
  const electron = process.getBuiltinModule("module").createRequire(process.execPath)("electron");
  return electron.BrowserWindow.getAllWindows().map(w=>({id:w.id,title:w.getTitle(),url:w.webContents.getURL().split("?")[0]}));
})()
