// Netlify Function: 调智谱 GLM-4.7-Flash 做记账分类 + 查询解析
// 接口文档: https://docs.bigmodel.cn/api-reference/模型-api/对话补全
// 智谱接口跟 OpenAI 兼容: POST https://open.bigmodel.cn/api/paas/v4/chat/completions

const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = 'glm-4.7-flash';

const CATEGORIES = ['买菜','餐饮','交通','医疗','日用','水电煤','人情','家人','儿女','衣服','娱乐','学习','还款','其他'];

// 提示词:记账分类
const CLASSIFY_SYSTEM = `你是一个家庭记账助手。用户(一位老人)会用语音说出一笔花销,你需要把它解析成结构化数据。

请严格返回 JSON 格式,不要任何额外解释、Markdown 标记或思考过程,直接输出 JSON:
{
  "cat": "分类名(必须是下面之一)",
  "amount": 金额数字(单位:元),
  "note": "简短备注(把用户说的内容提炼成 4-10 个字的关键信息)"
}

可选分类(必须严格使用下面其中一个,注意区分相似分类):
- 买菜: 蔬菜、水果、肉、鱼、超市买的食材
- 餐饮: 早餐午餐晚餐、外卖、奶茶、下馆子
- 交通: 打车、地铁、公交、加油、停车、车票
- 医疗: 看病、买药、体检、保健品
- 日用: 洗衣粉、纸巾、牙膏、家具、五金等家庭日用品
- 水电煤: 水电燃气费、物业费、话费宽带
- 人情: 随礼、份子钱、红包、送礼
- 家人: 给孙辈(孙子/孙女/外孙/小孙)买的东西或钱
- 儿女: 给儿子/女儿(成年子女)生活费、补贴、买东西。注意"儿女"是给成年子女,"家人"是给孙辈
- 衣服: 衣服、裤子、鞋袜、帽子
- 娱乐: 看电影、旅游、按摩、美容、理发、打麻将
- 学习: 老年大学、上课学费、培训班、买书、教材、兴趣班
- 还款: 房贷、车贷、信用卡还款、花呗、借呗、网贷、月供、房租
- 其他: 以上都不属于

如果分不清楚或听不懂,使用"其他"。如果听不出金额,amount 填 0。

例子:
输入: "今天买了点榴莲花了 50 块"
输出: {"cat":"买菜","amount":50,"note":"榴莲"}

输入: "给孙子买了个玩具 80"
输出: {"cat":"家人","amount":80,"note":"给孙子买玩具"}

输入: "给我儿子转了两千块生活费"
输出: {"cat":"儿女","amount":2000,"note":"给儿子生活费"}

输入: "今天还房贷三千"
输出: {"cat":"还款","amount":3000,"note":"房贷"}

输入: "信用卡还了一千五"
输出: {"cat":"还款","amount":1500,"note":"信用卡还款"}

输入: "老年大学交了五百学费"
输出: {"cat":"学习","amount":500,"note":"老年大学学费"}

输入: "充话费一百"
输出: {"cat":"水电煤","amount":100,"note":"话费"}

输入: "买了瓶钙片八十"
输出: {"cat":"医疗","amount":80,"note":"钙片"}`;

// 提示词:查询解析
const QUERY_SYSTEM = `你是一个家庭记账助手。用户会用语音问一个查询问题,你需要把它解析成结构化数据。

请严格返回 JSON 格式,不要任何额外解释、Markdown 标记或思考过程,直接输出 JSON:
{
  "period": "时间维度",
  "offset": 偏移数字,
  "days": 天数(仅当 period 是 recent 时),
  "cat": "类别名 或 null",
  "type": "查询类型"
}

字段说明:
- period: "day" | "week" | "month" | "quarter" | "year" | "recent" | "specific_month"
- offset: 整数。0=本周期, -1=上一周期, -2=再上一个。例如 day=-1 表示昨天, month=-1 表示上月。如果 period 是 recent 或 specific_month, offset 填 0。
- days: 仅当 period="recent" 时使用。例如"最近三天"则 days=3, "最近一周"则 days=7
- specific_month: 当用户说具体月份时(如"三月份"),period="specific_month", offset=月份数字 1-12
- cat: 类别名,从这个列表里选: 买菜/餐饮/交通/医疗/日用/水电煤/人情/家人/儿女/衣服/娱乐/学习/还款。如果用户没指定类别,填 null
- type: "total"(查询总金额) 或 "detail"(查询明细列表/有什么)

例子:
"这个月花了多少" -> {"period":"month","offset":0,"cat":null,"type":"total"}
"上个月买菜多少" -> {"period":"month","offset":-1,"cat":"买菜","type":"total"}
"最近三天花了什么" -> {"period":"recent","offset":0,"days":3,"cat":null,"type":"detail"}
"昨天打车多少" -> {"period":"day","offset":-1,"cat":"交通","type":"total"}
"三月份吃饭花了多少" -> {"period":"specific_month","offset":3,"cat":"餐饮","type":"total"}
"上周餐饮明细" -> {"period":"week","offset":-1,"cat":"餐饮","type":"detail"}
"今年总共多少" -> {"period":"year","offset":0,"cat":null,"type":"total"}
"今年还了多少房贷" -> {"period":"year","offset":0,"cat":"还款","type":"total"}
"这个月给儿子转了多少" -> {"period":"month","offset":0,"cat":"儿女","type":"total"}
"上学期学费多少" -> {"period":"month","offset":-3,"cat":"学习","type":"total"}`;

async function callZhipu(systemPrompt, userText, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const resp = await fetch(ZHIPU_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        // GLM-4.7-Flash 是 thinking 模型,关闭思考过程加快返回
        thinking: { type: 'disabled' },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`智谱接口 ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = await resp.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('智谱无内容返回');

    // 抽取 JSON: 优先直接解析,失败则尝试 markdown 块
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }
    return JSON.parse(cleaned);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('AI 超时');
    throw err;
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '后端未配置智谱密钥' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const mode = body.mode;
    const text = body.text;
    if (!text) return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 text' }) };

    let systemPrompt;
    if (mode === 'classify') systemPrompt = CLASSIFY_SYSTEM;
    else if (mode === 'query') systemPrompt = QUERY_SYSTEM;
    else return { statusCode: 400, headers, body: JSON.stringify({ error: 'mode 必须是 classify 或 query' }) };

    const result = await callZhipu(systemPrompt, text, apiKey);

    // classify 模式:校验分类是否在白名单
    if (mode === 'classify') {
      if (!CATEGORIES.includes(result.cat)) result.cat = '其他';
      if (typeof result.amount !== 'number' || result.amount < 0) result.amount = 0;
      if (typeof result.note !== 'string') result.note = text;
    }

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
