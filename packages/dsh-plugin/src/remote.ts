import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ManagerClient } from './client.js';
import type { PluginConfig } from './config.js';
import { parsePluginConfig } from './config.js';
import { createGpuCommand } from './commands.js';
import type { GpuCancelResult, GpuManagerStatus, GpuModelList, GpuOperationRequest, GpuSubmitResult } from './types.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    gpuWorkloads: GpuWorkloads;
  }
}

export class GpuWorkloads extends TypertRemoteService {
  static inject = ['commands', 'credentials'];
  private readonly client: ManagerClient;

  constructor(ctx: Context, config: PluginConfig) {
    super(ctx, 'gpuWorkloads');
    this.client = new ManagerClient(parsePluginConfig(config), ctx.credentials);
    ctx.commands.register(createGpuCommand(this));
  }

  @Remote
  status(signal: AbortSignal): Promise<GpuManagerStatus> {
    return this.client.status(signal);
  }

  @Remote
  models(signal: AbortSignal): Promise<GpuModelList> {
    return this.client.models(signal);
  }

  @Remote
  submit(request: GpuOperationRequest, signal: AbortSignal): Promise<GpuSubmitResult> {
    return this.client.submit(request, signal);
  }

  @Remote
  cancel(operationId: string, signal: AbortSignal): Promise<GpuCancelResult> {
    return this.client.cancel(operationId, signal);
  }
}

export default GpuWorkloads;
