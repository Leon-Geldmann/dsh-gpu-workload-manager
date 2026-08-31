export {
  DISABLED_LOCAL_REASON,
  LOCAL_MODEL_IDS,
  LOCAL_PROVIDER_ID,
  isManagedLocalModel,
  modelPolicy,
} from './policy.js';
export type { ManagerAvailability, ModelAvailability, ModelIdentity } from './policy.js';

/** Node-side DSH Loader entry; browser behavior lives in the client bundle. */
export function apply(): void {}
