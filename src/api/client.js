import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';

export async function generateAssistantResponse(requestBody, callback) {
  const token = await tokenManager.getToken();
  
  if (!token) {
    throw new Error('没有可用的token，请运行 npm run login 获取token');
  }
  
  const url = config.api.url;
  
  const requestHeaders = {
    'Host': config.api.host,
    'User-Agent': config.api.userAgent,
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip'
  };
  
  let response;
  
  try {
    // 创建 AbortController 用于超时控制
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 600000); // 10分钟超时
    
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    
    if (!response.ok) {
      const responseText = await response.text();
      
      if (response.status === 403) {
        tokenManager.disableCurrentToken(token);
        throw new Error(`该账号没有使用权限，已自动禁用。错误详情: ${responseText}`);
      }
      throw new Error(`API请求失败 (${response.status}): ${responseText}`);
    }
    
  } catch (error) {
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let reasoningContent = ''; // 累积 reasoning_content
  let toolCalls = [];

  let chunkCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value);
    chunkCount++;
    const lines = chunk.split('\n').filter(line => line.startsWith('data: '));
    
    for (const line of lines) {
      const jsonStr = line.slice(6);
      try {
        const data = JSON.parse(jsonStr);
        
        const parts = data.response?.candidates?.[0]?.content?.parts;
        if (parts) {
          for (const part of parts) {
            if (part.thought === true) {
              // Gemini 的思考内容转换为 OpenAI 兼容的 reasoning_content 格式
              reasoningContent += part.text || '';
              callback({ type: 'reasoning', content: part.text || '' });
            } else if (part.text !== undefined) {
              // 过滤掉空的非thought文本
              if (part.text.trim() === '') {
                continue;
              }
              callback({ type: 'text', content: part.text });
            } else if (part.functionCall) {
              toolCalls.push({
                id: part.functionCall.id,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args)
                }
              });
            }
          }
        }
        
        // 当遇到 finishReason 时，发送所有收集的工具调用
        if (data.response?.candidates?.[0]?.finishReason && toolCalls.length > 0) {
          callback({ type: 'tool_calls', tool_calls: toolCalls });
          toolCalls = [];
        }
      } catch (e) {
        // 忽略解析错误
      }
    }
  }
}

export async function getAvailableModels() {
  const token = await tokenManager.getToken();
  
  if (!token) {
    throw new Error('没有可用的token，请运行 npm run login 获取token');
  }
  
  const modelsUrl = config.api.modelsUrl;
  
  const requestHeaders = {
    'Host': config.api.host,
    'User-Agent': config.api.userAgent,
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip'
  };
  const requestBody = {};
  
  let response;
  let data;
  
  try {
    response = await fetch(modelsUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestBody)
    });
    
    data = await response.json();

    if (!response.ok) {
      throw new Error(`获取模型列表失败 (${response.status}): ${JSON.stringify(data)}`);
    }
    
  } catch (error) {
    throw error;
  }
  
  const models = data?.models || {};
  return {
    object: 'list',
    data: Object.keys(models).map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'google'
    }))
  };
}

/**
 * 生成图片
 * @param {Object} requestBody - 请求体
 * @returns {Promise<Object>} 图片生成响应
 */
export async function generateImage(requestBody) {
  const token = await tokenManager.getToken();
  
  if (!token) {
    throw new Error('没有可用的token，请运行 npm run login 获取token');
  }
  
  const url = config.api.url;
  
  const requestHeaders = {
    'Host': config.api.host,
    'User-Agent': config.api.userAgent,
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip'
  };
  
  let response;
  
  try {
    // 创建 AbortController 用于超时控制
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 600000); // 10分钟超时
    
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    
    if (!response.ok) {
      const responseText = await response.text();
      
      if (response.status === 403) {
        tokenManager.disableCurrentToken(token);
        throw new Error(`该账号没有使用权限，已自动禁用。错误详情: ${responseText}`);
      }
      throw new Error(`API请求失败 (${response.status}): ${responseText}`);
    }
    
  } catch (error) {
    throw error;
  }

  // 解析响应 (处理 SSE 流式格式)
  const responseText = await response.text();
  const lines = responseText.split('\n');
  let collectedParts = [];
  let lastFinishReason = null;

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const jsonStr = line.slice(6);
      try {
        const chunk = JSON.parse(jsonStr);
        const parts = chunk.response?.candidates?.[0]?.content?.parts;
        if (parts) {
          collectedParts.push(...parts);
        }
        if (chunk.response?.candidates?.[0]?.finishReason) {
          lastFinishReason = chunk.response.candidates[0].finishReason;
        }
      } catch (e) {
        // 忽略解析错误
      }
    }
  }

  // 构造标准的 Gemini 响应格式
  const data = {
    candidates: [
      {
        content: {
          parts: collectedParts,
          role: 'model'
        },
        finishReason: lastFinishReason || 'STOP'
      }
    ]
  };
  return data;
}
