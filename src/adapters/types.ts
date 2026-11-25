import type { AdapterKind, ChannelConfig, ChannelConnection, ExecutionResult, PublishJob } from "../types.js";

export interface AdapterExecutionOptions {
  dryRun?: boolean;
  headless?: boolean;
}

export interface PublishAdapter {
  readonly kind: AdapterKind;
  execute(
    job: PublishJob,
    channel: ChannelConfig,
    connection: ChannelConnection,
    options?: AdapterExecutionOptions,
  ): Promise<ExecutionResult>;
}
