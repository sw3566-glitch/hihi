// Vercel Serverless Function: /api/analyze-price
// 브라우저에서 받은 가격표 이미지(base64)를 Anthropic Vision API로 보내
// 상품명/가격/용량/단위/구성개수/행사문구만 추출해 JSON으로 돌려준다.
//
// 보안: ANTHROPIC_API_KEY는 Vercel 프로젝트의 서버 환경변수에만 존재하며
// 브라우저나 응답 본문에 절대 포함되지 않는다. (같은 배포/도메인에서 실행되므로 CORS 설정도 불필요)

const MAX_IMAGES = 4;
// base64 문자열 기준 대략적인 상한 (원본 이미지 약 6MB 상당). 과도한 비용/남용 방지용.
const MAX_IMAGE_BASE64_LEN = 8_000_000;
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const EXTRACT_TOOL = {
  name: 'return_items',
  description: '사진들에서 추출한 상품 정보 배열을 반환한다. 사진이 주어진 순서와 동일한 순서로 반환한다.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '상품명' },
            price: { type: 'number', description: '실제 지불 총액(정수, 원). 여러 개가 묶여 하나의 가격으로 팔리면 그 총액.' },
            volume: { type: 'number', description: '낱개(unit 1개) 기준 용량 숫자. 예: "50ml 3개"면 50, "2L"면 2.' },
            unit: { type: 'string', enum: ['ml', 'l', 'g', 'kg', '개'], description: '용량 단위. 용량 표기가 없고 개수만 있으면 "개".' },
            packQty: { type: 'number', description: '그 가격에 포함된 원래 판매 단위의 구성 개수(묶음). 예: "50ml 3개"면 3. 낱개 상품이면 1. "2+1" 같은 구매 행사 문구와 혼동하지 말 것.' },
            promo: { type: ['string', 'null'], description: '구매 시 추가로 더 주는 행사 문구(예: "1+1", "2+1"). 없으면 null.' },
          },
          required: ['name', 'price', 'volume', 'unit', 'packQty'],
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
    '각 사진에서 상품명, 실제 지불 총액, 낱개 기준 용량, 단위, 구성 개수(묶음), 행사 문구를 읽어서 ' +
    'return_items 도구를 호출해 결과를 반환해줘. 사진이 주어진 순서대로 items 배열을 채워줘. ' +
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
