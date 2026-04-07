/** @param {number} tabId */
async function dumpAllFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    injectImmediately: true,
    func: async () => {
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k != null) ls[k] = localStorage.getItem(k);
      }
      const ss = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k != null) ss[k] = sessionStorage.getItem(k);
      }

      const idbOut = { supported: false, databases: [] };
      try {
        if (window.indexedDB && indexedDB.databases) {
          idbOut.supported = true;
          const MAX_KEYS = 400;
          const meta = await indexedDB.databases();
          for (const info of meta) {
            const name = info.name;
            if (!name) continue;
            try {
              const db = await new Promise((res, rej) => {
                const r = indexedDB.open(name);
                r.onerror = () => rej(r.error);
                r.onsuccess = () => res(r.result);
              });
              const stores = {};
              for (const sn of db.objectStoreNames) {
                const tx = db.transaction(sn, "readonly");
                const st = tx.objectStore(sn);
                const keys = await new Promise((res, rej) => {
                  const q = st.getAllKeys();
                  q.onsuccess = () => res(q.result);
                  q.onerror = () => rej(q.error);
                });
                const slice = keys.slice(0, MAX_KEYS);
                const rows = [];
                for (const key of slice) {
                  const val = await new Promise((res, rej) => {
                    const g = st.get(key);
                    g.onsuccess = () => res(g.result);
                    g.onerror = () => rej(g.error);
                  });
                  let keyStr;
                  try {
                    keyStr =
                      key instanceof ArrayBuffer
                        ? `[ArrayBuffer key ${key.byteLength}b]`
                        : typeof key === "object"
                          ? JSON.stringify(key)
                          : String(key);
                  } catch {
                    keyStr = "[key]";
                  }
                  let valueStr;
                  try {
                    if (val instanceof ArrayBuffer) {
                      valueStr = `[ArrayBuffer ${val.byteLength} bytes]`;
                    } else if (val instanceof Blob) {
                      valueStr = `[Blob ${val.size} bytes ${val.type || ""}]`;
                    } else if (val && typeof val === "object") {
                      valueStr = JSON.stringify(val);
                    } else if (val === undefined) {
                      valueStr = "";
                    } else {
                      valueStr = String(val);
                    }
                  } catch {
                    valueStr = "[unserializable]";
                  }
                  rows.push({ key: keyStr, rawKeyType: typeof key, value: valueStr });
                }
                stores[sn] = {
                  truncated: keys.length > MAX_KEYS,
                  totalKeys: keys.length,
                  rows,
                };
              }
              db.close();
              idbOut.databases.push({ name, version: db.version, stores });
            } catch (e) {
              idbOut.databases.push({ name, error: String(e) });
            }
          }
        }
      } catch (e) {
        idbOut.error = String(e);
      }

      return {
        href: location.href,
        localStorage: ls,
        sessionStorage: ss,
        indexedDB: idbOut,
      };
    },
  });

  return results.map((r) => ({
    frameId: r.frameId,
    documentId: r.documentId,
    result: r.result,
  }));
}

/** @param {number} tabId @param {number} frameId @param {'local'|'session'} kind @param {string} key @param {string} value */
async function storageSet(tabId, frameId, kind, key, value) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    injectImmediately: true,
    args: [kind, key, value],
    func: (knd, k, v) => {
      if (knd === "local") localStorage.setItem(k, v);
      else sessionStorage.setItem(k, v);
    },
  });
}

/** @param {number} tabId @param {number} frameId @param {'local'|'session'} kind @param {string} key */
async function storageRemove(tabId, frameId, kind, key) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    injectImmediately: true,
    args: [kind, key],
    func: (knd, k) => {
      if (knd === "local") localStorage.removeItem(k);
      else sessionStorage.removeItem(k);
    },
  });
}

/** @param {number} tabId @param {number} frameId @param {'local'|'session'} kind */
async function storageClearAll(tabId, frameId, kind) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    injectImmediately: true,
    args: [kind],
    func: (knd) => {
      if (knd === "local") localStorage.clear();
      else sessionStorage.clear();
    },
  });
}

/** @param {number} tabId @param {number} frameId @param {string} dbName */
async function idbDeleteDatabase(tabId, frameId, dbName) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    injectImmediately: true,
    args: [dbName],
    func: (name) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("blocked"));
      }),
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const tabId = msg.tabId;
  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "missing tabId" });
    return false;
  }

  if (msg.type === "dump") {
    dumpAllFrames(tabId)
      .then((frames) => sendResponse({ ok: true, frames }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === "storageSet") {
    storageSet(tabId, msg.frameId, msg.kind, msg.key, msg.value)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === "storageRemove") {
    storageRemove(tabId, msg.frameId, msg.kind, msg.key)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === "storageClearAll") {
    storageClearAll(tabId, msg.frameId, msg.kind)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === "idbDeleteDatabase") {
    idbDeleteDatabase(tabId, msg.frameId, msg.dbName)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  sendResponse({ ok: false, error: "unknown message" });
  return false;
});
