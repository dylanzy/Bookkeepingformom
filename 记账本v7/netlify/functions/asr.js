// Netlify Function: 接收前端上传的音频,调讯飞 IAT 流式识别,返回文字
// 讯飞文档: https://www.xfyun.cn/doc/asr/voicedictation/API.html
//
// 环境变量需要在 Netlify 后台配置:
//   XFYUN_APPID
//   XFYUN_API_KEY
//   XFYUN_API_SECRET

const crypto = require('crypto');
const WebSocket = require('ws');

const HOST = 'iat-api.xfyun.cn';
const PATH = '/v2/iat';

function buildAuthUrl(apiKey, apiSecret) {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`;
  const signatureSha = crypto
    .createHmac('sha256', apiSecret)
    .update(signatureOrigin)
    .digest('base64');
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signatureSha}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  const url = `wss://${HOST}${PATH}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(HOST)}`;
  return url;
}

function recognize(audioBase64, appid, apiKey, apiSecret) {
  return new Promise((resolve, reject) => {
    const url = buildAuthUrl(apiKey, apiSecret);
    const ws = new WebSocket(url);

    let resultText = '';
    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('讯飞识别超时'));
      }
    }, 15000);

    ws.on('open', () => {
      // 一次性把整段音频发过去 (status: 0 first, 1 continue, 2 last)
      // 这里我们把整个音频拆成块发,简化为分两次发: 第一帧 + 末帧
      const audioBuf = Buffer.from(audioBase64, 'base64');
      const FRAME_SIZE = 1280; // 40ms * 16kHz * 16bit / 8 = 1280 bytes
      const totalFrames = Math.ceil(audioBuf.length / FRAME_SIZE);

      const sendFrame = (idx) => {
        const start = idx * FRAME_SIZE;
        const end = Math.min(start + FRAME_SIZE, audioBuf.length);
        const chunk = audioBuf.slice(start, end);
        const isFirst = idx === 0;
        const isLast = idx === totalFrames - 1;
        const status = isFirst ? 0 : (isLast ? 2 : 1);

        const frame = {
          data: {
            status: status,
            format: 'audio/L16;rate=16000',
            audio: chunk.toString('base64'),
            encoding: 'raw',
          },
        };
        if (isFirst) {
          frame.common = { app_id: appid };
          frame.business = {
            language: 'zh_cn',
            domain: 'iat',
            accent: 'mandarin',
            vad_eos: 3000,
            ptt: 0,  // 关闭标点
            dwa: 'wpgs', // 动态修正
          };
        }

        ws.send(JSON.stringify(frame));

        if (!isLast) {
          // 模拟 40ms 间隔 (避免被服务端限流)
          setTimeout(() => sendFrame(idx + 1), 40);
        }
      };

      sendFrame(0);
    });

    ws.on('message', (msg) => {
      try {
        const res = JSON.parse(msg.toString());
        if (res.code !== 0) {
          if (!finished) {
            finished = true;
            clearTimeout(timeout);
            try { ws.close(); } catch (e) {}
            reject(new Error(`讯飞错误 ${res.code}: ${res.message}`));
          }
          return;
        }
        if (res.data && res.data.result) {
          const ws_arr = res.data.result.ws || [];
          let segment = '';
          for (const w of ws_arr) {
            for (const cw of (w.cw || [])) {
              segment += cw.w;
            }
          }
          // pgs == "rpl" 表示替换 (动态修正), "apd" 表示追加
          if (res.data.result.pgs === 'rpl' && res.data.result.rg) {
            // 简化:每次结果都覆盖,因为我们最后只取最终
            resultText = segment;
          } else {
            resultText += segment;
          }
        }
        if (res.data && res.data.status === 2) {
          if (!finished) {
            finished = true;
            clearTimeout(timeout);
            try { ws.close(); } catch (e) {}
            resolve(resultText);
          }
        }
      } catch (e) {
        // 忽略解析错误,等下一帧
      }
    });

    ws.on('error', (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    ws.on('close', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        if (resultText) resolve(resultText);
        else reject(new Error('讯飞连接关闭但无结果'));
      }
    });
  });
}

exports.handler = async (event) => {
  // CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const APPID = process.env.XFYUN_APPID;
  const API_KEY = process.env.XFYUN_API_KEY;
  const API_SECRET = process.env.XFYUN_API_SECRET;

  if (!APPID || !API_KEY || !API_SECRET) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: '后端未配置讯飞密钥' }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const audio = body.audio;
    if (!audio) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 audio 字段' }) };
    }

    const text = await recognize(audio, APPID, API_KEY, API_SECRET);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ text: text || '' }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || String(err) }),
    };
  }
};
