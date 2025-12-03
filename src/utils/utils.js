import { randomUUID } from 'crypto';
import config from '../config/config.js';
import logger from './logger.js';

function generateRequestId() {
  return `agent-${randomUUID()}`;
}

function generateSessionId() {
  return String(-Math.floor(Math.random() * 9e18));
}

function generateProjectId() {
  const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
  const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
  const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomNum = Math.random().toString(36).substring(2, 7);
  return `${randomAdj}-${randomNoun}-${randomNum}`;
}

function extractImagesFromContent(content) {
  const result = { text: '', images: [] };

  // 如果content是字符串，直接返回
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  // 如果content是数组（multimodal格式）
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        // 提取base64图片数据
        const imageUrl = item.image_url?.url || '';

        // 匹配 data:image/{format};base64,{data} 格式
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const format = match[1]; // 例如 png, jpeg, jpg
          const base64Data = match[2];
          result.images.push({
            inlineData: {
              mimeType: `image/${format}`,
              data: base64Data
            }
          })
        }
      }
    }
  }

  return result;
}
function handleUserMessage(extracted, antigravityMessages, enableThinking){
  const parts = [];
  if (extracted.text) {
    // 在thinking模式下,文本部分需要添加thought标记以避免API错误
    if (enableThinking && extracted.images.length > 0) {
      parts.push({ text: extracted.text, thought: false });
    } else {
      parts.push({ text: extracted.text });
    }
  }
  parts.push(...extracted.images);
  
  // 确保parts数组不为空
  if (parts.length === 0) {
    parts.push({ text: "" });
  }
  
  antigravityMessages.push({
    role: "user",
    parts
  });
}
function handleAssistantMessage(message, antigravityMessages, isImageModel = false, enableThinking = false){
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = message.tool_calls && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const hasContent = message.content &&
    (typeof message.content === 'string' ? message.content.trim() !== '' : true);
  
  // 安全处理 tool_calls，防止 undefined.map() 错误
  const toolCallsArray = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const antigravityTools = hasToolCalls ? toolCallsArray.map((toolCall, index) => {
    let argsObj;
    try {
      argsObj = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments;
    } catch (e) {
      argsObj = {};
    }
    
    const functionCallObj = {
      functionCall: {
        id: toolCall.id,
        name: toolCall.function.name,
        args: argsObj
      }
    };
    
    return functionCallObj;
  }) : [];
  
  if (lastMessage?.role === "model" && hasToolCalls && !hasContent){
    lastMessage.parts.push(...antigravityTools)
  }else{
    const parts = [];
    if (hasContent) {
      let textContent = '';
      if (typeof message.content === 'string') {
        textContent = message.content;
      } else if (Array.isArray(message.content)) {
        textContent = message.content
          .filter(item => item.type === 'text')
          .map(item => item.text)
          .join('');
      }
      
      // 对于 image 模型，所有助手消息文本都标记为 thought: true
      if (isImageModel) {
        // 移除图片相关的markdown标记
        textContent = textContent.replace(/!\[.*?\]\(data:image\/[^)]+\)/g, '');
        textContent = textContent.replace(/\[图像生成完成[^\]]*\]/g, '');
        textContent = textContent.replace(/\n{3,}/g, '\n\n').trim();
        
        if (textContent) {
          parts.push({ text: textContent, thought: true });
        }
      } else {
        // 非 image 模型的正常处理逻辑
        // 提取并处理 <think>...</think> 标签内容
        const thinkMatches = textContent.match(/<think>([\s\S]*?)<\/think>/g);
        const hasThinkingContent = thinkMatches && thinkMatches.length > 0;
        
        if (hasThinkingContent) {
          for (const match of thinkMatches) {
            const thinkContent = match.replace(/<\/?think>/g, '').trim();
            if (thinkContent) {
              parts.push({
                text: thinkContent,
                thought: true,
                thoughtSignature: ""
              });
            }
          }
        }
        
        // 移除 <think>...</think> 标签及其内容，保留其他文本
        textContent = textContent.replace(/<think>[\s\S]*?<\/think>/g, '');
        
        // 清理多余的空行
        textContent = textContent.replace(/\n{3,}/g, '\n\n').trim();
        
        if (textContent) {
          // 在thinking模式下的处理逻辑
          if (enableThinking) {
            // 如果已经有thinking block，需要明确标记非thinking内容
            if (hasThinkingContent) {
              parts.push({ text: textContent, thought: false });
            } else {
              // 如果没有thinking内容但启用了thinking模式（从非thinking模型切换过来的历史消息）
              // 需要将整个内容标记为thought: false，确保最后一条助手消息有thought标记
              parts.push({ text: textContent, thought: false });
            }
          } else {
            parts.push({ text: textContent });
          }
        } else if (enableThinking && !hasThinkingContent && parts.length === 0) {
          // 如果启用thinking但没有任何内容，添加一个空的thought: false标记
          // 这确保了即使是空消息也符合thinking模式的要求
          parts.push({ text: "", thought: false });
        }
      }
    }
    parts.push(...antigravityTools);
    
    if (parts.length === 0) {
      parts.push({ text: "" });
    }
    
    antigravityMessages.push({
      role: "model",
      parts
    })
  }
}
function handleToolCall(message, antigravityMessages){
  let functionName = '';
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if (part.functionCall && part.functionCall.id === message.tool_call_id) {
          functionName = part.functionCall.name;
          break;
        }
      }
      if (functionName) break;
    }
  }
  
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      id: message.tool_call_id,
      name: functionName,
      response: {
        output: message.content
      }
    }
  };
  
  // 如果上一条消息是 user 且包含 functionResponse，则合并
  if (lastMessage?.role === "user" && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({
      role: "user",
      parts: [functionResponse]
    });
  }
}
function openaiMessageToAntigravity(openaiMessages, enableThinking, isCompletionModel = false, modelName = ''){
  // 补全模型只需要最后一条用户消息作为提示
  if (isCompletionModel) {
    // 将所有消息合并为一个提示词
    let prompt = '';
    for (const message of openaiMessages) {
      if (message.role === 'system') {
        prompt += message.content + '\n\n';
      } else if (message.role === 'user') {
        prompt += message.content;
      } else if (message.role === 'assistant') {
        prompt += '\n' + message.content + '\n';
      }
    }
    
    return [{
      role: "user",
      parts: [{ text: prompt }]
    }];
  }
  
  const antigravityMessages = [];
  const isImageModel = modelName.endsWith('-image');
  
  for (const message of openaiMessages) {
    if (message.role === "user" || message.role === "system") {
      const extracted = extractImagesFromContent(message.content);
      handleUserMessage(extracted, antigravityMessages, enableThinking);
    } else if (message.role === "assistant") {
      handleAssistantMessage(message, antigravityMessages, isImageModel, enableThinking);
    } else if (message.role === "tool") {
      handleToolCall(message, antigravityMessages);
    }
  }
  
  return antigravityMessages;
}
function generateGenerationConfig(parameters, enableThinking, actualModelName, isNonChatModel = false){
  // thinking 模型的 max_tokens 最小值为 2048
  let maxOutputTokens = parameters.max_tokens ?? config.defaults.max_tokens;
  if (enableThinking && maxOutputTokens < 2048) {
    maxOutputTokens = 2048;
  }
  
  const generationConfig = {
    temperature: parameters.temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: maxOutputTokens
  };
  
  // 非对话模型使用最简配置
  if (isNonChatModel) {
    return generationConfig;
  }
  
  // 标准对话模型添加完整配置
  generationConfig.topP = parameters.top_p ?? config.defaults.top_p;
  generationConfig.topK = parameters.top_k ?? config.defaults.top_k;
  generationConfig.stopSequences = [
    "<|user|>",
    "<|bot|>",
    "<|context_request|>",
    "<|endoftext|>",
    "<|end_of_turn|>"
  ];
  
  // gemini-2.5-flash-image 不支持 thinkingConfig 参数
  if (actualModelName !== 'gemini-2.5-flash-image') {
    generationConfig.thinkingConfig = {
      includeThoughts: enableThinking,
      thinkingBudget: enableThinking ? 1024 : 0
    };
  }
  
  if (enableThinking && actualModelName.includes("claude")){
    delete generationConfig.topP;
  }
  
  // 图片生成模型支持 imageConfig 参数
  if (actualModelName.endsWith('-image') && parameters.image_config) {
    generationConfig.imageConfig = {};
    
    // 支持 aspect_ratio 参数（如 "16:9", "4:3", "1:1" 等）
    if (parameters.image_config.aspect_ratio) {
      generationConfig.imageConfig.aspectRatio = parameters.image_config.aspect_ratio;
    }
    
    // 支持 image_size 参数（如 "4K", "1080p" 等）
    if (parameters.image_config.image_size) {
      generationConfig.imageConfig.imageSize = parameters.image_config.image_size;
    }
  }
  
  return generationConfig;
}
/**
 * Gemini API 不支持的 JSON Schema 关键字黑名单
 * 这些关键字会导致 Claude API 返回 "JSON schema is invalid" 错误
 */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  // 草案/元信息
  '$schema', '$id', '$defs', 'definitions',
  // 组合逻辑
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
  // 正则/模式类
  'pattern', 'patternProperties', 'propertyNames',
  // 字符串约束（重点：minLength/maxLength 会导致 tools.10 错误）
  'minLength', 'maxLength',
  // 数组约束
  'minItems', 'maxItems', 'uniqueItems', 'contains',
  // 数值约束
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  // 依赖相关
  'dependentSchemas', 'dependentRequired',
  // 评估相关
  'additionalItems', 'unevaluatedItems', 'unevaluatedProperties'
]);

/**
 * 规范化 JSON Schema，移除 Gemini 不支持的关键字
 * 只保留基本的 type/properties/required/items/enum/additionalProperties/description/format/default
 *
 * 这个函数解决了 "tools.10.custom.input_schema: JSON schema is invalid" 错误
 * 该错误是由于 TodoWrite 工具中使用了 minLength 等 Gemini 不支持的约束关键字
 */
function normalizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  // 处理数组
  if (Array.isArray(schema)) {
    return schema.map(item => normalizeJsonSchema(item));
  }

  // 深拷贝对象
  const normalized = { ...schema };

  // 1. 删除黑名单中的所有关键字
  for (const key of Object.keys(normalized)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) {
      delete normalized[key];
    }
  }

  // 2. 递归处理保留下来的 schema 相关字段
  // properties: 对象属性定义
  if (normalized.properties !== undefined) {
    if (typeof normalized.properties === 'object' && !Array.isArray(normalized.properties)) {
      const processed = {};
      for (const [propKey, propValue] of Object.entries(normalized.properties)) {
        processed[propKey] = normalizeJsonSchema(propValue);
      }
      normalized.properties = processed;
    }
  }

  // items: 数组项定义
  if (normalized.items !== undefined) {
    normalized.items = normalizeJsonSchema(normalized.items);
  }

  // additionalProperties: 额外属性定义
  if (normalized.additionalProperties !== undefined &&
      typeof normalized.additionalProperties === 'object') {
    normalized.additionalProperties = normalizeJsonSchema(normalized.additionalProperties);
  }

  return normalized;
}

function convertOpenAIToolsToAntigravity(openaiTools){
  // 安全处理 openaiTools，防止 undefined.map() 错误
  const toolsArray = Array.isArray(openaiTools) ? openaiTools : [];
  if (toolsArray.length === 0) return [];
  
  return toolsArray.map((tool) => {
    // 规范化 parameters，移除 Draft 7 特征和问题字段
    const normalizedParams = normalizeJsonSchema(tool.function.parameters);
    
    return {
      functionDeclarations: [
        {
          name: tool.function.name,
          description: tool.function.description,
          parameters: normalizedParams
        }
      ]
    };
  });
}

/**
 * 将存储的 signatures 注入到 contents 中
 * @param {Array} contents - Antigravity 格式的消息数组
 * @param {Array} signatures - 存储的 signature 数组
 */
function injectSignatures(contents, signatures) {
  if (!contents || !signatures || signatures.length === 0) {
    return;
  }
  
  // 找到最后一条 model 消息
  const lastModelMessage = [...contents].reverse().find(msg => msg.role === 'model');
  if (!lastModelMessage || !lastModelMessage.parts) {
    return;
  }
  
  // 注入 signatures 到对应的 parts
  for (const sig of signatures) {
    if (sig.type === 'functionCall' && sig.functionId) {
      // 查找对应的 functionCall
      const part = lastModelMessage.parts.find(p =>
        p.functionCall && p.functionCall.id === sig.functionId
      );
      if (part && !part.thoughtSignature) {
        part.thoughtSignature = sig.signature;
      }
    } else if (sig.type === 'text' && sig.index !== undefined) {
      // 根据索引注入到对应的 text part
      if (lastModelMessage.parts[sig.index] && !lastModelMessage.parts[sig.index].thoughtSignature) {
        lastModelMessage.parts[sig.index].thoughtSignature = sig.signature;
      }
    }
  }
}

async function generateRequestBody(openaiMessages, modelName, parameters, openaiTools, user_id = null, account = null){
  // Gemini 2.5 Flash Thinking 路由到 Gemini 2.5 Flash
  let actualModelName = modelName;
  if (modelName === 'gemini-2.5-flash-thinking') {
    actualModelName = 'gemini-2.5-flash';
  }
  
  const enableThinking = modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === "rev19-uic3-1p" ||
    modelName === "gpt-oss-120b-medium"
  
  // 用于生成配置的基础模型名（去掉-thinking后缀用于某些配置判断）
  const baseModelName = actualModelName.endsWith('-thinking') ? actualModelName.slice(0, -9) : actualModelName;
  
  // 检测并拒绝不支持的模型类型
  const isChatModel = baseModelName.startsWith('chat_');  // chat_ 开头的内部补全模型
  
  if (isChatModel) {
    throw new Error(`Unsupported completion model: ${baseModelName}`);
  }
  
  // 如果启用 thinking 且提供了 user_id，尝试检索并注入 signatures
  let storedSignatures = null;
  if (enableThinking && user_id) {
    try {
      const { default: signatureService } = await import('../services/signature.service.js');
      storedSignatures = await signatureService.retrieveSignatures(user_id, openaiMessages);
    } catch (error) {
      // 忽略错误，继续使用空 signature
    }
  }
  
  // 标准对话模型使用标准格式
  const generationConfig = generateGenerationConfig(parameters, enableThinking, baseModelName, false);
  
  const contents = openaiMessageToAntigravity(openaiMessages, enableThinking, false, baseModelName);
  
  // 如果有存储的 signatures，注入到对应的 parts 中
  if (storedSignatures && storedSignatures.length > 0) {
    injectSignatures(contents, storedSignatures);
  }
  
  // 优先使用账号的 project_id_0，如果不存在则随机生成
  let projectId = generateProjectId();
  if (account) {
    if (account.project_id_0 !== undefined && account.project_id_0 !== null) {
      projectId = account.project_id_0;
    } else {
      logger.info(`账号没有配置 project_id，使用随机生成: ${projectId}`);
    }
  }
  
  const requestBody = {
    project: projectId,
    requestId: generateRequestId(),
    request: {
      contents: contents,
      generationConfig: generationConfig,
      sessionId: generateSessionId(),
      systemInstruction: {
        role: "user",
        parts: [{ text: config.systemInstruction }]
      }
    },
    model: actualModelName,
    userAgent: "antigravity"
  };
  
  if (openaiTools && openaiTools.length > 0) {
    requestBody.request.tools = convertOpenAIToolsToAntigravity(openaiTools);
    requestBody.request.toolConfig = {
      functionCallingConfig: {
        mode: "VALIDATED"
      }
    };
  }
  
  // 不在这里打印请求体，因为projectId可能会在generateResponse中被修改
  // 打印请求体的逻辑移到generateResponse中，在选择projectId之后
  
  return requestBody;
}
/**
 * 生成图片生成请求体
 * @param {string} prompt - 图片生成提示词
 * @param {string} modelName - 模型名称
 * @param {Object} imageConfig - 图片配置参数
 * @param {Object} account - 账号对象（可选，包含project_id_0）
 * @returns {Object} 请求体
 */
function generateImageRequestBody(prompt, modelName, imageConfig = {}, account = null) {
  // 优先使用账号的 project_id_0，如果不存在则随机生成
  let projectId = generateProjectId();
  if (account) {
    if (account.project_id_0 !== undefined && account.project_id_0 !== null) {
      projectId = account.project_id_0;
    } else {
      logger.info(`图片生成账号没有配置 project_id，使用随机生成: ${projectId}`);
    }
  }
  
  const requestBody = {
    project: projectId,
    requestId: generateRequestId(),
    request: {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: prompt
            }
          ]
        }
      ],
      generationConfig: {
        candidateCount: 1
      }
    },
    model: modelName,
    userAgent: "antigravity",
    requestType: "image_gen"
  };
  
  if (imageConfig && Object.keys(imageConfig).length > 0) {
    requestBody.request.generationConfig.imageConfig = {};
    if (imageConfig.aspect_ratio) {
      requestBody.request.generationConfig.imageConfig.aspectRatio = imageConfig.aspect_ratio;
    }
    if (imageConfig.image_size) {
      requestBody.request.generationConfig.imageConfig.imageSize = imageConfig.image_size;
    }
  }
  
  // 不在这里打印请求体，因为projectId可能会在generateImage中被修改
  // 打印请求体的逻辑移到generateImage中，在选择projectId之后
  
  return requestBody;
}

export{
  generateRequestId,
  generateSessionId,
  generateProjectId,
  generateRequestBody,
  generateImageRequestBody,
  injectSignatures
}
