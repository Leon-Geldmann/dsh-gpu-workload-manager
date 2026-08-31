import { createProductionRuntime, parseRuntimeArguments, type ProductionRuntime } from './production-runtime.js';
import { openSystemdCredentials } from './runtime-credentials.js';
import { loadProductionConfiguration } from './runtime-files.js';

export async function runManagerd(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const arguments_ = parseRuntimeArguments(argv);
  const configuration = loadProductionConfiguration(arguments_);
  const credentials = openSystemdCredentials();
  let runtime: ProductionRuntime | undefined;
  try {
    runtime = await createProductionRuntime(configuration.manager, configuration.catalog, credentials);
    await runtime.listen();
    process.stdout.write('gpu-workload-managerd ready state=UNLOADED\n');
    await waitForShutdownSignal();
  } finally {
    if (runtime !== undefined) await runtime.shutdown();
    else credentials.close();
  }
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off('SIGTERM', done);
      process.off('SIGINT', done);
      resolve();
    };
    process.once('SIGTERM', done);
    process.once('SIGINT', done);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runManagerd().catch(() => {
    process.stderr.write('gpu-workload-managerd startup failed\n');
    process.exitCode = 1;
  });
}
