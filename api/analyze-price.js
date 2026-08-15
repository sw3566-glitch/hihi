// Vercel Serverless Function: /api/analyze-price
// 브라우저에서 받은 가격표 이미지(base64)를 Anthropic Vision API로 보내
// 상품명 / 품목 카테고리 / 용량·단위 / 구성개수 / 정상가·회원가 / 행사문구를 추출해 JSON으로 돌려준다.
// 실제 단위 환산과 가격 계산은 여기서 하지 않는다 (프론트엔드에서 처리).
//
// 보안: ANTHROPIC_API_KEY는 Vercel 프로젝트의 서버 환경변수에만 존재하며
// 브라우저나 응답 본문에 절대 포함되지 않는다. (같은 배포/도메인에서 실행되므로 CORS 설정도 불필요)
//
// 주의: Vercel Node.js 서버리스 함수는 요청 본문 전체가 약 4.5MB로 제한된다.
// 이미지 4장을 base64로 보내면 금방 넘기 때문에, 프론트엔드(src/main.js)에서
// 전송 전 캔버스로 리사이즈/재압축을 거친다. 이 파일의 크기 상한은 그 이후의 2차 방어선이다.

const MAX_IMAGES = 4;
// base64 문자열 기준 상한 (이미지 1장당 약 2.2MB 상당). 프론트엔드 압축이 정상 동작하면
// 보통 이보다 훨씬 작게 들어오며, 이 값은 남용 방지를 위한 안전장치다.
const MAX_IMAGE_BASE64_LEN = 3_000_000;
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
            category: {
              type: 'string',
              enum: ['liquid', 'weight', 'count', 'length', 'sheet', 'unknown'],
              description:
                '이 상품의 실제 비교 기준이 되는 품목 카테고리. ' +
                'liquid=액체(우유/음료/세제/샴푸/화장품, 100ml 기준), ' +
                'weight=중량(쌀/과자/가루세제, 100g 기준), ' +
                'count=개수(계란/라면/즉석밥처럼 낱개 수량이 기준, 1개 기준), ' +
                'length=길이(두루마리 휴지/랩/호일처럼 롤·길이가 기준, 1m 기준), ' +
                'sheet=매수(물티슈/각티슈처럼 장 수가 기준, 1매 기준), ' +
                'unknown=위 다섯 중 무엇에도 해당 안 되거나 판단 불가.',
            },
            amount: {
              type: 'number',
              description:
                '카테고리별 낱개(포장 1개) 기준 수치. liquid/weight: 낱개 용량(예: 500ml면 500, 2L면 2). ' +
                'length: 롤 1개의 길이(예: 30m면 30). sheet: 팩 1개의 매수(예: 80매면 80). ' +
                'count: 의미 없으므로 1을 넣는다. 묶음 구성이 서로 다른 용량을 섞어 파는 경우 ' +
                '(예: 50ml 2개 + 20ml 1개) 가장 흔하거나 큰 대표 용량으로 최선 추정한다.',
            },
            amountUnit: {
              type: 'string',
              enum: ['ml', 'l', 'g', 'kg', 'm', 'cm', '매', '개', ''],
              description:
                'amount의 단위. liquid는 ml 또는 l, weight는 g 또는 kg, length는 m 또는 cm, sheet는 매, count는 개. unknown이면 빈 문자열.',
            },
            packQty: {
              type: 'number',
              description:
                '이 가격에 포함된 원래 판매 단위의 구성 개수(묶음). 예: "500ml 3개"면 3, 휴지 "30m 30롤"이면 30, ' +
                '계란 한 판(30개)이면 30, 낱개/단일 포장이면 1. amount가 대표 용량으로 추정된 경우 ' +
                '그 대표 용량 기준 개수로 최선 추정한다. "2+1" 같은 구매 행사 문구와 혼동하지 말 것 ' +
                '(그건 promo 필드에 별도로 적는다).',
            },
            priceRegular: {
              type: 'number',
              description:
                '일반 구매자가 실제로 결제하는 금액(원). "정상가/판매가/즉시할인가/쿠폰 적용가/최종 결제가"처럼 ' +
                '별도 멤버십 가입 없이 누구나 받을 수 있는 가격을 여기에 넣는다. 가격이 하나만 있으면 그 값. ' +
                '여러 판매처가 나열된 가격비교 페이지라면 대표로 보이는 가격 하나만 사용한다.',
            },
            priceMember: {
              type: ['number', 'null'],
              description:
                '"멤버십가/회원 전용가/N+ 멤버십 적용가"처럼 별도 유료·무료 멤버십 가입이 있어야만 받을 수 있는 ' +
                '할인가가 정상가와 별도로 표시되어 있으면 그 값. 단순 쿠폰/즉시할인은 여기 넣지 말고 priceRegular에 반영. 없으면 null.',
            },
            promo: {
              type: ['string', 'null'],
              description: '구매 시 추가로 더 주는 행사 문구(예: "1+1", "2+1"). 없으면 null.',
            },
            memberOnlyPromo: {
              type: 'boolean',
              description: 'promo가 "회원 전용", "앱 회원", "멤버십 전용" 등 회원에게만 적용되는 조건이 붙어 있으면 true.',
            },
          },
          required: ['name', 'category', 'amount', 'amountUnit', 'packQty', 'priceRegular', 'memberOnlyPromo'],
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
    '사진에는 실물 가격표뿐 아니라 온라인 쇼핑몰 상품 상세페이지나 가격비교 페이지 스크린샷도 포함될 수 있어. ' +
    '각 사진에서 상품명, 품목 카테고리(liquid/weight/count/length/sheet/unknown), ' +
    '낱개 기준 수치(amount)와 단위(amountUnit), 구성 개수(packQty), ' +
    '정상가(priceRegular)와 회원가(priceMember, 멤버십 전용 할인가가 별도 표시된 경우만), ' +
    '행사 문구(promo)와 회원 전용 여부(memberOnlyPromo)를 읽어서 ' +
    'return_items 도구를 호출해 결과를 반환해줘. 사진이 주어진 순서대로 items 배열을 채워줘. ' +
    '카테고리 판단이 애매하면 unknown으로 표시해. ' +
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
        max_tokens: 2000,
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
