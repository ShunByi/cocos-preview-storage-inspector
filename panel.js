/** @typedef {{ frameId: number, documentId?: string, result: { href: string, localStorage: Record<string, string>, sessionStorage: Record<string, string>, indexedDB: object } }} FrameDump */

const tabId = chrome.devtools.inspectedWindow.tabId;

const el = {
  btnRefresh: /** @type {HTMLButtonElement} */ (document.getElementById("btnRefresh")),
  selFrame: /** @type {HTMLSelectElement} */ (document.getElementById("selFrame")),
  status: /** @type {HTMLSpanElement} */ (document.getElementById("status")),
  tabLocal: /** @type {HTMLDivElement} */ (document.getElementById("tabLocal")),
  tabSession: /** @type {HTMLDivElement} */ (document.getElementById("tabSession")),
  tabIdb: /** @type {HTMLDivElement} */ (document.getElementById("tabIdb")),
  modalBackdrop: /** @type {HTMLDivElement} */ (document.getElementById("modalBackdrop")),
  modalTitle: /** @type {HTMLDivElement} */ (document.getElementById("modalTitle")),
  modalBody: /** @type {HTMLDivElement} */ (document.getElementById("modalBody")),
  modalOk: /** @type {HTMLButtonElement} */ (document.getElementById("modalOk")),
  modalCancel: /** @type {HTMLButtonElement} */ (document.getElementById("modalCancel")),
  qKey: /** @type {HTMLInputElement} */ (document.getElementById("qKey")),
  qField: /** @type {HTMLInputElement} */ (document.getElementById("qField")),
  panelBody: /** @type {HTMLDivElement | null} */ (
    document.querySelector(".panel-body")
  ),
};

/** localStorage 键列宽度占比（%），关闭 DevTools 后再开仍保留 */
const KV_KEY_COL_PCT_LS = "cocosInspectorKvKeyColPct";

function readKvKeyColPct() {
  const v = parseFloat(localStorage.getItem(KV_KEY_COL_PCT_LS) || "");
  if (!Number.isFinite(v)) return 28;
  return Math.min(62, Math.max(10, v));
}

function applyKvKeyColPct(pct) {
  document.documentElement.style.setProperty("--kv-key-pct", `${pct}%`);
}

function wireStorageKvColumnResize() {
  const root = el.panelBody;
  if (!root) return;
  /** 键列右缘向内可拖区域（像素），对齐表格竖分割线 */
  const KEY_CELL_EDGE_PX = 12;
  root.addEventListener("pointerdown", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const table = t.closest("table.storage-kv-table");
    if (!table || !root.contains(table)) return;

    /** @type {Element | null} */
    let captureEl = null;
    const handle = t.closest(".kv-resize-handle");
    if (handle && table.contains(handle)) {
      captureEl = handle;
    } else {
      const cell = t.closest("th.key-cell, td.key-cell");
      if (!cell || cell.closest("table") !== table) return;
      const rect = cell.getBoundingClientRect();
      if (
        e.clientX < rect.right - KEY_CELL_EDGE_PX ||
        e.clientX > rect.right + 10
      ) {
        return;
      }
      captureEl = cell;
    }

    e.preventDefault();
    const pid = e.pointerId;
    captureEl.setPointerCapture(pid);
    let lastPct = readKvKeyColPct();

    const onMove = (ev) => {
      if (ev.pointerId !== pid) return;
      document.body.style.cursor = "col-resize";
      const rect = table.getBoundingClientRect();
      if (rect.width <= 1) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      lastPct = Math.min(62, Math.max(10, pct));
      applyKvKeyColPct(lastPct);
    };
    const onUp = (ev) => {
      if (ev.pointerId !== pid) return;
      document.body.style.cursor = "";
      try {
        captureEl.releasePointerCapture(pid);
      } catch (_err) {
        /* 已释放 */
      }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      localStorage.setItem(KV_KEY_COL_PCT_LS, String(lastPct));
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
}

/** @type {FrameDump[] | null} */
let lastFrames = null;
/** @type {'local'|'session'|'idb'} */
let activeTab = "local";
let lastFingerprint = "";

/** @type {null | (() => void | false | Promise<void | false>)} */
let modalOnOk = null;

/** 全局：查看=true / 修改=false（无单选 DOM 时回退，如当前在 idb 标签） */
let globalStorageViewOnly = true;

function setStatus(text, isErr) {
  el.status.textContent = text;
  el.status.classList.toggle("err", !!isErr);
}

function getSelectedFrame() {
  const v = el.selFrame.value;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return null;
  return n;
}

function getFrameData() {
  const fid = getSelectedFrame();
  if (fid == null || !lastFrames) return null;
  const f = lastFrames.find((x) => x.frameId === fid);
  return f || null;
}

function fingerprint(frames) {
  try {
    return JSON.stringify(frames);
  } catch {
    return String(Math.random());
  }
}

async function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ tabId, type, ...payload }, resolve);
  });
}

/** 弹窗子层：取消时先执行栈顶恢复，再关层；栈空则整窗关闭 */
/** @type {Array<() => void>} */
let modalCancelStack = [];

/** 放大 JSON 弹窗：persist 后同步重绘树（打开子弹窗期间置 null） */
/** @type {null | (() => void)} */
let jsonMagnifyRemounter = null;

/** 从放大弹窗打开「加键/加项」并成功 persist 后，用 cancel 栈回到放大视图，并阻止本次确定关闭整窗 */
let reopenMagnifyAfterNestedPersist = false;

/** @type {boolean} */
let suppressModalCloseOnce = false;

/** 放大 JSON 弹窗内查看/修改（与列表顶栏无关，重建弹窗时保持） */
let jsonMagnifyLocalViewOnly = true;

/** 当前放大窗展示的子树路径（相对存储根）；用于子弹窗 cancel 栈恢复与 pathPrefix，勿用于再合并 persist 载荷 */
let jsonMagnifySubtreePath = /** @type {null | (string|number)[]} */ (null);

/** 当前详情弹窗对应的存储键与 kind（用于嵌套「详情」时压栈） */
let jsonMagnifyActiveKey = /** @type {string | null} */ (null);
let jsonMagnifyActiveKind = /** @type {'local'|'session'|null} */ (null);

/**
 * 同一存储键内多级「详情」导航栈（返回上一级）
 * @type {{ kind: 'local'|'session', storageKey: string, subtreePath: (string|number)[] }[]}
 */
let magnifyNavStack = [];

function pushModalCancelLayer(restore) {
  modalCancelStack.push(restore);
}

function popModalCancelLayer() {
  modalCancelStack.pop();
}

function closeModal() {
  modalCancelStack.length = 0;
  el.modalBackdrop.hidden = true;
  modalOnOk = null;
  jsonMagnifyRemounter = null;
  reopenMagnifyAfterNestedPersist = false;
  suppressModalCloseOnce = false;
  el.modalBody.classList.remove("modal-body-magnify");
  jsonMagnifyLocalViewOnly = true;
  jsonMagnifySubtreePath = null;
  jsonMagnifyActiveKey = null;
  jsonMagnifyActiveKind = null;
  magnifyNavStack.length = 0;
  el.modalBackdrop
    .querySelector(".modal-dialog")
    ?.classList.remove("modal-dialog-json-bulk", "modal-magnify-embedded");
}

function modalCancelOrStepBack() {
  if (modalCancelStack.length > 0) {
    const fn = modalCancelStack.pop();
    fn();
  } else {
    closeModal();
  }
}

el.modalCancel.addEventListener("click", () => {
  modalCancelOrStepBack();
});

el.modalOk.addEventListener("click", async () => {
  if (typeof modalOnOk === "function") {
    try {
      const ret = await modalOnOk();
      if (suppressModalCloseOnce) {
        suppressModalCloseOnce = false;
        return;
      }
      if (ret !== false) closeModal();
    } catch (e) {
      setStatus(e && e.message ? e.message : String(e), true);
    }
  } else {
    closeModal();
  }
});

el.modalBackdrop.addEventListener("click", (ev) => {
  if (ev.target === el.modalBackdrop) modalCancelOrStepBack();
});

/** 弹窗显示时锁住整页滚动，避免滚轮穿透到底层列表 */
function syncModalScrollLock() {
  const open = !el.modalBackdrop.hasAttribute("hidden");
  document.documentElement.classList.toggle("modal-scroll-lock", open);
  document.body.classList.toggle("modal-scroll-lock", open);
}

new MutationObserver(() => syncModalScrollLock()).observe(el.modalBackdrop, {
  attributes: true,
  attributeFilter: ["hidden"],
});
syncModalScrollLock();

/** @returns {{ mode: 'key'|'field', query: string }} */
function getSearchState() {
  const mode =
    /** @type {HTMLInputElement | null} */
    (document.querySelector('input[name="qmode"]:checked'))?.value === "field"
      ? "field"
      : "key";
  const q =
    mode === "field"
      ? el.qField.value.trim().toLowerCase()
      : el.qKey.value.trim().toLowerCase();
  return { mode, query: q };
}

/** JSON 内字段名查找时用于树节点高亮（与 getSearchState 一致） */
function getFieldSearchQuery() {
  const s = getSearchState();
  return s.mode === "field" && s.query ? s.query : "";
}

/** @param {unknown} v */
function coerceToNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 解析后格式化为多行 JSON 字符串（用于写入存储） */
function formatJsonForStorage(text) {
  const parsed = JSON.parse(text);
  return JSON.stringify(parsed, null, 2);
}

/** @param {HTMLElement} scopeRoot 含 .json-tree-children / .json-caret 的容器 */
function setSubtreeExpanded(scopeRoot, expanded) {
  scopeRoot.querySelectorAll(".json-tree-children").forEach((box) => {
    box.hidden = !expanded;
  });
  scopeRoot.querySelectorAll(".json-caret").forEach((caret) => {
    caret.setAttribute("aria-expanded", expanded ? "true" : "false");
    caret.textContent = expanded ? "▼" : "▶";
  });
}

/** @param {Date} d */
function toDatetimeLocalValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 数字：直接输入 或 日期转时间戳（10 位秒 / 13 位毫秒）
 * @param {HTMLElement} body 挂载点（内部会清空并填充）
 * @param {number|string} initial
 * @param {{ src?: string, digits?: string }} [ids]
 * @returns {() => number}
 */
function mountNumberOrTimestampPicker(body, initial, ids) {
  const ns = ids?.src || "pickNumSrc";
  const nd = ids?.digits || "pickNumDigits";
  body.innerHTML = "";

  const modeRow = document.createElement("div");
  modeRow.className = "modal-row";
  const modeHint = document.createElement("span");
  modeHint.style.cssText = "color:#bbb;font-size:11px;display:block;margin-bottom:6px";
  modeHint.textContent = "数值来源";
  const modeFlex = document.createElement("div");
  modeFlex.className = "modal-bool-row";
  modeFlex.innerHTML = `<label class="modal-bool-opt"><input type="radio" name="${ns}" value="direct" checked /> 直接输入</label>
    <label class="modal-bool-opt"><input type="radio" name="${ns}" value="ts" /> 日期时间戳</label>`;
  modeRow.appendChild(modeHint);
  modeRow.appendChild(modeFlex);

  const directRow = document.createElement("div");
  directRow.className = "modal-row";
  const inp = document.createElement("input");
  inp.type = "number";
  inp.step = "any";
  inp.className = "modal-text modal-number-input";
  inp.value = String(coerceToNumber(initial));
  directRow.appendChild(inp);

  const tsRow = document.createElement("div");
  tsRow.className = "modal-row";
  tsRow.style.display = "none";
  const tsLbl = document.createElement("label");
  tsLbl.textContent = "本地日期与时间";
  tsRow.appendChild(tsLbl);
  const dt = document.createElement("input");
  dt.type = "datetime-local";
  dt.className = "modal-text";
  dt.value = toDatetimeLocalValue(new Date());
  tsRow.appendChild(dt);
  const digRow = document.createElement("div");
  digRow.className = "modal-bool-row";
  digRow.style.marginTop = "8px";
  digRow.innerHTML = `<label class="modal-bool-opt"><input type="radio" name="${nd}" value="10" /> 10位(秒)</label>
    <label class="modal-bool-opt"><input type="radio" name="${nd}" value="13" checked /> 13位(毫秒)</label>`;
  tsRow.appendChild(digRow);

  modeFlex.querySelectorAll(`input[name="${ns}"]`).forEach((r) => {
    r.addEventListener("change", () => {
      const v = /** @type {HTMLInputElement} */ (r).value;
      directRow.style.display = v === "direct" ? "" : "none";
      tsRow.style.display = v === "ts" ? "" : "none";
    });
  });

  body.appendChild(modeRow);
  body.appendChild(directRow);
  body.appendChild(tsRow);

  return () => {
    const src = /** @type {HTMLInputElement | null} */ (
      body.querySelector(`input[name="${ns}"]:checked`)
    );
    if (src?.value === "ts") {
      const ms = new Date(dt.value).getTime();
      if (!Number.isFinite(ms) || !dt.value) return 0;
      const dig = /** @type {HTMLInputElement | null} */ (
        body.querySelector(`input[name="${nd}"]:checked`)
      );
      return dig?.value === "10" ? Math.floor(ms / 1000) : ms;
    }
    return coerceToNumber(inp.value);
  };
}

/** @param {unknown} obj @param {string} q */
function jsonFieldNameMatches(obj, q) {
  if (!q) return true;
  if (Array.isArray(obj)) {
    return obj.some((item) => jsonFieldNameMatches(item, q));
  }
  if (obj !== null && typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      if (k.toLowerCase().includes(q)) return true;
      if (jsonFieldNameMatches(/** @type {Record<string, unknown>} */(obj)[k], q))
        return true;
    }
  }
  return false;
}

/** @param {string} storageKey @param {string} raw */
function shouldShowStorageRow(storageKey, raw) {
  const { mode, query } = getSearchState();
  if (!query) return true;
  if (mode === "key") return storageKey.toLowerCase().includes(query);
  try {
    const p = JSON.parse(String(raw).trim());
    return jsonFieldNameMatches(p, query);
  } catch {
    return false;
  }
}

function syncSearchInputs() {
  const mode =
    /** @type {HTMLInputElement | null} */
    (document.querySelector('input[name="qmode"]:checked'))?.value === "field"
      ? "field"
      : "key";
  el.qKey.disabled = mode === "field";
  el.qField.disabled = mode === "key";
  el.qKey.style.display = mode === "key" ? "" : "none";
  el.qField.style.display = mode === "field" ? "" : "none";
}

document.querySelectorAll('input[name="qmode"]').forEach((r) => {
  r.addEventListener("change", () => {
    const mode =
      /** @type {HTMLInputElement} */ (r).value === "field" ? "field" : "key";
    if (mode === "key") el.qField.value = "";
    else el.qKey.value = "";
    syncSearchInputs();
    renderAll();
  });
});
syncSearchInputs();

el.qKey.addEventListener("input", () => renderAll());
el.qField.addEventListener("input", () => renderAll());


/** @typedef {{ kind: 'json'|'number'|'bool'|'null'|'undefined'|'string', label: string, minified?: string }} ValueMeta */

/** @param {string} raw @returns {ValueMeta} */
function detectValueMeta(raw) {
  const s = raw == null ? "" : String(raw);
  const trim = s.trim();
  if (trim === "undefined") {
    return { kind: "undefined", label: "undefined" };
  }
  if (trim === "") {
    return { kind: "string", label: "文本" };
  }
  try {
    const v = JSON.parse(trim);
    if (typeof v === "object" && v !== null) {
      return {
        kind: "json",
        label: "JSON",
        minified: JSON.stringify(v),
      };
    }
    if (typeof v === "number") {
      return { kind: "number", label: "数字" };
    }
    if (typeof v === "boolean") {
      return { kind: "bool", label: "布尔" };
    }
    if (v === null) {
      return { kind: "null", label: "null" };
    }
    if (typeof v === "string") {
      return { kind: "string", label: "文本" };
    }
  } catch {
    /* 非 JSON */
  }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trim)) {
    return { kind: "number", label: "数字" };
  }
  return { kind: "string", label: "文本" };
}

/** @param {{ kind: string }} meta {@link detectValueMeta} */
function addKeyTypeSelectValueFromMeta(meta) {
  if (meta.kind === "json") return "json";
  if (meta.kind === "number") return "number";
  if (meta.kind === "bool") return "boolean";
  if (meta.kind === "null") return "null";
  return "string";
}

/** @param {unknown} v */
function formatJsonPrimitive(v) {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number")
    return Number.isFinite(v) ? String(v) : JSON.stringify(v);
  if (typeof v === "undefined") return "undefined";
  return JSON.stringify(v);
}

/** @param {unknown} v */
function valueTypeClass(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "undefined") return "undefined";
  return "string";
}

/** @param {(string|number)[]} path */
function pathEncode(path) {
  return encodeURIComponent(JSON.stringify(path));
}

/** 相对当前树根的路径 → 相对整条存储键根的绝对路径（用于放大子树内嵌套操作） */
function jsonCtxFullPath(ctx, relPath) {
  const p = ctx.pathPrefix || [];
  return [...p, ...relPath];
}

/** 树节点路径展示，如 botScoreGroups、a[0].name */
function formatJsonPathLabel(path) {
  if (path.length === 0) return "（根）";
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else {
      if (out !== "") out += ".";
      out += String(seg);
    }
  }
  return out;
}

/** 树中当前值 → 与 detectValueMeta 兼容的原始字符串 */
function jsonTreeValueToInitialRaw(cur) {
  if (cur === undefined) return "undefined";
  try {
    return JSON.stringify(cur);
  } catch (_e) {
    return String(cur);
  }
}

/**
 * @param {string} t typeSel.value
 * @param {HTMLTextAreaElement} ta
 * @param {null | (() => number)} readAddNum
 * @param {HTMLElement} modalBodyEl
 * @returns {{ ok: true, value: unknown } | { ok: false }}
 */
function readJsValueFromTypedValueForm(t, ta, readAddNum, modalBodyEl) {
  if (t === "null") return { ok: true, value: null };
  if (t === "json") {
    try {
      return {
        ok: true,
        value: JSON.parse(formatJsonForStorage(ta.value)),
      };
    } catch {
      setStatus("JSON 格式错误", true);
      return { ok: false };
    }
  }
  if (t === "boolean") {
    const chk = /** @type {HTMLInputElement | null} */ (
      modalBodyEl.querySelector('input[name="addBool"]:checked')
    );
    return { ok: true, value: chk?.value === "true" };
  }
  if (t === "number") {
    return { ok: true, value: readAddNum ? readAddNum() : 0 };
  }
  return { ok: true, value: ta.value };
}

/** 根路径 [] 时若当前根为对象/数组，新值须保持同类 */
function validateJsonPathResetValue(cur, path, newVal) {
  if (path.length !== 0) return true;
  if (cur !== null && typeof cur === "object") {
    const mustArray = Array.isArray(cur);
    if (mustArray && !Array.isArray(newVal)) {
      setStatus("根必须是 JSON 数组", true);
      return false;
    }
    if (
      !mustArray &&
      (newVal === null ||
        typeof newVal !== "object" ||
        Array.isArray(newVal))
    ) {
      setStatus("根必须是 JSON 对象", true);
      return false;
    }
  }
  return true;
}

/** @param {(string|number)[]} p */
function jsonEditActionsHtml(p) {
  const enc = pathEncode(p);
  return `<button type="button" class="btn-mini primary" data-json-act="mod" data-json-path="${enc}">修改</button>
      <button type="button" class="btn-mini" data-json-act="reset" data-json-path="${enc}">重置</button>
      <button type="button" class="btn-mini danger" data-json-act="del" data-json-path="${enc}">删除</button>
      <button type="button" class="btn-mini" data-json-act="cpy" data-json-path="${enc}">复制</button>`;
}

/** 长度为 0 的数组：无三角、无全展全收复制；根路径无「删除」 */
function jsonEmptyArrayActionsHtml(path) {
  const enc = pathEncode(path);
  const delBtn =
    path.length === 0
      ? ""
      : `<button type="button" class="btn-mini danger" data-json-act="del" data-json-path="${enc}">删除</button>`;
  return `<button type="button" class="btn-mini primary" data-json-act="mod" data-json-path="${enc}">修改</button>
      <button type="button" class="btn-mini" data-json-act="reset" data-json-path="${enc}">重置</button>
      ${delBtn}
      <button type="button" class="btn-mini primary" data-json-act="addarr" data-json-path="${enc}">加项</button>`;
}

/**
 * @param {HTMLTableRowElement} row
 * @param {boolean} isViewOnly true=查看模式
 */
function applyJsonViewMode(row, isViewOnly) {
  row.dataset.jsonViewOnly = isViewOnly ? "1" : "";
  const wrap = row.querySelector(".json-tree-wrap");
  if (wrap) wrap.classList.toggle("json-view-only", isViewOnly);
  row.querySelectorAll("[data-json-toolbar-edit-only]").forEach((n) => {
    /** @type {HTMLElement} */ (n).hidden = isViewOnly;
  });
}

function getGlobalJsonViewOnly() {
  const inp = /** @type {HTMLInputElement | null} */ (
    document.querySelector('input[name="jsonGlobalMode"]:checked')
  );
  if (inp) return inp.value !== "edit";
  return globalStorageViewOnly;
}

function applyGlobalJsonViewModeToAllRows() {
  const viewOnly = getGlobalJsonViewOnly();
  document
    .querySelectorAll("tr.kv-row:not(.json-magnify-modal-row) .json-tree-wrap")
    .forEach((wrap) => {
      const row = wrap.closest("tr.kv-row");
      if (row)
        applyJsonViewMode(/** @type {HTMLTableRowElement} */(row), viewOnly);
    });
  document.querySelectorAll("tr.kv-row [data-primitive-edit-only]").forEach(
    (n) => {
      /** @type {HTMLElement} */ (n).hidden = viewOnly;
    },
  );
}

/**
 * 用于判断数组元素结构是否一致（null 不参与比较）
 * @param {unknown} v
 */
function jsonShapeSignature(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[${v.map((x) => jsonShapeSignature(x)).join("|")}]`;
  }
  if (typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    const keys = Object.keys(o).sort();
    return `{${keys.map((k) => `${k}:${jsonShapeSignature(o[k])}`).join(",")}}`;
  }
  return typeof v;
}

/** 按样本生成同结构的占位默认值（嵌套数组/对象递归） */
function skeletonFromSample(v) {
  if (v === null) return null;
  if (Array.isArray(v)) {
    return v.map((item) => skeletonFromSample(item));
  }
  if (typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    const out = /** @type {Record<string, unknown>} */ ({});
    for (const k of Object.keys(o)) {
      out[k] = skeletonFromSample(o[k]);
    }
    return out;
  }
  if (typeof v === "number") return 0;
  if (typeof v === "boolean") return false;
  if (typeof v === "string") return "";
  return null;
}

/**
 * 新增数组项为对象时：数组字段默认 []，嵌套对象递归；标量按 0/""/false/null
 * @param {unknown} sample
 */
function newArrayItemObjectShell(sample) {
  if (sample === null || typeof sample !== "object" || Array.isArray(sample))
    return sample;
  const o = /** @type {Record<string, unknown>} */ (sample);
  const out = /** @type {Record<string, unknown>} */ ({});
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (Array.isArray(v)) out[k] = [];
    else if (v !== null && typeof v === "object")
      out[k] = newArrayItemObjectShell(v);
    else if (v === null) out[k] = null;
    else if (typeof v === "number") out[k] = 0;
    else if (typeof v === "boolean") out[k] = false;
    else if (typeof v === "string") out[k] = "";
    else out[k] = null;
  }
  return out;
}

/**
 * 草稿值与模板样本结构是否兼容（允许空数组 vs 非空样本数组）
 * @param {unknown} newVal
 * @param {unknown} sample
 */
function isStructureCompatible(newVal, sample) {
  if (sample === null) return newVal === null;
  if (Array.isArray(sample)) {
    if (!Array.isArray(newVal)) return false;
    if (sample.length === 0 || newVal.length === 0) return true;
    return isStructureCompatible(newVal[0], sample[0]);
  }
  if (typeof sample === "object") {
    if (newVal === null || typeof newVal !== "object" || Array.isArray(newVal))
      return false;
    const sk = Object.keys(sample).sort();
    const nk = Object.keys(/** @type {object} */(newVal)).sort();
    if (sk.length !== nk.length || sk.some((k, i) => k !== nk[i])) return false;
    const nv = /** @type {Record<string, unknown>} */ (newVal);
    const sv = /** @type {Record<string, unknown>} */ (sample);
    for (const k of sk) {
      if (!isStructureCompatible(nv[k], sv[k])) return false;
    }
    return true;
  }
  return typeof newVal === typeof sample;
}

/**
 * 判断数组里已有元素是否可视为同一模板（空数组与有元素的数组视为同构，与 isStructureCompatible 一致）
 * @param {unknown} a
 * @param {unknown} b
 */
function draftArrayElementsSameStructure(a, b) {
  return (
    isStructureCompatible(a, b) && isStructureCompatible(b, a)
  );
}

/**
 * 推断「数组加项」模板时：null / undefined / 空对象 {} / 空数组 [] 视为无固定结构占位，与 null 同等（不参与样本选取与同构判断）
 * @param {unknown} v
 */
function isDraftTemplatePlaceholder(v) {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v !== "object") return false;
  return Object.keys(/** @type {Record<string, unknown>} */ (v)).length === 0;
}

let draftFieldEditUid = 0;

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {unknown} sampleVal
 * @param {{ skind: 'local'|'session' | null; sk: string | null; root: unknown; renderRoot: () => void }} env
 */
function openDraftPrimitiveSubedit(obj, key, sampleVal, env) {
  const u = ++draftFieldEditUid;
  pushModalCancelLayer(() => env.renderRoot());
  el.modalBody.innerHTML = "";
  const backRow = document.createElement("div");
  backRow.className = "modal-row";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "btn-mini";
  back.textContent = "返回结构化编辑";
  back.addEventListener("click", () => modalCancelOrStepBack());
  backRow.appendChild(back);
  el.modalBody.appendChild(backRow);

  const cur = obj[key];

  if (typeof sampleVal === "number") {
    const readNum = mountNumberOrTimestampPicker(el.modalBody, cur, {
      src: `dftN${u}`,
      digits: `dftD${u}`,
    });
    modalOnOk = async () => {
      const n = readNum();
      if (typeof n !== "number") {
        setStatus("请输入数字", true);
        return false;
      }
      obj[key] = n;
      popModalCancelLayer();
      env.renderRoot();
      return false;
    };
  } else if (typeof sampleVal === "boolean") {
    const wrap = document.createElement("div");
    wrap.className = "modal-row";
    const opts = document.createElement("div");
    opts.className = "modal-bool-row";
    opts.innerHTML = `<label class="modal-bool-opt"><input type="radio" name="dftB${u}" value="true" ${cur ? "checked" : ""} /> true</label>
      <label class="modal-bool-opt"><input type="radio" name="dftB${u}" value="false" ${!cur ? "checked" : ""} /> false</label>`;
    wrap.appendChild(opts);
    el.modalBody.appendChild(wrap);
    modalOnOk = async () => {
      const inp = /** @type {HTMLInputElement | null} */ (
        el.modalBody.querySelector(`input[name="dftB${u}"]:checked`)
      );
      obj[key] = inp?.value === "true";
      popModalCancelLayer();
      env.renderRoot();
      return false;
    };
  } else if (typeof sampleVal === "string") {
    const ta = document.createElement("textarea");
    ta.className = "modal-text";
    ta.value = String(cur ?? "");
    el.modalBody.appendChild(ta);
    modalOnOk = async () => {
      obj[key] = ta.value;
      popModalCancelLayer();
      env.renderRoot();
      return false;
    };
  } else if (sampleVal === null) {
    const p = document.createElement("p");
    p.className = "modal-row";
    p.style.color = "#aaa";
    p.style.fontSize = "11px";
    p.textContent = "模板该字段为 null，请选择新类型并填写。";
    el.modalBody.appendChild(p);
    const read = mountNullishReplacementForm(el.modalBody, `dftNull${u}`);
    modalOnOk = async () => {
      const res = read();
      if (!res.ok) {
        setStatus(res.message, true);
        return false;
      }
      obj[key] = res.value;
      popModalCancelLayer();
      env.renderRoot();
      return false;
    };
  } else {
    const p = document.createElement("p");
    p.className = "modal-row";
    p.textContent = "该类型请返回后通过 JSON 树修改。";
    el.modalBody.appendChild(p);
    modalOnOk = async () => {
      popModalCancelLayer();
      env.renderRoot();
      return false;
    };
  }
}

/**
 * 嵌套数组内向「加项」推断元素样本（与 renderDraftObjectFields 数组加项一致）
 * @param {unknown[]} arr
 * @param {unknown[]} sampleArr
 */
function draftArrayAddItemSample(arr, sampleArr) {
  const nnDraft = arr.filter((x) => !isDraftTemplatePlaceholder(x));
  if (nnDraft.length > 0) return nnDraft[0];
  if (sampleArr.length > 0) return sampleArr[0];
  return undefined;
}

/**
 * 草稿结构化编辑：清空数组全部元素（保留数组）
 * @param {HTMLElement} row
 * @param {unknown[]} arr
 * @param {{ renderRoot: () => void }} env
 */
function mountDraftClearArrayChildrenButton(row, arr, env) {
  const clrB = document.createElement("button");
  clrB.type = "button";
  clrB.className = "btn-mini danger";
  clrB.textContent = "清空子项";
  clrB.title = "删除本数组内全部元素（数组本身保留）";
  clrB.addEventListener("click", () => {
    if (!confirm("确定清空该数组全部子项？")) return;
    arr.length = 0;
    env.renderRoot();
  });
  row.appendChild(clrB);
}

/**
 * 展开渲染数组的一项：[i] 行 + 子块；支持标量修改、整项删除、嵌套对象/数组
 * @param {unknown[]} arr
 * @param {number} i
 * @param {unknown} elemSample 父样本数组的首项形状（与同构模板一致）
 * @param {unknown[]} sampleArr 父级样本数组（用于空数组加项推断）
 * @param {HTMLElement} container
 * @param {{ skind: 'local'|'session' | null; sk: string | null; root: unknown; renderRoot: () => void }} env
 */
function renderDraftArrayElementRow(arr, i, elemSample, sampleArr, container, env) {
  const item = arr[i];
  const idxRow = document.createElement("div");
  idxRow.className = "draft-field-row draft-array-index-row";

  const idxSp = document.createElement("span");
  idxSp.className = "json-key";
  idxSp.textContent = `[${i}]: `;

  const delB = document.createElement("button");
  delB.type = "button";
  delB.className = "btn-mini danger";
  delB.textContent = "删除";
  delB.addEventListener("click", () => {
    arr.splice(i, 1);
    env.renderRoot();
  });

  if (item === null || item === undefined) {
    idxRow.appendChild(idxSp);
    const span = document.createElement("span");
    span.className = "json-value json-value-null";
    span.textContent = String(item);
    idxRow.appendChild(span);
    idxRow.appendChild(delB);
    container.appendChild(idxRow);
    return;
  }

  if (Array.isArray(item)) {
    idxRow.appendChild(idxSp);
    const sum = document.createElement("span");
    sum.className = "draft-summary";
    sum.textContent =
      item.length === 0 ? "[] 0 项" : `数组 · ${item.length} 项`;
    idxRow.appendChild(sum);
    const addB = document.createElement("button");
    addB.type = "button";
    addB.className = "btn-mini primary";
    addB.textContent = "加项";
    const innerElemSample =
      Array.isArray(elemSample) && elemSample.length > 0
        ? elemSample[0]
        : undefined;
    const innerSampleArr = Array.isArray(elemSample) ? elemSample : [];
    addB.addEventListener("click", () => {
      const elSample = draftArrayAddItemSample(item, innerSampleArr);
      openNestedEntryModal(null, env.skind, env.sk, [], true, {
        directParent: item,
        suppressPersist: true,
        onAfterMutate: env.renderRoot,
        onCancelRestore: env.renderRoot,
        arrayElementSample: elSample,
      });
    });
    idxRow.appendChild(addB);
    mountDraftClearArrayChildrenButton(idxRow, item, env);
    idxRow.appendChild(delB);
    container.appendChild(idxRow);
    const nest = document.createElement("div");
    nest.className = "draft-nested-block draft-array-items";
    for (let j = 0; j < item.length; j++) {
      renderDraftArrayElementRow(
        item,
        j,
        innerElemSample,
        innerSampleArr,
        nest,
        env,
      );
    }
    container.appendChild(nest);
    return;
  }

  if (typeof item === "object") {
    idxRow.appendChild(idxSp);
    const sum = document.createElement("span");
    sum.className = "draft-summary";
    sum.textContent = `object · ${Object.keys(/** @type {object} */(item)).length} 键`;
    idxRow.appendChild(sum);
    idxRow.appendChild(delB);
    container.appendChild(idxRow);
    const nest = document.createElement("div");
    nest.className = "draft-nested-block";
    const sampleObj =
      elemSample !== null &&
        typeof elemSample === "object" &&
        !Array.isArray(elemSample)
        ? /** @type {Record<string, unknown>} */ (elemSample)
        : /** @type {Record<string, unknown>} */ ({});
    renderDraftObjectFields(
      /** @type {Record<string, unknown>} */(item),
      sampleObj,
      nest,
      env,
    );
    container.appendChild(nest);
    return;
  }

  idxRow.appendChild(idxSp);
  const valSp = document.createElement("span");
  valSp.className =
    "json-value json-value-" + valueTypeClass(/** @type {unknown} */(item));
  valSp.textContent = formatJsonPrimitive(/** @type {unknown} */(item));
  idxRow.appendChild(valSp);
  const modB = document.createElement("button");
  modB.type = "button";
  modB.className = "btn-mini primary";
  modB.textContent = "修改";
  const sk =
    elemSample !== undefined && elemSample !== null ? elemSample : item;
  modB.addEventListener("click", () =>
    openDraftPrimitiveSubedit(arr, String(i), sk, env),
  );
  idxRow.appendChild(modB);
  idxRow.appendChild(delB);
  container.appendChild(idxRow);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {Record<string, unknown>} sampleObj
 * @param {HTMLElement} container
 * @param {{ skind: 'local'|'session' | null; sk: string | null; root: unknown; renderRoot: () => void }} env
 */
function renderDraftObjectFields(obj, sampleObj, container, env) {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    const s = sampleObj[key];
    const row = document.createElement("div");
    row.className = "draft-field-row";

    const keySp = document.createElement("span");
    keySp.className = "json-key";
    keySp.textContent = `"${key}": `;

    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      row.appendChild(keySp);
      const sum = document.createElement("span");
      sum.className = "draft-summary";
      sum.textContent = `object · ${Object.keys(v).length} 键`;
      row.appendChild(sum);
      container.appendChild(row);
      const nest = document.createElement("div");
      nest.className = "draft-nested-block";
      renderDraftObjectFields(
        /** @type {Record<string, unknown>} */(v),
        /** @type {Record<string, unknown>} */(s),
        nest,
        env,
      );
      container.appendChild(nest);
      continue;
    }

    if (Array.isArray(v)) {
      row.appendChild(keySp);
      const sum = document.createElement("span");
      sum.className = "draft-summary";
      sum.textContent =
        v.length === 0 ? "[] 0 项" : `数组 · ${v.length} 项（已展开）`;
      row.appendChild(sum);
      const addB = document.createElement("button");
      addB.type = "button";
      addB.className = "btn-mini primary";
      addB.textContent = "加项";
      const sampleArr = Array.isArray(s) ? s : [];
      addB.addEventListener("click", () => {
        const elSample = draftArrayAddItemSample(v, sampleArr);
        openNestedEntryModal(null, env.skind, env.sk, [], true, {
          directParent: v,
          suppressPersist: true,
          onAfterMutate: env.renderRoot,
          onCancelRestore: env.renderRoot,
          arrayElementSample: elSample,
        });
      });
      row.appendChild(addB);
      mountDraftClearArrayChildrenButton(row, v, env);
      container.appendChild(row);
      const nest = document.createElement("div");
      nest.className = "draft-nested-block draft-array-items";
      const elemSample = sampleArr.length > 0 ? sampleArr[0] : undefined;
      for (let ai = 0; ai < v.length; ai++) {
        renderDraftArrayElementRow(
          v,
          ai,
          elemSample,
          sampleArr,
          nest,
          env,
        );
      }
      container.appendChild(nest);
      continue;
    }

    row.appendChild(keySp);
    const valSp = document.createElement("span");
    valSp.className =
      "json-value json-value-" + valueTypeClass(/** @type {unknown} */(v));
    valSp.textContent = formatJsonPrimitive(/** @type {unknown} */(v));
    row.appendChild(valSp);
    const modB = document.createElement("button");
    modB.type = "button";
    modB.className = "btn-mini primary";
    modB.textContent = "修改";
    modB.addEventListener("click", () =>
      openDraftPrimitiveSubedit(obj, key, s, env),
    );
    row.appendChild(modB);
    container.appendChild(row);
  }
}

/**
 * @param {Record<string, unknown>} draft
 * @param {Record<string, unknown>} sample0
 * @param {unknown[]} arrParent
 * @param {unknown} root
 * @param {'local'|'session'} skind
 * @param {string} sk
 * @param {boolean} suppressPersist
 * @param {(() => void) | undefined} onAfterMutate
 * @param {(() => void) | undefined} onCancelRestore
 */
function mountDraftObjectTemplateModal(
  draft,
  sample0,
  arrParent,
  root,
  skind,
  sk,
  suppressPersist,
  onAfterMutate,
  onCancelRestore,
) {
  if (suppressPersist && typeof onCancelRestore === "function") {
    pushModalCancelLayer(onCancelRestore);
  }
  function renderRoot() {
    el.modalBody.innerHTML = "";
    const hint = document.createElement("p");
    hint.className = "modal-row";
    hint.style.cssText = "color:#aaa;font-size:11px";
    hint.textContent =
      "与 JSON 树一致：标量旁「修改」、数组项旁「修改/删除」；数组默认展开子项；数组旁「加项」与树上相同（确定本窗前不会写入存储）。";
    el.modalBody.appendChild(hint);
    const wrap = document.createElement("div");
    wrap.className = "draft-struct-editor";
    const env = {
      skind,
      sk,
      root,
      renderRoot,
    };
    renderDraftObjectFields(draft, sample0, wrap, env);
    el.modalBody.appendChild(wrap);
    modalOnOk = async () => {
      if (!isStructureCompatible(draft, sample0)) {
        setStatus("结构与现有项不一致", true);
        return false;
      }
      arrParent.push(/** @type {unknown} */(JSON.parse(JSON.stringify(draft))));
      if (!suppressPersist) {
        await persistKeyValue(skind, sk, JSON.stringify(root, null, 2));
      } else {
        if (typeof onCancelRestore === "function") {
          popModalCancelLayer();
        }
        onAfterMutate?.();
        return false;
      }
    };
  }
  renderRoot();
}

/**
 * @param {boolean} viewOnly
 * @param {HTMLElement} mountTo
 */
function mountStorageModeRadios(viewOnly, mountTo) {
  const wrap = document.createElement("span");
  wrap.className = "storage-mode-toggle";
  wrap.title = "控制所有存储项的修改类按钮是否显示";
  wrap.innerHTML = `<label class="storage-mode-label"><input type="radio" name="jsonGlobalMode" value="view" ${viewOnly ? "checked" : ""} /> 查看</label><label class="storage-mode-label"><input type="radio" name="jsonGlobalMode" value="edit" ${!viewOnly ? "checked" : ""} /> 修改</label>`;
  wrap.querySelectorAll('input[name="jsonGlobalMode"]').forEach((inp) => {
    inp.addEventListener("change", () => {
      const i = /** @type {HTMLInputElement} */ (inp);
      globalStorageViewOnly = i.value !== "edit";
      applyGlobalJsonViewModeToAllRows();
    });
  });
  mountTo.appendChild(wrap);
}

/**
 * @param {boolean} viewOnly
 * @param {HTMLElement} mountTo
 * @param {HTMLTableRowElement} synRow 需在 DOM 中且内含 .json-tree-wrap
 */
function mountMagnifyViewModeRadios(viewOnly, mountTo, synRow) {
  const wrap = document.createElement("span");
  wrap.className = "storage-mode-toggle";
  wrap.title = "仅控制本放大窗口内的 JSON 树（与列表顶栏无关）";
  wrap.innerHTML = `<label class="storage-mode-label"><input type="radio" name="jsonMagnifyMode" value="view" ${viewOnly ? "checked" : ""} /> 查看</label><label class="storage-mode-label"><input type="radio" name="jsonMagnifyMode" value="edit" ${!viewOnly ? "checked" : ""} /> 修改</label>`;
  wrap.querySelectorAll('input[name="jsonMagnifyMode"]').forEach((inp) => {
    inp.addEventListener("change", () => {
      const i = /** @type {HTMLInputElement} */ (inp);
      jsonMagnifyLocalViewOnly = i.value !== "edit";
      applyJsonViewMode(synRow, jsonMagnifyLocalViewOnly);
    });
  });
  mountTo.appendChild(wrap);
}

/**
 * @param {string} storageKey
 * @returns {HTMLTableRowElement | null}
 */
function findKvRowByStorageKey(storageKey) {
  for (const tr of document.querySelectorAll("tr.kv-row")) {
    if (tr.classList.contains("json-magnify-modal-row")) continue;
    if (tr.dataset.storageKey === storageKey)
      return /** @type {HTMLTableRowElement} */ (tr);
  }
  return null;
}

/**
 * 将 null/undefined 替换为其它类型（无 null/undefined 选项）
 * @param {HTMLElement} body
 * @param {string} suf
 * @returns {() => { ok: true, value: unknown } | { ok: false, message: string }}
 */
function mountNullishReplacementForm(body, suf) {
  const typeSel = document.createElement("select");
  typeSel.className = "modal-text";
  typeSel.innerHTML =
    '<option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option><option value="json">json</option>';

  const rowT = document.createElement("div");
  rowT.className = "modal-row";
  rowT.innerHTML = "<label>新类型</label>";
  rowT.appendChild(typeSel);

  const rowBool = document.createElement("div");
  rowBool.className = "modal-row";
  rowBool.style.display = "none";
  const boolLbl = document.createElement("label");
  boolLbl.textContent = "布尔值";
  boolLbl.style.display = "block";
  boolLbl.style.marginBottom = "6px";
  const boolOpts = document.createElement("div");
  boolOpts.className = "modal-bool-row";
  boolOpts.innerHTML = `<label class="modal-bool-opt"><input type="radio" name="repBool-${suf}" value="true" checked /> true</label><label class="modal-bool-opt"><input type="radio" name="repBool-${suf}" value="false" /> false</label>`;
  rowBool.appendChild(boolLbl);
  rowBool.appendChild(boolOpts);

  const ta = document.createElement("textarea");
  ta.className = "modal-text";
  ta.placeholder = "按类型填写";

  const numSlot = document.createElement("div");
  /** @type {null | (() => number)} */
  let readRepNum = null;

  const rowV = document.createElement("div");
  rowV.className = "modal-row";
  rowV.innerHTML = "<label>新值</label>";
  rowV.appendChild(ta);
  rowV.appendChild(numSlot);

  body.appendChild(rowT);
  body.appendChild(rowBool);
  body.appendChild(rowV);

  const sync = () => {
    const t = typeSel.value;
    if (t === "boolean") {
      rowBool.style.display = "";
      rowV.style.display = "none";
    } else {
      rowBool.style.display = "none";
      rowV.style.display = "";
    }
    if (t === "number") {
      ta.style.display = "none";
      numSlot.style.display = "";
      readRepNum = mountNumberOrTimestampPicker(numSlot, 0, {
        src: `repNumSrc-${suf}`,
        digits: `repNumDig-${suf}`,
      });
    } else if (t !== "boolean") {
      numSlot.innerHTML = "";
      numSlot.style.display = "none";
      readRepNum = null;
      ta.style.display = "";
    }
    if (t === "json") ta.placeholder = '{"a":1} 或 [1,2]';
    else if (t === "string") ta.placeholder = "文本";
  };
  typeSel.addEventListener("change", sync);
  sync();

  return () => {
    const t = typeSel.value;
    if (t === "json") {
      try {
        return { ok: true, value: JSON.parse(formatJsonForStorage(ta.value)) };
      } catch {
        return { ok: false, message: "JSON 格式错误" };
      }
    }
    if (t === "boolean") {
      const chk = /** @type {HTMLInputElement | null} */ (
        body.querySelector(`input[name="repBool-${suf}"]:checked`)
      );
      return { ok: true, value: chk?.value === "true" };
    }
    if (t === "number") {
      return { ok: true, value: readRepNum ? readRepNum() : 0 };
    }
    return { ok: true, value: ta.value };
  };
}

/** @param {unknown} root @param {(string|number)[]} path */
function getAtPath(root, path) {
  let cur = root;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = /** @type {Record<string|number, unknown>} */ (cur)[seg];
  }
  return cur;
}

/** @param {unknown} root @param {(string|number)[]} path @param {unknown} newVal */
function setAtPath(root, path, newVal) {
  if (path.length === 0) return newVal;
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    cur = /** @type {Record<string|number, unknown>} */ (cur)[path[i]];
  }
  const last = path[path.length - 1];
  /** @type {Record<string|number, unknown>} */ (cur)[last] = newVal;
  return root;
}

/** @param {unknown} root @param {(string|number)[]} path */
function deleteAtPath(root, path) {
  if (path.length === 0) throw new Error("不能删除根");
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    cur = /** @type {Record<string|number, unknown>} */ (cur)[path[i]];
  }
  const last = path[path.length - 1];
  if (Array.isArray(cur)) {
    cur.splice(Number(last), 1);
  } else {
    delete /** @type {Record<string|number, unknown>} */ (cur)[last];
  }
  return root;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus("已复制到剪贴板");
  } catch {
    setStatus("复制失败（浏览器权限）", true);
  }
}

/**
 * @param {'local'|'session'} kind
 * @param {string} key
 * @param {string} value
 */
async function persistKeyValue(kind, key, value) {
  const fid = getSelectedFrame();
  if (fid == null) throw new Error("未选择页面");
  setStatus("保存中…");
  const res = await send("storageSet", {
    frameId: fid,
    kind: kind === "session" ? "session" : "local",
    key,
    value,
  });
  if (!res.ok) throw new Error(res.error || "保存失败");
  setStatus("已保存");
  await refresh();
  if (reopenMagnifyAfterNestedPersist) {
    reopenMagnifyAfterNestedPersist = false;
    modalCancelOrStepBack();
    suppressModalCloseOnce = true;
  } else if (typeof jsonMagnifyRemounter === "function") {
    try {
      jsonMagnifyRemounter();
    } catch (_e) {
      /* 子弹窗替换 modalBody 时子节点可能已卸载 */
    }
  }
}

/**
 * @typedef {{
 *   row: HTMLTableRowElement,
 *   fieldQuery: string,
 *   pathPrefix?: (string|number)[],
 * }} JsonTreeCtx
 */

/**
 * @param {HTMLElement} container
 * @param {unknown} value
 * @param {number} depth
 * @param {string | null} keyName
 * @param {(string|number)[]} path
 * @param {JsonTreeCtx} ctx
 */
function renderJsonValue(container, value, depth, keyName, path, ctx) {
  const fieldQuery = ctx.fieldQuery || "";
  const isArr = Array.isArray(value);
  const isObj = value !== null && typeof value === "object" && !isArr;

  if (isArr && value.length === 0) {
    const line = document.createElement("div");
    line.className = "json-tree-leaf json-tree-empty-array-row";
    line.style.paddingLeft = depth * 12 + "px";

    if (keyName !== null) {
      const keySpan = document.createElement("span");
      keySpan.className = "json-key";
      if (keyName.startsWith("[") && keyName.endsWith("]")) {
        keySpan.textContent = `${keyName}: `;
      } else if (fieldQuery) {
        keySpan.innerHTML = jsonKeySpanHtml(keyName, fieldQuery);
      } else {
        keySpan.textContent = `"${keyName}": `;
      }
      line.appendChild(keySpan);
    }

    const valSpan = document.createElement("span");
    valSpan.className = "json-value json-empty-bracket";
    valSpan.textContent = "[]";
    line.appendChild(valSpan);

    const act = document.createElement("span");
    act.className = "json-node-actions json-json-edit-btns";
    act.innerHTML = jsonEmptyArrayActionsHtml(jsonCtxFullPath(ctx, path));
    line.appendChild(act);
    container.appendChild(line);
    return;
  }

  if (isObj || isArr) {
    const block = document.createElement("div");
    block.className = "json-tree-node";
    block.style.paddingLeft = depth * 12 + "px";

    const head = document.createElement("div");
    head.className = "json-tree-branch-head";

    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "json-caret";
    caret.setAttribute("aria-expanded", "false");
    caret.textContent = "▶";

    if (keyName !== null) {
      const keySpan = document.createElement("span");
      keySpan.className = "json-key";
      if (keyName.startsWith("[") && keyName.endsWith("]")) {
        keySpan.textContent = `${keyName}: `;
      } else if (fieldQuery) {
        keySpan.innerHTML = jsonKeySpanHtml(keyName, fieldQuery);
      } else {
        keySpan.textContent = `"${keyName}": `;
      }
      head.appendChild(keySpan);
    }

    head.appendChild(caret);

    const summary = document.createElement("span");
    summary.className = "json-summary";
    if (isArr) {
      summary.textContent = `[...] ${value.length} 项`;
    } else {
      const n = Object.keys(/** @type {object} */(value)).length;
      summary.textContent = `object · ${n} 键`;
    }
    head.appendChild(summary);

    const showSubtreeDetail =
      (isArr && value.length > 0) ||
      (isObj && Object.keys(/** @type {object} */(value)).length > 0);
    if (showSubtreeDetail) {
      const det = document.createElement("button");
      det.type = "button";
      det.className = "btn-mini primary";
      det.textContent = "详情";
      det.title = "放大查看/编辑此对象或数组（与工具栏「详情」相同）";
      det.dataset.jsonAct = "magnifysub";
      det.dataset.jsonPath = pathEncode(jsonCtxFullPath(ctx, path));
      head.appendChild(det);
    }

    const editBtns = document.createElement("span");
    editBtns.className = "json-json-edit-btns json-branch-edit-cluster";

    const expAll = document.createElement("button");
    expAll.type = "button";
    expAll.className = "btn-mini";
    expAll.textContent = "全展";
    expAll.title = "展开此节点及以下全部层级";
    expAll.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setSubtreeExpanded(block, true);
    });
    editBtns.appendChild(expAll);
    const colAll = document.createElement("button");
    colAll.type = "button";
    colAll.className = "btn-mini";
    colAll.textContent = "全收";
    colAll.title = "收起此节点及以下全部层级";
    colAll.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setSubtreeExpanded(block, false);
    });
    editBtns.appendChild(colAll);

    if (isObj) {
      const addK = document.createElement("button");
      addK.type = "button";
      addK.className = "btn-mini primary";
      addK.textContent = "加键";
      addK.dataset.jsonAct = "addchild";
      addK.dataset.jsonPath = pathEncode(jsonCtxFullPath(ctx, path));
      editBtns.appendChild(addK);
    }
    if (isArr) {
      const addA = document.createElement("button");
      addA.type = "button";
      addA.className = "btn-mini primary";
      addA.textContent = "加项";
      addA.dataset.jsonAct = "addarr";
      addA.dataset.jsonPath = pathEncode(jsonCtxFullPath(ctx, path));
      editBtns.appendChild(addA);
      const clrA = document.createElement("button");
      clrA.type = "button";
      clrA.className = "btn-mini danger";
      clrA.textContent = "清空子项";
      clrA.title = "删除数组内全部元素（保留该数组）";
      clrA.dataset.jsonAct = "clrarr";
      clrA.dataset.jsonPath = pathEncode(jsonCtxFullPath(ctx, path));
      editBtns.appendChild(clrA);
    }

    const actWrap = document.createElement("span");
    actWrap.className = "json-node-actions";
    actWrap.innerHTML = jsonEditActionsHtml(jsonCtxFullPath(ctx, path));
    editBtns.appendChild(actWrap);
    head.appendChild(editBtns);

    const childBox = document.createElement("div");
    childBox.className = "json-tree-children";

    if (isArr) {
      /** @type {unknown[]} */
      const arr = value;
      arr.forEach((item, i) => {
        renderJsonValue(childBox, item, depth + 1, `[${i}]`, [...path, i], ctx);
      });
    } else {
      for (const k of Object.keys(/** @type {object} */(value))) {
        renderJsonValue(
          childBox,
          /** @type {Record<string, unknown>} */(value)[k],
          depth + 1,
          k,
          [...path, k],
          ctx,
        );
      }
    }

    const shouldAutoExpand =
      !!fieldQuery && jsonFieldNameMatches(value, fieldQuery);
    childBox.hidden = !shouldAutoExpand;
    caret.setAttribute("aria-expanded", shouldAutoExpand ? "true" : "false");
    caret.textContent = shouldAutoExpand ? "▼" : "▶";

    caret.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const ex = caret.getAttribute("aria-expanded") === "true";
      childBox.hidden = ex;
      caret.setAttribute("aria-expanded", ex ? "false" : "true");
      caret.textContent = ex ? "▶" : "▼";
    });

    block.appendChild(head);
    block.appendChild(childBox);
    container.appendChild(block);
    return;
  }

  const line = document.createElement("div");
  line.className = "json-tree-leaf";
  line.style.paddingLeft = depth * 12 + "px";
  const keySpan = document.createElement("span");
  keySpan.className = "json-key";
  if (keyName !== null) {
    if (keyName.startsWith("[") && keyName.endsWith("]")) {
      keySpan.textContent = `${keyName}: `;
    } else if (fieldQuery) {
      keySpan.innerHTML = jsonKeySpanHtml(keyName, fieldQuery);
    } else {
      keySpan.textContent = `"${keyName}": `;
    }
  }
  const valSpan = document.createElement("span");
  valSpan.className = "json-value json-value-" + valueTypeClass(value);
  valSpan.textContent = formatJsonPrimitive(value);
  line.appendChild(keySpan);
  line.appendChild(valSpan);
  const act = document.createElement("span");
  act.className = "json-node-actions json-json-edit-btns";
  act.innerHTML = jsonEditActionsHtml(jsonCtxFullPath(ctx, path));
  line.appendChild(act);
  container.appendChild(line);
}

/**
 * @param {HTMLElement} rootEl
 * @param {unknown} root
 * @param {HTMLTableRowElement} row
 * @param {{
 *   resolveActionRow?: () => HTMLTableRowElement | null | undefined;
 *   isMagnifyUi?: boolean;
 *   magnifyPathPrefix?: (string|number)[];
 * }} [hooks] 放大弹窗内：写操作落在列表中的真实 kv 行上
 */
function renderJsonRoot(rootEl, root, row, hooks) {
  rootEl.innerHTML = "";
  const ctx = {
    row,
    fieldQuery: getFieldSearchQuery(),
    pathPrefix: hooks?.magnifyPathPrefix ?? [],
  };
  rootEl.onclick = (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest("[data-json-act]");
    if (!btn || !rootEl.contains(btn)) return;
    const act = btn.getAttribute("data-json-act");
    const enc = btn.getAttribute("data-json-path");
    if (!enc || !act) return;
    let path;
    try {
      path = /** @type {(string|number)[]} */ (JSON.parse(decodeURIComponent(enc)));
    } catch {
      return;
    }
    const actionRow =
      hooks && typeof hooks.resolveActionRow === "function"
        ? hooks.resolveActionRow() || row
        : row;
    void handleJsonTreeAction(
      actionRow,
      act,
      path,
      !!hooks?.isMagnifyUi,
    );
  };

  if (Array.isArray(root)) {
    if (root.length === 0) {
      const line = document.createElement("div");
      line.className = "json-tree-leaf json-tree-empty-array-row";
      const valSpan = document.createElement("span");
      valSpan.className = "json-value json-empty-bracket";
      valSpan.textContent = "[]";
      line.appendChild(valSpan);
      const act = document.createElement("span");
      act.className = "json-node-actions json-json-edit-btns";
      act.innerHTML = jsonEmptyArrayActionsHtml(jsonCtxFullPath(ctx, []));
      line.appendChild(act);
      rootEl.appendChild(line);
      return;
    }
    root.forEach((item, i) => {
      renderJsonValue(rootEl, item, 0, `[${i}]`, [i], ctx);
    });
    return;
  }
  if (root !== null && typeof root === "object") {
    const keys = Object.keys(/** @type {object} */(root));
    if (keys.length === 0) {
      const empty = document.createElement("div");
      empty.className = "json-summary";
      empty.textContent = "（空对象）";
      rootEl.appendChild(empty);
      return;
    }
    for (const k of keys) {
      renderJsonValue(
        rootEl,
        /** @type {Record<string, unknown>} */(root)[k],
        0,
        k,
        [k],
        ctx,
      );
    }
    return;
  }
  const line = document.createElement("div");
  line.className = "json-tree-leaf";
  const valSpan = document.createElement("span");
  valSpan.className = "json-value json-value-" + valueTypeClass(root);
  valSpan.textContent = formatJsonPrimitive(root);
  line.appendChild(valSpan);
  const act = document.createElement("span");
  act.className = "json-node-actions json-json-edit-btns";
  const enc0 = pathEncode(jsonCtxFullPath(ctx, []));
  act.innerHTML = `<button type="button" class="btn-mini primary" data-json-act="mod" data-json-path="${enc0}">修改</button>
      <button type="button" class="btn-mini" data-json-act="reset" data-json-path="${enc0}">重置</button>
      <button type="button" class="btn-mini" data-json-act="cpy" data-json-path="${enc0}">复制</button>`;
  line.appendChild(act);
  rootEl.appendChild(line);
}

/**
 * @param {HTMLTableRowElement} row
 * @param {string} act
 * @param {(string|number)[]} path
 * @param {boolean} [useMagnifyViewGate] 来自放大弹窗树时，以弹窗内单选为准，不读列表行 dataset
 */
async function handleJsonTreeAction(row, act, path, useMagnifyViewGate = false) {
  /** @type {{ _cocoJsonParsed?: unknown }} */
  const r = row;
  const root = r._cocoJsonParsed;
  if (root === undefined) {
    setStatus("数据未加载", true);
    return;
  }
  const sk = row.dataset.storageKey;
  const skind = /** @type {'local'|'session'} */ (row.dataset.storageKind);
  if (!sk) return;

  if (act === "magnifysub") {
    const baseRow = findKvRowByStorageKey(sk) || row;
    const fullRoot = /** @type {{ _cocoJsonParsed?: unknown }} */ (baseRow)
      ._cocoJsonParsed;
    if (fullRoot === undefined) {
      setStatus("无法打开详情", true);
      return;
    }
    const sub = getAtPath(fullRoot, path);
    if (sub === undefined || sub === null || typeof sub !== "object") {
      setStatus("无法打开详情", true);
      return;
    }
    if (Array.isArray(sub)) {
      if (sub.length === 0) return;
    } else if (Object.keys(/** @type {object} */(sub)).length === 0) {
      return;
    }
    openWholeKeyJsonEditorModal(skind, sk, baseRow, path);
    return;
  }

  const viewLocked = useMagnifyViewGate
    ? jsonMagnifyLocalViewOnly
    : row.dataset.jsonViewOnly === "1";
  const editAct =
    act === "mod" ||
    act === "reset" ||
    act === "del" ||
    act === "addchild" ||
    act === "addarr" ||
    act === "clrarr";
  if (viewLocked && editAct) {
    setStatus("请切换到「修改」模式后再编辑", true);
    return;
  }

  const cur = getAtPath(root, path);

  if (act === "cpy") {
    await copyText(JSON.stringify(cur));
    return;
  }

  if (act === "del") {
    if (!confirm("确定删除该键/项？")) return;
    try {
      deleteAtPath(root, path);
      await persistKeyValue(skind, sk, JSON.stringify(root, null, 2));
    } catch (e) {
      setStatus(e && e.message ? e.message : String(e), true);
    }
    return;
  }

  if (act === "addchild") {
    const parent = getAtPath(root, path);
    if (
      parent === undefined ||
      parent === null ||
      typeof parent !== "object" ||
      Array.isArray(parent)
    ) {
      setStatus("只能向对象添加键", true);
      return;
    }
    if (typeof jsonMagnifyRemounter === "function") {
      const _mp = jsonMagnifySubtreePath ? jsonMagnifySubtreePath.slice() : [];
      pushModalCancelLayer(() =>
        buildMagnifyModalBody(skind, sk, undefined, _mp),
      );
      jsonMagnifyRemounter = null;
      reopenMagnifyAfterNestedPersist = true;
    }
    openNestedEntryModal(row, skind, sk, path, false);
    return;
  }

  if (act === "addarr") {
    const parent = getAtPath(root, path);
    if (!Array.isArray(parent)) {
      setStatus("只能向数组添加项", true);
      return;
    }
    if (typeof jsonMagnifyRemounter === "function") {
      const _mp = jsonMagnifySubtreePath ? jsonMagnifySubtreePath.slice() : [];
      pushModalCancelLayer(() =>
        buildMagnifyModalBody(skind, sk, undefined, _mp),
      );
      jsonMagnifyRemounter = null;
      reopenMagnifyAfterNestedPersist = true;
    }
    openNestedEntryModal(row, skind, sk, path, true);
    return;
  }

  if (act === "clrarr") {
    const parent = getAtPath(root, path);
    if (!Array.isArray(parent)) {
      setStatus("只能清空数组", true);
      return;
    }
    if (parent.length === 0) {
      setStatus("数组已为空");
      return;
    }
    if (!confirm(`确定清空该数组内全部 ${parent.length} 项？`)) return;
    try {
      parent.length = 0;
      await persistKeyValue(skind, sk, JSON.stringify(root, null, 2));
    } catch (e) {
      setStatus(e && e.message ? e.message : String(e), true);
    }
    return;
  }

  if (act === "mod") {
    const fromMag = typeof jsonMagnifyRemounter === "function";
    if (fromMag) {
      const _mp = jsonMagnifySubtreePath ? jsonMagnifySubtreePath.slice() : [];
      pushModalCancelLayer(() =>
        buildMagnifyModalBody(skind, sk, undefined, _mp),
      );
      jsonMagnifyRemounter = null;
    }
    await openModifyJsonAtPath(row, path, cur, skind, sk, {
      magnifyNested: fromMag,
    });
    return;
  }

  if (act === "reset") {
    const fromMag = typeof jsonMagnifyRemounter === "function";
    if (fromMag) {
      const _mp = jsonMagnifySubtreePath ? jsonMagnifySubtreePath.slice() : [];
      pushModalCancelLayer(() =>
        buildMagnifyModalBody(skind, sk, undefined, _mp),
      );
      jsonMagnifyRemounter = null;
    }
    openJsonPathResetModal(row, path, cur, skind, sk, {
      magnifyNested: fromMag,
    });
  }
}

/**
 * JSON 树内某路径重置：与「新增键值」相同的值类型 + 值表单（路径只读）
 * @param {HTMLTableRowElement} row
 * @param {(string|number)[]} path
 * @param {unknown} cur
 * @param {'local'|'session'} skind
 * @param {string} sk
 * @param {{ magnifyNested?: boolean }} [opt]
 */
function openJsonPathResetModal(row, path, cur, skind, sk, opt = {}) {
  const mag = !!opt.magnifyNested;
  function afterPersistMagnify() {
    if (mag) {
      modalCancelOrStepBack();
      return false;
    }
    return undefined;
  }

  const pathLabel = formatJsonPathLabel(path);
  el.modalTitle.textContent =
    path.length === 0 ? "重置根值" : `重置字段 · ${pathLabel}`;
  el.modalBody.innerHTML = "";

  const rowP = document.createElement("div");
  rowP.className = "modal-row";
  const lblP = document.createElement("label");
  lblP.textContent = "路径（固定）";
  const pathInp = document.createElement("input");
  pathInp.type = "text";
  pathInp.className = "modal-text";
  pathInp.readOnly = true;
  pathInp.value = pathLabel;
  pathInp.title = "对应 JSON 树中的位置，不可更改";
  rowP.appendChild(lblP);
  rowP.appendChild(pathInp);
  el.modalBody.appendChild(rowP);

  const typeSel = document.createElement("select");
  typeSel.className = "modal-text";
  typeSel.innerHTML =
    '<option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option><option value="json">json</option><option value="null">null</option>';
  const ta = document.createElement("textarea");
  ta.className = "modal-text";
  ta.placeholder = "按类型填写值";
  const rowBool = document.createElement("div");
  rowBool.className = "modal-row";
  rowBool.style.display = "none";
  const boolLblAdd = document.createElement("label");
  boolLblAdd.textContent = "布尔值";
  boolLblAdd.style.display = "block";
  boolLblAdd.style.marginBottom = "6px";
  const boolOptsAdd = document.createElement("div");
  boolOptsAdd.className = "modal-bool-row";
  boolOptsAdd.innerHTML =
    '<label class="modal-bool-opt"><input type="radio" name="addBool" value="true" checked /> true</label><label class="modal-bool-opt"><input type="radio" name="addBool" value="false" /> false</label>';
  rowBool.appendChild(boolLblAdd);
  rowBool.appendChild(boolOptsAdd);

  const numSlotAdd = document.createElement("div");
  /** @type {null | (() => number)} */
  let readAddNum = null;
  let initialNum = 0;

  const rowT = document.createElement("div");
  rowT.className = "modal-row";
  rowT.innerHTML = "<label>值类型</label>";
  rowT.appendChild(typeSel);
  const rowV = document.createElement("div");
  rowV.className = "modal-row";
  rowV.innerHTML = "<label>值</label>";
  rowV.appendChild(ta);
  rowV.appendChild(numSlotAdd);
  el.modalBody.appendChild(rowT);
  el.modalBody.appendChild(rowBool);
  el.modalBody.appendChild(rowV);

  const initialRaw = jsonTreeValueToInitialRaw(cur);
  {
    const meta = detectValueMeta(String(initialRaw));
    typeSel.value = addKeyTypeSelectValueFromMeta(meta);
    if (meta.kind === "number") {
      initialNum = coerceToNumber(String(initialRaw).trim());
    }
  }

  const syncPlaceholder = () => {
    const t = typeSel.value;
    if (t === "null") {
      rowBool.style.display = "none";
      rowV.style.display = "none";
      numSlotAdd.innerHTML = "";
      numSlotAdd.style.display = "none";
      readAddNum = null;
      return;
    }
    if (t === "boolean") {
      rowBool.style.display = "";
      rowV.style.display = "none";
    } else {
      rowBool.style.display = "none";
      rowV.style.display = "";
    }
    if (t === "number") {
      ta.style.display = "none";
      numSlotAdd.style.display = "";
      readAddNum = mountNumberOrTimestampPicker(numSlotAdd, initialNum, {
        src: "pathResetNumSrc",
        digits: "pathResetNumDig",
      });
    } else if (t !== "boolean") {
      numSlotAdd.innerHTML = "";
      numSlotAdd.style.display = "none";
      readAddNum = null;
      ta.style.display = "";
    }
    if (t === "json") {
      ta.placeholder = '{"a":1} 或 [1,2]';
    } else if (t === "string") {
      ta.placeholder = "任意文本";
    }
  };
  typeSel.addEventListener("change", syncPlaceholder);
  syncPlaceholder();

  {
    const t = typeSel.value;
    if (t === "json") {
      try {
        const p = JSON.parse(String(initialRaw).trim());
        ta.value = JSON.stringify(p, null, 2);
      } catch {
        ta.value = String(initialRaw);
      }
    } else if (t === "string") {
      ta.value = typeof cur === "string" ? cur : String(initialRaw);
    } else if (t === "boolean") {
      const v = String(initialRaw).trim() === "true";
      const inp = /** @type {HTMLInputElement | null} */ (
        el.modalBody.querySelector(
          `input[name="addBool"][value="${v ? "true" : "false"}"]`,
        )
      );
      if (inp) inp.checked = true;
    }
  }

  modalOnOk = async () => {
    const t = typeSel.value;
    const parsed = readJsValueFromTypedValueForm(
      t,
      ta,
      readAddNum,
      el.modalBody,
    );
    if (!parsed.ok) return false;
    if (!validateJsonPathResetValue(cur, path, parsed.value)) return false;

    const r = /** @type {{ _cocoJsonParsed?: unknown }} */ (row);
    const root = r._cocoJsonParsed;
    if (path.length === 0) {
      r._cocoJsonParsed = parsed.value;
    } else {
      setAtPath(root, path, parsed.value);
    }
    await persistKeyValue(
      skind,
      sk,
      JSON.stringify(r._cocoJsonParsed, null, 2),
    );
    return afterPersistMagnify();
  };

  el.modalBackdrop.hidden = false;
}

/**
 * @param {HTMLTableRowElement} row
 * @param {(string|number)[]} path
 * @param {unknown} cur
 * @param {'local'|'session'} skind
 * @param {string} sk
 * @param {{ magnifyNested?: boolean }} [opt]
 */
async function openModifyJsonAtPath(row, path, cur, skind, sk, opt = {}) {
  el.modalTitle.textContent =
    path.length === 0 ? "修改根（整段 JSON）" : "修改值";
  el.modalBody.innerHTML = "";

  const mag = !!opt.magnifyNested;
  function afterPersistMagnify() {
    if (mag) {
      modalCancelOrStepBack();
      return false;
    }
    return undefined;
  }

  const isBool = typeof cur === "boolean";
  const isNum = typeof cur === "number";
  const isStr = typeof cur === "string";
  const isNull = cur === null;
  const isUndef = typeof cur === "undefined";
  const isObj = cur !== null && typeof cur === "object";

  if (isObj) {
    const ta = document.createElement("textarea");
    ta.className = "modal-text";
    ta.value = JSON.stringify(cur, null, 2);
    el.modalBody.appendChild(ta);
    const mustBeArray = Array.isArray(cur);
    const mustBePlainObject =
      cur !== null && typeof cur === "object" && !mustBeArray;
    modalOnOk = async () => {
      let parsed;
      try {
        parsed = JSON.parse(ta.value);
      } catch (e) {
        setStatus("JSON 格式错误", true);
        return false;
      }
      if (mustBeArray) {
        if (!Array.isArray(parsed)) {
          setStatus("修改错误：此处必须是 JSON 数组", true);
          return false;
        }
      } else if (mustBePlainObject) {
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          setStatus("修改错误：此处必须是 JSON 对象", true);
          return false;
        }
      }
      /** @type {{ _cocoJsonParsed?: unknown }} */
      const r = row;
      const root = r._cocoJsonParsed;
      if (path.length === 0) {
        r._cocoJsonParsed = parsed;
      } else {
        setAtPath(root, path, parsed);
      }
      await persistKeyValue(
        skind,
        sk,
        JSON.stringify(r._cocoJsonParsed, null, 2),
      );
      return afterPersistMagnify();
    };
  } else if (isBool) {
    const wrap = document.createElement("div");
    wrap.className = "modal-row";
    const lbl = document.createElement("label");
    lbl.textContent = "布尔值";
    lbl.style.display = "block";
    lbl.style.marginBottom = "6px";
    const opts = document.createElement("div");
    opts.className = "modal-bool-row";
    opts.innerHTML = `<label class="modal-bool-opt"><input type="radio" name="bv" value="true" ${cur ? "checked" : ""} /> true</label>
      <label class="modal-bool-opt"><input type="radio" name="bv" value="false" ${!cur ? "checked" : ""} /> false</label>`;
    wrap.appendChild(lbl);
    wrap.appendChild(opts);
    el.modalBody.appendChild(wrap);
    modalOnOk = async () => {
      const v = /** @type {HTMLInputElement | null} */ (
        el.modalBody.querySelector('input[name="bv"]:checked')
      );
      const b = v?.value === "true";
      const r = /** @type {{ _cocoJsonParsed?: unknown }} */ (row);
      const root = r._cocoJsonParsed;
      if (path.length === 0) {
        r._cocoJsonParsed = b;
      } else {
        setAtPath(root, path, b);
      }
      await persistKeyValue(
        skind,
        sk,
        JSON.stringify(r._cocoJsonParsed, null, 2),
      );
      return afterPersistMagnify();
    };
  } else if (isNum) {
    const readNum = mountNumberOrTimestampPicker(el.modalBody, cur, {
      src: "modNumSrc",
      digits: "modNumDig",
    });
    modalOnOk = async () => {
      const n = readNum();
      const r = /** @type {{ _cocoJsonParsed?: unknown }} */ (row);
      const root = r._cocoJsonParsed;
      if (path.length === 0) {
        r._cocoJsonParsed = n;
      } else {
        setAtPath(root, path, n);
      }
      await persistKeyValue(
        skind,
        sk,
        JSON.stringify(r._cocoJsonParsed, null, 2),
      );
      return afterPersistMagnify();
    };
  } else if (isStr) {
    const ta = document.createElement("textarea");
    ta.className = "modal-text";
    ta.value = cur;
    el.modalBody.appendChild(ta);
    modalOnOk = async () => {
      const r = /** @type {{ _cocoJsonParsed?: unknown }} */ (row);
      const root = r._cocoJsonParsed;
      if (path.length === 0) {
        r._cocoJsonParsed = ta.value;
      } else {
        setAtPath(root, path, ta.value);
      }
      await persistKeyValue(
        skind,
        sk,
        JSON.stringify(r._cocoJsonParsed, null, 2),
      );
      return afterPersistMagnify();
    };
  } else if (isNull || isUndef) {
    const hint = document.createElement("p");
    hint.className = "modal-row";
    hint.style.cssText = "color:#aaa;font-size:11px;margin-bottom:8px";
    hint.textContent = isUndef
      ? "当前值为 undefined，请选择新类型并填写值（不可为 null / undefined）。"
      : "当前为 null，请选择新类型并填写值（不可为 null / undefined）。";
    el.modalBody.appendChild(hint);
    const read = mountNullishReplacementForm(el.modalBody, "jsonPath");
    modalOnOk = async () => {
      const res = read();
      if (!res.ok) {
        setStatus(res.message, true);
        return false;
      }
      const r = /** @type {{ _cocoJsonParsed?: unknown }} */ (row);
      const root = r._cocoJsonParsed;
      if (path.length === 0) {
        r._cocoJsonParsed = res.value;
      } else {
        setAtPath(root, path, res.value);
      }
      await persistKeyValue(
        skind,
        sk,
        JSON.stringify(r._cocoJsonParsed, null, 2),
      );
      return afterPersistMagnify();
    };
  } else {
    const ta = document.createElement("textarea");
    ta.className = "modal-text";
    ta.value = JSON.stringify(cur);
    el.modalBody.appendChild(ta);
    modalOnOk = async () => {
      let parsed;
      try {
        parsed = JSON.parse(ta.value);
      } catch (e) {
        setStatus("JSON 无效", true);
        return false;
      }
      const r = /** @type {{ _cocoJsonParsed?: unknown }} */ (row);
      const root = r._cocoJsonParsed;
      if (path.length === 0) {
        r._cocoJsonParsed = parsed;
      } else {
        setAtPath(root, path, parsed);
      }
      await persistKeyValue(
        skind,
        sk,
        JSON.stringify(r._cocoJsonParsed, null, 2),
      );
      return afterPersistMagnify();
    };
  }

  el.modalBackdrop.hidden = false;
}

/**
 * 详情弹窗内返回上一级（同一存储键下的子路径）
 */
function magnifyNavigateBack() {
  if (magnifyNavStack.length === 0) return;
  const prev = magnifyNavStack.pop();
  const row = findKvRowByStorageKey(prev.storageKey);
  if (!row || row._cocoJsonParsed === undefined) {
    setStatus("列表中找不到该键，无法返回", true);
    magnifyNavStack.push(prev);
    return;
  }
  const titleBase = formatStorageKeyForDisplay(prev.storageKey);
  el.modalTitle.textContent =
    prev.subtreePath.length > 0
      ? `${titleBase} · ${formatJsonPathLabel(prev.subtreePath)}`
      : titleBase;
  el.modalBody.classList.add("modal-body-magnify");
  buildMagnifyModalBody(prev.kind, prev.storageKey, row, prev.subtreePath);
  modalOnOk = async () => {};
}

/**
 * 构建 JSON 放大弹窗主体（整条键或子树）；查看/修改仅本弹窗有效
 * @param {'local'|'session'} kind
 * @param {string} storageKey
 * @param {HTMLTableRowElement | null | undefined} [sourceRow] 首次打开时用于兜底解析引用
 * @param {(string|number)[]} [subtreePathFromStorageRoot] 非空时只展示并编辑该路径下的子对象/数组
 */
function buildMagnifyModalBody(
  kind,
  storageKey,
  sourceRow,
  subtreePathFromStorageRoot = [],
) {
  jsonMagnifyActiveKind = kind;
  jsonMagnifyActiveKey = storageKey;
  reopenMagnifyAfterNestedPersist = false;
  jsonMagnifySubtreePath =
    subtreePathFromStorageRoot.length > 0
      ? subtreePathFromStorageRoot.slice()
      : null;
  el.modalBody.innerHTML = "";
  const scrollHost = document.createElement("div");
  scrollHost.className = "modal-magnify-json-scroll";
  const table = document.createElement("table");
  table.className = "modal-magnify-json-table";
  const tbody = document.createElement("tbody");
  const synRow = document.createElement("tr");
  synRow.className = "kv-row json-magnify-modal-row";
  synRow.dataset.storageKey = storageKey;
  synRow.dataset.storageKind = kind;
  const td = document.createElement("td");
  td.className = "val-cell magnify-val-cell";
  td.colSpan = 3;
  const host = document.createElement("div");
  host.className = "json-editor-host";
  const treeWrap = document.createElement("div");
  treeWrap.className = "json-tree-wrap";
  const modalRootEl = document.createElement("div");
  modalRootEl.className = "json-tree-root";
  treeWrap.appendChild(modalRootEl);
  host.appendChild(treeWrap);
  td.appendChild(host);
  synRow.appendChild(td);
  tbody.appendChild(synRow);
  table.appendChild(tbody);
  scrollHost.appendChild(table);
  el.modalBody.appendChild(scrollHost);

  const top = document.createElement("div");
  top.className = "modal-row modal-magnify-top";
  top.style.cssText =
    "display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:10px";
  const hint = document.createElement("span");
  hint.style.cssText = "color:#aaa;font-size:11px;flex:1 1 220px";
  hint.textContent =
    "与列表中 JSON 树一致。「查看/修改」仅控制本窗口且会保持；复制在查看模式下也可用；修改模式下编辑即时写入存储。点「关闭」或空白处关闭。";
  top.appendChild(hint);
  const btnExpand = document.createElement("button");
  btnExpand.type = "button";
  btnExpand.className = "btn-mini";
  btnExpand.textContent = "全展";
  btnExpand.title = "展开本树全部节点";
  btnExpand.addEventListener("click", () => setSubtreeExpanded(treeWrap, true));
  top.appendChild(btnExpand);
  const btnCollapse = document.createElement("button");
  btnCollapse.type = "button";
  btnCollapse.className = "btn-mini";
  btnCollapse.textContent = "全收";
  btnCollapse.title = "收起本树全部节点";
  btnCollapse.addEventListener("click", () => setSubtreeExpanded(treeWrap, false));
  top.appendChild(btnCollapse);
  const btnBack = document.createElement("button");
  btnBack.type = "button";
  btnBack.className = "btn-mini";
  btnBack.textContent = "返回";
  btnBack.title = "返回上一级详情（同一存储键）";
  btnBack.hidden = magnifyNavStack.length === 0;
  btnBack.addEventListener("click", () => magnifyNavigateBack());
  top.appendChild(btnBack);
  mountMagnifyViewModeRadios(jsonMagnifyLocalViewOnly, top, synRow);
  const btnClose = document.createElement("button");
  btnClose.type = "button";
  btnClose.className = "btn-mini";
  btnClose.textContent = "关闭";
  btnClose.addEventListener("click", () => closeModal());
  top.appendChild(btnClose);
  el.modalBody.insertBefore(top, scrollHost);

  const pathPrefix = subtreePathFromStorageRoot.slice();
  const magnifyHooks = {
    resolveActionRow: () =>
      findKvRowByStorageKey(storageKey) || synRow,
    isMagnifyUi: true,
    magnifyPathPrefix: pathPrefix,
  };

  function remountMagnifyTree() {
    const liveMain = findKvRowByStorageKey(storageKey);
    /** @type {unknown} */
    let fullParsed;
    if (
      liveMain &&
      /** @type {{ _cocoJsonParsed?: unknown }} */ (liveMain)._cocoJsonParsed !==
        undefined
    ) {
      fullParsed = /** @type {{ _cocoJsonParsed?: unknown }} */ (liveMain)
        ._cocoJsonParsed;
    } else if (
      sourceRow &&
      /** @type {{ _cocoJsonParsed?: unknown }} */ (sourceRow)._cocoJsonParsed !==
        undefined
    ) {
      fullParsed = /** @type {{ _cocoJsonParsed?: unknown }} */ (sourceRow)
        ._cocoJsonParsed;
    } else if (synRow._cocoJsonParsed !== undefined) {
      fullParsed = synRow._cocoJsonParsed;
    } else {
      modalRootEl.innerHTML = "";
      const p = document.createElement("p");
      p.className = "modal-row";
      p.style.color = "#888";
      p.textContent =
        "列表中找不到该键或未加载 JSON（请关闭弹窗后检查查找过滤或刷新）。";
      modalRootEl.appendChild(p);
      return;
    }
    /** @type {unknown} */
    let parsed = fullParsed;
    if (subtreePathFromStorageRoot.length > 0) {
      const sub = getAtPath(fullParsed, subtreePathFromStorageRoot);
      if (sub === undefined || sub === null) {
        modalRootEl.innerHTML = "";
        const p = document.createElement("p");
        p.className = "modal-row";
        p.style.color = "#888";
        p.textContent = "该路径下暂无数据或已被删除。";
        modalRootEl.appendChild(p);
        return;
      }
      parsed = sub;
    }
    synRow._cocoJsonParsed = parsed;
    renderJsonRoot(modalRootEl, parsed, synRow, magnifyHooks);
    applyJsonViewMode(synRow, jsonMagnifyLocalViewOnly);
  }

  jsonMagnifyRemounter = remountMagnifyTree;
  remountMagnifyTree();
}

/**
 * JSON 存储行：打开放大编辑器（整条或子树）
 * @param {'local'|'session'} kind
 * @param {string} storageKey
 * @param {HTMLTableRowElement} row 须含完整 _cocoJsonParsed（列表行或解析后的主行）
 * @param {(string|number)[]} [subtreePath] 相对存储根的路径；空则整条键
 */
function openWholeKeyJsonEditorModal(kind, storageKey, row, subtreePath = []) {
  /** @type {{ _cocoJsonParsed?: unknown }} */
  const r = row;
  const root = r._cocoJsonParsed;
  if (root === undefined || root === null) {
    setStatus("无 JSON 数据", true);
    return;
  }
  if (typeof root !== "object") {
    setStatus("仅支持对象或数组根", true);
    return;
  }
  if (subtreePath.length > 0) {
    const sub = getAtPath(root, subtreePath);
    if (sub === undefined || sub === null || typeof sub !== "object") {
      setStatus("无法打开该路径的详情", true);
      return;
    }
  }

  const magnifyOpen =
    !el.modalBackdrop.hidden &&
    el.modalBody.classList.contains("modal-body-magnify");

  if (!magnifyOpen) {
    magnifyNavStack.length = 0;
  } else if (jsonMagnifyActiveKey === storageKey) {
    magnifyNavStack.push({
      kind: jsonMagnifyActiveKind || kind,
      storageKey,
      subtreePath: jsonMagnifySubtreePath
        ? jsonMagnifySubtreePath.slice()
        : [],
    });
  } else {
    magnifyNavStack.length = 0;
  }

  jsonMagnifyLocalViewOnly = getGlobalJsonViewOnly();
  el.modalBackdrop
    .querySelector(".modal-dialog")
    ?.classList.add("modal-dialog-json-bulk", "modal-magnify-embedded");
  const titleBase = formatStorageKeyForDisplay(storageKey);
  el.modalTitle.textContent =
    subtreePath.length > 0
      ? `${titleBase} · ${formatJsonPathLabel(subtreePath)}`
      : titleBase;
  el.modalBody.classList.add("modal-body-magnify");
  buildMagnifyModalBody(kind, storageKey, row, subtreePath);
  modalOnOk = async () => {};
  el.modalBackdrop.hidden = false;
}

/**
 * @param {'local'|'session'} kind
 * @param {string} storageKey
 * @param {string} raw
 * @param {ValueMeta} meta
 */
function wirePrimitiveRow(row, kind, storageKey, raw, meta) {
  row.dataset.storageKey = storageKey;
  row.dataset.storageKind = kind;
  row.dataset.primitiveKind = meta.kind;

  const bar = row.querySelector(".value-type-bar");
  const tdVal = row.querySelector(".val-cell");
  if (!tdVal || !bar) return;

  const preview = document.createElement("div");
  preview.className = "primitive-preview";
  preview.textContent = raw;

  const mk = (cls, text, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-mini " + cls;
    b.textContent = text;
    b.addEventListener("click", () => void onClick());
    return b;
  };

  const modBtn = mk("primary", "修改", async () => {
    el.modalTitle.textContent = "修改 · " + storageKey;
    el.modalBody.innerHTML = "";
    if (meta.kind === "bool") {
      const v = String(raw).trim() === "true";
      const wrap = document.createElement("div");
      wrap.className = "modal-row";
      const opts = document.createElement("div");
      opts.className = "modal-bool-row";
      opts.innerHTML = `<label class="modal-bool-opt"><input type="radio" name="pb" value="true" ${v ? "checked" : ""} /> true</label>
          <label class="modal-bool-opt"><input type="radio" name="pb" value="false" ${!v ? "checked" : ""} /> false</label>`;
      wrap.appendChild(opts);
      el.modalBody.appendChild(wrap);
      modalOnOk = async () => {
        const inp = /** @type {HTMLInputElement | null} */ (
          el.modalBody.querySelector('input[name="pb"]:checked')
        );
        const b = inp?.value === "true";
        await persistKeyValue(kind, storageKey, JSON.stringify(b));
      };
    } else if (meta.kind === "number") {
      const readPrim = mountNumberOrTimestampPicker(
        el.modalBody,
        coerceToNumber(String(raw).trim()),
        { src: "primNumSrc", digits: "primNumDig" },
      );
      modalOnOk = async () => {
        const n = readPrim();
        await persistKeyValue(kind, storageKey, String(n));
      };
    } else if (meta.kind === "null" || meta.kind === "undefined") {
      const hint = document.createElement("p");
      hint.className = "modal-row";
      hint.style.cssText = "color:#aaa;font-size:11px;margin-bottom:8px";
      hint.textContent =
        meta.kind === "undefined"
          ? "当前值为 undefined，请选择新类型并填写值（不可为 null / undefined）。"
          : "当前为 null，请选择新类型并填写值（不可为 null / undefined）。";
      el.modalBody.appendChild(hint);
      const read = mountNullishReplacementForm(el.modalBody, "prim");
      modalOnOk = async () => {
        const res = read();
        if (!res.ok) {
          setStatus(res.message, true);
          return false;
        }
        const val = res.value;
        let out = "";
        if (typeof val === "boolean") out = JSON.stringify(val);
        else if (typeof val === "number") out = String(val);
        else if (typeof val === "string") out = val;
        else out = JSON.stringify(val, null, 2);
        await persistKeyValue(kind, storageKey, out);
      };
    } else {
      const ta = document.createElement("textarea");
      ta.className = "modal-text";
      ta.value = raw;
      el.modalBody.appendChild(ta);
      modalOnOk = async () => {
        await persistKeyValue(kind, storageKey, ta.value);
      };
    }
    el.modalBackdrop.hidden = false;
  });
  modBtn.setAttribute("data-primitive-edit-only", "");
  modBtn.hidden = getGlobalJsonViewOnly();

  const copyBtn = mk("", "复制", async () => {
    await copyText(raw);
  });

  const resetBtn = mk("", "重置", () => {
    openAddKeyModal(kind, { fixedKey: storageKey, initialRaw: raw });
  });
  resetBtn.title = "与「新增键值」相同表单，键名固定，覆盖写入本键";
  resetBtn.setAttribute("data-primitive-edit-only", "");
  resetBtn.hidden = getGlobalJsonViewOnly();

  bar.appendChild(modBtn);
  bar.appendChild(copyBtn);
  bar.appendChild(resetBtn);

  tdVal.appendChild(preview);
}

/**
 * @param {HTMLTableRowElement} row
 * @param {'local'|'session'} kind
 * @param {string} storageKey
 * @param {unknown} parsed
 * @param {string} storageRaw 存储中的原始字符串（用于重置表单预填）
 */
function wireJsonRowToolbar(row, kind, storageKey, parsed, storageRaw) {
  row.dataset.storageKey = storageKey;
  row.dataset.storageKind = kind;
  /** @type {{ _cocoJsonParsed?: unknown }} */
  const r = row;
  r._cocoJsonParsed = parsed;

  const bar = row.querySelector(".value-type-bar");
  if (!bar) return;

  const bulkJsonBtn = document.createElement("button");
  bulkJsonBtn.type = "button";
  bulkJsonBtn.className = "btn-mini primary";
  bulkJsonBtn.textContent = "详情";
  bulkJsonBtn.title = "大窗口查看/编辑本条存储的完整 JSON";
  bulkJsonBtn.addEventListener("click", () => {
    openWholeKeyJsonEditorModal(kind, storageKey, row);
  });
  bar.appendChild(bulkJsonBtn);

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "btn-mini";
  resetBtn.setAttribute("data-json-toolbar-edit-only", "");
  resetBtn.textContent = "重置";
  resetBtn.title = "与「新增键值」相同表单，键名固定，可改类型与值后覆盖写入";
  resetBtn.addEventListener("click", () => {
    openAddKeyModal(kind, {
      fixedKey: storageKey,
      initialRaw: storageRaw,
    });
  });
  bar.appendChild(resetBtn);

  const copyAll = document.createElement("button");
  copyAll.type = "button";
  copyAll.className = "btn-mini";
  copyAll.textContent = "复制全部";
  copyAll.addEventListener("click", async () => {
    await copyText(JSON.stringify(r._cocoJsonParsed, null, 2));
  });
  bar.appendChild(copyAll);

  const rootVal = r._cocoJsonParsed;
  if (rootVal !== null && typeof rootVal === "object" && !Array.isArray(rootVal)) {
    const nb = document.createElement("button");
    nb.type = "button";
    nb.className = "btn-mini primary";
    nb.textContent = "新增键";
    nb.title = "在此 JSON 根对象上增加一个属性";
    nb.setAttribute("data-json-toolbar-edit-only", "");
    nb.addEventListener("click", () =>
      openNestedEntryModal(row, kind, storageKey, [], false),
    );
    bar.appendChild(nb);
  } else if (Array.isArray(rootVal)) {
    const clrRoot = document.createElement("button");
    clrRoot.type = "button";
    clrRoot.className = "btn-mini danger";
    clrRoot.setAttribute("data-json-toolbar-edit-only", "");
    clrRoot.textContent = "清空子项";
    clrRoot.title = "清空根数组内全部元素";
    clrRoot.addEventListener("click", async () => {
      if (rootVal.length === 0) {
        setStatus("根数组已为空");
        return;
      }
      if (!confirm(`确定清空根数组内全部 ${rootVal.length} 项？`)) return;
      rootVal.length = 0;
      await persistKeyValue(
        kind,
        storageKey,
        JSON.stringify(r._cocoJsonParsed, null, 2),
      );
    });
    bar.appendChild(clrRoot);
    const nb = document.createElement("button");
    nb.type = "button";
    nb.className = "btn-mini primary";
    nb.setAttribute("data-json-toolbar-edit-only", "");
    nb.textContent = "新增项";
    nb.title = "在数组末尾追加一项";
    nb.addEventListener("click", () =>
      openNestedEntryModal(row, kind, storageKey, [], true),
    );
    bar.appendChild(nb);
  }
}

/**
 * 在 JSON 内部对象/数组上新增（不经过顶层「新增键值」）
 * @param {HTMLTableRowElement | null} row
 * @param {'local'|'session' | null} skind
 * @param {string | null} sk
 * @param {(string|number)[]} parentPath
 * @param {boolean} arrayMode  true = 向数组 push；false = 向对象加键
 * @param {{
 *   directParent?: unknown;
 *   suppressPersist?: boolean;
 *   onAfterMutate?: () => void;
 *   onCancelRestore?: () => void;
 *   arrayElementSample?: unknown;
 *   draftRoot?: unknown;
 * }} [extra]
 */
function openNestedEntryModal(row, skind, sk, parentPath, arrayMode, extra = {}) {
  const suppressPersist = !!extra.suppressPersist;
  const onAfterMutate = extra.onAfterMutate;
  const directParent = extra.directParent;

  /** @type {unknown} */
  let root;
  /** @type {unknown} */
  let parent;

  if (directParent !== undefined && directParent !== null) {
    parent = directParent;
    root = extra.draftRoot ?? null;
    if (arrayMode && !Array.isArray(parent)) return;
    if (
      !arrayMode &&
      (parent === null || typeof parent !== "object" || Array.isArray(parent))
    )
      return;
  } else {
    if (!row) return;
    const r = /** @type {{ _cocoJsonParsed?: unknown }} */ (row);
    root = r._cocoJsonParsed;
    if (root === undefined) return;
    parent = getAtPath(root, parentPath);
    if (arrayMode && !Array.isArray(parent)) return;
    if (
      !arrayMode &&
      (parent === null || typeof parent !== "object" || Array.isArray(parent))
    )
      return;
  }

  const arrParent = /** @type {unknown[]} */ (parent);

  async function commitPersist() {
    if (suppressPersist) {
      if (typeof extra.onCancelRestore === "function") {
        popModalCancelLayer();
      }
      onAfterMutate?.();
      return;
    }
    await persistKeyValue(
      /** @type {'local'|'session'} */(skind),
      /** @type {string} */(sk),
      JSON.stringify(root, null, 2),
    );
  }

  let useArrayTemplate = false;
  /** @type {unknown} */
  let sample0 = null;
  if (arrayMode) {
    const nn = arrParent.filter((x) => !isDraftTemplatePlaceholder(x));
    if (nn.length > 0) {
      const ref = nn[0];
      let allMatch = true;
      for (let i = 1; i < nn.length; i++) {
        if (!draftArrayElementsSameStructure(nn[i], ref)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        useArrayTemplate = true;
        sample0 = ref;
      }
    } else if (
      extra.arrayElementSample !== undefined &&
      extra.arrayElementSample !== null &&
      !isDraftTemplatePlaceholder(extra.arrayElementSample)
    ) {
      useArrayTemplate = true;
      sample0 = extra.arrayElementSample;
    }
  }

  if (arrayMode && useArrayTemplate && sample0 != null) {
    el.modalTitle.textContent = "新增数组项（与现有项结构一致）";

    if (
      typeof sample0 === "object" &&
      sample0 !== null &&
      !Array.isArray(sample0)
    ) {
      const draft = /** @type {Record<string, unknown>} */ (
        newArrayItemObjectShell(sample0)
      );
      mountDraftObjectTemplateModal(
        draft,
        /** @type {Record<string, unknown>} */(sample0),
        arrParent,
        root,
        /** @type {'local'|'session'} */(skind),
        /** @type {string} */(sk),
        suppressPersist,
        onAfterMutate,
        suppressPersist ? extra.onCancelRestore : undefined,
      );
      el.modalBackdrop.hidden = false;
      return;
    }

    const skel = skeletonFromSample(sample0);
    const shape = jsonShapeSignature(sample0);

    el.modalBody.innerHTML = "";
    const hint = document.createElement("p");
    hint.className = "modal-row";
    hint.style.cssText = "color:#aaa;font-size:11px";
    hint.textContent =
      "已按当前数组中非 null 项的统一结构生成默认值，可在下方修改；结构须与现有一致。";
    el.modalBody.appendChild(hint);

    if (suppressPersist && typeof extra.onCancelRestore === "function") {
      pushModalCancelLayer(extra.onCancelRestore);
    }

    if (typeof skel === "number") {
      const readNum = mountNumberOrTimestampPicker(el.modalBody, skel, {
        src: "nestTmplNumSrc",
        digits: "nestTmplNumDig",
      });
      modalOnOk = async () => {
        const n = readNum();
        if (jsonShapeSignature(n) !== shape) {
          setStatus("类型须与现有项一致（数字）", true);
          return false;
        }
        arrParent.push(n);
        await commitPersist();
        return suppressPersist ? false : undefined;
      };
    } else if (typeof skel === "boolean") {
      const wrap = document.createElement("div");
      wrap.className = "modal-row";
      const opts = document.createElement("div");
      opts.className = "modal-bool-row";
      opts.innerHTML = `<label class="modal-bool-opt"><input type="radio" name="nestTmplBool" value="true" ${skel ? "checked" : ""} /> true</label>
        <label class="modal-bool-opt"><input type="radio" name="nestTmplBool" value="false" ${!skel ? "checked" : ""} /> false</label>`;
      wrap.appendChild(opts);
      el.modalBody.appendChild(wrap);
      modalOnOk = async () => {
        const chk = /** @type {HTMLInputElement | null} */ (
          el.modalBody.querySelector('input[name="nestTmplBool"]:checked')
        );
        const b = chk?.value === "true";
        if (jsonShapeSignature(b) !== shape) {
          setStatus("类型须与现有项一致（布尔）", true);
          return false;
        }
        arrParent.push(b);
        await commitPersist();
        return suppressPersist ? false : undefined;
      };
    } else if (typeof skel === "string") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "modal-text";
      inp.value = skel;
      const rowEl = document.createElement("div");
      rowEl.className = "modal-row";
      rowEl.appendChild(inp);
      el.modalBody.appendChild(rowEl);
      modalOnOk = async () => {
        const v = inp.value;
        if (jsonShapeSignature(v) !== shape) {
          setStatus("类型须与现有项一致（文本）", true);
          return false;
        }
        arrParent.push(v);
        await commitPersist();
        return suppressPersist ? false : undefined;
      };
    } else if (Array.isArray(sample0)) {
      const ta = document.createElement("textarea");
      ta.className = "modal-text";
      ta.style.minHeight = "200px";
      ta.value = JSON.stringify(skel, null, 2);
      el.modalBody.appendChild(ta);
      modalOnOk = async () => {
        let parsed;
        try {
          parsed = JSON.parse(ta.value);
        } catch {
          setStatus("JSON 格式错误", true);
          return false;
        }
        if (!isStructureCompatible(parsed, sample0)) {
          setStatus("结构与现有项不一致", true);
          return false;
        }
        arrParent.push(parsed);
        await commitPersist();
        return suppressPersist ? false : undefined;
      };
    } else {
      const ta = document.createElement("textarea");
      ta.className = "modal-text";
      ta.style.minHeight = "200px";
      ta.value = JSON.stringify(skel, null, 2);
      el.modalBody.appendChild(ta);
      modalOnOk = async () => {
        let parsed;
        try {
          parsed = JSON.parse(ta.value);
        } catch {
          setStatus("JSON 格式错误", true);
          return false;
        }
        if (jsonShapeSignature(parsed) !== shape) {
          setStatus("结构与现有项不一致", true);
          return false;
        }
        arrParent.push(parsed);
        await commitPersist();
        return suppressPersist ? false : undefined;
      };
    }

    el.modalBackdrop.hidden = false;
    return;
  }

  el.modalTitle.textContent = arrayMode ? "新增数组项" : "新增对象属性";
  el.modalBody.innerHTML = "";

  if (suppressPersist && typeof extra.onCancelRestore === "function") {
    pushModalCancelLayer(extra.onCancelRestore);
  }

  let keyInp = /** @type {HTMLInputElement | null} */ (null);
  if (!arrayMode) {
    const rowK = document.createElement("div");
    rowK.className = "modal-row";
    rowK.innerHTML = "<label>新键名</label>";
    keyInp = document.createElement("input");
    keyInp.type = "text";
    keyInp.className = "modal-text";
    keyInp.placeholder = "不可与已有键重复";
    rowK.appendChild(keyInp);
    el.modalBody.appendChild(rowK);
  }

  const typeSel = document.createElement("select");
  typeSel.className = "modal-text";
  typeSel.innerHTML =
    '<option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option><option value="json">json</option>' +
    (arrayMode ? '<option value="null">null</option>' : "");

  const rowBool = document.createElement("div");
  rowBool.className = "modal-row";
  rowBool.style.display = "none";
  const boolLbl = document.createElement("label");
  boolLbl.textContent = "布尔值";
  boolLbl.style.display = "block";
  boolLbl.style.marginBottom = "6px";
  const boolOpts = document.createElement("div");
  boolOpts.className = "modal-bool-row";
  boolOpts.innerHTML =
    '<label class="modal-bool-opt"><input type="radio" name="nestBool" value="true" checked /> true</label><label class="modal-bool-opt"><input type="radio" name="nestBool" value="false" /> false</label>';
  rowBool.appendChild(boolLbl);
  rowBool.appendChild(boolOpts);

  const ta = document.createElement("textarea");
  ta.className = "modal-text";
  const numSlot = document.createElement("div");
  /** @type {null | (() => number)} */
  let readNestNum = null;

  const rowT = document.createElement("div");
  rowT.className = "modal-row";
  rowT.innerHTML = "<label>值类型</label>";
  rowT.appendChild(typeSel);
  const rowV = document.createElement("div");
  rowV.className = "modal-row";
  rowV.innerHTML = "<label>值</label>";
  rowV.appendChild(ta);
  rowV.appendChild(numSlot);

  el.modalBody.appendChild(rowT);
  el.modalBody.appendChild(rowBool);
  el.modalBody.appendChild(rowV);

  const syncTypeUi = () => {
    const t = typeSel.value;
    if (t === "null") {
      rowBool.style.display = "none";
      rowV.style.display = "none";
      numSlot.innerHTML = "";
      numSlot.style.display = "none";
      readNestNum = null;
      return;
    }
    if (t === "boolean") {
      rowBool.style.display = "";
      rowV.style.display = "none";
    } else {
      rowBool.style.display = "none";
      rowV.style.display = "";
    }
    if (t === "number") {
      ta.style.display = "none";
      numSlot.style.display = "";
      readNestNum = mountNumberOrTimestampPicker(numSlot, 0, {
        src: "nestNumSrc",
        digits: "nestNumDig",
      });
    } else if (t !== "boolean") {
      numSlot.innerHTML = "";
      numSlot.style.display = "none";
      readNestNum = null;
      ta.style.display = "";
    }
    if (t === "json") ta.placeholder = '{"a":1}';
    else if (t === "string") ta.placeholder = "文本";
  };
  typeSel.addEventListener("change", syncTypeUi);
  syncTypeUi();

  modalOnOk = async () => {
    let newKey = "";
    if (!arrayMode && keyInp) {
      newKey = keyInp.value.trim();
      if (!newKey) {
        setStatus("请填写键名", true);
        return false;
      }
      if (
        Object.prototype.hasOwnProperty.call(
          /** @type {object} */(parent),
          newKey,
        )
      ) {
        setStatus("键已存在", true);
        return false;
      }
    }

    const t = typeSel.value;
    let val;
    if (t === "null") {
      val = null;
    } else if (t === "json") {
      try {
        val = JSON.parse(formatJsonForStorage(ta.value));
      } catch {
        setStatus("JSON 格式错误", true);
        return false;
      }
    } else if (t === "boolean") {
      const chk = /** @type {HTMLInputElement | null} */ (
        el.modalBody.querySelector('input[name="nestBool"]:checked')
      );
      val = chk?.value === "true";
    } else if (t === "number") {
      val = readNestNum ? readNestNum() : 0;
    } else {
      val = ta.value;
    }

    if (arrayMode) {
      arrParent.push(val);
    } else {
      /** @type {Record<string, unknown>} */ (parent)[newKey] = val;
    }
    await commitPersist();
    return suppressPersist ? false : undefined;
  };

  el.modalBackdrop.hidden = false;
}

async function refresh() {
  setStatus("读取中…");
  el.btnRefresh.disabled = true;
  try {
    /** @type {{ ok: boolean, frames?: FrameDump[], error?: string }} */
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ tabId, type: "dump" }, resolve);
    });
    if (!res.ok) {
      setStatus(res.error || "读取失败", true);
      return;
    }
    lastFrames = res.frames || [];
    const fp = fingerprint(lastFrames);
    const changed = fp !== lastFingerprint;
    lastFingerprint = fp;

    const prev = el.selFrame.value;
    el.selFrame.innerHTML = "";
    for (const fr of lastFrames) {
      const r = fr.result;
      const href = (r.href || "").trim();
      const label =
        href !== ""
          ? href
          : `#${fr.frameId}`;
      const opt = document.createElement("option");
      opt.value = String(fr.frameId);
      opt.textContent = label.length > 90 ? label.slice(0, 87) + "…" : label;
      el.selFrame.appendChild(opt);
    }
    if (prev && [...el.selFrame.options].some((o) => o.value === prev)) {
      el.selFrame.value = prev;
    }
    renderAll();
    setStatus(
      changed
        ? `已更新 · ${new Date().toLocaleTimeString()}`
        : "无变化",
    );
  } catch (e) {
    setStatus(String(e), true);
  } finally {
    el.btnRefresh.disabled = false;
  }
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 列表「键」列展示：去掉 Cocos 常见前缀「数字-」（如 0-http… → http…） */
function formatStorageKeyForDisplay(key) {
  return String(key).replace(/^\d+-/, "");
}

/** 表格「键」列：存储键名模糊高亮 */
function highlightStorageKeyCell(key, queryLower) {
  if (!queryLower) return escapeHtml(key);
  const lower = key.toLowerCase();
  const q = queryLower;
  let out = "";
  let i = 0;
  while (i < key.length) {
    const j = lower.indexOf(q, i);
    if (j < 0) {
      out += escapeHtml(key.slice(i));
      break;
    }
    out += escapeHtml(key.slice(i, j));
    out +=
      '<mark class="search-hit-storage-key">' +
      escapeHtml(key.slice(j, j + q.length)) +
      "</mark>";
    i = j + q.length;
  }
  return out;
}

/** JSON 树里的属性名高亮（fieldQuery 已小写） */
function jsonKeySpanHtml(keyName, fieldQueryLower) {
  const q = fieldQueryLower.trim();
  if (!q) return escapeHtml(`"${keyName}": `);
  const lower = keyName.toLowerCase();
  let inner = "";
  let i = 0;
  while (i < keyName.length) {
    const j = lower.indexOf(q, i);
    if (j < 0) {
      inner += escapeHtml(keyName.slice(i));
      break;
    }
    inner += escapeHtml(keyName.slice(i, j));
    inner +=
      '<mark class="search-hit-json-key">' +
      escapeHtml(keyName.slice(j, j + q.length)) +
      "</mark>";
    i = j + q.length;
  }
  return escapeHtml('"') + inner + escapeHtml('": ');
}

/**
 * @param {'local'|'session'} kind
 * @param {Record<string, string>} data
 * @param {boolean} showStorageModeToggle 仅当前激活的 storage 标签页显示全局 查看/修改
 */
function renderKeyValueTable(kind, data, showStorageModeToggle) {
  const allKeys = Object.keys(data || {}).sort();
  const keys = allKeys.filter((k) =>
    shouldShowStorageRow(k, data[k] ?? ""),
  );
  const fid = getSelectedFrame();
  const outer = document.createElement("div");

  if (fid != null) {
    const bar = document.createElement("div");
    bar.className = "clear-bar";
    if (showStorageModeToggle) {
      mountStorageModeRadios(globalStorageViewOnly, bar);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "danger btn-clear-all";
    btn.dataset.kind = kind;
    btn.textContent =
      kind === "session"
        ? "清空 sessionStorage（全部）"
        : "清空 localStorage（全部）";
    bar.appendChild(btn);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "primary";
    addBtn.textContent = "新增键值";
    addBtn.addEventListener("click", () => openAddKeyModal(kind, {}));
    bar.appendChild(addBtn);

    outer.appendChild(bar);
  }

  if (fid == null) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "未选择页面";
    outer.appendChild(p);
    return outer;
  }

  const filterHint =
    keys.length < allKeys.length
      ? `<p style="margin:6px 0;color:#888;font-size:11px">查找过滤：显示 ${keys.length} / ${allKeys.length} 条</p>`
      : "";

  if (keys.length === 0) {
    const inner = document.createElement("div");
    inner.innerHTML =
      filterHint +
      `<p class="empty">无匹配项或暂无数据。可调整查找条件或点刷新。</p>`;
    outer.appendChild(inner);
    return outer;
  }

  const rows = keys
    .map((k) => {
      return `
      <tr class="kv-row" data-key="${encodeURIComponent(k)}">
        <td class="key-cell"></td>
        <td class="val-cell"></td>
        <td class="actions"></td>
      </tr>`;
    })
    .join("");

  const table = `
    ${filterHint}
    <table class="storage-kv-table">
      <colgroup>
        <col class="kv-col-key" />
        <col class="kv-col-val" />
        <col class="kv-col-actions" />
      </colgroup>
      <thead><tr><th class="key-cell kv-key-head"><span class="kv-key-label">键</span><div class="kv-resize-handle" role="separator" aria-orientation="vertical" title="拖动调整键/值列宽"></div></th><th>值</th><th class="actions">操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  const inner = document.createElement("div");
  inner.innerHTML = table;
  for (const k of keys) {
    const row = /** @type {HTMLTableRowElement} */ (
      inner.querySelector(`tr[data-key="${encodeURIComponent(k)}"]`)
    );
    if (!row) continue;
    const { mode: searchMode, query: searchQ } = getSearchState();
    if (searchMode === "field" && searchQ) {
      row.classList.add("kv-row-field-hit");
    }
    const tdK = row.querySelector(".key-cell");
    if (tdK) {
      const kDisp = formatStorageKeyForDisplay(k);
      if (searchMode === "key" && searchQ) {
        tdK.innerHTML = highlightStorageKeyCell(kDisp, searchQ);
      } else {
        tdK.textContent = kDisp;
      }
      if (kDisp !== k) tdK.title = k;
    }
    const tdVal = row.querySelector(".val-cell");
    const tdAct = row.querySelector(".actions");
    if (!tdVal || !tdAct) continue;

    const raw = data[k] ?? "";
    const meta = detectValueMeta(raw);
    tdVal.innerHTML = "";

    const bar = document.createElement("div");
    bar.className = "value-type-bar";
    const badge = document.createElement("span");
    badge.className = "type-badge";
    badge.textContent = meta.label;
    if (meta.kind === "json") badge.classList.add("type-json");
    else if (meta.kind === "number") badge.classList.add("type-num");
    else if (
      meta.kind === "bool" ||
      meta.kind === "null" ||
      meta.kind === "undefined"
    )
      badge.classList.add("type-prim");
    else badge.classList.add("type-str");
    bar.appendChild(badge);
    tdVal.appendChild(bar);

    let parsedJson = null;
    if (meta.kind === "json") {
      try {
        parsedJson = JSON.parse(String(raw).trim());
      } catch {
        parsedJson = null;
      }
      if (parsedJson === null) {
        badge.textContent = "文本";
        badge.classList.remove("type-json");
        badge.classList.add("type-str");
      }
    }

    if (parsedJson !== null && meta.kind === "json") {
      const parsed = parsedJson;
      wireJsonRowToolbar(row, kind, k, parsed, raw);

      const host = document.createElement("div");
      host.className = "json-editor-host";
      const treeWrap = document.createElement("div");
      treeWrap.className = "json-tree-wrap";
      const rootEl = document.createElement("div");
      rootEl.className = "json-tree-root";
      treeWrap.appendChild(rootEl);
      host.appendChild(treeWrap);
      tdVal.appendChild(host);
      renderJsonRoot(rootEl, parsed, row);
      applyJsonViewMode(row, getGlobalJsonViewOnly());

      const expRoot = document.createElement("button");
      expRoot.type = "button";
      expRoot.className = "btn-mini";
      expRoot.textContent = "全展";
      expRoot.title = "展开整棵 JSON 树";
      expRoot.addEventListener("click", () => setSubtreeExpanded(treeWrap, true));
      bar.appendChild(expRoot);
      const colRoot = document.createElement("button");
      colRoot.type = "button";
      colRoot.className = "btn-mini";
      colRoot.textContent = "全收";
      colRoot.title = "收起整棵 JSON 树";
      colRoot.addEventListener("click", () => setSubtreeExpanded(treeWrap, false));
      bar.appendChild(colRoot);

      const delKey = document.createElement("button");
      delKey.type = "button";
      delKey.className = "danger";
      delKey.textContent = "删除";
      delKey.addEventListener("click", async () => {
        if (
          !confirm(
            "确定删除：\n" + formatStorageKeyForDisplay(k),
          )
        )
          return;
        const fid = getSelectedFrame();
        if (fid == null) return;
        setStatus("删除中…");
        const res = await send("storageRemove", {
          frameId: fid,
          kind: kind === "session" ? "session" : "local",
          key: k,
        });
        if (!res.ok) {
          setStatus(res.error || "删除失败", true);
          return;
        }
        setStatus("已删除");
        await refresh();
      });
      tdAct.appendChild(delKey);
      continue;
    }

    const primMeta =
      meta.kind === "json" && parsedJson === null
        ? { kind: "string", label: "文本" }
        : meta;
    wirePrimitiveRow(row, kind, k, raw, primMeta);
    const delKey = document.createElement("button");
    delKey.type = "button";
    delKey.className = "danger";
    delKey.textContent = "删除";
    delKey.addEventListener("click", async () => {
      if (!confirm("确定删除：\n" + formatStorageKeyForDisplay(k))) return;
      const fid = getSelectedFrame();
      if (fid == null) return;
      setStatus("删除中…");
      const res = await send("storageRemove", {
        frameId: fid,
        kind: kind === "session" ? "session" : "local",
        key: k,
      });
      if (!res.ok) {
        setStatus(res.error || "删除失败", true);
        return;
      }
      setStatus("已删除");
      await refresh();
    });
    tdAct.appendChild(delKey);
  }
  outer.appendChild(inner);
  return outer;
}

/**
 * 新增键值，或重置已有键（与新增相同表单，可传 fixedKey 固定键名）
 * @param {'local'|'session'} kind
 * @param {{ fixedKey?: string, initialRaw?: string }} [opt]
 */
function openAddKeyModal(kind, opt = {}) {
  const fixed = (opt.fixedKey || "").trim();
  const isFixedKey = !!fixed;
  const initialRaw = opt.initialRaw;

  el.modalTitle.textContent = isFixedKey ? `重置键值 · ${fixed}` : "新增键值";
  el.modalBody.innerHTML = "";
  const keyInp = document.createElement("input");
  keyInp.type = "text";
  keyInp.className = "modal-text";
  keyInp.placeholder = "键名（不可为空）";
  keyInp.value = isFixedKey ? fixed : "";
  keyInp.readOnly = isFixedKey;
  if (isFixedKey) keyInp.title = "键名不可更改";

  const typeSel = document.createElement("select");
  typeSel.className = "modal-text";
  typeSel.innerHTML =
    '<option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option><option value="json">json</option><option value="null">null</option>';
  const ta = document.createElement("textarea");
  ta.className = "modal-text";
  ta.placeholder = "按类型填写值";
  const rowBool = document.createElement("div");
  rowBool.className = "modal-row";
  rowBool.style.display = "none";
  const boolLblAdd = document.createElement("label");
  boolLblAdd.textContent = "布尔值";
  boolLblAdd.style.display = "block";
  boolLblAdd.style.marginBottom = "6px";
  const boolOptsAdd = document.createElement("div");
  boolOptsAdd.className = "modal-bool-row";
  boolOptsAdd.innerHTML =
    '<label class="modal-bool-opt"><input type="radio" name="addBool" value="true" checked /> true</label><label class="modal-bool-opt"><input type="radio" name="addBool" value="false" /> false</label>';
  rowBool.appendChild(boolLblAdd);
  rowBool.appendChild(boolOptsAdd);

  const numSlotAdd = document.createElement("div");
  /** @type {null | (() => number)} */
  let readAddNum = null;
  let initialNum = 0;

  const rowK = document.createElement("div");
  rowK.className = "modal-row";
  const lblK = document.createElement("label");
  lblK.textContent = isFixedKey ? "键名（固定）" : "键名";
  rowK.appendChild(lblK);
  rowK.appendChild(keyInp);
  const rowT = document.createElement("div");
  rowT.className = "modal-row";
  rowT.innerHTML = "<label>值类型</label>";
  rowT.appendChild(typeSel);
  const rowV = document.createElement("div");
  rowV.className = "modal-row";
  rowV.innerHTML = "<label>值</label>";
  rowV.appendChild(ta);
  rowV.appendChild(numSlotAdd);
  el.modalBody.appendChild(rowK);
  el.modalBody.appendChild(rowT);
  el.modalBody.appendChild(rowBool);
  el.modalBody.appendChild(rowV);

  if (initialRaw !== undefined && initialRaw !== null) {
    const meta = detectValueMeta(String(initialRaw));
    typeSel.value = addKeyTypeSelectValueFromMeta(meta);
    if (meta.kind === "number") {
      initialNum = coerceToNumber(String(initialRaw).trim());
    }
  }

  const syncPlaceholder = () => {
    const t = typeSel.value;
    if (t === "null") {
      rowBool.style.display = "none";
      rowV.style.display = "none";
      numSlotAdd.innerHTML = "";
      numSlotAdd.style.display = "none";
      readAddNum = null;
      return;
    }
    if (t === "boolean") {
      rowBool.style.display = "";
      rowV.style.display = "none";
    } else {
      rowBool.style.display = "none";
      rowV.style.display = "";
    }
    if (t === "number") {
      ta.style.display = "none";
      numSlotAdd.style.display = "";
      readAddNum = mountNumberOrTimestampPicker(numSlotAdd, initialNum, {
        src: "addNumSrc",
        digits: "addNumDig",
      });
    } else if (t !== "boolean") {
      numSlotAdd.innerHTML = "";
      numSlotAdd.style.display = "none";
      readAddNum = null;
      ta.style.display = "";
    }
    if (t === "json") {
      ta.placeholder = '{"a":1} 或 [1,2]';
    } else if (t === "string") {
      ta.placeholder = "任意文本";
    }
  };
  typeSel.addEventListener("change", syncPlaceholder);
  syncPlaceholder();

  if (initialRaw !== undefined && initialRaw !== null) {
    const t = typeSel.value;
    if (t === "json") {
      try {
        const p = JSON.parse(String(initialRaw).trim());
        ta.value = JSON.stringify(p, null, 2);
      } catch {
        ta.value = String(initialRaw);
      }
    } else if (t === "string") {
      ta.value = String(initialRaw);
    } else if (t === "boolean") {
      const v = String(initialRaw).trim() === "true";
      const inp = /** @type {HTMLInputElement | null} */ (
        el.modalBody.querySelector(
          `input[name="addBool"][value="${v ? "true" : "false"}"]`,
        )
      );
      if (inp) inp.checked = true;
    }
  }

  modalOnOk = async () => {
    const name = isFixedKey ? fixed : keyInp.value.trim();
    if (!name) {
      setStatus("请填写键名", true);
      return false;
    }
    const t = typeSel.value;
    let out = "";
    if (t === "null") {
      out = "null";
    } else if (t === "json") {
      try {
        out = formatJsonForStorage(ta.value);
      } catch {
        setStatus("JSON 格式错误", true);
        return false;
      }
    } else if (t === "boolean") {
      const chk = /** @type {HTMLInputElement | null} */ (
        el.modalBody.querySelector('input[name="addBool"]:checked')
      );
      out = JSON.stringify(chk?.value === "true");
    } else if (t === "number") {
      out = String(readAddNum ? readAddNum() : 0);
    } else {
      out = ta.value;
    }
    await persistKeyValue(kind, name, out);
  };

  el.modalBackdrop.hidden = false;
}

function mountHtml(container, node) {
  container.innerHTML = "";
  container.appendChild(node);
  bindClearAllHandlers(container);
}

function bindClearAllHandlers(root) {
  root.querySelectorAll(".btn-clear-all").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const kind = /** @type {'local'|'session'} */ (btn.getAttribute("data-kind"));
      const label = kind === "session" ? "sessionStorage" : "localStorage";
      if (
        !confirm(
          `确定清空当前页面的整份 ${label}？\n此操作不可撤销，游戏存档若存在于此将被清空。`,
        )
      ) {
        return;
      }
      const fid = getSelectedFrame();
      if (fid == null) return;
      setStatus("清空中…");
      const res = await send("storageClearAll", {
        frameId: fid,
        kind: kind === "session" ? "session" : "local",
      });
      if (!res.ok) {
        setStatus(res.error || "清空失败", true);
        return;
      }
      setStatus(`已清空 ${label}`);
      await refresh();
    });
  });
}

function renderIdb() {
  const fr = getFrameData();
  const box = document.createElement("div");
  if (!fr) {
    box.innerHTML = `<p class="empty">无数据</p>`;
    return box;
  }
  const idb = fr.result.indexedDB;
  if (!idb || !idb.supported) {
    box.innerHTML = `<p class="empty">当前环境不支持 indexedDB.databases()（或过旧浏览器内核）。</p>`;
    return box;
  }
  if (idb.error) {
    box.innerHTML = `<p class="empty err">IndexedDB 枚举错误：${escapeHtml(idb.error)}</p>`;
    return box;
  }
  const dbs = idb.databases || [];
  if (dbs.length === 0) {
    box.innerHTML = `<p class="empty">未发现 IndexedDB 数据库（或为空）。</p>`;
    return box;
  }

  const fid = getSelectedFrame();
  for (const db of dbs) {
    const section = document.createElement("div");
    section.className = "idb-db";
    const h = document.createElement("h4");
    const title = document.createElement("span");
    if (db.error) {
      title.textContent = `${db.name}（错误）`;
    } else {
      title.textContent = `${db.name} · v${db.version}`;
    }
    h.appendChild(title);
    if (!db.error && fid != null) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "danger";
      delBtn.textContent = "删除整个库";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`危险操作：将删除 IndexedDB 数据库「${db.name}」，确定？`)) return;
        setStatus("删除数据库…");
        const res = await send("idbDeleteDatabase", { frameId: fid, dbName: db.name });
        if (!res.ok) {
          setStatus(res.error || "删除失败", true);
          return;
        }
        setStatus("数据库已删除");
        await refresh();
      });
      h.appendChild(delBtn);
    }
    section.appendChild(h);

    if (db.error) {
      const p = document.createElement("p");
      p.className = "empty err";
      p.textContent = db.error;
      section.appendChild(p);
      box.appendChild(section);
      continue;
    }

    const stores = db.stores || {};
    const snames = Object.keys(stores).sort();
    if (snames.length === 0) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "无 object store";
      section.appendChild(p);
      box.appendChild(section);
      continue;
    }

    for (const sn of snames) {
      const st = stores[sn];
      const wrap = document.createElement("div");
      wrap.className = "idb-store";
      const h5 = document.createElement("h5");
      h5.textContent = `${sn} · 键数量 ${st.totalKeys ?? "?"}${st.truncated ? "（仅显示前 400 条）" : ""}`;
      wrap.appendChild(h5);
      const table = document.createElement("table");
      table.innerHTML =
        "<thead><tr><th class='key-cell'>键</th><th>值（只读）</th></tr></thead><tbody></tbody>";
      const tb = table.querySelector("tbody");
      for (const row of st.rows || []) {
        const tr = document.createElement("tr");
        const tdK = document.createElement("td");
        tdK.className = "key-cell";
        tdK.textContent = row.key;
        const tdV = document.createElement("td");
        const ta = document.createElement("textarea");
        ta.readOnly = true;
        ta.value = row.value;
        tdV.appendChild(ta);
        tr.appendChild(tdK);
        tr.appendChild(tdV);
        tb.appendChild(tr);
      }
      wrap.appendChild(table);
      section.appendChild(wrap);
    }
    box.appendChild(section);
  }

  const note = document.createElement("p");
  note.className = "empty";
  note.style.marginTop = "12px";
  note.textContent =
    "说明：IndexedDB 键类型可能是对象/二进制，此处为只读预览；行级增删改需专用工具。可删除整个库后让游戏重建。";
  box.appendChild(note);
  return box;
}

function emptyMessage(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}

function renderAll() {
  const fr = getFrameData();
  if (!fr) {
    mountHtml(el.tabLocal, emptyMessage("请先刷新"));
    mountHtml(el.tabSession, emptyMessage("请先刷新"));
    el.tabIdb.innerHTML = "";
    el.tabIdb.appendChild(renderIdb());
    return;
  }
  mountHtml(
    el.tabLocal,
    renderKeyValueTable(
      "local",
      fr.result.localStorage,
      activeTab === "local",
    ),
  );
  mountHtml(
    el.tabSession,
    renderKeyValueTable(
      "session",
      fr.result.sessionStorage,
      activeTab === "session",
    ),
  );
  applyGlobalJsonViewModeToAllRows();
  el.tabIdb.innerHTML = "";
  el.tabIdb.appendChild(renderIdb());
}

function setActiveTab(t) {
  activeTab = t;
  document.querySelectorAll(".tabs .tab").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-tab") === t);
  });
  el.tabLocal.hidden = t !== "local";
  el.tabSession.hidden = t !== "session";
  el.tabIdb.hidden = t !== "idb";
}

document.querySelectorAll(".tabs .tab").forEach((b) => {
  b.addEventListener("click", () => {
    const t = /** @type {'local'|'session'|'idb'} */ (b.getAttribute("data-tab") || "local");
    setActiveTab(t);
    if (t === "local" || t === "session") renderAll();
  });
});

el.selFrame.addEventListener("change", () => renderAll());

el.btnRefresh.addEventListener("click", () => refresh());

applyKvKeyColPct(readKvKeyColPct());
wireStorageKvColumnResize();

setActiveTab("local");
refresh();
