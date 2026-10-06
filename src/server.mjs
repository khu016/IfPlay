import { createIfPlayApp } from './app.mjs';

const host = process.env.IFPLAY_HOST ?? '127.0.0.1';
const port = Number(process.env.IFPLAY_PORT ?? 8787);
const { server } = await createIfPlayApp();

server.listen(port, host, () => {
  console.log(`IfPlay API 已启动：http://${host}:${port}`);
  console.log(`生成模式：${process.env.IFPLAY_GENERATOR_MODE ?? 'demo'}`);
});
