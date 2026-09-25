// 상세 설명 바텀 시트. docs/CONTRACT.md 4절 sheet.js.
// 닫기 버튼과 Escape 키 처리는 app.js가 담당하므로 여기서는 리스너를 붙이지 않는다.

const CLOSE_FALLBACK_MS = 300;
const LOADING_TEXT = "상세 설명을 불러오는 중입니다";
const RETRY_TEXT = "다시 시도";

// 시트 요소별 상태 (이전 포커스, body overflow, 진행 중인 닫기 작업).
const states = new WeakMap();

function getState(sheetEl) {
  let st = states.get(sheetEl);
  if (!st) {
    st = { prevFocus: null, prevOverflow: "", closing: null, openGen: 0 };
    states.set(sheetEl, st);
  }
  return st;
}

function setText(sheetEl, name, value) {
  for (const el of sheetEl.querySelectorAll(`[data-field="${name}"]`)) {
    el.textContent = value == null ? "" : String(value);
  }
}

function formatConfidence(confidence) {
  const n = Number(confidence);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "";
}

// 모델이 준 텍스트는 innerHTML로 넣지 않고 빈 줄 기준으로 나눠 <p>에 textContent로 담는다.
function toParagraphs(text) {
  return String(text ?? "")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const p = document.createElement("p");
      p.textContent = s;
      return p;
    });
}

function loadingNodes() {
  const p = document.createElement("p");
  p.className = "sheet-loading";
  p.textContent = LOADING_TEXT;
  return [p];
}

// 오류 문구와 (onRetry가 있을 때만) 다시 시도 버튼.
function errorNodes(message, onRetry) {
  const p = document.createElement("p");
  p.className = "sheet-error";
  p.textContent = message;
  if (typeof onRetry !== "function") return [p];
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn sheet-retry";
  btn.textContent = RETRY_TEXT;
  btn.addEventListener("click", () => onRetry());
  return [p, btn];
}

// 상세 영역을 다시 그린다. 컨테이너가 여럿일 수 있으므로 노드는 컨테이너마다 새로 만든다.
function renderDetail(sheetEl, makeNodes, { busy = false } = {}) {
  for (const el of sheetEl.querySelectorAll('[data-field="detail_ko"]')) {
    el.replaceChildren(...makeNodes());
    if (busy) el.setAttribute("aria-busy", "true");
    else el.removeAttribute("aria-busy");
  }
}

function fill(sheetEl, plant) {
  const p = plant || {};
  setText(sheetEl, "name_ko", p.name_ko || "이름 미상");
  setText(sheetEl, "name_sci", p.name_sci);
  setText(sheetEl, "name_en", p.name_en);
  setText(sheetEl, "family_ko", p.family_ko);
  setText(sheetEl, "confidence", formatConfidence(p.confidence));
  setText(sheetEl, "summary_ko", p.summary_ko);
  for (const el of sheetEl.querySelectorAll('[data-field="tags"]')) {
    const tags = Array.isArray(p.tags) ? p.tags : [];
    el.replaceChildren(
      ...tags.map((t) => {
        const li = document.createElement("li");
        li.textContent = String(t);
        return li;
      }),
    );
  }
  // 상세가 비어 있으면 app.js가 describe를 부르는 동안 불러오는 중 표시를 보여준다.
  if (String(p.detail_ko ?? "").trim()) renderDetail(sheetEl, () => toParagraphs(p.detail_ko));
  else renderDetail(sheetEl, loadingNodes, { busy: true });
}

function cancelPendingClose(sheetEl, st) {
  if (!st.closing) return;
  clearTimeout(st.closing.timer);
  st.closing.panel?.removeEventListener("transitionend", st.closing.onEnd);
  st.closing = null;
}

export function openSheet(sheetEl, plant) {
  if (!sheetEl) return;
  const st = getState(sheetEl);
  const wasClosing = Boolean(st.closing);
  cancelPendingClose(sheetEl, st);

  // 완전히 닫힌 상태에서 여는 경우에만 복원 정보를 기억한다 (닫히는 중이거나 이미 열려 있으면 유지).
  if (sheetEl.hidden && !wasClosing) {
    st.prevFocus = document.activeElement;
    st.prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }

  sheetEl.dataset.plantId = String(plant?.id ?? "");
  fill(sheetEl, plant);
  const panel = sheetEl.querySelector(".sheet-panel");
  if (panel) panel.scrollTop = 0;

  sheetEl.hidden = false;
  sheetEl.setAttribute("aria-hidden", "false");
  // display:none에서 막 나온 요소는 시작 스타일이 없어 전환이 생략되므로 강제로 레이아웃을 한 번 계산한다.
  if (panel) void panel.offsetHeight;
  const gen = ++st.openGen;
  requestAnimationFrame(() => {
    if (st.openGen === gen && !sheetEl.hidden) sheetEl.classList.add("is-open");
  });

  sheetEl.querySelector(".sheet-close")?.focus({ preventScroll: true });
}

// 현재 열린(또는 닫히는 중인) 식물 id. 완전히 닫혀 있으면 null.
export function getSheetPlantId(sheetEl) {
  if (!sheetEl) return null;
  if (sheetEl.hidden && !states.get(sheetEl)?.closing) return null;
  const id = sheetEl.dataset.plantId;
  return id == null ? null : id;
}

// 시트가 plantId를 보여주고 있을 때만 상세 영역을 갱신한다 (늦게 온 응답이 다른 식물을 덮어쓰지 않도록).
// detail_ko -> 문단, error -> 오류 문구와 다시 시도 버튼, 둘 다 없으면 다시 불러오는 중 표시. -> 갱신했으면 true.
export function setSheetDetail(sheetEl, plantId, { detail_ko, error, onRetry } = {}) {
  if (!sheetEl) return false;
  const current = getSheetPlantId(sheetEl);
  if (current == null || current !== String(plantId)) return false;
  if (String(detail_ko ?? "").trim()) renderDetail(sheetEl, () => toParagraphs(detail_ko));
  else if (error) renderDetail(sheetEl, () => errorNodes(String(error), onRetry));
  else renderDetail(sheetEl, loadingNodes, { busy: true });
  return true;
}

export function closeSheet(sheetEl) {
  if (!sheetEl || sheetEl.hidden) return;
  const st = getState(sheetEl);
  if (st.closing) return;
  st.openGen += 1; // 아직 실행되지 않은 openSheet의 rAF를 무효화한다.

  sheetEl.classList.remove("is-open");
  sheetEl.setAttribute("aria-hidden", "true");

  const panel = sheetEl.querySelector(".sheet-panel");
  const finish = () => {
    cancelPendingClose(sheetEl, st);
    sheetEl.hidden = true;
    delete sheetEl.dataset.plantId;
    document.body.style.overflow = st.prevOverflow;
    const prev = st.prevFocus;
    st.prevFocus = null;
    if (prev && prev.isConnected && typeof prev.focus === "function") {
      prev.focus({ preventScroll: true });
    }
  };
  const onEnd = (e) => {
    if (e.target === panel) finish();
  };
  panel?.addEventListener("transitionend", onEnd);
  st.closing = { panel, onEnd, timer: setTimeout(finish, CLOSE_FALLBACK_MS) };
}
