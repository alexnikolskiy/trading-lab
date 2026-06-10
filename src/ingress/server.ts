import { serve } from '@hono/node-server';
import { composeRuntime } from '../composition.ts';
import { createIngressApp } from './app.ts';

const { env, repo, queue } = composeRuntime();
const app = createIngressApp({ repo, queue });
serve({ fetch: app.fetch, port: env.INGRESS_PORT });
console.log(`ingress listening on :${env.INGRESS_PORT}`);
