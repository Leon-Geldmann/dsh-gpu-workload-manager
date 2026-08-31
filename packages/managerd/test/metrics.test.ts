import { expect, it } from 'vitest';
import { Metrics } from '../src/metrics.js';

const snapshot = { phase: 'READY', activeModel: 'catalog-model', activeRequestCount: 1 } as const;

it('records bounded catalog telemetry with an actual first-generated-token TTFT', () => {
  let now = 0;
  const metrics = new Metrics(['catalog-model'], () => now);

  const inference = metrics.beginInference('catalog-model');
  now = 250;
  inference.firstGeneratedToken();
  now = 750;
  inference.end();
  inference.firstGeneratedToken();
  inference.end();
  metrics.observeChildLoadToHealth('catalog-model', 12.5);
  metrics.observeChildWarmup('catalog-model', 1.25);
  metrics.observeQueueWait('catalog-model', 2.5);
  metrics.addForceCancellations('catalog-model', 1);
  metrics.addChildCrash('catalog-model');

  const rendered = metrics.render(snapshot);
  expect(rendered).toContain('manager_gateway_requests_total 1\nmanager_gateway_active_requests 0\nmanager_engine_active_requests 1\n');
  expect(rendered).toContain('manager_inference_ttft_seconds_sum{model="catalog-model"} 0.25\n');
  expect(rendered).toContain('manager_inference_ttft_seconds_count{model="catalog-model"} 1\n');
  expect(rendered).toContain('manager_inference_request_duration_seconds_sum{model="catalog-model"} 0.75\n');
  expect(rendered).toContain('manager_child_load_to_health_seconds_sum{model="catalog-model"} 12.5\n');
  expect(rendered).toContain('manager_child_warmup_seconds_sum{model="catalog-model"} 1.25\n');
  expect(rendered).toContain('manager_queue_wait_seconds_sum{model="catalog-model"} 2.5\n');
  expect(rendered).toContain('manager_force_cancellations_total{model="catalog-model"} 1\n');
  expect(rendered).toContain('manager_child_crashes_total{model="catalog-model"} 1\n');
  expect(rendered).toContain('manager_engine_phase{phase="READY"} 1\n');
  expect(rendered).toContain('manager_engine_phase{phase="UNLOADED"} 0\n');
});

it('ignores non-catalog observer labels and never renders sensitive free-form values', () => {
  const metrics = new Metrics(['catalog-model'], () => 1_000);
  const secretKey = 'f'.repeat(64);
  const hostile = `/private/model.gguf\" credential=secret prompt=private response=private key=${secretKey} 192.168.3.44`;

  metrics.observeChildLoadToHealth(hostile, 1);
  metrics.observeChildWarmup(hostile, 1);
  metrics.observeQueueWait(hostile, 1);
  metrics.addForceCancellations(hostile, 1);
  metrics.addChildCrash(hostile);
  const inference = metrics.beginInference(hostile);
  inference.firstGeneratedToken();
  inference.end();

  const rendered = metrics.render(snapshot);
  expect(rendered).not.toContain('/private/model.gguf');
  expect(rendered).not.toContain('credential');
  expect(rendered).not.toContain('prompt=private');
  expect(rendered).not.toContain('response=private');
  expect(rendered).not.toContain(secretKey);
  expect(rendered).not.toContain('192.168.3.44');
  expect(rendered).toContain('manager_gateway_requests_total 1\nmanager_gateway_active_requests 0\n');
  expect(rendered).toContain('manager_inference_ttft_seconds_count{model="catalog-model"} 0\n');
});
