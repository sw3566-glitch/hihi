const HISTORY_KEY = 'geuramgap:history';
const MEMBER_FLAG_KEY = 'geuramgap:isMember';
const PRICE_MODE_KEY = 'geuramgap:priceMode';
const MAX_HISTORY = 50;
const THUMB_MAX_SIZE = 64;

// 카테고리 → 기준 단위 매핑. AI(백엔드)는 카테고리 분류와 숫자 읽기만 하고,
// 카테고리를 어떤 기준 단위(100ml/100g/1개/1m/1매)로 환산할지는 전부 여기서 코드로 결정한다.
const CATEGORY_META = {
  liquid: { unit: 'ml', per: 100, label: '100ml당', suffix: '원/100ml' },
  weight: { unit: 'g', per: 100, label: '100g당', suffix: '원/100g' },
  count: { unit: '개', per: 1, label: '1개당', suffix: '원/개' },
  length: { unit: 'm', per: 1, label: '1m당', suffix: '원/1m' },
  sheet: { unit: '매', per: 1, label: '1매당', suffix: '원/매' },
  unknown: { unit: '?', per: 1, label: '기준 미정', suffix: '' },
};
const CATEGORY_CHOICES = [
  { value: 'liquid', label: '액체 · 100ml' },
  { value: 'weight', label: '무게 · 100g' },
  { value: 'count', label: '개수 · 1개' },
  { value: 'length', label: '길이 · 1m/롤' },
  { value: 'sheet', label: '매수 · 1매' },
];

let captured = [];
let items = [];
let seq = 0;
let priceMode = localStorage.getItem(PRICE_MODE_KEY) || (localStorage.getItem(MEMBER_FLAG_KEY) === 'true' ? 'member' : 'regular');

const thumbs = document.getElementById('thumbs');
const fileInput = document.getElementById('fileInput');
const galleryInput = document.getElementById('galleryInput');
const btnCompare = document.getElementById('btnCompare');
const captureCount = document.getElementById('captureCount');
const loadingLabel = document.getElementById('loadingLabel');
const errorBanner = document.getElementById('errorBanner');

document.getElementById('btnCapture').addEventListener('click', () => fileInput.click());
document.getElementById('btnGallery').addEventListener('click', () => galleryInput.click());

function handleFilesAdded(e) {
  const files = Array.from(e.target.files || []).slice(0, 4 - captured.length);
  files.forEach(file => {
    if (captured.length >= 4) return;
    const id = 'p' + (seq++);
    const url = URL.createObjectURL(file);
    captured.push({ id, file, url });
    const div = document.createElement('div');
    div.className = 'thumb';
    div.id = 'thumb-' + id;
    div.innerHTML = '<img src="' + url + '" alt="촬영된 가격표"><div class="rm">×</div>';
    div.querySelector('.rm').addEventListener('click', () => {
      captured = captured.filter(c => c.id !== id);
      URL.revokeObjectURL(url);
      div.remove();
      updateCount();
    });
    thumbs.appendChild(div);
  });
  e.target.value = '';
  updateCount();
}

fileInput.addEventListener('change', handleFilesAdded);
galleryInput.addEventListener('change', handleFilesAdded);

function updateCount() {
  captureCount.textContent = '사진 ' + captured.length + '장 · 최소 2장 필요';
  btnCompare.disabled = captured.length < 2;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

// 촬영/선택한 원본 사진을 그대로 저장하면 이력 용량이 빠르게 늘어나므로,
// 이력에 붙일 작은 썸네일(긴 변 THUMB_MAX_SIZE px, JPEG)만 따로 만든다.
function resizeThumbnail(file) {
  return new Promise((resolve) => {
    if (!file) { resolve(null); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, THUMB_MAX_SIZE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      } catch (e) {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// 이미지를 같은 배포(Vercel)의 서버리스 함수 /api/analyze-price 로 전달한다.
// Anthropic API 키는 서버 환경변수에만 존재하며 브라우저로 절대 전달되지 않는다.
// 같은 도메인에서 호출하므로 별도 CORS 설정이 필요 없다.
async function extractItemsFromImages(entries) {
  const images = await Promise.all(entries.map(async e => ({
    mediaType: e.file.type || 'image/jpeg',
    data: await fileToBase64(e.file)
  })));

  let res;
  try {
    res = await fetch('/api/analyze-price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images })
    });
  } catch (e) {
    throw new Error('network'); // 요청 자체가 도달하지 못한 경우 (오프라인 등)
  }

  if (!res.ok) {
    throw new Error('server'); // 함수는 응답했지만 오류 (키 누락, 파싱 실패 등)
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    throw new Error('server');
  }
  return data.items;
}

function fallbackItems(count) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push({ name: '상품 ' + (i + 1), category: 'unknown', regularPrice: 0, memberPrice: null, unitSize: 1, rawUnit: '개', packQty: 1, promo: null, promoMemberOnly: false });
  }
  return arr;
}

btnCompare.addEventListener('click', async () => {
  showScreen('screen-loading');
  loadingLabel.textContent = '가격표 인식 중';
  errorBanner.style.display = 'none';

  let extracted;
  let failed = false;
  let failReason = 'server';
  try {
    extracted = await extractItemsFromImages(captured);
  } catch (err) {
    failed = true;
    failReason = err && err.message === 'network' ? 'network' : 'server';
    extracted = fallbackItems(captured.length);
  }

  loadingLabel.textContent = '썸네일 정리 중';
  const thumbList = await Promise.all(captured.map(c => resizeThumbnail(c.file)));

  loadingLabel.textContent = '단가 계산 중';
  await new Promise(r => setTimeout(r, 200));

  items = extracted.map((p, i) => ({
    id: 'item' + i,
    name: (p.name || ('상품 ' + (i + 1))).toString(),
    category: CATEGORY_META[p.category] ? p.category : 'unknown',
    regularPrice: p.regularPrice === null || p.regularPrice === undefined ? null : Number(p.regularPrice),
    memberPrice: p.memberPrice === null || p.memberPrice === undefined ? null : Number(p.memberPrice),
    unitSize: Number(p.unitSize) > 0 ? Number(p.unitSize) : 1,
    rawUnit: (p.rawUnit || '').toString().toLowerCase(),
    packQty: Number(p.packQty) > 0 ? Number(p.packQty) : 1,
    promoText: p.promo || null,
    promoMemberOnly: !!p.promoMemberOnly,
    thumb: thumbList[i] || null,
  }));

  if (failed) {
    errorBanner.textContent = failReason === 'network'
      ? '서버에 연결하지 못했어요. 인터넷 연결을 확인하고, 아래에서 상품명·가격·용량을 직접 입력해주세요.'
      : '자동 인식에 실패했어요. 아래에서 상품명·가격·용량을 직접 입력해주세요.';
    errorBanner.style.display = 'block';
  } else {
    errorBanner.style.display = 'none';
  }
  updateModeButtons();
  renderResults(true);
  showScreen('screen-results');
});

document.getElementById('btnRestart').addEventListener('click', () => {
  captured.forEach(c => URL.revokeObjectURL(c.url));
  captured = [];
  thumbs.innerHTML = '';
  updateCount();
  showScreen('screen-capture');
});

// 현재 가격 모드(정상가/회원가)에 맞는 가격을 고른다. 없으면 있는 쪽으로 대신 계산하고
// priceFellBack 플래그로 "다른 기준으로 대신 계산했다"는 사실을 화면에 알린다.
function pickPrice(item, mode) {
  const primary = mode === 'member' ? item.memberPrice : item.regularPrice;
  const secondary = mode === 'member' ? item.regularPrice : item.memberPrice;
  if (primary !== null && primary !== undefined) return { price: primary, fellBack: false };
  if (secondary !== null && secondary !== undefined) return { price: secondary, fellBack: true };
  return { price: 0, fellBack: false };
}

function normalize(item, mode) {
  const category = CATEGORY_META[item.category] ? item.category : 'unknown';
  const meta = CATEGORY_META[category];
  const { price, fellBack } = pickPrice(item, mode);

  let canonicalUnitSize = item.unitSize > 0 ? item.unitSize : 1;
  if (category === 'liquid' && item.rawUnit === 'l') canonicalUnitSize *= 1000;
  if (category === 'weight' && item.rawUnit === 'kg') canonicalUnitSize *= 1000;

  const packQty = item.packQty > 0 ? item.packQty : 1;

  let totalAmount;
  let rollCount = null;
  if (category === 'count' || category === 'sheet') {
    totalAmount = packQty;
  } else if (category === 'length') {
    totalAmount = canonicalUnitSize * packQty;
    rollCount = packQty;
  } else if (category === 'liquid' || category === 'weight') {
    totalAmount = canonicalUnitSize * packQty;
  } else {
    totalAmount = packQty > 1 ? packQty : (canonicalUnitSize > 0 ? canonicalUnitSize : 1);
  }
  if (!(totalAmount > 0)) totalAmount = 1;

  // 행사가 회원 전용이면 회원가 모드일 때만 반영한다.
  const promoUsable = !!item.promoText && (!item.promoMemberOnly || mode === 'member');
  let promoBuy = 1, promoFree = 0;
  if (promoUsable) {
    const m = String(item.promoText).match(/(\d+)\s*\+\s*(\d+)/);
    if (m) { promoBuy = parseInt(m[1], 10); promoFree = parseInt(m[2], 10); }
  }
  const factor = promoBuy / (promoBuy + promoFree);

  const baseUnit = category === 'unknown' ? 0 : (price / totalAmount) * meta.per;
  const afterUnit = baseUnit * factor;

  let altBaseUnit = null, altAfterUnit = null;
  if (category === 'length' && rollCount > 0) {
    altBaseUnit = price / rollCount;
    altAfterUnit = altBaseUnit * factor;
  }

  return {
    ...item, category, meta, price, priceFellBack: fellBack,
    canonicalUnitSize, packQty, totalAmount, rollCount,
    promoBuy, promoFree, factor, promoActive: promoUsable && (promoBuy > 0 && promoFree > 0),
    baseUnit, afterUnit, altBaseUnit, altAfterUnit,
  };
}

function volText(it) {
  if (it.category === 'length') {
    return it.totalAmount.toLocaleString() + 'm' + (it.packQty > 1 ? ' (' + it.canonicalUnitSize.toLocaleString() + 'm × ' + it.packQty + '롤)' : '');
  }
  if (it.category === 'count') return it.totalAmount.toLocaleString() + '개';
  if (it.category === 'sheet') return it.totalAmount.toLocaleString() + '매';
  if (it.category === 'liquid' || it.category === 'weight') {
    return it.totalAmount.toLocaleString() + it.meta.unit + (it.packQty > 1 ? ' (' + it.canonicalUnitSize.toLocaleString() + it.meta.unit + ' × ' + it.packQty + '개)' : '');
  }
  return '기준 미정';
}

function basisTag(it) {
  const modeLabel = priceMode === 'member' ? '회원가' : '정상가';
  let tag = modeLabel + ' 기준';
  if (it.priceFellBack) {
    tag += priceMode === 'member' ? ' · 회원가 정보 없어 정상가로 계산' : ' · 정상가 정보 없어 회원가로 계산';
  }
  return tag;
}

function calcText(it) {
  const lines = [];
  if (it.category === 'length') {
    if (it.packQty > 1) {
      lines.push(it.canonicalUnitSize.toLocaleString() + 'm × ' + it.packQty + '롤 = ' + it.totalAmount.toLocaleString() + 'm');
    }
    lines.push(it.price.toLocaleString() + '원 ÷ ' + it.totalAmount.toLocaleString() + 'm = ' + Math.round(it.baseUnit).toLocaleString() + '원/1m');
    if (it.rollCount > 0) {
      lines.push(it.price.toLocaleString() + '원 ÷ ' + it.rollCount.toLocaleString() + '롤 = ' + Math.round(it.altBaseUnit).toLocaleString() + '원/1롤');
    }
  } else if (it.category === 'count' || it.category === 'sheet') {
    const unitName = it.category === 'count' ? '개' : '매';
    lines.push(it.price.toLocaleString() + '원 ÷ ' + it.totalAmount.toLocaleString() + unitName + ' = ' + Math.round(it.baseUnit).toLocaleString() + '원/1' + unitName);
  } else if (it.category === 'liquid' || it.category === 'weight') {
    const u = it.meta.unit;
    if (it.packQty > 1) {
      lines.push(it.canonicalUnitSize.toLocaleString() + u + ' × ' + it.packQty + '개 = ' + it.totalAmount.toLocaleString() + u);
    }
    lines.push(it.price.toLocaleString() + '원 ÷ ' + it.totalAmount.toLocaleString() + u + ' × 100 = ' + Math.round(it.baseUnit).toLocaleString() + '원/' + it.meta.label);
  } else {
    return '아직 비교 기준을 선택하지 않았어요.';
  }
  if (it.promoActive) {
    lines.push('× ' + it.promoBuy + '/' + (it.promoBuy + it.promoFree) + ' 행사가 반영 = ' + Math.round(it.afterUnit).toLocaleString() + '원');
  } else if (it.promoText && it.promoMemberOnly) {
    lines.push('(' + it.promoText + ' 행사는 회원 전용이라 이 기준에는 반영하지 않았어요)');
  }
  return lines.join('\n');
}

// 이력은 기기(브라우저) 로컬에만 저장한다 (서버로 전송하지 않음).
// 비교했던 전체 상품(순위·단가·썸네일)을 묶음으로 저장해, 나중에 "무엇과 비교해서 이걸 골랐는지" 볼 수 있게 한다.
function saveHistory(enriched) {
  const buildEntry = (withThumbs) => ({
    date: new Date().toISOString(),
    priceMode,
    items: enriched.map((it, idx) => ({
      rank: idx + 1,
      name: it.name,
      price: Math.round(it.afterUnit),
      unitLabel: it.meta.suffix,
      category: it.category,
      thumb: withThumbs ? (it.thumb || null) : null,
    })),
  });
  const write = (entry) => {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
  };
  try {
    write(buildEntry(true));
  } catch (e) {
    // 용량 초과 등으로 실패하면 썸네일을 빼고 한 번 더 시도한다.
    try { write(buildEntry(false)); } catch (e2) { console.error('history save failed', e2); }
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function renderResults(shouldSave) {
  const withMeta = items.map(it => normalize(it, priceMode));
  const known = withMeta.filter(it => it.category !== 'unknown').sort((a, b) => a.afterUnit - b.afterUnit);
  const unknown = withMeta.filter(it => it.category === 'unknown');
  const enriched = [...known, ...unknown];

  const winner = known[0] || null;
  const runnerUp = known.length > 1 ? known[1] : null;

  const list = document.getElementById('resultList');
  list.innerHTML = '';

  enriched.forEach((it, idx) => {
    const isWinner = winner && it.id === winner.id;
    const card = document.createElement('div');

    if (it.category === 'unknown') {
      card.className = 'result-card unknown-card';
      card.innerHTML = `
        <div class="rc-rank">기준 미정</div>
        <div class="rc-name">${escapeHtml(it.name)}</div>
        <div class="unknown-note">품목을 자동으로 인식하지 못했어요. 비교 기준을 선택해주세요.</div>
        <div class="cat-pills" data-id="${it.id}">
          ${CATEGORY_CHOICES.map(c => '<button type="button" data-cat="' + c.value + '">' + c.label + '</button>').join('')}
        </div>
        <div class="rc-actions">
          <span class="rc-toggle" data-act="edit" data-id="${it.id}">값 직접 입력하기</span>
        </div>
        ${editRowHtml(it)}
      `;
      list.appendChild(card);
      return;
    }

    card.className = 'result-card' + (isWinner ? ' winner' : '');
    const hasPromo = it.promoActive;

    let saveLine = '';
    if (isWinner && runnerUp) {
      const pct = Math.round(((runnerUp.afterUnit - winner.afterUnit) / runnerUp.afterUnit) * 100);
      const savedDisplay = Math.round(((runnerUp.afterUnit - winner.afterUnit) / winner.meta.per) * winner.totalAmount);
      if (pct > 0) {
        saveLine = '<div class="rc-save">' + escapeHtml(runnerUp.name) + '보다 약 ' + pct + '% 저렴 · 이 용량 기준 약 ' + savedDisplay.toLocaleString() + '원 절약</div>';
      }
    }

    const promoDisplay = it.promoText ? (escapeHtml(it.promoText) + (it.promoMemberOnly ? ' (회원 전용)' : '')) : '행사 없음';

    card.innerHTML = `
      <div class="rc-top">
        <div>
          <div class="rc-rank">${idx + 1}위</div>
          <div class="rc-name">${escapeHtml(it.name)}</div>
          <div class="rc-vol">${volText(it)} · ${promoDisplay}</div>
        </div>
        <div class="rc-price">
          <div class="rc-basis-tag">${basisTag(it)}</div>
          ${hasPromo ? '<span class="rc-before">' + Math.round(it.baseUnit).toLocaleString() + '원' + it.meta.suffix.replace('원', '') + '</span>' : ''}
          <div><span class="num">${Math.round(it.afterUnit).toLocaleString()}</span><span class="unit">${it.meta.suffix}</span></div>
          ${it.category === 'length' && it.altAfterUnit !== null ? '<div class="rc-alt"><span class="num-alt">' + Math.round(it.altAfterUnit).toLocaleString() + '</span><span class="unit-alt">원/1롤</span></div>' : ''}
        </div>
      </div>
      ${it.category === 'length' ? '<div class="rc-note">1m당·1롤당 두 기준을 함께 보여드려요 — 겹 수·길이가 다른 휴지끼리는 두 값을 같이 비교해보세요.</div>' : ''}
      ${saveLine}
      <div class="rc-actions">
        <span class="rc-toggle" data-act="calc" data-id="${it.id}">계산 과정 보기</span>
        <span class="rc-toggle" data-act="edit" data-id="${it.id}">값 수정하기</span>
      </div>
      <pre class="rc-calc" id="calc-${it.id}">${calcText(it)}</pre>
      ${editRowHtml(it)}
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('.cat-pills').forEach(wrap => {
    wrap.querySelectorAll('button[data-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = items.find(i => i.id === wrap.dataset.id);
        if (item) item.category = btn.dataset.cat;
        renderResults(false);
      });
    });
  });

  list.querySelectorAll('.rc-toggle').forEach(t => {
    t.addEventListener('click', () => {
      const targetId = (t.dataset.act === 'calc' ? 'calc-' : 'edit-') + t.dataset.id;
      const el = document.getElementById(targetId);
      if (!el) return;
      const showing = el.style.display === 'block' || el.style.display === 'flex';
      el.style.display = showing ? 'none' : (t.dataset.act === 'calc' ? 'block' : 'flex');
    });
  });

  list.querySelectorAll('input[data-field], select[data-field]').forEach(inp => {
    inp.addEventListener('change', () => {
      const item = items.find(i => i.id === inp.dataset.id);
      if (!item) return;
      const field = inp.dataset.field;
      if (field === 'price' || field === 'unitSize' || field === 'packQty') {
        const val = parseFloat(inp.value);
        item[field] = isNaN(val) ? (field === 'packQty' ? 1 : 0) : val;
      } else if (field === 'regularPrice' || field === 'memberPrice') {
        const raw = inp.value.trim();
        item[field] = raw === '' ? null : (parseFloat(raw) || 0);
      } else if (field === 'promoText') {
        item[field] = inp.value.trim() || null;
      } else if (field === 'promoMemberOnly') {
        item[field] = inp.checked;
      } else {
        item[field] = inp.value;
      }
      renderResults(false);
    });
  });

  if (shouldSave && enriched.length > 0) saveHistory(enriched);
}

function editRowHtml(it) {
  return `
      <div class="edit-row" id="edit-${it.id}">
        <div class="edit-field">
          <label>상품명</label>
          <input type="text" data-field="name" data-id="${it.id}" value="${escapeAttr(it.name)}">
        </div>
        <div class="edit-field">
          <label>카테고리</label>
          <select data-field="category" data-id="${it.id}">
            ${CATEGORY_CHOICES.map(c => '<option value="' + c.value + '"' + (it.category === c.value ? ' selected' : '') + '>' + c.label + '</option>').join('')}
          </select>
        </div>
        <div class="edit-field">
          <label>정상가(원)</label>
          <input type="number" data-field="regularPrice" data-id="${it.id}" value="${it.regularPrice === null || it.regularPrice === undefined ? '' : it.regularPrice}">
        </div>
        <div class="edit-field">
          <label>회원가(원, 없으면 비워두기)</label>
          <input type="number" data-field="memberPrice" data-id="${it.id}" value="${it.memberPrice === null || it.memberPrice === undefined ? '' : it.memberPrice}">
        </div>
        <div class="edit-field">
          <label>낱개/롤 기준 수치</label>
          <input type="number" data-field="unitSize" data-id="${it.id}" value="${it.unitSize}">
        </div>
        <div class="edit-field">
          <label>단위</label>
          <select data-field="rawUnit" data-id="${it.id}">
            <option value="ml" ${it.rawUnit === 'ml' ? 'selected' : ''}>ml</option>
            <option value="l" ${it.rawUnit === 'l' ? 'selected' : ''}>L</option>
            <option value="g" ${it.rawUnit === 'g' ? 'selected' : ''}>g</option>
            <option value="kg" ${it.rawUnit === 'kg' ? 'selected' : ''}>kg</option>
            <option value="m" ${it.rawUnit === 'm' ? 'selected' : ''}>m</option>
            <option value="매" ${it.rawUnit === '매' ? 'selected' : ''}>매</option>
            <option value="개" ${it.rawUnit === '개' ? 'selected' : ''}>개</option>
          </select>
        </div>
        <div class="edit-field">
          <label>구성 수량(묶음/총개수/총매수)</label>
          <input type="number" data-field="packQty" data-id="${it.id}" value="${it.packQty}" min="1">
        </div>
        <div class="edit-field">
          <label>행사(예: 2+1)</label>
          <input type="text" data-field="promoText" data-id="${it.id}" value="${escapeAttr(it.promoText || '')}">
        </div>
        <div class="edit-field edit-field-check">
          <label><input type="checkbox" data-field="promoMemberOnly" data-id="${it.id}" ${it.promoMemberOnly ? 'checked' : ''}> 이 행사는 회원 전용</label>
        </div>
      </div>
    `;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// --- 정상가/회원가 토글 ---
function setPriceMode(mode) {
  priceMode = mode;
  localStorage.setItem(PRICE_MODE_KEY, mode);
  updateModeButtons();
  if (items.length > 0) renderResults(false);
}
function updateModeButtons() {
  const r = document.getElementById('modeRegularBtn');
  const m = document.getElementById('modeMemberBtn');
  if (!r || !m) return;
  r.classList.toggle('active', priceMode === 'regular');
  m.classList.toggle('active', priceMode === 'member');
}
document.getElementById('modeRegularBtn')?.addEventListener('click', () => setPriceMode('regular'));
document.getElementById('modeMemberBtn')?.addEventListener('click', () => setPriceMode('member'));

// --- 첫 실행 시 "회원이신가요?" 1회 질문 ---
function maybeAskMembership() {
  if (localStorage.getItem(MEMBER_FLAG_KEY) !== null) return;
  const modal = document.getElementById('memberModal');
  if (modal) modal.style.display = 'flex';
}
document.getElementById('memberYesBtn')?.addEventListener('click', () => {
  localStorage.setItem(MEMBER_FLAG_KEY, 'true');
  setPriceMode('member');
  const modal = document.getElementById('memberModal');
  if (modal) modal.style.display = 'none';
});
document.getElementById('memberNoBtn')?.addEventListener('click', () => {
  localStorage.setItem(MEMBER_FLAG_KEY, 'false');
  setPriceMode('regular');
  const modal = document.getElementById('memberModal');
  if (modal) modal.style.display = 'none';
});

// --- 이력 (비교 묶음 단위로 상세 표시) ---
document.getElementById('btnHistory').addEventListener('click', () => {
  const list = document.getElementById('historyList');
  showScreen('screen-history');

  const entries = loadHistory();
  if (entries.length === 0) {
    list.innerHTML = '<p class="empty-state">아직 비교 이력이 없어요.</p>';
    return;
  }
  list.innerHTML = '';
  entries.forEach((e, idx) => {
    const d = new Date(e.date);
    const dateLabel = d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate();
    const row = document.createElement('div');
    row.className = 'hist-item';

    if (Array.isArray(e.items) && e.items.length > 0) {
      const top = e.items[0];
      const modeLabel = e.priceMode === 'member' ? '회원가' : '정상가';
      row.innerHTML = `
        <div class="hist-row" data-idx="${idx}">
          <div>
            <div class="hist-name">${escapeHtml(top.name)}</div>
            <div class="hist-date">${dateLabel} · 상품 ${e.items.length}개 비교 · ${modeLabel}</div>
          </div>
          <div class="hist-right">
            <div class="hist-price">${top.price.toLocaleString()}${top.unitLabel || ''}</div>
            <span class="hist-caret">▾</span>
          </div>
        </div>
        <div class="hist-detail" id="hist-detail-${idx}"></div>
      `;
    } else {
      // 이력 상세화 이전 버전 데이터와의 호환
      row.innerHTML = `
        <div class="hist-row">
          <div>
            <div class="hist-name">${escapeHtml(e.winner || '')}</div>
            <div class="hist-date">${dateLabel} · 상품 ${e.itemCount || ''}개 비교</div>
          </div>
          <div class="hist-price">${(e.winnerPrice || 0).toLocaleString()}${e.winnerUnit || ''}</div>
        </div>
      `;
    }
    list.appendChild(row);
  });

  list.querySelectorAll('.hist-row[data-idx]').forEach(rowEl => {
    rowEl.addEventListener('click', () => {
      const idx = rowEl.dataset.idx;
      const detail = document.getElementById('hist-detail-' + idx);
      if (!detail) return;
      const showing = detail.classList.contains('open');
      if (showing) { detail.classList.remove('open'); return; }
      if (!detail.dataset.filled) {
        const entry = entries[idx];
        detail.innerHTML = entry.items.map(it => `
          <div class="hist-detail-row">
            <div class="hist-thumb">${it.thumb ? '<img src="' + it.thumb + '" alt="">' : ''}</div>
            <div class="hist-detail-mid">
              <div class="hist-detail-rank">${it.rank}위</div>
              <div class="hist-detail-name">${escapeHtml(it.name)}</div>
            </div>
            <div class="hist-detail-price">${it.price.toLocaleString()}${it.unitLabel || ''}</div>
          </div>
        `).join('');
        detail.dataset.filled = '1';
      }
      detail.classList.add('open');
    });
  });
});

document.getElementById('btnHistoryBack').addEventListener('click', () => showScreen('screen-capture'));

updateCount();
updateModeButtons();
maybeAskMembership();
