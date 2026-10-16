export class ChatRequestError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) { super(message); this.name = 'ChatRequestError'; this.code = code; }
}
export function chatErrorGuidance(code?: string): string {
  switch (code) {
    case 'AGENT_APPROVAL_CHANGED': return '审批已过期或任务、权限已变化，请刷新执行记录并重新核对命令。';
    case 'AGENT_TOOLS_UNSUPPORTED': return '当前工具执行链需要支持 Chat Completions 函数工具的模型；工具默认启用，无需另外开启。';
    case 'AGENT_INVALID_REQUEST': return '请求或工具参数定义未通过校验，本次生成未完成；请更新应用后手动重试。';
    case 'AGENT_TOOL_UNKNOWN': return '命令可能已执行，请先核查服务器状态；不会自动重试。';
    case 'AGENT_TOOL_LIMIT': return '本轮已达到工具调用上限，请核对已有结果后再继续。';
    case 'MODEL_CONTEXT_BINDING_CHANGED': return '此会话保存的模型上下文与当前接口、模型或密钥不一致，请使用原配置或新建会话。';
    case 'MODEL_RESPONSES_UNSUPPORTED': return '供应商不支持所需的 Responses 输入计数或远端整理接口，请检查协议和供应商能力。';
    case 'MODEL_CREDENTIALS': return '请打开模型设置，配置或重新保存 API Key。';
    case 'MODEL_CONTEXT_LIMIT':
    case 'AGENT_HISTORY_LIMIT': return '当前输入与保留上下文超过模型容量，请缩短输入、新建会话或检查模型窗口设置。';
    case 'AGENT_COMPACTION_FAILED': return '对话整理失败，原始历史仍保留；请检查模型是否支持非流式 JSON 摘要，再手动重试。';
    case 'AGENT_COMPACTION_LIMIT': return '整理后仍无法容纳当前请求，请缩短输入、新建会话或提高合理的模型窗口设置。';
    case 'AGENT_TARGET_UNAVAILABLE':
    case 'SSH_SESSION_NOT_FOUND': return '当前连接不可用；仍可讨论已有记录，新建服务器任务或实时操作需先连接。';
    case 'AGENT_TARGET_MISMATCH': return '当前连接与任务的服务器身份不一致，请选择对应任务或为当前服务器新建任务；原有历史已保留。';
    case 'AGENT_CANCELLED': return '本次生成已停止，部分回复已保留。';
    case 'AGENT_INTERRUPTED': return '上次生成已中断；可查看部分回复，重新发送会创建新的请求。';
    case 'MODEL_TIMEOUT': return '模型请求超时，请检查网络或模型超时设置后手动重试。';
    case 'MODEL_INCOMPLETE':
    case 'MODEL_PROTOCOL_FAILED': return '模型未返回完整回复，已有文本已保留；请检查兼容接口后手动重试。';
    case 'CHAT_CONTENT_REQUIRED': return '请输入文字或附加文件后重新发送。';
    case 'AGENT_ATTACHMENT_INVALID':
    case 'CHAT_ATTACHMENT_INVALID': return '请移除无效或重复附件，重新选择文件或再次附加。';
    case 'CHAT_ATTACHMENT_FORBIDDEN': return '当前账户无权使用此附件，请移除并上传自己的文件。';
    case 'CHAT_ATTACHMENT_LIMIT': return '请减少附件数量、总大小或文本内容后重试。';
    case 'CHAT_ATTACHMENT_UNSUPPORTED': return '请移除暂不支持的附件格式。';
    case 'CHAT_ATTACHMENT_CONTENT_INVALID': return '请检查文件内容；文本附件需使用 UTF-8 编码。';
    case 'CHAT_MODEL_MEDIA_UNSUPPORTED': return '当前智能体不支持该媒体类型，请选择支持的智能体或手动移除附件。';
    case 'CHAT_ATTACHMENT_BUSY': return '附件对话繁忙，请稍后手动重试。';
    case 'FILE_READ_FAILED':
    case 'FILE_STORAGE_UNAVAILABLE': return '文件暂时无法读取，可保留附件引用，稍后重试。';
    default: return '本次文字和附件已保留，可在输入框中重试。';
  }
}
