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
function handleUserMessage(extracted, antigravityMessages, enableThinking) {
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
function handleAssistantMessage(message, antigravityMessages, isImageModel = false, enableThinking = false, signature = null) {
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

    // 修复：Gemini API 要求 functionCall parts 包含 thoughtSignature
    // 注意：thoughtSignature 是 part 对象的属性，与 functionCall 同级，而不是 functionCall 内部的属性
    // 正确格式：{ thoughtSignature: "...", functionCall: { name, args } }
    // 错误格式：{ functionCall: { name, args, thoughtSignature: "..." } }
    const functionCallObj = {
      functionCall: {
        id: toolCall.id,
        name: toolCall.function.name,
        args: argsObj
      }
    };

    // 只有在启用 thinking 且有 signature 时才添加 thoughtSignature（与 functionCall 同级）
    if (enableThinking && signature) {
      functionCallObj.thoughtSignature = signature;
    }

    return functionCallObj;
  }) : [];

  if (lastMessage?.role === "model" && hasToolCalls && !hasContent) {
    // 修复：在合并 tool_calls 到现有 model 消息时，
    // 如果启用 thinking 且有 signature，需要确保消息开头有思考块
    if (enableThinking && signature && !lastMessage.parts.some(p => p.thought === true)) {
      // 在开头插入一个带 signature 的思考块（使用占位符内容）
      lastMessage.parts.unshift({
        text: "...",
        thought: true,
        thoughtSignature: signature
      });
    }
    lastMessage.parts.push(...antigravityTools)
  } else {
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
                thoughtSignature: signature || ""
              });
            }
          }
        }

        // 修复：如果启用 thinking 但没有思考内容，需要添加一个带 signature 的思考块
        // Claude API 要求：当 thinking 启用时，所有 assistant 消息都必须以 thinking 块开头
        // 这包括：1) 有 tool_calls 的消息  2) 纯文本消息（没有 tool_calls）
        // 注意：使用占位符内容而不是空字符串，因为空字符串可能导致 Antigravity 转换问题
        if (enableThinking && !hasThinkingContent && signature) {
          parts.unshift({
            text: "...",
            thought: true,
            thoughtSignature: signature
          });
        }

        // 移除 <think>...</think> 标签及其内容，保留其他文本
        textContent = textContent.replace(/<think>[\s\S]*?<\/think>/g, '');

        // 清理多余的空行
        textContent = textContent.replace(/\n{3,}/g, '\n\n').trim();

        if (textContent) {
          // 在thinking模式下的处理逻辑
          if (enableThinking) {
            parts.push({ text: textContent, thought: false });
          } else {
            parts.push({ text: textContent });
          }
        } else if (enableThinking && !hasThinkingContent && parts.length === 0 && !hasToolCalls) {
          // 如果启用thinking但没有任何内容且没有tool_calls，添加一个空的thought: false标记
          parts.push({ text: "", thought: false });
        }
      }
    } else if (enableThinking && hasToolCalls && signature) {
      // 修复：如果没有内容但有 tool_calls，需要添加思考块（使用占位符内容）
      parts.push({
        text: "...",
        thought: true,
        thoughtSignature: signature
      });
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
function handleToolCall(message, antigravityMessages, enableThinking = false, signature = null) {
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

  // functionResponse part - 不添加 thought 属性
  // Gemini API 的 functionResponse 不支持 thought/thoughtSignature 属性
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
/**
 * 检查助手消息是否是无效的
 * 无效消息包括：
 * 1. 只包含单个 "{" 字符的消息
 * 2. content 数组中包含空块或结构不正确的元素
 * 这种消息通常是由于客户端错误产生的，需要被过滤掉
 * @param {Object} message - OpenAI 格式的消息对象
 * @returns {boolean} 如果消息无效返回 true
 */
function isInvalidAssistantMessage(message) {
  if (message.role !== 'assistant') {
    return false;
  }

  // 检查 content 是否是数组格式
  if (Array.isArray(message.content)) {
    // 空数组视为无效
    if (message.content.length === 0) {
      return true;
    }

    // 检查是否只有一个元素
    if (message.content.length === 1) {
      const item = message.content[0];
      
      // 检查元素是否是 text 类型，内容为 "{"
      if (item.type === 'text' && item.text === '{') {
        return true;
      }
      
      // 检查元素是否是空块或结构不正确
      // 情况1: text 类型但 text 字段为空、undefined、null 或不是字符串
      if (item.type === 'text') {
        if (item.text === undefined || item.text === null || item.text === '') {
          return true;
        }
        // 情况2: text 字段不是字符串（例如是对象）
        if (typeof item.text !== 'string') {
          return true;
        }
      }
      
      // 情况3: 元素没有 type 字段或 type 不是有效值
      if (!item.type) {
        return true;
      }
    }

    // 检查所有元素是否都是空的或无效的
    const hasValidContent = message.content.some(item => {
      if (item.type === 'text') {
        return typeof item.text === 'string' && item.text.trim() !== '' && item.text !== '{';
      }
      // 其他类型（如 image_url）视为有效
      return item.type && item.type !== 'text';
    });
    
    if (!hasValidContent) {
      return true;
    }
  }

  // 检查 content 是否是字符串格式，内容为 "{" 或空字符串
  if (typeof message.content === 'string') {
    if (message.content === '{' || message.content.trim() === '') {
      return true;
    }
  }

  // 检查 content 是否为 null 或 undefined
  if (message.content === null || message.content === undefined) {
    return true;
  }

  return false;
}

function openaiMessageToAntigravity(openaiMessages, enableThinking, isCompletionModel = false, modelName = '', signature = null) {
  // 过滤掉无效的助手消息（只包含单个 "{" 字符的消息）
  const filteredMessages = openaiMessages.filter(message => !isInvalidAssistantMessage(message));

  // 补全模型只需要最后一条用户消息作为提示
  if (isCompletionModel) {
    // 将所有消息合并为一个提示词
    let prompt = '';
    for (const message of filteredMessages) {
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

  for (const message of filteredMessages) {
    if (message.role === "user" || message.role === "system") {
      const extracted = extractImagesFromContent(message.content);
      handleUserMessage(extracted, antigravityMessages, enableThinking);
    } else if (message.role === "assistant") {
      handleAssistantMessage(message, antigravityMessages, isImageModel, enableThinking, signature);
    } else if (message.role === "tool") {
      handleToolCall(message, antigravityMessages, enableThinking, signature);
    }
  }

  return antigravityMessages;
}
/**
 * 检查消息列表中最后一条助手消息是否包含思考内容
 * @param {Array} messages - OpenAI 格式的消息数组
 * @returns {boolean} 如果最后一条助手消息有思考内容返回 true，否则返回 false
 */
function hasThinkingContentInLastAssistant(messages) {
  // 找到最后一条助手消息
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      const message = messages[i];
      const content = typeof message.content === 'string'
        ? message.content
        : (Array.isArray(message.content)
            ? message.content.filter(c => c.type === 'text').map(c => c.text).join('')
            : '');
      
      // 检查是否有 <think>...</think> 标签
      return /<think>[\s\S]*?<\/think>/.test(content);
    }
  }
  // 没有助手消息，返回 true（不需要禁用 thinking）
  return true;
}

function generateGenerationConfig(parameters, enableThinking, actualModelName, isNonChatModel = false, forceDisableThinking = false) {
  // 如果强制禁用 thinking，则覆盖 enableThinking
  const effectiveEnableThinking = forceDisableThinking ? false : enableThinking;
  
  // thinking 模型的 max_tokens 最小值为 2048
  let maxOutputTokens = parameters.max_tokens ?? config.defaults.max_tokens;
  if (effectiveEnableThinking && maxOutputTokens < 2048) {
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
      includeThoughts: effectiveEnableThinking,
      thinkingBudget: effectiveEnableThinking ? 1024 : 0
    };
  }

  if (effectiveEnableThinking && actualModelName.includes("claude")) {
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
      // gemini-2.5-pro-image 不支持 imageSize 参数
      if (actualModelName === 'gemini-2.5-pro-image') {
        const error = new Error('gemini-2.5-pro-image 不支持 imageSize 参数');
        error.statusCode = 400;
        throw error;
      }
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

function convertOpenAIToolsToAntigravity(openaiTools) {
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

// 注意：injectSignatures 函数已废弃，signature 现在在消息转换时直接注入
// 保留空函数以保持向后兼容
function injectSignatures(contents, signatures, enableThinking = false) {
  return;
}

async function generateRequestBody(openaiMessages, modelName, parameters, openaiTools, user_id = null, account = null) {
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
  const isImageModel = baseModelName.endsWith('-image');

  // 检测并拒绝不支持的模型类型
  const isChatModel = baseModelName.startsWith('chat_');  // chat_ 开头的内部补全模型

  if (isChatModel) {
    throw new Error(`Unsupported completion model: ${baseModelName}`);
  }

  // 先检索存储的 signature（需要在判断是否禁用 thinking 之前）
  let storedSignature = null;
  if (enableThinking && user_id && !isImageModel) {
    try {
      const { default: signatureService } = await import('../services/signature.service.js');
      // 检查是否有 tool 交互
      if (signatureService.hasToolInteraction(openaiMessages)) {
        storedSignature = await signatureService.retrieveSignature(user_id);
      }
    } catch (error) {
      logger.warn('检索 signature 失败:', error.message);
    }
  }

  // 检查是否需要强制禁用 thinking
  // 对于非 Gemini 的思考模型（如 Claude），只有在以下情况才禁用 thinking 功能：
  // 1. 最后一条助手消息没有思考内容
  // 2. 且没有存储的 signature 可用于注入
  // 如果有存储的 signature，可以通过注入来满足 API 要求，不需要禁用
  // 注意：Gemini 模型不需要强制禁用思考，因为它可以处理没有思考内容的情况
  const isGeminiModel = baseModelName.startsWith('gemini-');
  let forceDisableThinking = false;
  if (enableThinking && !isImageModel && !isGeminiModel) {
    const hasThinkingContent = hasThinkingContentInLastAssistant(openaiMessages);
    if (!hasThinkingContent && !storedSignature) {
      logger.info('最后一条助手消息没有思考内容且没有存储的 signature，禁用 thinking 功能');
      forceDisableThinking = true;
    }
  }

  // 计算实际的 enableThinking 状态（用于消息转换）
  const effectiveEnableThinking = forceDisableThinking ? false : enableThinking;

  // 标准对话模型使用标准格式，传入 forceDisableThinking 参数
  const generationConfig = generateGenerationConfig(parameters, enableThinking, baseModelName, false, forceDisableThinking);

  // 传入 signature 参数，在消息转换时直接注入
  // 使用 effectiveEnableThinking 来决定是否启用 thinking 相关的消息处理
  const contents = openaiMessageToAntigravity(openaiMessages, effectiveEnableThinking, false, baseModelName, storedSignature);

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

  return requestBody;
}
/**
 * 生成图片生成请求体
 * @param {string} prompt - 图片生成提示词
 * @param {string} modelName - 模型名称
 * @param {Object} imageConfig - 图片配置参数
 * @param {Object} account - 账号对象（可选，包含project_id_0）
 * @param {Array} images - 图片数组（可选，用于图生图/图片编辑），格式为 [{ inlineData: { mimeType, data } }]
 * @returns {Object} 请求体
 */
function generateImageRequestBody(prompt, modelName, imageConfig = {}, account = null, images = []) {
  // 优先使用账号的 project_id_0，如果不存在则随机生成
  let projectId = generateProjectId();
  if (account) {
    if (account.project_id_0 !== undefined && account.project_id_0 !== null) {
      projectId = account.project_id_0;
    } else {
      logger.info(`图片生成账号没有配置 project_id，使用随机生成: ${projectId}`);
    }
  }

  // 构建 parts 数组：文本 + 图片
  const parts = [];
  
  // 添加文本提示词
  if (prompt) {
    parts.push({ text: prompt });
  }
  
  // 添加图片（用于图生图/图片编辑）
  if (images && images.length > 0) {
    parts.push(...images);
  }

  // 确保 parts 不为空
  if (parts.length === 0) {
    parts.push({ text: "" });
  }

  const requestBody = {
    project: projectId,
    requestId: generateRequestId(),
    request: {
      contents: [
        {
          role: "user",
          parts: parts
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
      // 校验 aspectRatio 参数
      const validAspectRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];
      if (!validAspectRatios.includes(imageConfig.aspect_ratio)) {
        const error = new Error(`Invalid aspectRatio: ${imageConfig.aspect_ratio}. Supported values: ${validAspectRatios.join(', ')}`);
        error.statusCode = 400;
        throw error;
      }
      requestBody.request.generationConfig.imageConfig.aspectRatio = imageConfig.aspect_ratio;
    }
    if (imageConfig.image_size) {
      // 校验 imageSize 参数
      const validImageSizes = ['1K', '2K', '4K'];
      if (!validImageSizes.includes(imageConfig.image_size)) {
        const error = new Error(`Invalid imageSize: ${imageConfig.image_size}. Supported values: ${validImageSizes.join(', ')}`);
        error.statusCode = 400;
        throw error;
      }

      if (modelName === 'gemini-2.5-flash-image') {
        const error = new Error('Unsupported parameter: imageSize for gemini-2.5-flash-image');
        error.statusCode = 400;
        throw error;
      }
      requestBody.request.generationConfig.imageConfig.imageSize = imageConfig.image_size;
    }
  }


  return requestBody;
}
/**
 * 将错误现场（用户请求、上游请求、上游响应）转储到文件
 * @param {Object} userRequest - 用户原始请求体
 * @param {Object} upstreamRequest - 发送给上游的请求体
 * @param {string|Object} upstreamResponse - 上游返回的响应内容
 * @param {string} errorInfo - 错误信息描述
 */
async function dumpErrorArtifacts(userRequest, upstreamRequest, upstreamResponse, errorInfo) {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `errordump-${timestamp}.json`;
    const filepath = path.join(process.cwd(), filename);

    const dumpData = {
      timestamp: new Date().toISOString(),
      error: errorInfo,
      user_request: userRequest,
      upstream_request: upstreamRequest,
      upstream_response: upstreamResponse
    };

    // 如果响应是JSON字符串，尝试解析以便更好阅读
    if (typeof upstreamResponse === 'string') {
      try {
        dumpData.upstream_response_parsed = JSON.parse(upstreamResponse);
      } catch (e) {
        // 忽略解析错误
      }
    }

    await fs.writeFile(filepath, JSON.stringify(dumpData, null, 2), 'utf8');
    logger.info(`错误现场已转储至文件: ${filepath}`);
    return filepath;
  } catch (error) {
    logger.error('转储错误现场失败:', error.message);
    return null;
  }
}

export {
  generateRequestId,
  generateSessionId,
  generateProjectId,
  generateRequestBody,
  generateImageRequestBody,
  injectSignatures,
  dumpErrorArtifacts
}
