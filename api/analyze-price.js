// Vercel Serverless Function: /api/analyze-price
// 브라우저에서 받은 가격표 이미지(base64)를 Anthropic Vision API로 보내
// 상품명/카테고리/가격(정상가·회원가)/용량/단위/구성개수/행사문구만 추출해 JSON으로 돌려준다.
//
// 설계 원칙: AI에게 단가 계산은 절대 시키지 않는다. AI는 딱 두 가지만 한다.
//   ① 품목 카테고리 분류 (열거형 고정 — 자유 텍스트로 두면 "포당","인분당" 같은
//      즉흥적인 값이 나와 프론트엔드 코드가 깨진다)
//   ② 사진 속 숫자·단위를 있는 그대로 읽기
// 기준 단위 결정(카테고리→100ml/100g/1개/1m/1매)과 환산·정렬은 전부 src/main.js(코드)에서 처리한다.
//
// 보안: ANTHROPIC_API_KEY는 Vercel 프로젝트의 서버 환경변수에만 존재하며
// 브라우저나 응답 본문에 절대 포함되지 않는다. (같은 배포/도메인에서 실행되므로 CORS 설정도 불필요)

const MAX_IMAGES = 4;
// base64 문자열 기준 대략적인 상한 (원본 이미지 약 6MB 상당). 과도한 비용/남용 방지용.
const MAX_IMAGE_BASE64_LEN = 8_000_000;
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// 코드 쪽(main.js)의 CATEGORY_RULES 와 이름을 반드시 맞춰서 유지할 것.
const CATEGORIES = ['liquid', 'weight', 'count', 'length', 'sheet', 'unknown'];
const RAW_UNITS = ['ml', 'l', 'g', 'kg', 'm', '매', '개'];

const EXTRACT_TOOL = {
  name: 'return_items',
  description:
    '사진들에서 추출한 상품 정보 배열을 반환한다. 사진이 주어진 순서와 동일한 순서로 반환한다. ' +
    '단가·환산은 절대 직접 계산하지 말고, 사진에 적힌 숫자·단위를 있는 그대로 옮겨 적는다.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '상품명' },
            category: {
              type: 'string',
              enum: CATEGORIES,
              description:
                '상품 종류를 아래 다섯 가지 중 하나로 분류한다(확신이 없을 때만 unknown). ' +
                'liquid = 우유·음료·액체세제·샴푸 등 부피(ml, L)로 표시되는 액체. ' +
                'weight = 쌀·과자·가루세제 등 무게(g, kg)로 표시되는 고체. ' +
                'count = 계란·라면·즉석밥처럼 개수로 세는 낱개 상품. ' +
                'length = 두루마리 휴지·랩·호일처럼 길이(m)와 롤 수로 표시되는 상품. ' +
                'sheet = 물티슈·각티슈처럼 매수로 세는 상품. ' +
                'unknown = 위 다섯 가지 중 어디에도 확실히 속하지 않을 때만 사용.',
            },
            regularPrice: {
              type: ['number', 'null'],
              description: '정상가(회원 할인 미적용) 총 지불액(원, 정수). 가격표에 가격이 하나뿐이면 그 값을 넣는다. 정상가를 알 수 없으면 null.',
            },
            memberPrice: {
              type: ['number', 'null'],
              description: '회원가/멤버십가 총 지불액(원, 정수). 별도 회원가 표시가 없으면 null.',
            },
            unitSize: {
              type: 'number',
              description:
                'category에 따른 "낱개 1단위" 표시 수치를 있는 그대로 옮긴다. ' +
                'liquid/weight: 낱개 하나의 용량·중량 숫자(예: "500ml"→500, "2L"→2, "50ml×3"→50). ' +
                'length: 롤 1개의 길이 숫자(예: "27m×30롤"→27). ' +
                'count/sheet/unknown: 1로 고정.',
            },
            rawUnit: {
              type: 'string',
              enum: RAW_UNITS,
              description:
                'unitSize의 단위. category와 반드시 짝이 맞아야 한다: liquid→ml 또는 l, weight→g 또는 kg, ' +
                'length→m, count→개, sheet→매, unknown이면 아무 값이나(무시됨).',
            },
            packQty: {
              type: 'number',
              description:
                '그 가격 하나에 묶여 있는 수량. ' +
                'liquid/weight/length: unitSize 단위가 몇 개/롤 묶였는지(예: "50ml×3"→3, "27m×30롤"→30, 낱개면 1). ' +
                'count: 총 개수(예: "계란 30구"→30). ' +
                'sheet: 총 매수(예: "120매"→120, 봉지가 여러 개면 봉지당 매수×봉지 수를 곱한 총 매수). ' +
                '"2+1" 같은 구매 행사(추가 증정)와 절대 혼동하지 말 것 — 그건 promo 필드에 별도로 적는다.',
            },
            promo: {
              type: ['string', 'null'],
              description: '구매 시 추가로 더 주는 행사 문구(예: "1+1", "2+1"). 없으면 null.',
            },
            promoMemberOnly: {
              type: 'boolean',
              description: 'promo 행사에 회원 조건이 붙어 있으면 true(예: "앱 회원 2+1", "멤버십 회원 한정"), 아니면 false.',
            },
          },
          required: ['name', 'category', 'regularPrice', 'memberPrice', 'unitSize', 'rawUnit', 'packQty', 'promoMemberOnly'],
        },
      },
    },
    required: ['items'],
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY가 설정되지 않았습니다. Vercel 프로젝트 Settings > Environment Variables에서 설정하세요.');
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }

  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  if (images.length < 1 || images.length > MAX_IMAGES) {
    res.status(400).json({ error: 'invalid_image_count' });
    return;
  }

  const imageBlocks = [];
  for (const img of images) {
    const mediaType = (img.mediaType || '').toLowerCase();
    const data = img.data || '';
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      res.status(400).json({ error: 'invalid_media_type' });
      return;
    }
    if (!data || data.length > MAX_IMAGE_BASE64_LEN) {
      res.status(400).json({ error: 'invalid_or_too_large_image' });
      return;
    }
    imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  }

  const promptText =
    '아래는 마트/쇼핑몰 가격표 또는 상품 정보 사진 ' + images.length + '장이야. ' +
    '각 사진에서 상품명, 품목 카테고리, 정상가, 회원가(있다면), 낱개 기준 수치와 단위, 구성 수량(묶음), ' +
    '행사 문구와 그 행사가 회원 전용인지를 읽어서 return_items 도구를 호출해 결과를 반환해줘. ' +
    '사진이 주어진 순서대로 items 배열을 채워줘. ' +
    '가격표에 정상가와 회원가가 둘 다 붙어 있으면 반드시 둘 다 각자의 필드에 넣고, 하나만 있으면 그 하나만 채우고 나머지는 null로 둬. ' +
    '단가나 환산값은 절대 계산하지 말고, 사진에 인쇄된 숫자와 단위를 그대로 옮겨 적기만 해. ' +
    '값을 확신할 수 없으면 최선의 추정치를 채우되, 절대 도구 호출 없이 텍스트로만 답하지 마.';

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 1500,
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: promptText }] }],
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'return_items' },
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      console.error('Anthropic API error', anthropicRes.status, errText);
      res.status(502).json({ error: 'upstream_error' });
      return;
    }

    const data = await anthropicRes.json();
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
    const items = toolUse?.input?.items;

    if (!Array.isArray(items) || items.length === 0) {
      console.error('예상치 못한 Claude 응답 형태', JSON.stringify(data).slice(0, 500));
      res.status(502).json({ error: 'parse_failed' });
      return;
    }

    res.status(200).json({ items });
  } catch (err) {
    console.error('analyze-price 처리 중 오류', err);
    res.status(500).json({ error: 'internal_error' });
  }
}
