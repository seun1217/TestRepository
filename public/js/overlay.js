// 툴팁 오버레이 렌더링. docs/CONTRACT.md 4절 overlay.js.
// 좌표 계산은 overlay-math.js에 맡기고 여기서는 DOM만 만든다.
import { computeCoverGeometry, mapBBox, anchorTooltip, resolveOverlaps } from "./overlay-math.js";

const TIP_MARGIN = 8;
const TIP_GAP = 4;

const px = (v) => `${v}px`;

function formatConfidence(confidence) {
  const n = Number(confidence);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "";
}

function makeBox(rect) {
  const box = document.createElement("div");
  box.className = "plant-box";
  box.style.left = px(rect.left);
  box.style.top = px(rect.top);
  box.style.width = px(rect.width);
  box.style.height = px(rect.height);
  return box;
}

function makeTip(plant, onSelect) {
  const tip = document.createElement("button");
  tip.type = "button";
  tip.className = "plant-tip";
  tip.tabIndex = 0;
  tip.dataset.plantId = String(plant.id ?? "");
  tip.setAttribute("aria-label", `${plant.name_ko} 상세 보기`);
  tip.append(document.createTextNode(String(plant.name_ko ?? "")));
  const conf = document.createElement("span");
  conf.className = "tip-conf";
  conf.textContent = formatConfidence(plant.confidence);
  tip.append(conf);

  const select = () => {
    if (typeof onSelect === "function") onSelect(plant);
  };
  tip.addEventListener("click", select);
  // 네이티브 button은 Enter/Space에서 click을 또 내므로 preventDefault로 중복 호출을 막는다.
  tip.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (e.repeat) return;
    select();
  });
  return tip;
}

// 오버레이를 비우고 plants를 다시 그린다. 같은 입력이면 같은 결과가 나오므로 리사이즈 때 다시 불러도 된다.
export function renderOverlay(container, plants, { videoEl, onSelect } = {}) {
  container.replaceChildren();
  if (!Array.isArray(plants) || plants.length === 0) return;

  const elemW = container.clientWidth;
  const elemH = container.clientHeight;
  const videoW = videoEl?.videoWidth || elemW;
  const videoH = videoEl?.videoHeight || elemH;
  const geometry = computeCoverGeometry({ videoW, videoH, elemW, elemH });

  const entries = plants.map((plant) => ({
    rect: mapBBox(plant.bbox, geometry),
    tip: makeTip(plant, onSelect),
  }));

  // 박스를 먼저, 툴팁을 나중에 붙여 툴팁이 항상 테두리 위에 그려지게 한다.
  const frag = document.createDocumentFragment();
  for (const { rect } of entries) frag.append(makeBox(rect));
  for (const { tip } of entries) frag.append(tip);
  container.append(frag);

  // DOM에 붙인 뒤 실제 크기를 재서 위치를 정한다.
  const placements = entries.map(({ rect, tip }) => {
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const { left, top } = anchorTooltip(rect, { elemW, elemH, tipW, tipH, margin: TIP_MARGIN });
    return { left, top, width: tipW, height: tipH };
  });
  const resolved = resolveOverlaps(placements, { gap: TIP_GAP });
  entries.forEach(({ tip }, i) => {
    tip.style.left = px(resolved[i].left);
    tip.style.top = px(resolved[i].top);
  });
}

export function clearOverlay(container) {
  container.replaceChildren();
}
