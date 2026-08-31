export const zh = {
  'command.description': '选择本会话使用的模型',
} as const;

export type GpuModelLocaleKey = keyof typeof zh;

export const en: Record<GpuModelLocaleKey, string> = {
  'command.description': 'Select the model for this conversation',
};
