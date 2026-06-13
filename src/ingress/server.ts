import { serve } from '@hono/node-server';
import { composeRuntime } from '../composition.ts';
import { createIngressApp } from './app.ts';
import { createChatApp } from '../chat/chat-app.ts';

const { env, services, queue, pool, chat } = composeRuntime();
const app = createIngressApp({ repo: services.researchTasks, queue });
app.route('/chat', createChatApp(chat));
serve({ fetch: app.fetch, port: env.INGRESS_PORT });
console.log(`ingress listening on :${env.INGRESS_PORT}`);

const shutdown = async () => {
  await queue.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
